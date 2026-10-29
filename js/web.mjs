// Browser entry: the wasm-bindgen build, with an init() that explains the most common deploy failure.
import wasmInit from "../pkg/web/web_index.js";
import { withHelp } from "./with-help.mjs";

export * from "../pkg/web/web_index.js";
export default withHelp(wasmInit, "web_index_bg.wasm");
