/** WebAssembly JSPI surface, not yet present in TypeScript's libraries. */
declare namespace WebAssembly {
  function promising<Args extends unknown[], TResult>(
    wasmExport: (...args: Args) => TResult,
  ): (...args: Args) => Promise<TResult>;
}
