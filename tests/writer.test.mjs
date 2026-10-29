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

test("conditional formats: cell rules, formulas, color scales and data bars", () => {
  const wb = new XlsxWriter();
  const red = wb.format({ color: "#9c0006", fill: "#ffc7ce", bold: true });
  const ws = wb.addSheet("S");
  ws.addRow([1, 2, 3]);
  ws.conditionalFormat("A1:A10", { type: "cell", operator: "greaterThan", value: 100, format: red });
  ws.conditionalFormat("B1:B10", { type: "cell", operator: "between", value: new Date("2024-01-01T00:00:00Z"), value2: { formula: "=TODAY()" }, format: red });
  ws.conditionalFormat("C1:C10", { type: "cell", operator: "equal", value: 'say "hi"', format: red });
  ws.conditionalFormat("A1:C10", { type: "formula", formula: "=$C1>2", format: red });
  ws.conditionalFormat("D1:D10", { type: "colorScale" });
  ws.conditionalFormat("E1:E10", { type: "colorScale", min: "#ffffff", mid: "#ffeb84", max: "#63be7b" });
  ws.conditionalFormat("F1:F10", { type: "dataBar", color: "#638ec6" });
  const f = unzip(wb.save());
  const sheet = f["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<conditionalFormatting sqref="A1:A10"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>100<\/formula><\/cfRule><\/conditionalFormatting>/);
  assert.match(sheet, /priority="2" operator="between"><formula>45292<\/formula><formula>TODAY\(\)<\/formula>/);
  assert.match(sheet, /<formula>&quot;say &quot;&quot;hi&quot;&quot;&quot;<\/formula>/);
  assert.match(sheet, /<cfRule type="expression" dxfId="0" priority="4"><formula>\$C1&gt;2<\/formula>/);
  assert.match(sheet, /<colorScale><cfvo type="min" val="0"\/><cfvo type="max" val="0"\/><color rgb="FFF8696B"\/><color rgb="FF63BE7B"\/><\/colorScale>/);
  assert.match(sheet, /<cfvo type="percentile" val="50"\/><cfvo type="max" val="0"\/><color rgb="FFFFFFFF"\/><color rgb="FFFFEB84"\/><color rgb="FF63BE7B"\/>/);
  assert.match(sheet, /<dataBar><cfvo type="min"\/><cfvo type="max"\/><color rgb="FF638EC6"\/><\/dataBar>/);
  assert.match(f["xl/styles.xml"], /<dxfs count="1"><dxf><font><b\/><color rgb="FF9C0006"\/><\/font><fill><patternFill><bgColor rgb="FFFFC7CE"\/><\/patternFill><\/fill><\/dxf><\/dxfs><\/styleSheet>$/);
  // order inside <worksheet> matters to Excel
  assert.ok(sheet.indexOf("</sheetData>") < sheet.indexOf("<conditionalFormatting"));
});

test("data validation: lists, numbers, dates, text length and formulas", () => {
  const wb = new XlsxWriter();
  const ws = wb.addSheet("S");
  ws.validate("A2:A100", { type: "list", values: ["Yes", "No", 'Say "x"'], input: { title: "Pick", message: "Yes or no" } });
  ws.validate("B2:B100", { type: "list", source: "=$H$1:$H$5", dropdown: false });
  ws.validate("C2:C100", { type: "whole", value: 1, value2: 10, error: { title: "Oops", message: "1 to 10", style: "warning" } });
  ws.validate("D2:D100", { type: "decimal", operator: "greaterThan", value: 0, allowBlank: false });
  ws.validate("E2:E100", { type: "date", operator: "lessThanOrEqual", value: { formula: "TODAY()" } });
  ws.validate("F2:F100", { type: "textLength", operator: "lessThan", value: 50 });
  ws.validate("G2:G100", { type: "custom", formula: "ISNUMBER(G2)" });
  const sheet = unzip(wb.save())["xl/worksheets/sheet1.xml"];
  assert.match(sheet, /<dataValidations count="7">/);
  assert.match(sheet, /<dataValidation type="list" allowBlank="1" showInputMessage="1" promptTitle="Pick" prompt="Yes or no" showErrorMessage="1" sqref="A2:A100"><formula1>&quot;Yes,No,Say &quot;&quot;x&quot;&quot;&quot;<\/formula1><\/dataValidation>/);
  assert.match(sheet, /type="list" showDropDown="1" allowBlank="1" showErrorMessage="1" sqref="B2:B100"><formula1>\$H\$1:\$H\$5<\/formula1>/);
  assert.match(sheet, /type="whole" operator="between" allowBlank="1" showErrorMessage="1" errorStyle="warning" errorTitle="Oops" error="1 to 10" sqref="C2:C100"><formula1>1<\/formula1><formula2>10<\/formula2>/);
  assert.match(sheet, /type="decimal" operator="greaterThan" showErrorMessage="1" sqref="D2:D100"/);
  assert.match(sheet, /<formula1>TODAY\(\)<\/formula1>/);
  assert.match(sheet, /type="custom" allowBlank="1" showErrorMessage="1" sqref="G2:G100"><formula1>ISNUMBER\(G2\)<\/formula1>/);
});

test("tables: header written for you, range follows the rows", () => {
  const wb = new XlsxWriter();
  const head = wb.format({ bold: true });
  const ws = wb.addSheet("Data");
  ws.addRow(["Report"]);
  ws.addTable({ columns: ["id", "name", "price"], name: "Orders", style: "TableStyleLight9", headerFormat: head });
  ws.addRow([1, "Ann", 9.5]);
  ws.addRow([2, "Bob", 3]);
  ws.endTable();
  ws.addRow(["after"]);
  ws.addTable({ columns: ["still open"] });
  ws.addRow(["its row"]); // no endTable(): the table ends with the sheet
  const s2 = wb.addSheet("More");
  s2.addTable({ columns: ["x"] }); // no data rows: an empty one is reserved
  const bytes = wb.save();
  const f = unzip(bytes);
  assert.match(f["xl/tables/table1.xml"], /id="1" name="Orders" displayName="Orders" ref="A2:C4" totalsRowShown="0"><autoFilter ref="A2:C4"\/><tableColumns count="3"><tableColumn id="1" name="id"\/><tableColumn id="2" name="name"\/><tableColumn id="3" name="price"\/><\/tableColumns><tableStyleInfo name="TableStyleLight9"/);
  assert.match(f["xl/tables/table2.xml"], /name="Table2" displayName="Table2" ref="A6:A7"/);
  assert.match(f["xl/tables/table3.xml"], /name="Table3" displayName="Table3" ref="A1:A2"/);
  assert.match(f["xl/worksheets/sheet1.xml"], /<tableParts count="2"><tablePart r:id="rId1"\/><tablePart r:id="rId2"\/><\/tableParts><\/worksheet>$/);
  assert.match(f["xl/worksheets/_rels/sheet1.xml.rels"], /Target="..\/tables\/table2.xml"/);
  assert.match(f["xl/worksheets/_rels/sheet2.xml.rels"], /Id="rId1" .*Target="..\/tables\/table3.xml"/);
  assert.match(f["[Content_Types].xml"], /\/xl\/tables\/table3.xml/);
  assert.ok(styleOf(f["xl/worksheets/sheet1.xml"], "A2") > 0, "header format");
  assert.deepEqual(read(bytes, "Data"), [
    ["Report", null, null],
    ["id", "name", "price"],
    [1, "Ann", 9.5],
    [2, "Bob", 3],
    ["after", null, null],
    ["still open", null, null],
    ["its row", null, null],
  ]);
});

test("rejects bad rules and tables", () => {
  const wb = new XlsxWriter();
  const fmt = wb.format({ bold: true });
  const ws = wb.addSheet("S");
  for (const rule of [
    { type: "nope" },
    { type: "cell", value: 1 }, // no format
    { type: "cell", operator: "bigger", value: 1, format: fmt },
    { type: "cell", operator: "between", value: 1, format: fmt }, // no value2
    { type: "cell", value: 1, value2: 2, format: fmt }, // value2 without between
    { type: "colorScale", min: "red" },
    { type: "dataBar", colour: "#ffffff" },
  ]) {
    assert.throws(() => ws.conditionalFormat("A1:A2", rule), code("INVALID_INPUT"), JSON.stringify(rule));
  }
  for (const rule of [
    { type: "list" },
    { type: "list", values: ["a,b"] },
    { type: "list", values: ["x".repeat(300)] },
    { type: "whole" },
    { type: "custom" },
    { type: "list", values: ["a"], error: { style: "panic" } },
    { type: "list", values: ["a"], input: { title: "x".repeat(33) } },
  ]) {
    assert.throws(() => ws.validate("A1:A2", rule), code("INVALID_INPUT"), JSON.stringify(rule));
  }
  for (const t of [
    {},
    { columns: [] },
    { columns: ["a", "A"] },
    { columns: ["a\nb"] },
    { columns: ["a"], name: "A1" },
    { columns: ["a"], name: "R1C1" },
    { columns: ["a"], name: "has space" },
    { columns: ["a"], style: "TableStyleMedium29" },
    { columns: ["a"], style: "TableStyleMedium02" },
    { columns: ["a"], colour: "red" },
  ]) {
    assert.throws(() => ws.addTable(t), code("INVALID_INPUT"), JSON.stringify(t));
  }
  ws.addTable({ columns: ["a", "b"], name: "T" });
  assert.throws(() => ws.merge("A3:B3"), code("INVALID_INPUT"), "merge inside the open table");
  ws.endTable();
  assert.throws(() => ws.addTable({ columns: ["a"], name: "t" }), code("INVALID_INPUT"), "duplicate name");
  const filtered = wb.addSheet("F", { autofilter: true });
  assert.throws(() => filtered.addTable({ columns: ["a"] }), code("INVALID_INPUT"), "autofilter + table");
  assert.throws(() => ws.conditionalFormat("A1:A2", { type: "dataBar" }), code("CLOSED"));
});
