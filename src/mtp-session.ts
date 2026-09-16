/** Pairing stays a page concern: requestDevice() needs a user gesture, so open() only sees paired devices. */
import createMtpModule from 'mtp-loader';
import {
  MtpDeviceNotFoundError,
  MtpOpenError,
  MtpFileReadError,
  MtpWriteError,
  MtpSessionClosedError,
} from './mtp-errors.js';
import type { MtpEmscriptenModule } from './mtp-module.js';

const LIBMTP_DEBUG_NONE = 0;
const LIBMTP_DEBUG_ALL = 0xff;

/** Folder id under which MTP exposes a storage's root-level contents. */
export const MTP_ROOT_FOLDER_ID = 0xffffffff;

/** mtp_detect_raw_devices' encoding of LIBMTP_ERROR_NO_DEVICE_ATTACHED (5). */
const DETECT_NO_MTP_DEVICE_RESULT = -6;

// emcc promising-wraps only main; these exports must be wrapped by hand or
// ccall(..., { async: true }) throws SuspendError on first suspension.
const SUSPENDING_EXPORTS = [
  'mtp_detect_raw_devices',
  'mtp_open_raw_device',
  'mtp_release_device',
  'mtp_friendlyname',
  'mtp_modelname',
  'mtp_get_storage',
  'mtp_get_files_and_folders',
  'mtp_read_file_range',
  'mtp_read_file_stream',
  'mtp_send_file_stream',
  'mtp_create_folder',
  'mtp_delete_object',
];

/** Matches the op libmtp's LIBMTP_GetPartialObject sends. */
const PTP_OC_GET_PARTIAL_OBJECT = 0x101b;
/** Matches the op libmtp's LIBMTP_SendPartialObject sends (Android extension). */
const PTP_OC_ANDROID_SEND_PARTIAL_OBJECT = 0x95c2;

/** Bytes queued toward the consumer before the device read loop suspends. */
const READ_WINDOW_BYTES = 8 * 1024 * 1024;
/** Bytes fetched per GetPartialObject call. */
const RANGE_READ_BYTES = 1024 * 1024;

export interface MtpDeviceSummary {
  friendlyName: string;
  modelName: string;
  /** Device advertises ranged reads (PTP GetPartialObject). */
  supportsRangeReads: boolean;
  /** Device advertises ranged writes (the Android SendPartialObject extension libmtp uses). */
  supportsRangeWrites: boolean;
}

export interface MtpStorageInfo {
  storageId: number;
  name: string;
}

export interface MtpEntryInfo {
  id: number;
  name: string;
  isFolder: boolean;
  /** Size in bytes; 0 for folders. */
  size: number;
  /** Epoch milliseconds; 0 when the device reports no timestamp. */
  modificationTimeMs: number;
}

export interface MtpFileRef {
  id: number;
  name: string;
  /** Total bytes; bounds the ranged pump's loop. */
  size: number;
}

let modulePromise: Promise<MtpEmscriptenModule> | null = null;
/** wasmUrl from the last open; locateFile falls back to this module's URL when null. */
let moduleWasmUrl: string | null = null;

