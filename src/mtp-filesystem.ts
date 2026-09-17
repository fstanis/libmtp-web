/**
 * File System Access API-shaped facade over an MtpSession. MTP deviations:
 * { create: true } files appear on the device at writable close,
 * createWritable({ size }) streams while an omitted size buffers, and
 * seek/truncate/positional writes reject (MTP sizes objects before the first
 * byte flows).
 */
import {
  MTP_ROOT_FOLDER_ID,
  MtpSession,
  type MtpDeviceSummary,
  type MtpEntryInfo,
  type MtpStorageInfo,
} from './mtp-session.js';

export interface RequestMtpFileSystemOptions {
  /** URL of dist/mtp.wasm; relative strings resolve against the page URL. Defaults to the module-relative copy bundlers emit. */
  wasmUrl?: string | URL;
  /** Defaults to false; enables libmtp and WebUSB trace logging in the console. */
  isVerboseLogging?: boolean;
  /** Overall deadline for loading the module, detecting, and opening the device; defaults to 30000. */
  openTimeoutMs?: number;
}

/** Opens the first paired device; the returned file system holds it open until close(). */
export async function requestMtpFileSystem(options: RequestMtpFileSystemOptions = {}): Promise<MtpFileSystem> {
  const session = await MtpSession.open({
    isVerboseLogging: options.isVerboseLogging ?? false,
    wasmUrl: options.wasmUrl,
    openTimeoutMs: options.openTimeoutMs,
  });
  return new MtpFileSystem(session);
}

export class MtpFileSystem {
  readonly name: string;
  readonly device: MtpDeviceSummary;
  readonly root: MtpDirectoryHandle;
  readonly session: MtpSession;

  constructor(session: MtpSession) {
    this.session = session;
    this.name = session.device.friendlyName || session.device.modelName || 'MTP device';
    this.device = session.device;
    this.root = new MtpDirectoryHandle(this, null, 0, '', '/');
  }

  /** Releases the device; all handles become unusable. */
  async close(): Promise<void> {
    await this.session.close();
  }

  /** Hard-releases a wedged device so a fresh requestMtpFileSystem() recovers without replugging. */
  async abort(): Promise<void> {
    await this.session.abort();
  }
}

export type MtpHandle = MtpFileHandle | MtpDirectoryHandle;

abstract class MtpHandleBase implements FileSystemHandle {
  abstract readonly kind: 'file' | 'directory';
  readonly name: string;
  readonly fullPath: string;
  protected readonly filesystem: MtpFileSystem;

  protected constructor(filesystem: MtpFileSystem, name: string, fullPath: string) {
    this.filesystem = filesystem;
    this.name = name;
    this.fullPath = fullPath;
  }

  // WebUSB permission is granted at pairing time.
  queryPermission(): Promise<PermissionState> {
    return Promise.resolve('granted');
  }

  requestPermission(): Promise<PermissionState> {
    return Promise.resolve('granted');
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return isMtpHandle(other) && other.fullPath === this.fullPath;
  }
}

