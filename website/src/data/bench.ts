// From bench/results.md (Node 22, Apple Silicon, median of 3 runs, peak RSS).
// Rerun `node bench/run.mjs` and update these numbers together.
export type Row = { lib: string; variant: string; s: number; mb: number; ours?: boolean };
export type Size = { key: string; label: string; file: string; rows: string; data: Row[] };

export const SIZES: Size[] = [
  {
    key: "1mb",
    label: "1 MB",
    file: "1.0 MB",
    rows: "22k rows",
    data: [
      { lib: "kurama", variant: "forEachRow()", s: 0.1, mb: 96, ours: true },
      { lib: "kurama", variant: "iterRows()", s: 0.1, mb: 89, ours: true },
      { lib: "kurama", variant: "rows()", s: 0.11, mb: 130, ours: true },
      { lib: "exceljs", variant: "stream", s: 0.28, mb: 146 },
      { lib: "SheetJS", variant: "0.20.3", s: 0.34, mb: 166 },
      { lib: "exceljs", variant: "4.4.0", s: 0.41, mb: 208 },
    ],
  },
  {
    key: "10mb",
    label: "10 MB",
    file: "10.0 MB",
    rows: "220k rows",
    data: [
      { lib: "kurama", variant: "forEachRow()", s: 0.73, mb: 127, ours: true },
      { lib: "kurama", variant: "iterRows()", s: 0.72, mb: 126, ours: true },
      { lib: "kurama", variant: "rows()", s: 0.76, mb: 379, ours: true },
      { lib: "exceljs", variant: "stream", s: 1.71, mb: 327 },
      { lib: "SheetJS", variant: "0.20.3", s: 2.55, mb: 675 },
      { lib: "exceljs", variant: "4.4.0", s: 2.87, mb: 1000 },
    ],
  },
  {
    key: "50mb",
    label: "50 MB",
    file: "47.5 MB",
    rows: "1M rows",
    data: [
      { lib: "kurama", variant: "forEachRow()", s: 3.41, mb: 282, ours: true },
      { lib: "kurama", variant: "iterRows()", s: 3.37, mb: 276, ours: true },
      { lib: "kurama", variant: "rows()", s: 3.55, mb: 1326, ours: true },
      { lib: "exceljs", variant: "stream", s: 7.51, mb: 730 },
      { lib: "SheetJS", variant: "0.20.3", s: 12.29, mb: 2913 },
      { lib: "exceljs", variant: "4.4.0", s: 16.24, mb: 4111 },
    ],
  },
];

// From bench/write-results.md (`node bench/write.mjs`): write 8 columns to xlsx.
export type WriteRow = { lib: string; s: [number, number | null]; mb: [number, number | null]; file: number | null; ours?: boolean };
export const WRITE: WriteRow[] = [
  { lib: "kurama XlsxWriter", s: [0.33, 3.24], mb: [86, 239], file: 44.2, ours: true },
  { lib: "exceljs stream", s: [0.62, 4.43], mb: [150, 510], file: 52.0 },
  { lib: "SheetJS 0.20.3", s: [2.03, 27.11], mb: [472, 3557], file: 117.4 },
  { lib: "exceljs 4.4.0", s: [2.7, null], mb: [1245, null], file: null },
];

export const BUNDLE = [
  { lib: "kurama reader (wasm + js)", raw: 732, gzip: 370, ours: true },
  { lib: "kurama writer (wasm + js)", raw: 479, gzip: 207, ours: true },
  { lib: "SheetJS xlsx.full.min.js", raw: 930, gzip: 328 },
  { lib: "exceljs.min.js", raw: 925, gzip: 252 },
];

export const formatMb = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb} MB`);