export class MtpSession {
  readonly device: MtpDeviceSummary;
  readonly storages: MtpStorageInfo[];
  private readonly mtp: MtpEmscriptenModule;
  private readonly devicePointer: number;
  private isClosed = false;
  // libmtp is not reentrant: device requests run one at a time.
  private deviceQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    mtp: MtpEmscriptenModule,
    devicePointer: number,
    device: MtpDeviceSummary,
    storages: MtpStorageInfo[],
  ) {
    this.mtp = mtp;
    this.devicePointer = devicePointer;
    this.device = device;
    this.storages = storages;
  }

  /** Loads the wasm module and opens the first paired device. */
  static async open(options: { isVerboseLogging: boolean; wasmUrl: string }): Promise<MtpSession> {
    const mtp = await loadMtpModule(options.wasmUrl);
    mtp.ccall(
      'mtp_set_debug_level',
      null,
      ['number'],
      [options.isVerboseLogging ? LIBMTP_DEBUG_ALL : LIBMTP_DEBUG_NONE],
    );

    console.log('[mtp] detecting raw devices...');
    const rawDeviceCount = await callNumberAsync(mtp, 'mtp_detect_raw_devices', []);
    console.log(`[mtp] mtp_detect_raw_devices: result=${rawDeviceCount}`);
    if (rawDeviceCount === DETECT_NO_MTP_DEVICE_RESULT) {
      // libmtp returns the same code for "nothing paired" and "paired but not MTP".
      const pairedCount = (await navigator.usb.getDevices()).length;
      throw new MtpDeviceNotFoundError(
        pairedCount === 0
          ? 'No paired MTP device found. Pair a device first.'
          : 'A paired USB device was found but none presented an MTP interface. The device may not be in MTP mode.',
      );
    }
    if (rawDeviceCount <= 0) {
      throw new MtpDeviceNotFoundError(`MTP device detection failed (libmtp error ${-(rawDeviceCount + 1)}).`);
    }

    const devicePointer = await callNumberAsync(mtp, 'mtp_open_raw_device', [0]);
    if (!devicePointer) {
      const detail = lastWebUsbError(mtp);
      throw new MtpOpenError(
        detail
          ? `Could not open the MTP device: ${detail}`
          : 'Could not open the MTP device. Check the browser console for details.',
      );
    }
    console.log('[mtp] device opened successfully');

    const friendlyName = takeOwnedString(mtp, await callNumberAsync(mtp, 'mtp_friendlyname', [devicePointer])) ?? '';
    const modelName = takeOwnedString(mtp, await callNumberAsync(mtp, 'mtp_modelname', [devicePointer])) ?? '';

    const supportsRangeReads =
      callNumber(mtp, 'mtp_device_supports_operation', [devicePointer, PTP_OC_GET_PARTIAL_OBJECT]) !== 0;
    const supportsRangeWrites =
      callNumber(mtp, 'mtp_device_supports_operation', [devicePointer, PTP_OC_ANDROID_SEND_PARTIAL_OBJECT]) !== 0;
    console.log(`[mtp] capabilities: rangeReads=${supportsRangeReads} rangeWrites=${supportsRangeWrites}`);

    const storageRc = await callNumberAsync(mtp, 'mtp_get_storage', [devicePointer]);
    console.log(`[mtp] mtp_get_storage: rc=${storageRc}`);

    const storages: MtpStorageInfo[] = [];
    let storagePointer = callNumber(mtp, 'mtp_storage_first', [devicePointer]);
    while (storagePointer) {
      const storageId = callNumber(mtp, 'mtp_storage_id', [storagePointer]) >>> 0;
      const description = readBorrowedString(mtp, callNumber(mtp, 'mtp_storage_description', [storagePointer]));
      console.log(`[mtp] storage id=${storageId} (${description})`);
      storages.push({ storageId, name: description || `Storage ${storageId}` });
      storagePointer = callNumber(mtp, 'mtp_storage_next', [storagePointer]);
    }

    return new MtpSession(
      mtp,
      devicePointer,
      { friendlyName, modelName, supportsRangeReads, supportsRangeWrites },
      storages,
    );
  }

  /** Releases the device; all subsequent operations reject with MtpSessionClosedError. */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await this.serialize(() => callNumberAsync(this.mtp, 'mtp_release_device', [this.devicePointer]));
  }

  listChildren(storageId: number, folderId: number): Promise<MtpEntryInfo[]> {
    this.assertOpen();
    return this.serialize(() => this.scanChildren(storageId, folderId));
  }

  /** Streams the whole object with backpressure; memory stays bounded by READ_WINDOW_BYTES. */
  readFileStream(file: MtpFileRef): Promise<ReadableStream<Uint8Array>> {
    this.assertOpen();
    const window = new ByteLengthQueuingStrategy({ highWaterMark: READ_WINDOW_BYTES });
    const pipe = new TransformStream<Uint8Array, Uint8Array>(undefined, window, window);
    void this.serialize(() => this.pumpFileContents(file, pipe.writable.getWriter()));
    return Promise.resolve(pipe.readable);
  }

  /** Reads one range; empty when it starts at/past end-of-file. */
  readFileRange(file: Pick<MtpFileRef, 'id' | 'name'>, offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    return this.serialize(() => this.fetchFileRange(file, offset, length));
  }

  /** Uploads a stream as a new child object, replacing any same-named file. Returns the new object id. */
  writeFileStream(
    storageId: number,
    folderId: number,
    fileName: string,
    totalBytes: number,
    contents: ReadableStream<Uint8Array>,
  ): Promise<number> {
    this.assertOpen();
    return this.serialize(() => this.performWriteFileStream(storageId, folderId, fileName, totalBytes, contents));
  }

  /** Returns the new folder's object id. */
  createFolder(storageId: number, folderId: number, name: string): Promise<number> {
    this.assertOpen();
    return this.serialize(async () => {
      const namePointer = allocUtf8(this.mtp, name);
      try {
        console.log(`[mtp] mtp_create_folder: "${name}" -> storage ${storageId} folder ${folderId}`);
        const newFolderId =
          (await callNumberAsync(this.mtp, 'mtp_create_folder', [
            this.devicePointer,
            storageId,
            folderId,
            namePointer,
          ])) >>> 0;
        console.log(`[mtp] mtp_create_folder: folder_id=${newFolderId}`);
        if (!newFolderId) {
          throw newWriteError(this.mtp, `Could not create directory "${name}" on the device`);
        }
        return newFolderId;
      } finally {
        this.mtp._free(namePointer);
      }
    });
  }

  /** Deletes one object (file or empty directory). */
  deleteObject(objectId: number, name: string): Promise<void> {
    this.assertOpen();
    return this.serialize(async () => {
      console.log(`[mtp] mtp_delete_object: "${name}" (object ${objectId})`);
      const result = await callNumberAsync(this.mtp, 'mtp_delete_object', [this.devicePointer, objectId]);
      console.log(`[mtp] mtp_delete_object: rc=${result}`);
      if (result !== 0) {
        throw newWriteError(this.mtp, `Could not remove "${name}" from the device`);
      }
    });
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new MtpSessionClosedError('The MTP device session is closed.');
    }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.deviceQueue.then(action);
    this.deviceQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async pumpFileContents(file: MtpFileRef, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
    try {
      if (this.device.supportsRangeReads) {
        let offset = 0;
        while (offset < file.size) {
          const length = Math.min(RANGE_READ_BYTES, file.size - offset);
          const chunk = await this.fetchFileRange(file, offset, length);
          if (chunk.byteLength === 0) {
            throw new MtpFileReadError(
              `Could not read "${file.name}" from the device: it ended at ${offset} of ${file.size} bytes.`,
            );
          }
          await writer.write(chunk);
          offset += chunk.byteLength;
        }
      } else {
        await this.readWholeObjectAsStream(file, writer);
      }
      await writer.close();
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      await writer.abort(reason).catch(() => undefined);
    }
  }

  private async fetchFileRange(
    file: Pick<MtpFileRef, 'id' | 'name'>,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const mtp = this.mtp;
    const pointerSlot = mtp._malloc(4);
    const lengthSlot = mtp._malloc(4);
    try {
      const result = await callNumberAsync(mtp, 'mtp_read_file_range', [
        this.devicePointer,
        file.id,
        offset >>> 0,
        Math.floor(offset / 2 ** 32),
        length,
        pointerSlot,
        lengthSlot,
      ]);
      if (result !== 0) {
        throw new MtpFileReadError(`Could not read "${file.name}" from the device at offset ${offset}.`);
      }
      const bufferPointer = mtp.HEAP32[pointerSlot >> 2] >>> 0;
      const byteLength = mtp.HEAP32[lengthSlot >> 2] >>> 0;
      if (!bufferPointer || byteLength === 0) {
        return new Uint8Array(0);
      }
      const bytes = mtp.HEAPU8.slice(bufferPointer, bufferPointer + byteLength);
      callVoid(mtp, 'mtp_free_file_buffer', [bufferPointer]);
      return bytes;
    } finally {
      mtp._free(pointerSlot);
      mtp._free(lengthSlot);
    }
  }

  private async readWholeObjectAsStream(
    file: Pick<MtpFileRef, 'id' | 'name'>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ): Promise<void> {
    this.mtp.mtpStreamPusher = async (chunk: Uint8Array): Promise<void> => {
      await writer.write(chunk);
    };
    try {
      const result = await callNumberAsync(this.mtp, 'mtp_read_file_stream', [this.devicePointer, file.id]);
      if (result !== 0) {
        throw new MtpFileReadError(`Could not read "${file.name}" from the device.`);
      }
    } finally {
      this.mtp.mtpStreamPusher = undefined;
    }
  }

  private async performWriteFileStream(
    storageId: number,
    folderId: number,
    fileName: string,
    totalBytes: number,
    contents: ReadableStream<Uint8Array>,
  ): Promise<number> {
    const mtp = this.mtp;
    await this.removeExistingChildWithName(storageId, folderId, fileName);
    const reader = contents.getReader();
    let pendingChunk: Uint8Array | null = null;
    let streamErrorMessage: string | null = null;
    mtp.mtpStreamPuller = async (target: Uint8Array): Promise<number> => {
      try {
        let filled = 0;
        while (filled < target.byteLength) {
          if (!pendingChunk) {
            const { done, value } = await reader.read();
            if (done || !value) {
              break;
            }
            pendingChunk = value;
          }
          const count = Math.min(pendingChunk.byteLength, target.byteLength - filled);
          target.set(pendingChunk.subarray(0, count), filled);
          filled += count;
          pendingChunk = count === pendingChunk.byteLength ? null : pendingChunk.subarray(count);
        }
        return filled;
      } catch (error) {
        streamErrorMessage = error instanceof Error ? error.message : String(error);
        return 0;
      }
    };
    const namePointer = allocUtf8(mtp, fileName);
    try {
      console.log(
        `[mtp] mtp_send_file_stream: "${fileName}" ${totalBytes} bytes -> storage ${storageId} folder ${folderId}`,
      );
      const itemId =
        (await callNumberAsync(mtp, 'mtp_send_file_stream', [
          this.devicePointer,
          storageId,
          folderId,
          namePointer,
          totalBytes >>> 0,
          Math.floor(totalBytes / 2 ** 32),
        ])) >>> 0;
      console.log(`[mtp] mtp_send_file_stream: item_id=${itemId}`);
      if (!itemId) {
        if (streamErrorMessage) {
          throw new MtpWriteError(
            `Could not write "${fileName}" to the device: the source stream failed (${streamErrorMessage}).`,
          );
        }
        throw newWriteError(mtp, `Could not write "${fileName}" to the device`);
      }
      return itemId;
    } finally {
      mtp.mtpStreamPuller = undefined;
      mtp._free(namePointer);
      await reader.cancel().catch(() => undefined);
    }
  }

  /** Makes writes replace: a same-named file is deleted first so re-uploads don't duplicate. */
  private async removeExistingChildWithName(storageId: number, folderId: number, fileName: string): Promise<void> {
    for (const child of await this.scanChildren(storageId, folderId)) {
      if (child.name !== fileName) {
        continue;
      }
      if (child.isFolder) {
        throw new MtpWriteError(`A folder named "${fileName}" already exists on the device.`);
      }
      console.log(`[mtp] replacing object ${child.id} ("${fileName}")`);
      const result = await callNumberAsync(this.mtp, 'mtp_delete_object', [this.devicePointer, child.id]);
      if (result !== 0) {
        throw newWriteError(this.mtp, `Could not replace "${fileName}" on the device`);
      }
    }
  }

  private async scanChildren(storageId: number, folderId: number): Promise<MtpEntryInfo[]> {
    const mtp = this.mtp;
    let filePointer = await callNumberAsync(mtp, 'mtp_get_files_and_folders', [
      this.devicePointer,
      storageId,
      folderId,
    ]);
    const children: MtpEntryInfo[] = [];
    while (filePointer) {
      const name = readBorrowedString(mtp, callNumber(mtp, 'mtp_file_name', [filePointer]));
      const isFolder = callNumber(mtp, 'mtp_file_is_folder', [filePointer]) !== 0;
      const sizeLo = callNumber(mtp, 'mtp_file_size_lo', [filePointer]) >>> 0;
      const sizeHi = callNumber(mtp, 'mtp_file_size_hi', [filePointer]) >>> 0;
      const modificationTimeMs = callNumber(mtp, 'mtp_file_modification_time', [filePointer]) * 1000;
      const id = callNumber(mtp, 'mtp_file_item_id', [filePointer]) >>> 0;
      children.push({ id, name, isFolder, size: sizeHi * 2 ** 32 + sizeLo, modificationTimeMs });
      const nextPointer = callNumber(mtp, 'mtp_file_next', [filePointer]);
      callVoid(mtp, 'mtp_file_destroy', [filePointer]);
      filePointer = nextPointer;
    }
    return children;
  }
}

