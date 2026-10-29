/// <reference lib="webworker" />
// Holds the parsed workbook/sheet so the page never blocks; the page asks for row windows.
import init, { Workbook, type Cell, type Sheet } from "@kuramajs/excel";
import type { Format, WriteCell } from "@kuramajs/excel/writer";
import { isFormula, type Edit, type Fmt } from "./edits";
import type { ExportSheet, Progress, ViewerRequest, ViewerResponse } from "./protocol";

const post = (msg: ViewerResponse) => self.postMessage(msg);
const progress = (p: Progress) => post({ type: "progress", progress: p });

const wasm = await init();
const memory = () => wasm.memory.buffer.byteLength;
let wb: Workbook | null = null;
let sheet: Sheet | null = null;
let active: string | null = null;

async function readWithProgress(file: File): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let offset = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, offset);
    offset += value.length;
    const pct = Math.floor((offset / file.size) * 100);
    if (pct !== lastPct) {
      lastPct = pct;
      progress({ phase: "read", done: offset, total: file.size });
    }
  }
  return bytes;
}

type Value = Cell | { formula: string };
const withFormat = (v: Value, format: Format): WriteCell =>
  isFormula(v) ? { ...v, format } : v !== null && typeof v === "object" && !(v instanceof Date) ? { ...v, format } : { value: v, format };

/** Streams a sheet's rows (the file's, then the edits on top) to `each`. Returns the row count. */
function withRows(s: ExportSheet, each: (row: Value[], styles?: (Fmt | undefined)[]) => void): number {
  const byRow = new Map<number, [number, Edit][]>();
  let height = 0;
  for (const [k, e] of s.edits) {
    const [r, c] = k.split(":").map(Number);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r)!.push([c, e]);
    height = Math.max(height, r + 1);
  }
  // The open sheet is already parsed; other sheets from the file are parsed just for this
  const base = !s.source ? null : s.source === active && sheet ? sheet : wb!.sheet(s.source);
  height = Math.max(height, base?.height ?? 0);
  try {
    for (let start = 0; start < height; start += 10_000) {
      const rows: Value[][] = base ? base.rowsSlice(start, start + 10_000) : [];
      for (let r = start; r < Math.min(height, start + 10_000); r++) {
        const row = rows[r - start] ?? [];
        const edits = byRow.get(r);
        let styles: (Fmt | undefined)[] | undefined;
        for (const [c, e] of edits ?? []) {
          while (row.length <= c) row.push(null);
          if ("v" in e) row[c] = e.v!;
          if (e.f) (styles ??= [])[c] = e.f;
        }
        each(row, styles);
      }
    }
  } finally {
    if (base && base !== sheet) base.free();
  }
  return height;
}

async function handle(req: ViewerRequest) {
  switch (req.type) {
    case "open": {
      sheet?.free();
      wb?.free();
      sheet = wb = null;
      const t0 = performance.now();
      const bytes = await readWithProgress(req.file);
      const readMs = performance.now() - t0;
      progress({ phase: "open" });
      const t1 = performance.now();
      wb = Workbook.open(bytes);
      post({ type: "opened", sheets: wb.sheets(), size: req.file.size, readMs, openMs: performance.now() - t1, memory: memory() });
      break;
    }
    case "sheet": {
      if (!wb) throw new Error("No workbook open");
      sheet?.free();
      sheet = null;
      const t0 = performance.now();
      sheet = wb.sheet(req.name, {
        onProgress: (done, total) => progress({ phase: "parse", done, total, name: req.name }),
      });
      active = req.name;
      post({ type: "sheet", name: req.name, height: sheet.height, width: sheet.width, parseMs: performance.now() - t0, memory: memory() });
      break;
    }
    case "export": {
      // Write the sheets back out with @kuramajs/excel/writer (loaded on first use), edits applied
      const t0 = performance.now();
      const writer = await import("@kuramajs/excel/writer");
      await writer.default();
      if (req.format === "csv") {
        const rows: WriteCell[][] = [];
        // Typed formulas stay formulas; other text is escaped the way toCsv's escapeFormulas does it
        const csvCell = (c: Value): WriteCell =>
          isFormula(c) ? `=${c.formula}` : typeof c === "string" && /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
        const total = withRows(req.sheets[0], (row) => rows.push(row.map(csvCell)));
        const text = writer.toCsv(rows, { bom: true, escapeFormulas: false });
        post({ type: "exported", format: "csv", bytes: new TextEncoder().encode(text), rows: total, ms: performance.now() - t0 });
        break;
      }
      const out = new writer.XlsxWriter();
      const formats = new Map<string, Format>();
      const fmt = (f: Fmt) => {
        const k = JSON.stringify(f);
        if (!formats.has(k)) formats.set(k, out.format(f));
        return formats.get(k)!;
      };
      let total = 0;
      for (const s of req.sheets) {
        const ws = out.addSheet(s.name);
        total += withRows(s, (row, styles) =>
          ws.addRow(styles ? row.map((v, c) => (styles[c] ? withFormat(v, fmt(styles[c]!)) : v)) : row),
        );
      }
      post({ type: "exported", format: "xlsx", bytes: out.save(), rows: total, ms: performance.now() - t0 });
      break;
    }
    case "rows": {
      if (!sheet) break;
      const t0 = performance.now();
      const rows = sheet.rowsSlice(req.start, req.end);
      post({ type: "rows", start: req.start, end: req.end, rows, ms: performance.now() - t0 });
      break;
    }
  }
}

self.onmessage = async ({ data }: MessageEvent<ViewerRequest>) => {
  try {
    await handle(data);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    post({ type: "error", code: e.code, message: e.message ?? String(err) });
  }
};
