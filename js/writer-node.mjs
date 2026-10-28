// Node ESM entry for @kuramajs/excel/writer: same API as the web build; the wasm loads on import.
import pkg from "../pkg/writer/nodejs/writer.js";

export const { XlsxWriter, SheetWriter, writeXlsx, toCsv } = pkg;
export function initSync() {}
export default async function init() {}
