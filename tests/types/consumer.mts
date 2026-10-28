// Compiled by `npm run test:types` with a minimal lib and no skipLibCheck, as a strict consumer would.
import init, { Workbook, type Cell } from "@kuramajs/excel";

await init();
const wb = Workbook.open(new Uint8Array(0));
export const row: Cell[] = wb.sheet("Data", { onProgress: (read, total) => void (read / total) }).row(0);
export const objects: Record<string, Cell>[] = wb.sheet("Data").toObjects({ header: 0 });
using disposable = wb;
export { disposable };

import initWriter, { XlsxWriter, writeXlsx, toCsv, type WriteCell } from "@kuramajs/excel/writer";
await initWriter();
const out = new XlsxWriter();
const cells: WriteCell[] = ["a", 1, true, new Date(), null, { formula: "A1", result: 1 }, { error: "#N/A" }];
out.addSheet("Data").addRow(cells);
export const xlsx: Uint8Array = out.save();
export const quick: Uint8Array = writeXlsx({ People: [{ id: 1, name: "Ann" }] });
export const csv: string = toCsv([["a", 1]], { delimiter: ";", escapeFormulas: true, bom: true });
