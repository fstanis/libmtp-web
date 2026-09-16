/** Build-time alias (package.json build:js) for the wasm link step's output, bundled into dist/index.js. */
declare module 'mtp-loader' {
  import type { MtpEmscriptenModule } from './mtp-module';
  export default function createMtpModule(options?: {
    locateFile?: (path: string) => string;
  }): Promise<MtpEmscriptenModule>;
}