/** Loads (and caches) the wasm module without opening a device; MtpSession.open and mtpDeviceFilters() share it. */
export async function loadMtpModule(wasmUrl?: string): Promise<MtpEmscriptenModule> {
  if (wasmUrl !== undefined) {
    moduleWasmUrl = wasmUrl;
  }
  return loadModule();
}

async function loadModule(): Promise<MtpEmscriptenModule> {
  if (!modulePromise) {
    modulePromise = importMtpModule();
  }
  return modulePromise;
}

async function importMtpModule(): Promise<MtpEmscriptenModule> {
  // Without a passed wasmUrl the loader looks for mtp.wasm next to this bundle.
  const mtp = await createMtpModule({
    locateFile: (path) => (moduleWasmUrl !== null && path.endsWith('.wasm') ? moduleWasmUrl : path),
  });
  for (const exportName of SUSPENDING_EXPORTS) {
    const wasmExport = mtp['_' + exportName] as (...args: unknown[]) => unknown;
    mtp['_' + exportName] = WebAssembly.promising(wasmExport);
  }
  return mtp;
}

function callNumber(mtp: MtpEmscriptenModule, exportName: string, args: number[]): number {
  return mtp.ccall(
    exportName,
    'number',
    args.map(() => 'number'),
    args,
  ) as number;
}

