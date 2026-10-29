import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Workbook } from "@kuramajs/excel";
import { XlsxWriter, writeXlsx, toCsv } from "@kuramajs/excel/writer";

const read = (bytes, sheet = "Sheet1") => Workbook.open(bytes).sheet(sheet).rows();
const code = (c) => (e) => e instanceof Error && e.code === c;

test("round-trips typed cells through the reader", () => {
  const wb = new XlsxWriter();
  const ws = wb.addSheet("Data");
  const day = new Date("2024-01-02T00:00:00Z");
  const time = new Date("2024-01-02T13:14:15Z");
  ws.addRow(["name", 42.5, true, day, time, null, { error: "#N/A" }]);
  ws.addRow([" padded ", -0.001, false, undefined, "a<b>&\"c\"", "tab\there", "line\nbreak"]);
  ws.addRow([]);
  ws.addRow([null, null, "after gap"]);
  assert.deepEqual(read(wb.save(), "Data"), [
    ["name", 42.5, true, day, time, null, { error: "#N/A" }],
    [" padded ", -0.001, false, null, 'a<b>&"c"', "tab\there", "line\nbreak"],
    [null, null, null, null, null, null, null],
    [null, null, "after gap", null, null, null, null],
  ]);
});

test("escapes control characters and literal _xHHHH_ text", () => {
  const s = ["bell\u0007", "_x0041_ stays literal"];
  assert.deepEqual(read(writeXlsx({ Sheet1: [s] })), [s]);
});

test("writes several sheets in order, and finished sheets reject rows", () => {
  const wb = new XlsxWriter();
  const a = wb.addSheet("A");
  a.addRow([1]);
  const b = wb.addSheet("B & 'C' 2");
  b.addRow([2]);
  assert.throws(() => a.addRow([3]), code("CLOSED"));
  const bytes = wb.save();
  assert.deepEqual(Workbook.open(bytes).sheets().map((s) => s.name), ["A", "B & 'C' 2"]);
  assert.deepEqual(read(bytes, "A"), [[1]]);
  assert.deepEqual(read(bytes, "B & 'C' 2"), [[2]]);
  assert.throws(() => wb.save(), code("CLOSED"));
  assert.throws(() => b.addRow([1]), code("CLOSED"));
});

test("formula cells keep their result", () => {
  const bytes = writeXlsx({
    Sheet1: [[1, 2, { formula: "=SUM(A1:B1)", result: 3 }, { formula: 'A1&"x"', result: "1x" }, { formula: "A1>0" }]],
  });
  // calamine reads the cached result; a formula without one reads as empty until Excel recalculates
  assert.deepEqual(read(bytes), [[1, 2, 3, "1x"]]);
});

test("rejects values xlsx can't store, without writing half a row", () => {
  const wb = new XlsxWriter();
  const ws = wb.addSheet("S");
  for (const bad of [NaN, Infinity, new Date("nope"), new Date("1899-01-01"), {}, [1], 10n, "x".repeat(32768)]) {
    assert.throws(() => ws.addRow(["ok", bad]), code("INVALID_INPUT"));
  }
  ws.addRow(["kept"]);
  assert.deepEqual(read(wb.save(), "S"), [["kept"]]);
});

test("validates sheet names", () => {
  const wb = new XlsxWriter();
  wb.addSheet("Data");
  for (const bad of ["", "x".repeat(32), "a/b", "[x]", "'q", "DATA"]) {
    assert.throws(() => wb.addSheet(bad), code("INVALID_INPUT"), bad);
  }
});

test("an empty writer saves a valid workbook with one sheet", () => {
  const bytes = new XlsxWriter().save();
  assert.deepEqual(Workbook.open(bytes).sheets(), [{ name: "Sheet1", visibility: "Visible" }]);
});

test("writeXlsx takes arrays or objects, objects get a header from all keys", () => {
  const bytes = writeXlsx({
    People: [{ id: 1, name: "Ann" }, { id: 2, city: "Galle" }],
    Grid: [["a", "b"], null, [1]],
  });
  assert.deepEqual(read(bytes, "People"), [
    ["id", "name", "city"],
    [1, "Ann", null],
    [2, null, "Galle"],
  ]);
  assert.deepEqual(read(bytes, "Grid"), [["a", "b"], [null, null], [1, null]]);
  assert.throws(() => writeXlsx({ S: [[1], { a: 1 }] }), code("INVALID_INPUT"));
  assert.throws(() => writeXlsx({ S: "nope" }), code("INVALID_INPUT"));
});

