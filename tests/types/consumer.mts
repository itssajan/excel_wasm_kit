// Compiled by `npm run test:types` with a minimal lib and no skipLibCheck, as a strict consumer would.
import init, { Workbook, type Cell } from "@milojs/excel-kit";

await init();
const wb = Workbook.open(new Uint8Array(0));
export const row: Cell[] = wb.sheet("Data", { onProgress: (read, total) => void (read / total) }).row(0);
export const objects: Record<string, Cell>[] = wb.sheet("Data").toObjects({ header: 0 });
using disposable = wb;
export { disposable };
