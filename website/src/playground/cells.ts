import type { Cell } from "./protocol";

export type CellKind = "empty" | "string" | "number" | "boolean" | "date" | "error";

export function cellKind(cell: Cell): CellKind {
  if (cell === null) return "empty";
  if (cell instanceof Date) return "date";
  if (typeof cell === "object") return "error";
  return typeof cell as "string" | "number" | "boolean";
}

export function formatCell(cell: Cell): string {
  switch (cellKind(cell)) {
    case "empty":
      return "";
    case "date": {
      // Dates are UTC (Excel has no timezone); hide midnight and milliseconds
      const iso = (cell as Date).toISOString().replace(".000Z", "").replace("T", " ");
      return iso.endsWith(" 00:00:00") ? iso.slice(0, 10) : iso;
    }
    case "error":
      return (cell as { error: string }).error;
    case "boolean":
      return cell ? "TRUE" : "FALSE";
    default:
      return String(cell);
  }
}

export function rawCell(cell: Cell): string {
  const kind = cellKind(cell);
  if (kind === "date") return `date: ${(cell as Date).toISOString()}`;
  if (kind === "error") return `error: ${(cell as { error: string }).error}`;
  return `${kind}: ${JSON.stringify(cell)}`;
}

export const KIND_CLASS: Record<CellKind, string> = {
  empty: "",
  string: "",
  number: "n",
  boolean: "b",
  date: "d",
  error: "e",
};

/** 0 -> A, 25 -> Z, 26 -> AA */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export const formatBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;
export const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(0)} ms`);
