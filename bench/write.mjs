// Write benchmark: @kuramajs/excel/writer vs SheetJS vs exceljs. Usage: node write.mjs [runs=3]
// Each case runs in a fresh process (node write.mjs --case <name> <rows>) and builds the same
// 8-column rows as gen.rs, then produces the finished xlsx bytes. Time includes making the rows.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const header = ["id", "name", "city", "price", "qty", "date", "active", "note"];
const cities = ["Colombo", "Kandy", "Galle", "Jaffna", "Negombo", "Matara"];
const row = (r) => [
  r,
  `Customer ${r % 5000}`,
  cities[r % 6],
  (r % 1000) * 1.25,
  r % 97,
  new Date(Date.UTC(2020, 0, 1 + (r % 1500))),
  r % 3 === 0,
  `Order note number ${r} with some text`,
];

const cases = {
  noop: async () => 0,
  "kurama XlsxWriter": async (rows) => {
    const { XlsxWriter } = require(process.env.EK_WRITER ?? "../pkg/writer/nodejs/writer.js");
    const wb = new XlsxWriter();
    const ws = wb.addSheet("Data");
    ws.addRow(header);
    for (let r = 1; r <= rows; r++) ws.addRow(row(r));
    return wb.save().length;
  },
  sheetjs: async (rows) => {
    const XLSX = require("xlsx");
    const aoa = [header];
    for (let r = 1; r <= rows; r++) aoa.push(row(r));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), "Data");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true }).length;
  },
  exceljs: async (rows) => {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(header);
    for (let r = 1; r <= rows; r++) ws.addRow(row(r));
    return (await wb.xlsx.writeBuffer()).byteLength;
  },
  "exceljs stream": async (rows) => {
    const ExcelJS = require("exceljs");
    let bytes = 0;
    const sink = new Writable({ write: (chunk, _enc, done) => ((bytes += chunk.length), done()) });
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false });
    const ws = wb.addWorksheet("Data");
    ws.addRow(header).commit();
    for (let r = 1; r <= rows; r++) ws.addRow(row(r)).commit();
    await wb.commit();
    return bytes;
  },
};

if (process.argv[2] === "--case") {
  const [name, rows] = process.argv.slice(3);
  const t0 = performance.now();
  const bytes = await cases[name](Number(rows));
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ ms, bytes, maxRssMB: process.resourceUsage().maxRSS / 1024 }));
  process.exit(0);
}

const runs = Number(process.argv[2] ?? 3);
function runCase(name, rows) {
  try {
    const out = execFileSync("node", ["--max-old-space-size=8192", "write.mjs", "--case", name, String(rows)], {
      encoding: "utf8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch {
    return null; // crash, OOM or timeout
  }
}

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const lines = [];
const log = (s = "") => (console.log(s), lines.push(s));

const baseline = runCase("noop", 0).maxRssMB;
log(`Node ${process.version}, ${runs} runs (median time, max peak RSS). Baseline process RSS: ${baseline.toFixed(0)} MB.\n`);
for (const rows of [100_000, 1_000_000]) {
  log(`### Write ${rows.toLocaleString("en")} rows x 8 columns\n`);
  log("| Library | Time | Peak RSS | File |");
  log("|---|---:|---:|---:|");
  for (const name of Object.keys(cases).filter((c) => c !== "noop")) {
    const results = Array.from({ length: runs }, () => runCase(name, rows));
    if (results.some((r) => !r)) {
      log(`| ${name} | failed | | |`);
      continue;
    }
    const ms = median(results.map((r) => r.ms));
    const rss = Math.max(...results.map((r) => r.maxRssMB));
    log(`| ${name} | ${(ms / 1000).toFixed(2)} s | ${rss.toFixed(0)} MB | ${(results[0].bytes / 1e6).toFixed(1)} MB |`);
  }
  log();
}
writeFileSync("write-results.md", lines.join("\n") + "\n");