export class MtpDirectoryHandle extends MtpHandleBase implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  /** Null on the device root, whose children are the storages. */
  private readonly storageId: number | null;
  /** MTP folder id; MTP_ROOT_FOLDER_ID on a storage's root. */
  private readonly folderId: number;

  constructor(filesystem: MtpFileSystem, storageId: number | null, folderId: number, name: string, fullPath: string) {
    super(filesystem, name, fullPath);
    this.storageId = storageId;
    this.folderId = folderId;
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<MtpFileHandle> {
    assertPlainName(name);
    const child = await this.findChild(name);
    if (child) {
      if (child.isFolder) {
        throw entryKindMismatchError(name, 'file');
      }
      return this.childFileHandle(child);
    }
    if (!options?.create) {
      throw notFoundError(name);
    }
    this.assertWritableDirectory('creating files');
    return new MtpFileHandle(this.filesystem, this, null, name, joinPath(this.fullPath, name), Date.now(), 0);
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<MtpDirectoryHandle> {
    assertPlainName(name);
    const child = await this.findChild(name);
    if (child) {
      if (!child.isFolder) {
        throw entryKindMismatchError(name, 'directory');
      }
      return this.childDirectoryHandle(child);
    }
    if (!options?.create) {
      throw notFoundError(name);
    }
    this.assertWritableDirectory('creating directories');
    const folderId = await this.filesystem.session.createFolder(this.storageId!, this.folderId, name);
    return new MtpDirectoryHandle(this.filesystem, this.storageId!, folderId, name, joinPath(this.fullPath, name));
  }

  /** Fails with MtpWriteError when a non-empty directory is removed without { recursive: true }. */
  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    assertPlainName(name);
    const child = await this.findChild(name);
    if (!child) {
      throw notFoundError(name);
    }
    if (this.storageId === null) {
      throw new DOMException(`Storage "${name}" is a device storage root and cannot be removed.`, 'NotSupportedError');
    }
    if (child.isFolder && options?.recursive) {
      await this.removeRecursively(child);
    }
    await this.filesystem.session.deleteObject(child.id, child.name);
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (!isMtpHandle(possibleDescendant) || possibleDescendant.fullPath === this.fullPath) {
      return null;
    }
    const prefix = this.fullPath === '/' ? '/' : `${this.fullPath}/`;
    if (!possibleDescendant.fullPath.startsWith(prefix)) {
      return null;
    }
    return possibleDescendant.fullPath.slice(prefix.length).split('/');
  }

  entries(): AsyncIterableIterator<[string, MtpHandle]> {
    return this.projectChildren((handle) => [handle.name, handle] as [string, MtpHandle]);
  }

  keys(): AsyncIterableIterator<string> {
    return this.projectChildren((handle) => handle.name);
  }

  values(): AsyncIterableIterator<MtpHandle> {
    return this.projectChildren((handle) => handle);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<[string, MtpHandle]> {
    return this.entries();
  }

  /** Uploads contents as this directory's child file, replacing any same-named file. */
  async writeChildFileStream(
    name: string,
    totalBytes: number,
    contents: ReadableStream<Uint8Array>,
  ): Promise<{ id: number; size: number }> {
    this.assertWritableDirectory('writing files');
    const id = await this.filesystem.session.writeFileStream(
      this.storageId!,
      this.folderId,
      name,
      totalBytes,
      contents,
    );
    return { id, size: totalBytes };
  }

  private async *projectChildren<V>(project: (handle: MtpHandle) => V): AsyncIterableIterator<V> {
    for (const child of await this.listChildren()) {
      yield project(this.childHandle(child));
    }
  }

  private listChildren(): Promise<MtpEntryInfo[]> {
    if (this.storageId === null) {
      const storages = this.filesystem.session.storages;
      return Promise.resolve(storages.map(storageEntry));
    }
    return this.filesystem.session.listChildren(this.storageId, this.folderId);
  }

  private async findChild(name: string): Promise<MtpEntryInfo | undefined> {
    for (const child of await this.listChildren()) {
      if (child.name === name) {
        return child;
      }
    }
    return undefined;
  }

  private childHandle(child: MtpEntryInfo): MtpHandle {
    return child.isFolder ? this.childDirectoryHandle(child) : this.childFileHandle(child);
  }

  private childFileHandle(child: MtpEntryInfo): MtpFileHandle {
    return new MtpFileHandle(
      this.filesystem,
      this,
      child.id,
      child.name,
      joinPath(this.fullPath, child.name),
      child.modificationTimeMs,
      child.size,
    );
  }

  private childDirectoryHandle(child: MtpEntryInfo): MtpDirectoryHandle {
    if (this.storageId === null) {
      return new MtpDirectoryHandle(
        this.filesystem,
        child.id,
        MTP_ROOT_FOLDER_ID,
        child.name,
        joinPath(this.fullPath, child.name),
      );
    }
    return new MtpDirectoryHandle(
      this.filesystem,
      this.storageId,
      child.id,
      child.name,
      joinPath(this.fullPath, child.name),
    );
  }

  /** The device root only lists storages; real entries live inside them. */
  private assertWritableDirectory(operationName: string): void {
    if (this.storageId === null) {
      throw notSupportedError(`${operationName} on the device root`);
    }
  }

  private async removeRecursively(child: MtpEntryInfo): Promise<void> {
    const childDirectory = new MtpDirectoryHandle(
      this.filesystem,
      this.storageId,
      child.id,
      child.name,
      joinPath(this.fullPath, child.name),
    );
    for (const grandchild of await childDirectory.listChildren()) {
      if (grandchild.isFolder) {
        await childDirectory.removeRecursively(grandchild);
      }
      await this.filesystem.session.deleteObject(grandchild.id, grandchild.name);
    }
  }
}

function storageEntry(storage: MtpStorageInfo): MtpEntryInfo {
  return { id: storage.storageId, name: storage.name, isFolder: true, size: 0, modificationTimeMs: 0 };
}

export class MtpFileHandle extends MtpHandleBase implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  private readonly parentDirectory: MtpDirectoryHandle;
  /** Null until the first writable stream closes, for handles created with { create: true }. */
  private fileId: number | null;
  private readonly lastModifiedMs: number;
  /** Bytes as last listed; the session's ranged pump delivers exactly this count. */
  private sizeBytes: number;

  constructor(
    filesystem: MtpFileSystem,
    parentDirectory: MtpDirectoryHandle,
    fileId: number | null,
    name: string,
    fullPath: string,
    lastModifiedMs: number,
    sizeBytes: number,
  ) {
    super(filesystem, name, fullPath);
    this.parentDirectory = parentDirectory;
    this.fileId = fileId;
    this.lastModifiedMs = lastModifiedMs;
    this.sizeBytes = sizeBytes;
  }

  /** Bytes as of the listing that produced this handle; moves to the uploaded count after a writable close. */
  get size(): number {
    return this.sizeBytes;
  }

  /** Epoch milliseconds as of the listing that produced this handle. */
  get lastModified(): number {
    return this.lastModifiedMs;
  }

  /** Rejects with NotFoundError for handles created with { create: true } until the first writable stream closes. */
  async getFile(): Promise<File> {
    // JS cannot construct a lazily-backed Blob, so the object materializes
    // once; the File constructor shares a Blob part's bytes without copying.
    const contents = await this.createReadable();
    return new File([await new Response(contents).blob()], this.name, { lastModified: this.lastModifiedMs });
  }

  /**
   * Streams the object chunk-by-chunk with backpressure; memory stays bounded
   * regardless of size.
   */
  async createReadable(): Promise<ReadableStream<Uint8Array>> {
    if (this.fileId === null) {
      throw notFoundError(this.name);
    }
    return this.filesystem.session.readFileStream(this.fileRef());
  }

  /**
   * Reads an arbitrary byte range; repeatable and order-independent. Rejects
   * NotSupportedError unless device.supportsRangeReads. Ranges starting at or
   * past end-of-file return empty; offsets address the first 4 GiB (the PTP
   * op libmtp sends is 32-bit). The response materializes in full, so length
   * is the caller's memory budget.
   */
  async readRange(offset: number, length: number): Promise<Uint8Array> {
    if (this.fileId === null) {
      throw notFoundError(this.name);
    }
    if (!this.filesystem.device.supportsRangeReads) {
      throw notSupportedError('readRange', 'the device does not support ranged reads');
    }
    if (offset < 0 || length < 0) {
      throw new TypeError('offset and length must be non-negative.');
    }
    if (offset > 0xffffffff) {
      throw new RangeError('Ranged reads address the first 4 GiB of a file.');
    }
    if (length === 0) {
      return new Uint8Array(0);
    }
    return this.filesystem.session.readFileRange({ id: this.fileId, name: this.name }, offset, length);
  }

  /**
   * Uploads written bytes as this file on close(), replacing any same-named
   * object. { size } starts a streaming upload with backpressure; without it
   * content buffers until close(). { keepExistingData: true } prefixes the
   * current content, streamed from the device rather than buffered.
   */
  async createWritable(
    options?: FileSystemCreateWritableOptions & { size?: number },
  ): Promise<FileSystemWritableFileStream> {
    let seed: MtpWritableSeed | undefined;
    if (options?.keepExistingData) {
      if (this.fileId === null) {
        throw notFoundError(this.name);
      }
      seed = { stream: await this.createReadable(), size: this.sizeBytes };
    }
    return new MtpWritableFileStream({
      seed,
      totalSize: options?.size,
      target: { uploadStreamed: (contents, totalBytes) => this.uploadStreamed(contents, totalBytes) },
    });
  }

  createSyncAccessHandle(_options?: FileSystemCreateWritableOptions): Promise<never> {
    return Promise.reject(notSupportedError('createSyncAccessHandle'));
  }

  private fileRef() {
    return { id: this.fileId!, name: this.name, size: this.sizeBytes };
  }

  private async uploadStreamed(contents: ReadableStream<Uint8Array>, totalBytes: number): Promise<void> {
    const uploaded = await this.parentDirectory.writeChildFileStream(this.name, totalBytes, contents);
    this.fileId = uploaded.id;
    this.sizeBytes = uploaded.size;
  }
}

