// Playground edits: an overlay on top of the file's rows, so editing a 1M-row sheet stays cheap.
// The page owns the overlay; the worker applies it while writing the export.
import type { Cell } from "./protocol";

export type Fmt = { bold?: boolean; fill?: string; numFmt?: string };
/** `v` missing = keep the file's value (only the format changed). */
export type Edit = { v?: Cell | { formula: string }; f?: Fmt };
/** Keyed by `row:col`, 0-based. */
export type Edits = Map<string, Edit>;
/** `source` is the sheet name in the opened file, or null for a new blank sheet. */
export type BookSheet = { id: number; name: string; source: string | null; edits: Edits };

export const key = (row: number, col: number) => `${row}:${col}`;

export function isFormula(v: Edit["v"]): v is { formula: string } {
  return typeof v === "object" && v !== null && !(v instanceof Date) && "formula" in v;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** What the user typed -> a cell. `=` starts a formula, `'` forces text. */
export function parseInput(text: string): Edit["v"] {
  if (text === "") return null;
  if (text.startsWith("'")) return text.slice(1);
  if (text.startsWith("=") && text.length > 1) return { formula: text.slice(1) };
  const t = text.trim();
  if (NUMBER.test(t)) return Number(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  const d = DATE.exec(t);
  if (d) {
    const [, y, m, day, h = "0", min = "0", s = "0"] = d;
    const date = new Date(Date.UTC(+y, +m - 1, +day, +h, +min, +s));
    if (!isNaN(date.getTime())) return date;
  }
  return text;
}

/** Most edited row/col + 1, so the grid and the export include them. */
export function extent(edits: Edits): { height: number; width: number } {
  let height = 0;
  let width = 0;
  for (const k of edits.keys()) {
    const [r, c] = k.split(":").map(Number);
    height = Math.max(height, r + 1);
    width = Math.max(width, c + 1);
  }
  return { height, width };
}

export const NUM_FMTS: [string, string][] = [
  ["", "General"],
  ["0.00", "0.00"],
  ["#,##0", "#,##0"],
  ["#,##0.00", "#,##0.00"],
  ["0%", "0%"],
  ["$#,##0.00", "$#,##0.00"],
  ["yyyy-mm-dd", "yyyy-mm-dd"],
  ["dd/mm/yyyy", "dd/mm/yyyy"],
];
