// Browser entry for @kuramajs/excel/writer (its own wasm, so readers don't download it).
import wasmInit from "../pkg/writer/web/writer.js";
import { withHelp } from "./with-help.mjs";

export * from "../pkg/writer/web/writer.js";
export default withHelp(wasmInit, "writer_bg.wasm");