function callNumberAsync(mtp: MtpEmscriptenModule, exportName: string, args: number[]): Promise<number> {
  return mtp.ccall(
    exportName,
    'number',
    args.map(() => 'number'),
    args,
    { async: true },
  ) as Promise<number>;
}

function callVoid(mtp: MtpEmscriptenModule, exportName: string, args: number[]): void {
  mtp.ccall(
    exportName,
    null,
    args.map(() => 'number'),
    args,
  );
}

/** Returns the pointer's string, or "" for a NULL pointer. */
function readBorrowedString(mtp: MtpEmscriptenModule, pointer: number): string {
  return pointer ? mtp.UTF8ToString(pointer) : '';
}

/** Consumes a malloc'd string returned by libmtp. */
function takeOwnedString(mtp: MtpEmscriptenModule, pointer: number): string | null {
  if (!pointer) {
    return null;
  }
  const value = mtp.UTF8ToString(pointer);
  callVoid(mtp, 'mtp_free_string', [pointer]);
  return value;
}

/** Writes a NUL-terminated UTF-8 string into the wasm heap; the caller frees it with _free. */
function allocUtf8(mtp: MtpEmscriptenModule, text: string): number {
  const encoded = new TextEncoder().encode(text);
  const pointer = mtp._malloc(encoded.byteLength + 1);
  mtp.HEAPU8.set(encoded, pointer);
  mtp.HEAPU8[pointer + encoded.byteLength] = 0;
  return pointer;
}

function newWriteError(mtp: MtpEmscriptenModule, message: string): MtpWriteError {
  const detail = lastWebUsbError(mtp);
  return new MtpWriteError(detail ? `${message}: ${detail}` : `${message}.`);
}

/** Returns the message of the last WebUSB failure, or "" if none was recorded. */
function lastWebUsbError(mtp: MtpEmscriptenModule): string {
  return readBorrowedString(mtp, callNumber(mtp, 'webusb_get_last_error', []));
}