test("toCsv quotes, escapes formulas by default and reads back", () => {
  const rows = [
    ["name", "note", "n", "ok", "when"],
    ["Smith, J", 'say "hi"\nbye', 1.5, true, new Date("2024-01-02T00:00:00Z")],
    ["=HYPERLINK(1)", "-5", -5, null, { formula: "A1", result: 7 }],
  ];
  const csv = toCsv(rows);
  assert.equal(
    csv,
    'name,note,n,ok,when\n"Smith, J","say ""hi""\nbye",1.5,true,2024-01-02T00:00:00.000Z\n\'=HYPERLINK(1),\'-5,-5,,7\n',
  );
  assert.equal(toCsv([["=1"]], { escapeFormulas: false }), "=1\n");
  assert.equal(toCsv([{ a: 1, b: 2 }], { delimiter: ";", bom: true }), "﻿a;b\n1;2\n");
  assert.deepEqual(read(Buffer.from(toCsv(rows.slice(0, 2)))), [
    ["name", "note", "n", "ok", "when"],
    ["Smith, J", 'say "hi"\nbye', "1.5", "true", "2024-01-02T00:00:00.000Z"],
  ]);
  assert.throws(() => toCsv([[1]], { delimiter: "ab" }), code("INVALID_INPUT"));
});

test("writer CommonJS require exposes the same API", () => {
  const cjs = createRequire(import.meta.url)("@kuramajs/excel/writer");
  assert.deepEqual(read(cjs.writeXlsx({ Sheet1: [[1]] })), [[1]]);
});

// Formatting isn't visible to the reader, so these tests look at the XML inside the zip.
import { inflateRawSync } from "node:zlib";
function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const files = {};
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50; ) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.toString("utf8", at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    at = start + size;
  }
  return files;
}
const styleOf = (xml, ref) => +(xml.match(new RegExp(`<c r="${ref}"(?: s="(\\d+)")?`))?.[1] ?? 0);
const xfs = (styles) => [...styles.match(/<cellXfs[^>]*>(.*)<\/cellXfs>/)[1].matchAll(/<xf [^>]*?(?:\/>|>.*?<\/xf>)/g)].map((m) => m[0]);

test("formats: fonts, fills, borders, number formats and alignment end up in styles.xml", () => {
  const wb = new XlsxWriter();
  const head = wb.format({ bold: true, color: "#ffffff", fill: "#1f6feb", border: "thin", align: "center" });
  const same = wb.format({ bold: true, color: "#ffffff", fill: "#1f6feb", border: "thin", align: "center" });
  const money = wb.format({ numFmt: "#,##0.00", border: { bottom: "double" }, borderColor: "#ff0000" });
  const ws = wb.addSheet("S");
  ws.addRow([{ value: "a", format: head }, { value: "b", format: same }, { value: 1.5, format: money }]);
  const f = unzip(wb.save());
  const s1 = styleOf(f["xl/worksheets/sheet1.xml"], "A1");
  assert.ok(s1 > 0);
  assert.equal(styleOf(f["xl/worksheets/sheet1.xml"], "B1"), s1, "identical specs share one xf");
  const styles = f["xl/styles.xml"];
  assert.match(styles, /<font><b\/><sz val="11"\/><color rgb="FFFFFFFF"\/>/);
  assert.match(styles, /<fgColor rgb="FF1F6FEB"\/>/);
  assert.match(styles, /<left style="thin"><color auto="1"\/><\/left>/);
  assert.match(styles, /<bottom style="double"><color rgb="FFFF0000"\/><\/bottom>/);
  assert.match(styles, /<numFmt numFmtId="164" formatCode="#,##0.00"\/>/);
  assert.match(xfs(styles)[s1], /applyAlignment="1"><alignment horizontal="center"\/><\/xf>/);
});

test("formats: cell beats row beats column, and dates keep a date format", () => {
  const wb = new XlsxWriter();
  const col = wb.format({ italic: true });
  const row = wb.format({ bold: true });
  const cell = wb.format({ strike: true });
  const ws = wb.addSheet("S", { columns: [{ width: 20, format: col }, null, { hidden: true }] });
  ws.addRow(["col", "none"]);
  ws.addRow(["row", { value: "cell", format: cell }, new Date("2024-01-02T00:00:00Z")], row);
  ws.addRow([{ format: row }], { height: 30 });
  const f = unzip(wb.save());
  const sheet = f["xl/worksheets/sheet1.xml"];
  const x = xfs(f["xl/styles.xml"]);
  const font = (ref) => f["xl/styles.xml"].match(/<fonts[^>]*>(.*)<\/fonts>/)[1].match(/<font>.*?<\/font>/g)[+x[styleOf(sheet, ref)].match(/fontId="(\d+)"/)[1]];
  assert.match(font("A1"), /<i\/>/);
  assert.equal(styleOf(sheet, "B1"), 0);
  assert.match(font("A2"), /<b\/>/);
  assert.match(font("B2"), /<strike\/>/);
  assert.match(font("C2"), /<b\/>/);
  assert.match(x[styleOf(sheet, "C2")], /numFmtId="16\d"/, "bold date still gets a date format");
  assert.match(sheet, /<row r="3" ht="30" customHeight="1"><c r="A3" s="\d+"\/><\/row>/, "styled empty cell");
  assert.match(sheet, /<cols><col min="1" max="1" width="20" customWidth="1" style="\d+"\/><col min="3" max="3" width="8.43" hidden="1"\/><\/cols>/);
});

