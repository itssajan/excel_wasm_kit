/// <reference lib="webworker" />
// Times parse + reading every row of one sheet per library (median of N runs).
import init, { Workbook } from "@kuramajs/excel";
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import type { BenchLib, BenchRequest, BenchResponse } from "./protocol";

const post = (msg: BenchResponse) => self.postMessage(msg);

const cases: Record<BenchLib, (buf: Uint8Array, sheet: string) => number | Promise<number>> = {
  "kurama rows()": (buf, name) => {
    const wb = Workbook.open(buf);
    const sheet = wb.sheet(name);
    const n = sheet.rows().length;
    sheet.free();
    wb.free();
    return n;
  },
  "kurama forEachRow()": (buf, name) => {
    const wb = Workbook.open(buf);
    let n = 0;
    wb.forEachRow(name, () => {
      n++;
    });
    wb.free();
    return n;
  },
  sheetjs: (buf, name) => {
    const wb = XLSX.read(buf, { dense: true, cellDates: true, sheets: [name] });
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }).length;
  },
  exceljs: async (buf, name) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf.buffer as ArrayBuffer);
    const rows: unknown[] = [];
    wb.getWorksheet(name)!.eachRow({ includeEmpty: true }, (row) => rows.push(row.values));
    return rows.length;
  },
};

self.onmessage = async ({ data }: MessageEvent<BenchRequest>) => {
  await init();
  const buf = new Uint8Array(await data.file.arrayBuffer());
  if (data.type === "list") {
    try {
      const wb = Workbook.open(buf);
      post({ type: "sheets", names: wb.sheets().filter((s) => s.visibility === "Visible").map((s) => s.name) });
      wb.free();
    } catch (err) {
      post({ type: "error", message: String((err as Error)?.message ?? err) });
    }
    return;
  }
  for (const lib of data.libs) {
    try {
      const times: number[] = [];
      let rows = 0;
      for (let i = 0; i < data.runs; i++) {
        const t0 = performance.now();
        rows = await cases[lib](buf, data.sheet);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      post({ type: "result", lib, ms: times[Math.floor(times.length / 2)], rows });
    } catch (err) {
      post({ type: "failed", lib, error: String((err as Error)?.message ?? err) });
    }
  }
  post({ type: "done" });
};
