# @kuramajs/excel

Fast, low-memory Excel reader and writer for browsers and Node.js, written in Rust (reading via [calamine](https://github.com/tafia/calamine)) and compiled to WebAssembly.

**[Website](https://kuramajs.github.io/excel) · [Playground](https://kuramajs.github.io/excel/playground) · [Benchmarks](https://kuramajs.github.io/excel/benchmarks)**

Formerly published as `@milojs/excel-kit`.

- Reads **xlsx, xlsm, xlsb, xls, ods and csv**
- **~3.5× faster than SheetJS** and **2–10× less memory** on large files ([benchmarks](#benchmarks))
- **Streaming** row readers for files bigger than you want in memory
- **Typed cells**: numbers, booleans, `Date`s, `null`, and error values, not strings
- **Writes xlsx** with a streaming writer: 1M rows in about 3 s and 240 MB, with formatting, conditional formats, data validation and tables ([writing](#writing))
- Works in browsers, Web Workers and Node.js 20+, with TypeScript types included

The reader returns values, not formulas or styles. The writer is a separate import with its own wasm, so apps that only read don't download it.

## Install

```bash
npm install @kuramajs/excel
```

## Quick start

The same code works in the browser, a Web Worker and Node.js (ESM):

```js
import init, { Workbook } from "@kuramajs/excel";

await init(); // loads the wasm module (no-op in Node)

const bytes = new Uint8Array(await file.arrayBuffer()); // or fs.readFileSync(path) in Node
const wb = Workbook.open(bytes);

wb.sheets(); // [{ name: "Data", visibility: "Visible" }, ...]

const sheet = wb.sheet("Data");
sheet.rows();      // [["id", "name", "joined"], [1, "Ann", Date], ...]
sheet.toObjects(); // [{ id: 1, name: "Ann", joined: Date }, ...]

sheet.free(); // release wasm memory now (otherwise freed on GC)
wb.free();
```

CommonJS works too: `const { Workbook } = require("@kuramajs/excel")`, with no `init()` needed.

With [explicit resource management](https://github.com/tc39/proposal-explicit-resource-management) (Node 24+, TypeScript 5.2+), use `using wb = Workbook.open(bytes)` and the memory is freed at the end of the block.

## Streaming large sheets

`sheet()` parses the whole sheet into memory, which is fastest when you need random access. For big files, stream rows instead:

```js
// Generator: break early and the reader is freed
for (const row of wb.iterRows("Data")) {
  if (row[0] === "STOP") break;
}

// Callback: the fastest way to visit every row; return false to stop
wb.forEachRow("Data", (row, index) => {
  if (index >= 1000) return false;
});
```

Streaming is low-memory for xlsx and xlsm. Other formats are loaded fully first, then streamed.

## CSV

`Workbook.open` also reads CSV. You get one sheet named `"Sheet1"`, and every cell is a string (`null` if empty). Types aren't guessed, so `"01234"` keeps its leading zero. The delimiter (`,` `;` or tab) is picked from the first line. Text is read as UTF-8, or as windows-1252 (what Excel's "CSV" save writes) if it isn't valid UTF-8. Blank lines are skipped.

## Progress for big sheets

```js
const sheet = wb.sheet("Data", {
  onProgress: (rowsRead, totalRows) => console.log(`${Math.round((rowsRead / totalRows) * 100)}%`),
});
```

The callback fires about every 10,000 rows for xlsx and xlsm. Run it in a Web Worker and `postMessage` the progress to keep the page responsive (see the [playground source](https://github.com/kuramajs/excel/tree/master/website/src/playground)).

## Writing

```js
import init, { XlsxWriter } from "@kuramajs/excel/writer";

await init(); // loads the writer's wasm (no-op in Node)
const wb = new XlsxWriter();
const ws = wb.addSheet("Orders");
ws.addRow(["id", "customer", "amount", "ordered"]);
for (const o of orders) ws.addRow([o.id, o.customer, o.amount, o.date]);
const bytes = wb.save(); // Uint8Array of the .xlsx file
```

Cells are `string`, `number`, `boolean`, `Date`, `null`/`undefined` (empty), `{ formula, result? }` or `{ error }`. Formulas are always explicit: a string starting with `=` stays text. Excel calculates formulas when the file opens; pass `result` if other readers need the value.

Rows are compressed as you add them, so memory stays low however many rows you write. Two rules come from that:

- Sheets are written in order. Once you call `addSheet()` again, earlier sheets take no more rows.
- Column widths and frozen panes come first in the file, so they are options of `addSheet()`.

In the browser, download the result with a Blob:

```js
const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "orders.xlsx" });
a.click();
URL.revokeObjectURL(a.href);
```

### Formatting

```js
const head = wb.format({ bold: true, color: "#ffffff", fill: "#1f6feb", border: "thin", align: "center" });
const money = wb.format({ numFmt: "#,##0.00" });

const ws = wb.addSheet("Report", {
  columns: [{ width: 8 }, { width: 30 }, { width: 14, format: money }],
  freeze: { rows: 1 },
  autofilter: true,
});
ws.addRow(["id", "customer", "amount"], head);                 // format a whole row
ws.addRow([1, "Ann", { value: 1234.5, format: money }]);       // or one cell
ws.addRow(["", "Total", { formula: "SUM(C2:C99)" }], { format: head, height: 24 });
ws.merge("E1:G1");
```

Format options: `bold`, `italic`, `underline`, `strike`, `font`, `size`, `color`, `fill`, `border` (a style like `"thin"`, or `{ top, bottom, left, right }`), `borderColor`, `align`, `valign`, `wrap` and `numFmt` (any Excel number format code). When formats meet, the cell's wins over the row's, which wins over the column's. Dates keep a date format unless the format sets `numFmt`.

### Tables, conditional formats and validation

```js
ws.addTable({ columns: ["id", "customer", "amount"], name: "Orders", style: "TableStyleMedium2" });
for (const o of orders) ws.addRow([o.id, o.customer, o.amount]); // these rows are the table
ws.endTable();

ws.conditionalFormat("C2:C999", { type: "cell", operator: "greaterThan", value: 1000, format: green });
ws.conditionalFormat("A2:C999", { type: "formula", formula: "$C2<0", format: red });
ws.conditionalFormat("D2:D999", { type: "colorScale" });  // or { type: "dataBar" }

ws.validate("E2:E999", { type: "list", values: ["Open", "Paid", "Late"] });
ws.validate("F2:F999", { type: "whole", value: 0, value2: 100, error: { message: "0 to 100" } });
```

`addTable` writes the header row for you, so it always matches the table (Excel insists). The rows you add next belong to the table until `endTable()`, the next `addTable()` or the end of the sheet. Validation types: `list` (`values`, or `source: "$H$1:$H$9"`), `whole`, `decimal`, `date`, `textLength` and `custom` (a formula), each with optional `input` and `error` messages.

### Quick exports and CSV

```js
import { writeXlsx, toCsv } from "@kuramajs/excel/writer";

writeXlsx({ People: [{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }] }); // objects: header row from the keys
toCsv(rows, { delimiter: ";", bom: true });                               // bom: true helps Excel with non-ASCII text
```

`toCsv` prefixes `'` to text starting with `=`, `+`, `-` or `@` so spreadsheet apps don't run it as a formula (CSV injection). Turn that off with `escapeFormulas: false`.

### Writer API

| | |
|---|---|
| `new XlsxWriter()` | Start a workbook. |
| `wb.format(spec): Format` | Make a cell format. |
| `wb.addSheet(name, { columns?, freeze?, autofilter? }): SheetWriter` | Start the next sheet. Names: 1–31 characters, no `[ ] : * ? / \`, unique. |
| `wb.save(): Uint8Array` | Finish and return the file. The writer can't be used afterwards. |
| `ws.addRow(cells, format \| { format?, height? })` | Append a row. |
| `ws.merge(range)` | Merge cells like `"A1:C1"`. |
| `ws.addTable({ columns, name?, style?, headerFormat? })`, `ws.endTable()` | Start and end an Excel table. |
| `ws.conditionalFormat(range, rule)` | `cell`, `formula`, `colorScale` or `dataBar`. |
| `ws.validate(range, rule)` | Restrict what can be typed into cells. |
| `writeXlsx({ [sheet]: rows }): Uint8Array` | Whole workbook in one call. Rows are arrays or objects. |
| `toCsv(rows, { delimiter?, escapeFormulas?, bom? }): string` | Rows to CSV text. |

Writer errors have a `code` too: `INVALID_INPUT` (a value xlsx can't store, like `NaN` or a date before 1900, or a bad option) or `CLOSED` (writing to a finished sheet or a saved workbook). A row with a bad cell throws before anything from it is written.

## API

| | |
|---|---|
| `Workbook.open(data: Uint8Array \| ArrayBuffer)` | Parse a workbook or CSV. The format is detected from the bytes. |
| `wb.sheets(): SheetInfo[]` | Worksheets in order: `{ name, visibility: "Visible" \| "Hidden" \| "VeryHidden" }`. Chart sheets are skipped. |
| `wb.sheet(name, { onProgress? }): Sheet` | Parse one worksheet. |
| `wb.iterRows(name): Generator<Cell[]>` | Lazily iterate rows. |
| `wb.forEachRow(name, (row, index) => boolean \| void)` | Stream rows to a callback. Return `false` to stop. |
| `sheet.height`, `sheet.width` | Size in rows and columns, counted from A1. |
| `sheet.rows(): Cell[][]` | All rows. |
| `sheet.row(i): Cell[]` | One row. |
| `sheet.rowsSlice(start, end): Cell[][]` | A window of rows, like `Array.prototype.slice`. |
| `sheet.toObjects({ header? }): Record<string, Cell>[]` | Rows below the header row (default `0`) as objects. Blank headers become `__EMPTY_<col>` and duplicates get `_1`, `_2`, … |
| `.free()` / `[Symbol.dispose]()` | Release wasm memory for a `Workbook` or `Sheet`. |

Row and column indexes start at **A1**: `rows()[0][0]` is cell A1, even if the data starts further down.

### Cells

```ts
type Cell = string | number | boolean | Date | null | { error: string };
```

| Excel | JavaScript |
|---|---|
| Text | `string` |
| Number | `number` |
| TRUE / FALSE | `boolean` |
| Date / time | `Date`, read as **UTC** (Excel stores no timezone) |
| Duration | `number` of seconds |
| Error (`#DIV/0!`, `#N/A`, …) | `{ error: "#DIV/0!" }` |
| Empty | `null` |

Formula cells return their last calculated value.

### Errors

Every thrown error is an `Error` with a `code`:

| `code` | When |
|---|---|
| `INVALID_INPUT` | `open()` was given something other than a `Uint8Array` or `ArrayBuffer` |
| `INVALID_FILE` | The bytes are not a readable workbook |
| `PASSWORD_PROTECTED` | The workbook is encrypted |
| `SHEET_NOT_FOUND` | No worksheet has that name |
| `OUT_OF_BOUNDS` | `row(i)` or the `toObjects` header row is past the end |

```js
try {
  Workbook.open(bytes);
} catch (err) {
  if (err.code === "PASSWORD_PROTECTED") askForAnotherFile();
}
```

## Benchmarks

Parse a sheet and read every row, on Node 22 (Apple Silicon). Median of 3 runs. Peak memory includes Node's ~43 MB baseline.

| 47.5 MB xlsx, 1M rows | Time | Peak memory |
|---|---:|---:|
| **kurama** `forEachRow()` | **3.4 s** | **282 MB** |
| **kurama** `iterRows()` | 3.4 s | 276 MB |
| **kurama** `rows()` | 3.6 s | 1.3 GB |
| exceljs (streaming reader) | 7.5 s | 730 MB |
| SheetJS 0.20.3 | 12.3 s | 2.9 GB |
| exceljs 4.4.0 | 16.2 s | 4.1 GB |

| 10 MB xlsx, 220k rows | Time | Peak memory |
|---|---:|---:|
| **kurama** `forEachRow()` | **0.73 s** | **127 MB** |
| **kurama** `rows()` | 0.76 s | 379 MB |
| exceljs (streaming reader) | 1.71 s | 327 MB |
| SheetJS | 2.55 s | 675 MB |
| exceljs | 2.87 s | 1.0 GB |

Writing 1M rows × 8 columns to xlsx, same setup:

| Write 1M rows | Time | Peak memory | File |
|---|---:|---:|---:|
| **kurama** `XlsxWriter` | **3.2 s** | **239 MB** | **44.2 MB** |
| exceljs (streaming writer) | 4.4 s | 510 MB | 52.0 MB |
| SheetJS 0.20.3 | 27.1 s | 3.6 GB | 117.4 MB |
| exceljs 4.4.0 | out of memory | | |

At 100k rows: kurama 0.33 s / 86 MB, exceljs streaming 0.62 s / 150 MB.

In the [playground](https://kuramajs.github.io/excel/playground) (Chromium), @kuramajs/excel opens a 520 MB, 11.5M-row workbook and shows its first sheet in about 6 s.

**Bundle size:** 732 KB raw / 370 KB gzip (wasm + JS) for the reader. The writer is a separate 207 KB gzip download. That is larger than SheetJS (328 KB gzip) and exceljs (252 KB gzip). Most of it is calamine's parsers for five formats plus text-encoding tables that xlsx and ods also need. Dropping `.xls` would only save about 20 KB gzip.

Full results and how to reproduce them: [`bench/`](https://github.com/kuramajs/excel/tree/master/bench). Or [run it in your browser](https://kuramajs.github.io/excel/benchmarks) with your own file.

## Troubleshooting

**`expected magic word 00 61 73 6d, found 3c 21 44 4f`** (or "the .wasm file didn't load") means the browser asked for the `.wasm` file and got an HTML page, usually your app's `index.html`. Three common causes:

- **Vite dev only:** pre-bundling moves the JS away from the wasm. Add `optimizeDeps: { exclude: ["@kuramajs/excel"] }` to `vite.config`.
- **Deployed only:** your host's SPA rewrite sends `.wasm` to `index.html`. Let `.wasm` through and serve it as `application/wasm`.
- **Still failing after a fix:** the CDN cached the HTML, often only for `Accept-Encoding: br`. Clear the cache or redeploy.

You can also pass the file's URL yourself: `import wasmUrl from "@kuramajs/excel/wasm?url"; await init({ module_or_path: wasmUrl })`.

Step-by-step fixes for Vite, Amplify, nginx, S3/CloudFront, Netlify and Vercel: [troubleshooting guide](https://kuramajs.github.io/excel/troubleshooting).

## Limitations

- The reader returns values only: no formulas, styles, merged-cell info or images.
- The writer writes xlsx only. No charts, images, comments, hyperlinks or rich text yet. Tables always start in column A, and data bars use Excel's older gradient style.
- `sheet()` and `rows()` hold the whole sheet in memory. Use `iterRows()` or `forEachRow()` for huge sheets.
- WebAssembly memory is capped at 4 GB per instance and never shrinks. In practice, about 500 MB xlsx files are the ceiling in a browser tab.
- `iterRows()` borrows the parsed workbook until it finishes or you `break` out of it. Other calls made in the meantime still work, but they parse the file again, which is slow on big files. Finish or break out of one iterator before using the workbook again.
- Streamed rows (`iterRows()`, `forEachRow()`) are padded to the widest row seen so far, starting from the size the sheet declares. If a file declares its size wrongly, the first rows can be narrower than in `sheet().rows()`.
- Encrypted workbooks are detected (`PASSWORD_PROTECTED`) but cannot be opened.

## Development

Requires Rust with the `wasm32-unknown-unknown` target, [wasm-pack](https://github.com/drager/wasm-pack) and Node 20+.

```bash
npm run build   # builds pkg/nodejs and pkg/web
npm test        # Rust unit tests + node:test suite + TypeScript types check
cd website && npm install && npm run dev   # website: playground, benchmarks, docs
```

Releases are published from version tags: bump `version` in `package.json` and `Cargo.toml`, then push a `vX.Y.Z` tag.

## License

MIT
