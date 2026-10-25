// One benchmark case in a fresh process: node case.mjs <case> <file.xlsx>
// Prints JSON: { ms, rows, maxRssMB }. Time covers parse + reading every row (file read excluded).
import { readFileSync, createReadStream } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [name, file] = process.argv.slice(2);
const buf = readFileSync(file);

const cases = {
  noop: async () => 0,
  "kurama rows()": async () => {
    const { Workbook } = require(process.env.EK_PKG ?? "../pkg/nodejs/nodejs_index.js");
    const wb = Workbook.open(buf);
    return wb.sheet(wb.sheets()[0].name).rows().length;
  },
  "kurama iterRows()": async () => {
    const { Workbook } = require(process.env.EK_PKG ?? "../pkg/nodejs/nodejs_index.js");
    const wb = Workbook.open(buf);
    let n = 0;
    for (const _row of wb.iterRows(wb.sheets()[0].name)) n++;
    return n;
  },
  "kurama forEachRow()": async () => {
    const { Workbook } = require(process.env.EK_PKG ?? "../pkg/nodejs/nodejs_index.js");
    const wb = Workbook.open(buf);
    let n = 0;
    wb.forEachRow(wb.sheets()[0].name, () => { n++; });
    return n;
  },
  sheetjs: async () => {
    const XLSX = require("xlsx");
    const wb = XLSX.read(buf, { dense: true, cellDates: true });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).length;
  },
  exceljs: async () => {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = [];
    wb.worksheets[0].eachRow({ includeEmpty: true }, (row) => rows.push(row.values));
    return rows.length;
  },
  "exceljs stream": async () => {
    const ExcelJS = require("exceljs");
    let n = 0;
    for await (const ws of new ExcelJS.stream.xlsx.WorkbookReader(createReadStream(file), { sharedStrings: "cache" })) {
      for await (const _row of ws) n++;
    }
    return n;
  },
};

const t0 = performance.now();
const rows = await cases[name]();
const ms = performance.now() - t0;
console.log(JSON.stringify({ ms, rows, maxRssMB: process.resourceUsage().maxRSS / 1024 }));
