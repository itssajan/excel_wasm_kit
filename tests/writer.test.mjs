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
