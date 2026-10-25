import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const { Workbook } = createRequire(import.meta.url)("../pkg/nodejs/nodejs_index.js");
const bytes = readFileSync(new URL("./fixtures/basic.xlsx", import.meta.url));

test("lists worksheets with visibility", () => {
  const wb = Workbook.open(bytes);
  assert.deepEqual(wb.sheets(), [
    { name: "Data", visibility: "Visible" },
    { name: "Secret", visibility: "Hidden" },
    { name: "People", visibility: "Visible" },
    { name: "Offset", visibility: "Visible" },
  ]);
});

test("returns typed cells and UTC dates", () => {
  const wb = Workbook.open(bytes);
  const sheet = wb.sheet("Data");
  assert.equal(sheet.height, 2);
  assert.equal(sheet.width, 5);
  const [first, second] = sheet.rows();
  assert.deepEqual(first, ["name", 42.5, true, new Date("2024-01-02T13:14:15Z"), { error: "#DIV/0!" }]);
  assert.deepEqual(second, [null, 7, null, null, null]);
  assert.deepEqual(sheet.row(1), second);
});

test("accepts ArrayBuffer", () => {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const wb = Workbook.open(buf);
  assert.equal(wb.sheets().length, 4);
});

test("throws errors with codes", () => {
  const code = (code) => (err) => err instanceof Error && err.code === code;
  assert.throws(() => Workbook.open(new Uint8Array([1, 2, 3])), code("INVALID_FILE"));
  assert.throws(() => Workbook.open("nope"), code("INVALID_INPUT"));
  const wb = Workbook.open(bytes);
  assert.throws(() => wb.sheet("Missing"), code("SHEET_NOT_FOUND"));
  assert.throws(() => wb.forEachRow("Missing", () => {}), code("SHEET_NOT_FOUND"));
  const sheet = wb.sheet("Data");
  assert.throws(() => sheet.row(99), code("OUT_OF_BOUNDS"));
  assert.throws(() => sheet.toObjects({ header: 99 }), code("OUT_OF_BOUNDS"));
});

test("toObjects keys rows by header, dedupes and fills blanks", () => {
  const wb = Workbook.open(bytes);
  assert.deepEqual(wb.sheet("People").toObjects(), [
    { id: 1, name: "Ann", __EMPTY_2: null, name_1: null },
    { id: null, name: null, __EMPTY_2: null, name_1: null },
    { id: 3, name: null, __EMPTY_2: null, name_1: null },
  ]);
  assert.deepEqual(wb.sheet("Data").toObjects({ header: 1 }), []);
});

test("forEachRow streams same rows as rows(), including gaps", () => {
  const wb = Workbook.open(bytes);
  for (const name of ["Data", "People", "Offset"]) {
    const streamed = [];
    wb.forEachRow(name, (row, i) => { streamed[i] = row; });
    assert.deepEqual(streamed, wb.sheet(name).rows(), name);
    assert.deepEqual([...wb.iterRows(name)], wb.sheet(name).rows(), name);
  }
});

test("iterRows supports early break and throws eagerly", () => {
  const wb = Workbook.open(bytes);
  let count = 0;
  for (const row of wb.iterRows("People")) {
    count++;
    assert.deepEqual(row, ["id", "name", null, "name"]);
    break;
  }
  assert.equal(count, 1);
  const it = wb.iterRows("People");
  it.next();
  assert.deepEqual(it.return(), { done: true, value: undefined });
  assert.deepEqual(it.next(), { done: true, value: undefined });
  assert.throws(() => wb.iterRows("Missing"), (err) => err.code === "SHEET_NOT_FOUND");
});

test("indexes rows and columns from A1", () => {
  const wb = Workbook.open(bytes);
  const sheet = wb.sheet("Offset");
  assert.deepEqual(sheet.rows(), [
    [null, null, null, null],
    [null, null, null, null],
    [null, null, "C3", null],
    [null, null, null, "D4"],
  ]);
  assert.equal(sheet.row(2)[2], "C3");
});

test("forEachRow stops on false and propagates throws", () => {
  const wb = Workbook.open(bytes);
  const seen = [];
  wb.forEachRow("People", (_row, i) => { seen.push(i); return false; });
  assert.deepEqual(seen, [0]);
  assert.throws(() => wb.forEachRow("People", () => { throw new Error("boom"); }), /boom/);
});

test("supports explicit and Symbol.dispose cleanup", () => {
  const wb = Workbook.open(bytes);
  assert.equal(typeof wb[Symbol.dispose], "function");
  wb.free();
});

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const d = (iso) => new Date(iso);

for (const file of ["date.xls", "date_1904.xls", "date.xlsb"]) {
  test(`reads dates and durations from ${file}`, () => {
    const wb = Workbook.open(fixture(file));
    const [{ name }] = wb.sheets();
    const rows = wb.sheet(name).rows();
    assert.deepEqual(rows, [
      [d("2021-01-01T00:00:00Z"), 15],
      [d("2021-01-02T00:00:00Z"), 16],
      [918610, 17],
    ]);
    const streamed = [];
    wb.forEachRow(name, (row, i) => { streamed[i] = row; });
    assert.deepEqual(streamed, rows);
    assert.deepEqual([...wb.iterRows(name)], rows);
  });
}

test("reads ISO dates and durations from ods", () => {
  const wb = Workbook.open(fixture("date.ods"));
  const [{ name }] = wb.sheets();
  assert.deepEqual(wb.sheet(name).rows(), [
    [d("2021-01-01T00:00:00Z"), 15],
    [d("2021-01-01T10:10:10Z"), 16],
    [36610, 17],
    [36610.123456, 18],
  ]);
});

for (const file of ["pass_protected.xlsx", "pass_protected.xlsb", "pass_protected.ods"]) {
  test(`reports PASSWORD_PROTECTED for ${file}`, () => {
    assert.throws(() => Workbook.open(fixture(file)), (err) => err.code === "PASSWORD_PROTECTED");
  });
}
