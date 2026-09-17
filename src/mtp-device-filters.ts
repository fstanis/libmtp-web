/**
 * requestDevice filter recipes. The MTP/PTP still-image interface covers
 * standards-compliant devices; the vendor ids are read live from libmtp's
 * compiled-in device table because some vendors - Garmin among them - ship
 * MTP with a vendor-specific interface class no classCode filter can match.
 */
import { loadMtpModule } from './mtp-session.js';

/** The MTP/PTP still-image interface triple. */
export const MTP_INTERFACE_FILTER: USBDeviceFilter = { classCode: 0x06, subclassCode: 0x01, protocolCode: 0x01 };

export interface MtpDeviceFiltersOptions {
  /** URL of dist/mtp.wasm; relative strings resolve against the page URL. Defaults to the module-relative copy bundlers emit. */
  wasmUrl?: string | URL;
}

/**
 * Filters covering every device libmtp can open; pass to
 * navigator.usb.requestDevice. Loads the wasm module (cached for the later
 * open), so compute these before the user gesture that opens the picker.
 */
export async function mtpDeviceFilters(options: MtpDeviceFiltersOptions = {}): Promise<USBDeviceFilter[]> {
  const module = await loadMtpModule(options.wasmUrl);
  let capacity = 256;
  for (;;) {
    const out = module._malloc(capacity * 2);
    try {
      const count = module.ccall('mtp_supported_vendor_ids', 'number', ['number', 'number'], [out, capacity]) as number;
      if (count >= 0) {
        const vendorIds = Array.from(new Uint16Array(module.HEAPU8.buffer, out, count), (vendorId) => ({ vendorId }));
        return [MTP_INTERFACE_FILTER, ...vendorIds];
      }
    } finally {
      module._free(out);
    }
    capacity *= 2;
  }
}
