/** Typings for the emscripten module xmake emits (emcc writes none); only the surface mtp-session.ts uses. */
export interface MtpEmscriptenModule {
  ccall(
    name: string,
    returnType: string | null,
    argTypes: string[],
    args: number[],
    options?: { async?: boolean },
  ): unknown;
  UTF8ToString(pointer: number): string;
  HEAPU8: Uint8Array<ArrayBuffer>;
  HEAP32: Int32Array<ArrayBuffer>;
  _malloc(size: number): number;
  _free(pointer: number): void;
  /** Registered by the session for the duration of mtp_send_file_stream; the js_stream_pull import calls it. */
  mtpStreamPuller?: (target: Uint8Array) => Promise<number>;
  /** Registered by the session for the duration of mtp_read_file_stream; the js_stream_push import calls it. */
  mtpStreamPusher?: (chunk: Uint8Array) => Promise<void>;
  [wasmExport: string]: unknown;
}
