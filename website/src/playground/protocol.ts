import type { Cell, SheetInfo } from "@milojs/excel-kit";

export type { Cell, SheetInfo };

export type ViewerRequest =
  | { type: "open"; file: File }
  | { type: "sheet"; name: string }
  | { type: "rows"; start: number; end: number };

export type Progress =
  | { phase: "read"; done: number; total: number }
  | { phase: "open" }
  | { phase: "parse"; done: number; total: number; name: string };

export type ViewerResponse =
  | { type: "progress"; progress: Progress }
  | { type: "opened"; sheets: SheetInfo[]; size: number; readMs: number; openMs: number; memory: number }
  | { type: "sheet"; name: string; height: number; width: number; parseMs: number; memory: number }
  | { type: "rows"; start: number; end: number; rows: Cell[][]; ms: number }
  | { type: "error"; code?: string; message: string };

export type BenchLib = "excel-kit rows()" | "excel-kit forEachRow()" | "sheetjs" | "exceljs";
export const BENCH_LIBS: BenchLib[] = ["excel-kit rows()", "excel-kit forEachRow()", "sheetjs", "exceljs"];

export type BenchRequest =
  | { type: "list"; file: File }
  | { type: "run"; file: File; sheet: string; libs: BenchLib[]; runs: number };
export type BenchResponse =
  | { type: "sheets"; names: string[] }
  | { type: "error"; message: string }
  | { type: "result"; lib: BenchLib; ms: number; rows: number }
  | { type: "failed"; lib: BenchLib; error: string }
  | { type: "done" };
