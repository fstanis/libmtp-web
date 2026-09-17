/** Emscripten --js-library: the js_usb_* and js_stream_* externs of src/wasm, implemented over WebUSB. */

declare const mergeInto: (into: object, extra: object) => void;
declare const LibraryManager: { library: object };
declare const HEAPU8: Uint8Array;

declare function mtp_usb_registry(): MtpUsbRegistry;
declare function mtp_usb_live_device(id: number): USBDevice | null;
declare function mtp_usb_set_last_error(message: string): void;
declare function mtp_write_utf8(text: string, out: number, outlen: number): number;
declare function mtp_with_timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T>;
declare const libusb_errors: { IO: number; NO_DEVICE: number; BUSY: number; TIMEOUT: number; PIPE: number };

interface MtpUsbRegistry {
  devices: (USBDevice | undefined)[];
  order: number[];
  nextId: number;
  lastError: string;
  lastLoggedError: string;
  poisoned: Set<number>;
}

interface MtpModule {
  mtpUsb?: MtpUsbRegistry;
  /** Registered by the session for the duration of mtp_send_file_stream; fills its target from the upload stream. */
  mtpStreamPuller?: (target: Uint8Array) => Promise<number>;
  /** Registered by the session for the duration of mtp_read_file_stream; receives download chunks. */
  mtpStreamPusher?: (chunk: Uint8Array) => Promise<void>;
}

declare const Module: MtpModule;

// WebUSB awaits libmtp passes no deadline to; a wedged device must not hang the wasm stack forever.
const USB_STEP_TIMEOUT_MS = 5000;
const USB_RESET_TIMEOUT_MS = 10000;
const USB_CONTROL_TIMEOUT_MS = 5000;
// libmtp's own timeouts are always nonzero in practice; this only bounds an infinite (timeout 0) wait.
const USB_BULK_MAX_TIMEOUT_MS = 120000;

