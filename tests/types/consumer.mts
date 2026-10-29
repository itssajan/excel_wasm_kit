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
const head = out.format({ bold: true, fill: "#e8f5e9", border: { bottom: "thin" }, align: "center" });
const sheet2 = new XlsxWriter().addSheet("R", { columns: [{ width: 12, format: head }, null], freeze: { rows: 1 }, autofilter: true });
sheet2.addRow([{ value: "x", format: head }, { format: head }, { formula: "A1", format: head }], head);
sheet2.addRow([1], { format: head, height: 20 });
sheet2.merge("A1:B1");
const s3 = new XlsxWriter().addSheet("Rules");
s3.conditionalFormat("A1:A9", { type: "cell", operator: "between", value: 1, value2: { formula: "B1" }, format: head });
s3.conditionalFormat("B1:B9", { type: "colorScale", mid: "#ffeb84" });
s3.validate("C1:C9", { type: "list", values: ["Yes", "No"], input: { message: "Pick one" } });
s3.validate("D1:D9", { type: "date", operator: "greaterThan", value: new Date(), error: { style: "warning" } });
s3.addTable({ columns: ["id", "name"], style: "TableStyleLight9", headerFormat: head });
s3.endTable();