test("formatted values read back unchanged", () => {
  const wb = new XlsxWriter();
  const pct = wb.format({ bold: true, numFmt: "0.0%" });
  const bold = wb.format({ bold: true });
  const day = new Date("2024-01-02T00:00:00Z");
  const ws = wb.addSheet("S", { columns: [{ format: pct }] });
  ws.addRow([0.25, { value: day, format: bold }, { formula: "A1*2", result: 0.5, format: pct }], pct);
  // an explicit numFmt wins, even on a Date: it's then just a number
  ws.addRow([{ value: day, format: pct }]);
  assert.deepEqual(read(wb.save(), "S"), [[0.25, day, 0.5], [45293, null, null]]);
});

test("freeze panes, autofilter and merges", () => {
  const wb = new XlsxWriter();
  const a = wb.addSheet("O'Neil", { freeze: { rows: 1, cols: 2 }, autofilter: true });
  a.addRow(["h1", "h2", "h3"]);
  a.addRow([1, 2]);
  a.merge("A3:C3");
  a.merge("E1:D2"); // any corner order
  assert.throws(() => a.merge("B3:B4"), code("INVALID_INPUT"), "overlap");
  assert.throws(() => a.merge("A9"), code("INVALID_INPUT"), "single cell");
  assert.throws(() => a.merge("A0:B1"), code("INVALID_INPUT"));
  assert.throws(() => a.merge("a1:b2"), code("INVALID_INPUT"));
  wb.addSheet("Only rows", { freeze: { rows: 3 }, autofilter: "B1:C1" });
  assert.throws(() => a.merge("G1:H1"), code("CLOSED"));
  const f = unzip(wb.save());
  const s1 = f["xl/worksheets/sheet1.xml"];
  assert.match(s1, /<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"\/>/);
  assert.match(s1, /<\/sheetData><autoFilter ref="A1:C2"\/><mergeCells count="2"><mergeCell ref="A3:C3"\/><mergeCell ref="D1:E2"\/><\/mergeCells><\/worksheet>$/);
  assert.match(f["xl/worksheets/sheet2.xml"], /<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(f["xl/worksheets/sheet2.xml"], /<autoFilter ref="B1:C1"\/>/);
  const book = f["xl/workbook.xml"];
  assert.match(book, /<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'O''Neil'!\$A\$1:\$C\$2<\/definedName>/);
  assert.match(book, /localSheetId="1" hidden="1">'Only rows'!\$B\$1:\$C\$1</);
});

test("rejects bad formats and options", () => {
  const wb = new XlsxWriter();
  for (const spec of [{ bolt: true }, { color: "red" }, { fill: "#12345" }, { border: "heavy" }, { size: 0 }, { bold: "yes" }, { align: "middle" }, { numFmt: "" }]) {
    assert.throws(() => wb.format(spec), code("INVALID_INPUT"), JSON.stringify(spec));
  }
  const other = new XlsxWriter().format({ bold: true });
  assert.throws(() => wb.addSheet("A", { columns: [{ format: other }] }), code("INVALID_INPUT"), "format from another writer");
  assert.throws(() => wb.addSheet("A", { freez: {} }), code("INVALID_INPUT"));
  assert.throws(() => wb.addSheet("A", { freeze: { rows: 1.5 } }), code("INVALID_INPUT"));
  assert.throws(() => wb.addSheet("A", { columns: [{ width: 300 }] }), code("INVALID_INPUT"));
  assert.throws(() => wb.addSheet("A", { autofilter: "nope" }), code("INVALID_INPUT"));
  const ws = wb.addSheet("A"); // the failed attempts above didn't take the name
  assert.throws(() => ws.addRow([1], { height: -1 }), code("INVALID_INPUT"));
  assert.throws(() => ws.addRow([1], 99), code("INVALID_INPUT"));
  assert.throws(() => ws.addRow([{ value: 1, format: 99 }]), code("INVALID_INPUT"));
  assert.equal(toCsv([[{ value: "x", format: 0 }, { format: 0 }]]), "x,\n");
});