export interface MtpUploadTarget {
  uploadStreamed(contents: ReadableStream<Uint8Array>, totalBytes: number): Promise<void>;
}

/** Prefix for keepExistingData uploads; the existing object streams in rather than buffering. */
export interface MtpWritableSeed {
  stream: ReadableStream<Uint8Array>;
  /** Declared byte count: SendObjectInfo needs the total before the first byte flows. */
  size: number;
}

/** Bytes of written data that may sit queued toward the device before write() blocks; only enforced with a declared totalSize. */
const STREAM_WINDOW_BYTES = 16 * 1024 * 1024;
/** Largest slice one write() snapshots and enqueues at a time, so oversized buffers respect the window. */
const WRITE_PART_BYTES = 4 * 1024 * 1024;

/**
 * A real WritableStream piping write() chunks to the device as one object.
 * A declared totalSize caps queued bytes at STREAM_WINDOW_BYTES and uploads
 * concurrently; without one the bytes queue in memory and upload at close().
 */
export class MtpWritableFileStream
  extends WritableStream<FileSystemWriteChunkType>
  implements FileSystemWritableFileStream
{
  private readonly target: MtpUploadTarget;
  private readonly pipe: TransformStream<Uint8Array, Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Non-null when the upload runs concurrently with writes. */
  private readonly streamingUpload: Promise<void> | null;
  /** Pumps the seed ahead of user writes; failures surface on the next write()/close(). */
  private readonly seedPump: Promise<void> | null;
  private seedReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private queuedBytes = 0;
  private isSettled = false;
  private isAborted = false;

  constructor(options: { seed?: MtpWritableSeed; totalSize?: number; target: MtpUploadTarget }) {
    super({
      write: (chunk) => this.write(chunk),
      close: () => this.finish(),
      abort: () => this.discard(),
    });
    this.target = options.target;
    // The identity transform's backpressure is driven by the readable queue, so both sides carry the window.
    const windowBytes = options.totalSize === undefined ? Number.POSITIVE_INFINITY : STREAM_WINDOW_BYTES;
    const strategy = new ByteLengthQueuingStrategy({ highWaterMark: windowBytes });
    this.pipe = new TransformStream<Uint8Array, Uint8Array>(undefined, strategy, strategy);
    this.writer = this.pipe.writable.getWriter();
    this.streamingUpload =
      options.totalSize === undefined
        ? null
        : this.captureUpload(
            this.target.uploadStreamed(this.pipe.readable, (options.seed?.size ?? 0) + options.totalSize),
          );
    const seedPump = options.seed === undefined ? null : this.pumpSeed(options.seed.stream);
    // A seed failure must wait for write()/close() to rethrow it, not fire unhandledrejection.
    seedPump?.catch(() => undefined);
    this.seedPump = seedPump;
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    this.assertWritable();
    if (isWriteParams(data)) {
      if (data.type === 'write' && (data.position === undefined || data.position === null)) {
        if (data.data !== undefined && data.data !== null) {
          await this.writeSnapshot(data.data);
        }
        return;
      }
      const operationName = data.type === 'write' ? 'positional writes' : data.type;
      throw notSupportedError(operationName, 'MTP uploads whole objects');
    }
    await this.writeSnapshot(data);
  }

  seek(_position: number): Promise<void> {
    return Promise.reject(notSupportedError('seek', 'MTP uploads whole objects'));
  }

  truncate(_size: number): Promise<void> {
    return Promise.reject(notSupportedError('truncate', 'MTP uploads whole objects'));
  }

  async close(): Promise<void> {
    if (this.locked) {
      throw new DOMException('The writable stream is locked.', 'InvalidStateError');
    }
    this.assertWritable();
    await this.getWriter().close();
  }

  /** User writes wait for the seed so its chunks enqueue first. */
  private async writeSnapshot(data: BufferSource | Blob | string): Promise<void> {
    await this.seedPump;
    for await (const part of snapshotParts(data)) {
      await this.writePart(part);
    }
  }

  private async pumpSeed(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    this.seedReader = reader;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        await this.writePart(value);
      }
    } finally {
      this.seedReader = null;
    }
  }

  private async writePart(part: Uint8Array): Promise<void> {
    this.queuedBytes += part.byteLength;
    await this.writer.write(part);
  }

  private async finish(): Promise<void> {
    if (this.isSettled) {
      return;
    }
    this.isSettled = true;
    await this.seedPump;
    await this.writer.close();
    if (this.streamingUpload) {
      await this.streamingUpload;
      return;
    }
    await this.target.uploadStreamed(this.pipe.readable, this.queuedBytes);
  }

  private async discard(): Promise<void> {
    this.isSettled = true;
    this.isAborted = true;
    await this.seedReader?.cancel().catch(() => undefined);
    await this.writer.abort().catch(() => undefined);
    if (this.streamingUpload) {
      await this.streamingUpload.catch(() => undefined);
    }
  }

  private assertWritable(): void {
    if (this.isSettled) {
      const state = this.isAborted ? 'was aborted' : 'has already been closed';
      throw new DOMException(`The writable stream ${state}.`, 'InvalidStateError');
    }
  }

  /** Keeps a concurrent-upload rejection unobserved until finish() rethrows it or the pipe surfaces it. */
  private captureUpload(upload: Promise<void>): Promise<void> {
    upload.catch(() => undefined);
    return upload;
  }
}