// emcc text-scans for `name: function (...)`, so entries use function
// expressions, and only library members reach the emitted module: shared
// values live here as $-prefixed data, kept when a __deps chain references
// them (with the `$` stripped at emission).
const lib = {
  // libusb-1.0 error codes (enum libusb_error) the backend returns.
  $libusb_errors: { IO: -1, NO_DEVICE: -4, BUSY: -6, TIMEOUT: -7, PIPE: -9 },
  $mtp_usb_registry: function (): MtpUsbRegistry {
    if (!Module.mtpUsb) {
      Module.mtpUsb = { devices: [], order: [], nextId: 1, lastError: '', lastLoggedError: '', poisoned: new Set() };
    }
    return Module.mtpUsb;
  },

  // null when the id is unknown or its transport was poisoned by a timed-out transfer.
  $mtp_usb_live_device: function (id: number): USBDevice | null {
    const registry = mtp_usb_registry();
    const device = registry.devices[id];
    return device && !registry.poisoned.has(id) ? device : null;
  },

  $mtp_usb_set_last_error__deps: ['$mtp_usb_registry'],
  $mtp_usb_set_last_error: function (message: string): void {
    const registry = mtp_usb_registry();
    registry.lastError = message;
    if (message !== registry.lastLoggedError) {
      registry.lastLoggedError = message;
      console.error('[mtp-webusb]', message);
    }
  },

  $mtp_write_utf8: function (text: string, out: number, outlen: number): number {
    const bytes = new TextEncoder().encode(text);
    const n = Math.min(bytes.length, outlen - 1);
    HEAPU8.set(bytes.subarray(0, n), out);
    HEAPU8[out + n] = 0;
    return n;
  },

  $mtp_with_timeout: function <T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (!timeoutMs) {
      return promise;
    }
    promise.catch(() => undefined);
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
  },

  js_usb_get_last_error: function (out: number, outlen: number): number {
    const message = mtp_usb_registry().lastError;
    if (!message) {
      return 0;
    }
    return mtp_write_utf8(message, out, outlen);
  },
  js_usb_get_last_error__deps: ['$mtp_usb_registry', '$mtp_write_utf8'],

  js_usb_refresh_devices: async function (): Promise<number> {
    const registry = mtp_usb_registry();
    console.log('[mtp-webusb] refreshing paired device list via navigator.usb.getDevices()');
    const paired = await navigator.usb.getDevices();
    console.log('[mtp-webusb] navigator.usb.getDevices() returned', paired.length, 'device(s)');
    registry.order = [];
    for (const device of paired) {
      let id: number | null = null;
      for (let existingId = 0; existingId < registry.devices.length; existingId++) {
        if (registry.devices[existingId] === device) {
          id = existingId;
          break;
        }
      }
      if (id === null) {
        id = registry.nextId++;
        registry.devices[id] = device;
      }
      registry.order.push(id);
      const activeConfig = device.configuration ? device.configuration.configurationValue : 'none';
      console.log(
        `[mtp-webusb]   device id=${id} vendorId=0x${device.vendorId.toString(16)}` +
          ` productId=0x${device.productId.toString(16)} product="${device.productName}"` +
          ` serial="${device.serialNumber}" opened=${device.opened}` +
          ` configurations=${device.configurations.map((c) => c.configurationValue).join(',')}` +
          ` activeConfig=${activeConfig}`,
      );
    }
    if (paired.length === 0) {
      console.warn(
        '[mtp-webusb] no paired devices found - the page must call navigator.usb.requestDevice() ' +
          'from a user gesture first (a cancelled device picker grants nothing).',
      );
    }
    return registry.order.length;
  },
  js_usb_refresh_devices__deps: ['$mtp_usb_registry', '$libusb_errors'],
  js_usb_refresh_devices__async: true,

  js_usb_device_id_at: function (index: number): number {
    return mtp_usb_registry().order[index];
  },
  js_usb_device_id_at__deps: ['$mtp_usb_registry', '$libusb_errors'],

  js_usb_desc_int: function (id: number, field: number): number {
    const device = mtp_usb_registry().devices[id];
    if (!device) {
      return -1;
    }
    switch (field) {
      case 0:
        return device.deviceClass || 0;
      case 1:
        return device.deviceSubclass || 0;
      case 2:
        return device.deviceProtocol || 0;
      case 3:
        return device.vendorId || 0;
      case 4:
        return device.productId || 0;
      case 5:
        return (
          ((device.deviceVersionMajor || 0) << 8) |
          ((device.deviceVersionMinor || 0) << 4) |
          (device.deviceVersionSubminor || 0)
        );
      case 6:
        return (
          ((device.usbVersionMajor || 2) << 8) | ((device.usbVersionMinor || 0) << 4) | (device.usbVersionSubminor || 0)
        );
      case 7:
        return device.configurations ? device.configurations.length : 0;
      case 8:
        return device.manufacturerName ? 1 : 0;
      case 9:
        return device.productName ? 1 : 0;
      case 10:
        return device.serialNumber ? 1 : 0;
      default:
        return 0;
    }
  },
  js_usb_desc_int__deps: ['$mtp_usb_registry', '$libusb_errors'],

  // WebUSB has no bus/address; synthesize stable per-device numbers as a lookup key.
  js_usb_bus_number: function (_id: number): number {
    return 1;
  },
  js_usb_bus_number__deps: [],

  js_usb_device_address: function (id: number): number {
    return id;
  },
  js_usb_device_address__deps: [],

  js_usb_num_interfaces: function (id: number, configIndex: number): number {
    const config = mtp_usb_registry().devices[id]?.configurations[configIndex];
    return config ? config.interfaces.length : -1;
  },
  js_usb_num_interfaces__deps: ['$mtp_usb_registry', '$libusb_errors'],

  js_usb_config_value: function (id: number, configIndex: number): number {
    const config = mtp_usb_registry().devices[id]?.configurations[configIndex];
    return config ? config.configurationValue : -1;
  },
  js_usb_config_value__deps: ['$mtp_usb_registry', '$libusb_errors'],

  js_usb_active_config_index: function (id: number): number {
    const device = mtp_usb_registry().devices[id];
    const activeConfig = device?.configuration;
    if (!device || !activeConfig) {
      return -1;
    }
    return device.configurations.findIndex((c) => c.configurationValue === activeConfig.configurationValue);
  },
  js_usb_active_config_index__deps: ['$mtp_usb_registry', '$libusb_errors'],

  js_usb_num_altsettings: function (id: number, configIndex: number, ifaceIndex: number): number {
    const iface = mtp_usb_registry().devices[id]?.configurations[configIndex]?.interfaces[ifaceIndex];
    return iface ? iface.alternates.length : -1;
  },
  js_usb_num_altsettings__deps: ['$mtp_usb_registry', '$libusb_errors'],

  // field: 0=bInterfaceNumber 1=bAlternateSetting 2=bInterfaceClass 3=bInterfaceSubClass 4=bInterfaceProtocol
  js_usb_iface_field: function (
    id: number,
    configIndex: number,
    ifaceIndex: number,
    altIndex: number,
    field: number,
  ): number {
    const iface = mtp_usb_registry().devices[id]?.configurations[configIndex]?.interfaces[ifaceIndex];
    const alt = iface?.alternates[altIndex];
    if (!iface || !alt) {
      return -1;
    }
    switch (field) {
      case 0:
        return iface.interfaceNumber;
      case 1:
        return alt.alternateSetting;
      case 2:
        return alt.interfaceClass;
      case 3:
        return alt.interfaceSubclass;
      case 4:
        return alt.interfaceProtocol;
      default:
        return -1;
    }
  },
  js_usb_iface_field__deps: ['$mtp_usb_registry', '$libusb_errors'],

  js_usb_num_endpoints: function (id: number, configIndex: number, ifaceIndex: number, altIndex: number): number {
    const alt =
      mtp_usb_registry().devices[id]?.configurations[configIndex]?.interfaces[ifaceIndex]?.alternates[altIndex];
    return alt ? alt.endpoints.length : -1;
  },
  js_usb_num_endpoints__deps: ['$mtp_usb_registry', '$libusb_errors'],

  // field: 0=bEndpointAddress(with dir bit) 1=bmAttributes(transfer type bits) 2=wMaxPacketSize
  js_usb_ep_field: function (
    id: number,
    configIndex: number,
    ifaceIndex: number,
    altIndex: number,
    epIndex: number,
    field: number,
  ): number {
    const alt =
      mtp_usb_registry().devices[id]?.configurations[configIndex]?.interfaces[ifaceIndex]?.alternates[altIndex];
    const ep = alt?.endpoints[epIndex];
    if (!ep) {
      return -1;
    }
    const typeMap: Record<string, number> = { bulk: 2, interrupt: 3, isochronous: 1 };
    switch (field) {
      case 0:
        return ep.endpointNumber | (ep.direction === 'in' ? 0x80 : 0x00);
      case 1:
        return typeMap[ep.type] ?? 0;
      case 2:
        return ep.packetSize;
      default:
        return -1;
    }
  },
  js_usb_ep_field__deps: ['$mtp_usb_registry', '$libusb_errors'],

  // index 1/2/3 match the fake iManufacturer/iProduct/iSerialNumber ids in webusb_backend.c.
  js_usb_get_string: function (id: number, index: number, out: number, outlen: number): number {
    const device = mtp_usb_registry().devices[id];
    if (!device) {
      return -1;
    }
    const stringsByIndex: Record<number, string | null | undefined> = {
      1: device.manufacturerName,
      2: device.productName,
      3: device.serialNumber,
    };
    const value = stringsByIndex[index];
    if (!value) {
      return -1;
    }
    return mtp_write_utf8(value, out, outlen);
  },
  js_usb_get_string__deps: ['$mtp_usb_registry', '$mtp_write_utf8'],

  js_usb_open: async function (id: number): Promise<number> {
    const device = mtp_usb_registry().devices[id];
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    console.log(`[mtp-webusb] open(): calling device.open() for id=${id}`);
    try {
      await mtp_with_timeout(device.open(), USB_STEP_TIMEOUT_MS);
      console.log(
        '[mtp-webusb] open(): device.open() succeeded, opened =',
        device.opened,
        'activeConfig =',
        device.configuration ? device.configuration.configurationValue : 'none',
      );
    } catch (e) {
      mtp_usb_set_last_error(`device.open() failed: ${(e as Error).name}: ${(e as Error).message}`);
      return libusb_errors.IO;
    }
    if (!device.configuration && device.configurations.length > 0) {
      const wanted = device.configurations[0].configurationValue;
      console.log(`[mtp-webusb] open(): no active configuration, calling selectConfiguration(${wanted})`);
      try {
        await mtp_with_timeout(device.selectConfiguration(wanted), USB_STEP_TIMEOUT_MS);
        console.log('[mtp-webusb] open(): selectConfiguration succeeded');
      } catch (e) {
        // Some devices throw here while already usable; claimInterface below fails loudly if not.
        const configAfterFailure = device.configuration as USBConfiguration | null;
        console.warn(
          `[mtp-webusb] open(): selectConfiguration(${wanted}) failed` +
            ` (${(e as Error).name}: ${(e as Error).message}) - continuing anyway, activeConfig is now`,
          configAfterFailure ? configAfterFailure.configurationValue : 'still none',
        );
      }
    }
    return 0;
  },
  js_usb_open__deps: ['$mtp_usb_registry', '$mtp_usb_set_last_error', '$mtp_with_timeout', '$libusb_errors'],
  js_usb_open__async: true,

  js_usb_close: async function (id: number): Promise<void> {
    const device = mtp_usb_registry().devices[id];
    if (!device) {
      return;
    }
    try {
      await mtp_with_timeout(device.close(), USB_STEP_TIMEOUT_MS);
    } catch (e) {
      console.warn('[mtp-webusb] close() failed', e);
    }
  },
  js_usb_close__deps: ['$mtp_usb_registry', '$mtp_with_timeout', '$libusb_errors'],
  js_usb_close__async: true,

  js_usb_set_configuration: async function (id: number, configValue: number): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    console.log(`[mtp-webusb] set_configuration(${configValue})`);
    try {
      await mtp_with_timeout(device.selectConfiguration(configValue), USB_STEP_TIMEOUT_MS);
      return 0;
    } catch (e) {
      mtp_usb_set_last_error(
        `selectConfiguration(${configValue}) failed: ${(e as Error).name}: ${(e as Error).message}`,
      );
      return libusb_errors.IO;
    }
  },
  js_usb_set_configuration__deps: [
    '$mtp_usb_registry',
    '$mtp_usb_live_device',
    '$mtp_usb_set_last_error',
    '$mtp_with_timeout',
    '$libusb_errors',
  ],
  js_usb_set_configuration__async: true,

  js_usb_claim_interface: async function (id: number, ifaceNumber: number): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    console.log(`[mtp-webusb] claimInterface(${ifaceNumber})`);
    try {
      await mtp_with_timeout(device.claimInterface(ifaceNumber), USB_STEP_TIMEOUT_MS);
      console.log(`[mtp-webusb] claimInterface(${ifaceNumber}) succeeded`);
      return 0;
    } catch (e) {
      if (e instanceof Error && e.message === 'timeout') {
        mtp_usb_set_last_error(`claimInterface(${ifaceNumber}) timed out after ${USB_STEP_TIMEOUT_MS}ms`);
        return libusb_errors.IO;
      }
      mtp_usb_set_last_error(
        `claimInterface(${ifaceNumber}) failed: ${(e as Error).name}: ${(e as Error).message}` +
          ' - another application is holding this device open (Image Capture, Photos, Android File Transfer,' +
          ' another browser tab); on macOS run: sudo pkill PTPCamera',
      );
      return libusb_errors.BUSY;
    }
  },
  js_usb_claim_interface__deps: [
    '$mtp_usb_registry',
    '$mtp_usb_live_device',
    '$mtp_usb_set_last_error',
    '$mtp_with_timeout',
    '$libusb_errors',
  ],
  js_usb_claim_interface__async: true,

  js_usb_release_interface: async function (id: number, ifaceNumber: number): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    try {
      await mtp_with_timeout(device.releaseInterface(ifaceNumber), USB_STEP_TIMEOUT_MS);
      return 0;
    } catch {
      return libusb_errors.IO;
    }
  },
  js_usb_release_interface__deps: ['$mtp_usb_registry', '$mtp_usb_live_device', '$mtp_with_timeout', '$libusb_errors'],
  js_usb_release_interface__async: true,

  // Deliberately not guarded: a reset is what clears a poisoned transport.
  js_usb_reset_device: async function (id: number): Promise<number> {
    const registry = mtp_usb_registry();
    const device = registry.devices[id];
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    try {
      await mtp_with_timeout(device.reset(), USB_RESET_TIMEOUT_MS);
      registry.poisoned.delete(id);
      return 0;
    } catch {
      return libusb_errors.IO;
    }
  },
  js_usb_reset_device__deps: ['$mtp_usb_registry', '$mtp_with_timeout', '$libusb_errors'],
  js_usb_reset_device__async: true,

  js_usb_clear_halt: async function (id: number, endpointAddress: number): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    const epNum = endpointAddress & 0x0f;
    const direction = endpointAddress & 0x80 ? 'in' : 'out';
    try {
      await mtp_with_timeout(device.clearHalt(direction, epNum), USB_STEP_TIMEOUT_MS);
      return 0;
    } catch {
      return libusb_errors.IO;
    }
  },
  js_usb_clear_halt__deps: ['$mtp_usb_registry', '$mtp_usb_live_device', '$mtp_with_timeout', '$libusb_errors'],
  js_usb_clear_halt__async: true,

  // Returns actual_length (>=0) on success, or a negative LIBUSB_ERROR_*.
  js_usb_bulk_transfer: async function (
    id: number,
    endpointAddress: number,
    data: number,
    length: number,
    timeoutMs: number,
  ): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    const waitMs = timeoutMs || USB_BULK_MAX_TIMEOUT_MS;
    const epNum = endpointAddress & 0x0f;
    try {
      if (endpointAddress & 0x80) {
        const result = await mtp_with_timeout(device.transferIn(epNum, length), waitMs);
        if (result.status === 'stall') {
          console.warn(`[mtp-webusb] bulk IN ep=0x${endpointAddress.toString(16)} stalled, clearing halt`);
          await mtp_with_timeout(device.clearHalt('in', epNum), USB_STEP_TIMEOUT_MS);
          return libusb_errors.PIPE;
        }
        const view = new Uint8Array(result.data!.buffer, result.data!.byteOffset, result.data!.byteLength);
        HEAPU8.set(view, data);
        return view.byteLength;
      } else {
        const view = HEAPU8.slice(data, data + length);
        const result = await mtp_with_timeout(device.transferOut(epNum, view), waitMs);
        if (result.status === 'stall') {
          console.warn(`[mtp-webusb] bulk OUT ep=0x${endpointAddress.toString(16)} stalled, clearing halt`);
          await mtp_with_timeout(device.clearHalt('out', epNum), USB_STEP_TIMEOUT_MS);
          return libusb_errors.PIPE;
        }
        return result.bytesWritten ?? 0;
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'timeout') {
        // WebUSB cannot cancel the in-flight transfer, so the stream is out of sync until a reset.
        mtp_usb_registry().poisoned.add(id);
        console.warn(
          `[mtp-webusb] bulk transfer ep=0x${endpointAddress.toString(16)} len=${length} timed out after ${waitMs}ms`,
        );
        return libusb_errors.TIMEOUT;
      }
      mtp_usb_set_last_error(
        `bulk transfer ep=0x${endpointAddress.toString(16)} len=${length} failed: ${(e as Error).name}: ${(e as Error).message}`,
      );
      return libusb_errors.IO;
    }
  },
  js_usb_bulk_transfer__deps: [
    '$mtp_usb_registry',
    '$mtp_usb_live_device',
    '$mtp_usb_set_last_error',
    '$mtp_with_timeout',
    '$libusb_errors',
  ],
  js_usb_bulk_transfer__async: true,

  // Returns actual byte count (>=0) on success, negative LIBUSB_ERROR_* on failure.
  js_usb_control_transfer: async function (
    id: number,
    bmRequestType: number,
    bRequest: number,
    wValue: number,
    wIndex: number,
    data: number,
    wLength: number,
    timeoutMs: number,
  ): Promise<number> {
    const device = mtp_usb_live_device(id);
    if (!device) {
      return libusb_errors.NO_DEVICE;
    }
    const requestTypeMap: Record<number, USBRequestType> = { 0: 'standard', 1: 'class', 2: 'vendor' };
    const recipientMap: Record<number, USBRecipient> = { 0: 'device', 1: 'interface', 2: 'endpoint', 3: 'other' };
    const setup: USBControlTransferParameters = {
      requestType: requestTypeMap[(bmRequestType >> 5) & 0x03] || 'vendor',
      recipient: recipientMap[bmRequestType & 0x1f] || 'device',
      request: bRequest,
      value: wValue,
      index: wIndex,
    };
    const waitMs = timeoutMs || USB_CONTROL_TIMEOUT_MS;
    try {
      if (bmRequestType & 0x80) {
        const result = await mtp_with_timeout(device.controlTransferIn(setup, wLength), waitMs);
        if (result.status === 'stall') {
          console.warn('[mtp-webusb] control transfer IN', setup, 'stalled');
          return libusb_errors.PIPE;
        }
        if (result.status !== 'ok' || !result.data) {
          console.warn('[mtp-webusb] control transfer IN', setup, 'returned status', result.status);
          return libusb_errors.IO;
        }
        const view = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        HEAPU8.set(view, data);
        return view.byteLength;
      } else {
        const view = HEAPU8.slice(data, data + wLength);
        const result = await mtp_with_timeout(device.controlTransferOut(setup, view), waitMs);
        if (result.status === 'stall') {
          console.warn('[mtp-webusb] control transfer OUT', setup, 'stalled');
          return libusb_errors.PIPE;
        }
        if (result.status !== 'ok') {
          console.warn('[mtp-webusb] control transfer OUT', setup, 'returned status', result.status);
          return libusb_errors.IO;
        }
        return result.bytesWritten ?? 0;
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'timeout') {
        console.warn(`[mtp-webusb] control transfer ${JSON.stringify(setup)} timed out after ${waitMs}ms`);
        return libusb_errors.TIMEOUT;
      }
      mtp_usb_set_last_error(
        `control transfer ${JSON.stringify(setup)} failed: ${(e as Error).name}: ${(e as Error).message}`,
      );
      return libusb_errors.IO;
    }
  },
  js_usb_control_transfer__deps: [
    '$mtp_usb_registry',
    '$mtp_usb_live_device',
    '$mtp_usb_set_last_error',
    '$mtp_with_timeout',
    '$libusb_errors',
  ],
  js_usb_control_transfer__async: true,

  // The heap view stays valid across the await: device requests are
  // serialized, so no other wasm call can grow memory mid-pull.
  js_stream_pull: async function (bufferPointer: number, wantLength: number): Promise<number> {
    const puller = Module.mtpStreamPuller;
    if (!puller) {
      return 0;
    }
    return puller(HEAPU8.subarray(bufferPointer, bufferPointer + wantLength));
  },
  js_stream_pull__deps: [],
  js_stream_pull__async: true,

  // The slice copies because the heap buffer is reused once the handler returns.
  js_stream_push: async function (dataPointer: number, length: number): Promise<number> {
    const pusher = Module.mtpStreamPusher;
    if (!pusher) {
      return 1;
    }
    await pusher(HEAPU8.slice(dataPointer, dataPointer + length));
    return 0;
  },
  js_stream_push__deps: [],
  js_stream_push__async: true,
};

mergeInto(LibraryManager.library, lib);
