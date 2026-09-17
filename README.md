# libmtp-web

libmtp compiled to WebAssembly, speaking MTP to paired USB devices over WebUSB. The interface follows the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API): `FileSystemDirectoryHandle`, `FileSystemFileHandle`, async iteration, standard `File` objects.

## Compatibility

Requires [WASM JavaScript promise integration](https://caniuse.com/wf-wasm-jspi) and [WebUSB](https://caniuse.com/webusb).

## Usage

```ts
import { mtpDeviceFilters, requestMtpFileSystem } from 'libmtp-web';

// The MTP/PTP interface class plus every vendor id in libmtp's device table
const filters = await mtpDeviceFilters();

await navigator.usb.requestDevice({ filters });
const fileSystem = await requestMtpFileSystem();
```

Zero-config where the bundler follows `new URL(..., import.meta.url)` asset references (Webpack, Vite). Bun: import the wasm instead:

```ts
import wasmUrl from 'libmtp-web/dist/mtp.wasm' with { type: 'file' };
const filters = await mtpDeviceFilters({ wasmUrl });
const fileSystem = await requestMtpFileSystem({ wasmUrl });
```

Relative `wasmUrl` strings resolve against the page URL, so the value a bundler emits for the import above works as-is.

Anything else (esbuild, no bundler): host `dist/mtp.wasm` same-origin and pass `{ wasmUrl }` to `mtpDeviceFilters()` and `requestMtpFileSystem()`.

```ts
// Storage roots sit directly under /.
for await (const [, handle] of fileSystem.root.entries()) {
  console.log(handle.fullPath, handle.kind);
}

const storage = await fileSystem.root.getDirectoryHandle('Internal Storage');
const dcim = await storage.getDirectoryHandle('DCIM');
const fileHandle = await dcim.getFileHandle('IMG_0001.jpg');
const file = await fileHandle.getFile();

// Random access where the device supports it (fileSystem.device.supportsRangeReads).
const head = await fileHandle.readRange(0, 64);

const videoHandle = await storage.getFileHandle('video.mp4', { create: true });
const writable = await videoHandle.createWritable({ size: videoFile.size });
await videoFile.stream().pipeTo(writable);

await storage.removeEntry('video.mp4');
await fileSystem.close();
```

## Ranged reads

Where the device supports it (`device.supportsRangeReads`), `readRange(offset, length)` fetches any slice without streaming the rest — one small read is enough for tags, and a trailing index (an MP4 `moov` atom) can be sought from `handle.size`. Offsets address the first 4 GiB; `handle.lastModified` is also exposed.

## Error handling

Failures throw typed errors. `MtpObjectNotFoundError` (object deleted on-device) and `MtpDeviceDisconnectedError` (device unplugged) are permanent — don't retry them; `MtpFileReadError` and `MtpWriteError` may be transient and carry the PTP response `code` when the device reported one. Recover a wedged session without replugging:

```ts
await fileSystem.abort();
fileSystem = await requestMtpFileSystem();
```

## Building from source

Requires [xmake](https://xmake.io) with emsdk's `emcc`/`emar` on PATH.

```bash
npm install
npm run build
```
