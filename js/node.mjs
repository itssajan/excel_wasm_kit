// Node ESM entry: same API as the web build. The Node build loads its wasm
// synchronously on import, so init() has nothing to do.
import pkg from "../pkg/nodejs/nodejs_index.js";

export const { Workbook, Sheet, RowIter } = pkg;
export function initSync() {}
export default async function init() {}
