// Times parse + reading every row of the first sheet, per library, median of 3 runs.
import init, { Workbook } from "@milojs/excel-kit";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";

const cases = {
  "excel-kit rows()": (buf) => {
    const wb = Workbook.open(buf);
    const n = wb.sheet(wb.sheets()[0].name).rows().length;
    wb.free();
    return n;
  },
  "excel-kit iterRows()": (buf) => {
    const wb = Workbook.open(buf);
    let n = 0;
    for (const _row of wb.iterRows(wb.sheets()[0].name)) n++;
    wb.free();
    return n;
  },
  sheetjs: (buf) => {
    const wb = XLSX.read(buf, { dense: true, cellDates: true });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).length;
  },
  exceljs: async (buf) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = [];
    wb.worksheets[0].eachRow({ includeEmpty: true }, (row) => rows.push(row.values));
    return rows.length;
  },
};

self.onmessage = async ({ data: buf }) => {
  await init();
  for (const [name, run] of Object.entries(cases)) {
    try {
      const times = [];
      let rows;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        rows = await run(buf);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      postMessage({ type: "result", name, ms: times[1], rows });
    } catch (err) {
      postMessage({ type: "result", name, ms: null, error: String(err?.message ?? err) });
    }
  }
  postMessage({ type: "done" });
};
