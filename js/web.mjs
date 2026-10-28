// Browser entry: the wasm-bindgen build, with an init() that explains the most common deploy failure.
import wasmInit from "../pkg/web/web_index.js";

export * from "../pkg/web/web_index.js";

export default async function init(options) {
  try {
    return await wasmInit(options);
  } catch (e) {
    if (!(e instanceof WebAssembly.CompileError)) throw e;
    // The bytes fetched for web_index_bg.wasm aren't wasm. Almost always an SPA fallback or a dev
    // server answering with index.html ("<!DOCTYPE html>" = 3c 21 44 4f).
    throw new Error(
      "@kuramajs/excel: the .wasm file didn't load. The server most likely returned an HTML page " +
        "(often index.html) instead of web_index_bg.wasm. See https://kuramajs.github.io/excel/troubleshooting",
      { cause: e },
    );
  }
}
