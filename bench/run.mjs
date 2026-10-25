// Benchmark excel-kit vs SheetJS vs exceljs. Usage: node run.mjs [runs=3]
// Needs `npm run build` in the repo root and fixtures from bench/gen.rs (see README).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runs = Number(process.argv[2] ?? 3);
const files = ["1mb", "10mb", "50mb"].map((f) => `fixtures/${f}.xlsx`);
const cases = ["excel-kit rows()", "excel-kit iterRows()", "excel-kit forEachRow()", "sheetjs", "exceljs", "exceljs stream"];

function runCase(name, file) {
  try {
    const out = execFileSync("node", ["--max-old-space-size=8192", "case.mjs", name, file], {
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
const log = (s = "") => { console.log(s); lines.push(s); };

const baseline = runCase("noop", files[0]).maxRssMB;
log(`Node ${process.version}, ${runs} runs (median time, max peak RSS). Baseline process RSS: ${baseline.toFixed(0)} MB.\n`);

for (const file of files) {
  log(`### ${file.split("/")[1]} (${(statSync(file).size / 1e6).toFixed(1)} MB)\n`);
  log("| Library | Time | Peak RSS | Rows |");
  log("|---|---:|---:|---:|");
  for (const name of cases) {
    const results = Array.from({ length: runs }, () => runCase(name, file));
    if (results.some((r) => !r)) {
      log(`| ${name} | failed | | |`);
      continue;
    }
    const ms = median(results.map((r) => r.ms));
    const rss = Math.max(...results.map((r) => r.maxRssMB));
    log(`| ${name} | ${(ms / 1000).toFixed(2)} s | ${rss.toFixed(0)} MB | ${results[0].rows} |`);
  }
  log();
}

const gz = (paths) => paths.reduce((sum, p) => sum + gzipSync(readFileSync(p)).length, 0) / 1024;
const raw = (paths) => paths.reduce((sum, p) => sum + statSync(p).size, 0) / 1024;
const bundles = {
  "excel-kit (wasm + js)": ["../pkg/web/web_index_bg.wasm", "../pkg/web/web_index.js"],
  "sheetjs (xlsx.full.min.js)": [require.resolve("xlsx/dist/xlsx.full.min.js")],
  "exceljs (exceljs.min.js)": [require.resolve("exceljs/dist/exceljs.min.js")],
};
log("### Browser bundle size\n");
log("| Library | Raw | Gzip |");
log("|---|---:|---:|");
for (const [name, paths] of Object.entries(bundles)) {
  log(`| ${name} | ${raw(paths).toFixed(0)} KB | ${gz(paths).toFixed(0)} KB |`);
}
writeFileSync("results.md", lines.join("\n") + "\n");
