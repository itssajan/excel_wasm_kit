/// <reference lib="webworker" />
// Holds the parsed workbook/sheet so the page never blocks; the page asks for row windows.
import init, { Workbook, type Sheet } from "@kuramajs/excel";
import type { Progress, ViewerRequest, ViewerResponse } from "./protocol";

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
      // Write the open sheet back out with @kuramajs/excel/writer, loaded on first use
      if (!sheet || !active) break;
      const t0 = performance.now();
      const writer = await import("@kuramajs/excel/writer");
      await writer.default();
      const out = new writer.XlsxWriter();
      const head = out.format({ bold: true, fill: "#e8f5e9", border: { bottom: "thin" } });
      const ws = out.addSheet(active, { freeze: { rows: 1 }, autofilter: true });
      for (let start = 0; start < sheet.height; start += 10_000) {
        sheet.rowsSlice(start, start + 10_000).forEach((row, i) => ws.addRow(row, start + i === 0 ? head : undefined));
      }
      const bytes = out.save();
      post({ type: "exported", name: active, bytes, rows: sheet.height, ms: performance.now() - t0 });
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
