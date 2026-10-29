// Wrap a wasm-bindgen init() so the most common deploy failure explains itself.
export function withHelp(wasmInit, file) {
  return async function init(options) {
    try {
      return await wasmInit(options);
    } catch (e) {
      if (!(e instanceof WebAssembly.CompileError)) throw e;
      // The bytes fetched for the .wasm aren't wasm. Almost always an SPA fallback or a dev
      // server answering with index.html ("<!DOCTYPE html>" = 3c 21 44 4f).
      throw new Error(
        "@kuramajs/excel: the .wasm file didn't load. The server most likely returned an HTML page " +
          `(often index.html) instead of ${file}. See https://kuramajs.github.io/excel/troubleshooting`,
        { cause: e },
      );
    }
  };
}