function isMtpHandle(handle: FileSystemHandle): handle is MtpHandle {
  return handle instanceof MtpFileHandle || handle instanceof MtpDirectoryHandle;
}

function isWriteParams(data: FileSystemWriteChunkType): data is WriteParams {
  return (
    typeof data === 'object' && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)
  );
}

/** Snapshots one write() payload as parts of at most WRITE_PART_BYTES: write()
 * resolves on enqueue, so caller-owned buffers cannot pass through uncopied. */
async function* snapshotParts(data: BufferSource | Blob | string): AsyncGenerator<Uint8Array> {
  if (typeof data === 'string') {
    yield new TextEncoder().encode(data);
    return;
  }
  if (data instanceof Blob) {
    for (let offset = 0; offset < data.size; offset += WRITE_PART_BYTES) {
      yield new Uint8Array(await data.slice(offset, Math.min(offset + WRITE_PART_BYTES, data.size)).arrayBuffer());
    }
    return;
  }
  const bytes =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += WRITE_PART_BYTES) {
    yield bytes.slice(offset, Math.min(offset + WRITE_PART_BYTES, bytes.byteLength));
  }
}

function joinPath(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
}

function assertPlainName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new TypeError(`"${name}" is not a valid entry name.`);
  }
}

function notFoundError(name: string): DOMException {
  return new DOMException(`No entry named "${name}".`, 'NotFoundError');
}

function entryKindMismatchError(name: string, wantedKind: string): DOMException {
  return new DOMException(`Entry "${name}" is not a ${wantedKind}.`, 'TypeMismatchError');
}

function notSupportedError(operationName: string, hint?: string): DOMException {
  const detail = hint ? `; ${hint}` : '';
  return new DOMException(`${operationName} is not supported on the MTP file system${detail}.`, 'NotSupportedError');
}
