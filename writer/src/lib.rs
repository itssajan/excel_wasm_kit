//! Streaming xlsx writer: each row's XML goes straight into the deflated zip, so memory stays
//! flat however many rows you write (no cell table, inline strings instead of a shared-string table).
use std::cell::RefCell;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::io::{Cursor, Write};
use std::rc::Rc;

use js_sys::{Array, Date, Object, Reflect};
use wasm_bindgen::prelude::*;
use zip::{write::SimpleFileOptions, ZipWriter};

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type WriteCell =
  | string | number | boolean | Date | null | undefined
  | { formula: string; result?: string | number | boolean }
  | { error: string };
export type WriteRow = WriteCell[] | Record<string, WriteCell>;
export interface CsvOptions {
  /** Field separator. Default `,`. */
  delimiter?: string;
  /** Prefix `'` to strings starting with `= + - @`, tab or CR, so spreadsheet apps don't run them as formulas. Default `true`. */
  escapeFormulas?: boolean;
  /** Start with a UTF-8 BOM, so Excel reads non-ASCII text correctly. Default `false`. */
  bom?: boolean;
}
export type WriterErrorCode = "INVALID_INPUT" | "CLOSED";
"#;

fn error(code: &str, message: &str) -> JsValue {
    let err = js_sys::Error::new(message);
    Reflect::set(&err, &"code".into(), &code.into()).unwrap_throw();
    err.into()
}

fn invalid(message: &str) -> JsValue {
    error("INVALID_INPUT", message)
}

const MAX_ROWS: u32 = 1_048_576;
const MAX_COLS: usize = 16_384;
const MAX_STRING: usize = 32_767;

// cellXfs indexes in STYLES
const XF_DATE: u8 = 1;
const XF_DATETIME: u8 = 2;

const XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NS: &str = "http://schemas.openxmlformats.org";
const STYLES: &str = r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd"/><numFmt numFmtId="165" formatCode="yyyy\-mm\-dd\ hh:mm:ss"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

/// Column index (0-based) to letters: 0 -> A, 26 -> AA.
fn push_col(out: &mut String, mut c: usize) {
    let mut letters = [0u8; 3];
    let mut i = letters.len();
    loop {
        i -= 1;
        letters[i] = b'A' + (c % 26) as u8;
        if c < 26 {
            break;
        }
        c = c / 26 - 1;
    }
    out.push_str(std::str::from_utf8(&letters[i..]).unwrap_throw());
}

/// XML-escape text. Control characters XML can't hold become Excel's `_xHHHH_`, and a literal
/// `_xHHHH_` gets its `_` escaped so Excel doesn't decode it.
fn push_escaped(out: &mut String, s: &str) {
    let bytes = s.as_bytes();
    for (i, ch) in s.char_indices() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(ch),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {
                let _ = write!(out, "_x{:04X}_", c as u32);
            }
            '_' if is_hex_escape(&bytes[i..]) => out.push_str("_x005F_"),
            c => out.push(c),
        }
    }
}

fn is_hex_escape(b: &[u8]) -> bool {
    b.len() >= 7 && b[1] == b'x' && b[2..6].iter().all(u8::is_ascii_hexdigit) && b[6] == b'_'
}

/// Excel serial date (days since 1899-12-30, as Excel counts from 1900-03-01 on).
fn excel_serial(d: &Date) -> Result<f64, JsValue> {
    let ms = d.get_time();
    if ms.is_nan() {
        return Err(invalid("Invalid Date"));
    }
    let serial = ms / 86_400_000.0 + 25_569.0;
    // ponytail: Excel's fake 1900-02-29 shifts serials before 1900-03-01 by a day; reject those
    // instead of special-casing dates nobody exports.
    if serial < 61.0 {
        return Err(invalid("Dates before 1900-03-01 can't be stored in xlsx"));
    }
    Ok(serial)
}

fn number(n: f64) -> Result<f64, JsValue> {
    if n.is_finite() {
        Ok(n)
    } else {
        Err(invalid(&format!("{n} can't be stored in xlsx")))
    }
}

fn get(obj: &JsValue, key: &str) -> JsValue {
    Reflect::get(obj, &key.into()).unwrap_or(JsValue::UNDEFINED)
}

/// Append one `<c>` for `v` at (`row`, `col`). Empty cells write nothing.
fn push_cell(out: &mut String, row: u32, col: usize, v: &JsValue) -> Result<(), JsValue> {
    if v.is_null() || v.is_undefined() {
        return Ok(());
    }
    out.push_str("<c r=\"");
    push_col(out, col);
    let _ = write!(out, "{row}\"");
    if let Some(n) = v.as_f64() {
        let _ = write!(out, "><v>{}</v></c>", number(n)?);
    } else if let Some(s) = v.as_string() {
        push_inline_str(out, &s)?;
    } else if let Some(b) = v.as_bool() {
        let _ = write!(out, " t=\"b\"><v>{}</v></c>", b as u8);
    } else if let Some(d) = v.dyn_ref::<Date>() {
        let serial = excel_serial(d)?;
        let xf = if serial.fract() == 0.0 {
            XF_DATE
        } else {
            XF_DATETIME
        };
        let _ = write!(out, " s=\"{xf}\"><v>{serial}</v></c>");
    } else if let Some(f) = get(v, "formula").as_string() {
        let result = get(v, "result");
        let kind = if result.as_string().is_some() {
            " t=\"str\""
        } else if result.as_bool().is_some() {
            " t=\"b\""
        } else {
            ""
        };
        out.push_str(kind);
        out.push_str("><f>");
        push_escaped(out, f.strip_prefix('=').unwrap_or(&f));
        out.push_str("</f>");
        if let Some(n) = result.as_f64() {
            let _ = write!(out, "<v>{}</v>", number(n)?);
        } else if let Some(s) = result.as_string() {
            out.push_str("<v>");
            push_escaped(out, &s);
            out.push_str("</v>");
        } else if let Some(b) = result.as_bool() {
            let _ = write!(out, "<v>{}</v>", b as u8);
        }
        out.push_str("</c>");
    } else if let Some(e) = get(v, "error").as_string() {
        out.push_str(" t=\"e\"><v>");
        push_escaped(out, &e);
        out.push_str("</v></c>");
    } else {
        return Err(invalid(
            "Cells must be string, number, boolean, Date, null, { formula } or { error }",
        ));
    }
    Ok(())
}

fn push_inline_str(out: &mut String, s: &str) -> Result<(), JsValue> {
    if s.encode_utf16().count() > MAX_STRING {
        return Err(invalid("Strings are limited to 32,767 characters in xlsx"));
    }
    let space = s.starts_with(char::is_whitespace) || s.ends_with(char::is_whitespace);
    out.push_str(" t=\"inlineStr\"><is><t");
    if space {
        out.push_str(" xml:space=\"preserve\"");
    }
    out.push('>');
    push_escaped(out, s);
    out.push_str("</t></is></c>");
    Ok(())
}

/// Sheet names: 1-31 chars, none of `[]:*?/\`, no leading/trailing `'`, unique ignoring case.
fn check_sheet_name(name: &str, taken: &[String]) -> Result<(), JsValue> {
    let len = name.chars().count();
    if len == 0 || len > 31 {
        return Err(invalid("Sheet names must be 1 to 31 characters"));
    }
    if name.contains(['[', ']', ':', '*', '?', '/', '\\']) {
        return Err(invalid("Sheet names can't contain [ ] : * ? / \\"));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err(invalid("Sheet names can't start or end with '"));
    }
    let lower = name.to_lowercase();
    if taken.iter().any(|t| t.to_lowercase() == lower) {
        return Err(invalid(&format!("Sheet '{name}' already exists")));
    }
    Ok(())
}

struct Inner {
    /// `None` once saved
    zip: Option<ZipWriter<Cursor<Vec<u8>>>>,
    sheets: Vec<String>,
    /// Rows written to the open sheet (the last in `sheets`)
    rows: u32,
    buf: String,
}

impl Inner {
    fn zip(&mut self) -> Result<&mut ZipWriter<Cursor<Vec<u8>>>, JsValue> {
        self.zip
            .as_mut()
            .ok_or_else(|| error("CLOSED", "The workbook was already saved"))
    }

    fn add_sheet(&mut self, name: &str) -> Result<usize, JsValue> {
        self.zip()?;
        check_sheet_name(name, &self.sheets)?;
        self.close_sheet()?;
        let n = self.sheets.len() + 1;
        let zip = self.zip()?;
        zip.start_file(format!("xl/worksheets/sheet{n}.xml"), opts())
            .map_err(zip_error)?;
        write!(
            zip,
            "{XML}<worksheet xmlns=\"{NS}/spreadsheetml/2006/main\"><sheetData>"
        )
        .map_err(io_error)?;
        self.sheets.push(name.to_owned());
        self.rows = 0;
        Ok(n - 1)
    }

    fn close_sheet(&mut self) -> Result<(), JsValue> {
        if !self.sheets.is_empty() {
            self.zip()?
                .write_all(b"</sheetData></worksheet>")
                .map_err(io_error)?;
        }
        Ok(())
    }

    fn add_row(&mut self, sheet: usize, row: &Array) -> Result<(), JsValue> {
        self.zip()?;
        if sheet + 1 != self.sheets.len() {
            return Err(error(
                "CLOSED",
                &format!(
                    "Sheet '{}' is finished: rows can only go to the last added sheet",
                    self.sheets[sheet]
                ),
            ));
        }
        if self.rows == MAX_ROWS {
            return Err(invalid("xlsx sheets are limited to 1,048,576 rows"));
        }
        if row.length() as usize > MAX_COLS {
            return Err(invalid("xlsx rows are limited to 16,384 columns"));
        }
        let r = self.rows + 1;
        // Build the whole row first, so a bad cell throws without leaving half a row in the file.
        let mut buf = std::mem::take(&mut self.buf);
        buf.clear();
        let _ = write!(buf, "<row r=\"{r}\">");
        let built = row
            .iter()
            .enumerate()
            .try_for_each(|(c, v)| push_cell(&mut buf, r, c, &v));
        buf.push_str("</row>");
        let written = built.and_then(|()| self.zip()?.write_all(buf.as_bytes()).map_err(io_error));
        self.buf = buf;
        written?;
        self.rows = r;
        Ok(())
    }

    fn save(&mut self) -> Result<Vec<u8>, JsValue> {
        self.zip()?;
        if self.sheets.is_empty() {
            self.add_sheet("Sheet1")?;
        }
        self.close_sheet()?;
        let mut zip = self.zip.take().unwrap_throw();
        let sheets = &self.sheets;

        let mut types = format!("{XML}<Types xmlns=\"{NS}/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
        let mut book = format!("{XML}<workbook xmlns=\"{NS}/spreadsheetml/2006/main\" xmlns:r=\"{NS}/officeDocument/2006/relationships\"><sheets>");
        let mut rels = format!("{XML}<Relationships xmlns=\"{NS}/package/2006/relationships\">");
        for (i, name) in sheets.iter().enumerate() {
            let n = i + 1;
            let _ = write!(types, "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
            book.push_str("<sheet name=\"");
            push_escaped(&mut book, name);
            let _ = write!(book, "\" sheetId=\"{n}\" r:id=\"rId{n}\"/>");
            let _ = write!(rels, "<Relationship Id=\"rId{n}\" Type=\"{NS}/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>");
        }
        types.push_str("</Types>");
        // fullCalcOnLoad: formulas written without a cached result get computed when Excel opens the file
        book.push_str("</sheets><calcPr calcId=\"0\" fullCalcOnLoad=\"1\"/></workbook>");
        let _ = write!(rels, "<Relationship Id=\"rId{}\" Type=\"{NS}/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>", sheets.len() + 1);
        let root_rels = format!("{XML}<Relationships xmlns=\"{NS}/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{NS}/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
        let styles = format!("{XML}{STYLES}");

        for (name, body) in [
            ("[Content_Types].xml", &types),
            ("_rels/.rels", &root_rels),
            ("xl/workbook.xml", &book),
            ("xl/_rels/workbook.xml.rels", &rels),
            ("xl/styles.xml", &styles),
        ] {
            zip.start_file(name, opts()).map_err(zip_error)?;
            zip.write_all(body.as_bytes()).map_err(io_error)?;
        }
        Ok(zip.finish().map_err(zip_error)?.into_inner())
    }
}

fn opts() -> SimpleFileOptions {
    SimpleFileOptions::default()
}

fn zip_error(e: zip::result::ZipError) -> JsValue {
    js_sys::Error::new(&e.to_string()).into()
}

fn io_error(e: std::io::Error) -> JsValue {
    js_sys::Error::new(&e.to_string()).into()
}

/// Builds an xlsx file. Rows are compressed as they arrive, so memory stays low on big files.
/// Sheets are written in order: once you add a sheet, earlier sheets take no more rows.
#[wasm_bindgen]
pub struct XlsxWriter {
    inner: Rc<RefCell<Inner>>,
}

#[wasm_bindgen]
impl XlsxWriter {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> XlsxWriter {
        XlsxWriter {
            inner: Rc::new(RefCell::new(Inner {
                zip: Some(ZipWriter::new(Cursor::new(Vec::new()))),
                sheets: Vec::new(),
                rows: 0,
                buf: String::new(),
            })),
        }
    }

    /// Start a new sheet. The previous sheet is finished and takes no more rows.
    #[wasm_bindgen(js_name = addSheet)]
    pub fn add_sheet(&self, name: &str) -> Result<SheetWriter, JsValue> {
        let index = self.inner.borrow_mut().add_sheet(name)?;
        Ok(SheetWriter {
            inner: self.inner.clone(),
            index,
        })
    }

    /// Finish the file and return its bytes. The writer can't be used afterwards.
    pub fn save(&self) -> Result<Vec<u8>, JsValue> {
        self.inner.borrow_mut().save()
    }
}

/// One sheet of an `XlsxWriter`.
#[wasm_bindgen]
pub struct SheetWriter {
    inner: Rc<RefCell<Inner>>,
    index: usize,
}

#[wasm_bindgen]
impl SheetWriter {
    /// Append a row. `null`/`undefined` leave a cell empty.
    #[wasm_bindgen(js_name = addRow)]
    pub fn add_row(
        &self,
        #[wasm_bindgen(unchecked_param_type = "WriteCell[]")] row: Array,
    ) -> Result<(), JsValue> {
        self.inner.borrow_mut().add_row(self.index, &row)
    }
}

/// Rows as arrays. Objects become arrays in header order: the keys of all rows, first seen first.
fn normalize(rows: &Array) -> Result<Vec<Array>, JsValue> {
    let mixed = || invalid("Rows must all be arrays or all be objects");
    let is_objects = rows
        .iter()
        .find(|r| !r.is_null() && !r.is_undefined())
        .is_some_and(|r| !Array::is_array(&r));
    if !is_objects {
        return rows
            .iter()
            .map(|r| match r.dyn_into::<Array>() {
                Ok(a) => Ok(a),
                Err(r) if r.is_null() || r.is_undefined() => Ok(Array::new()),
                Err(_) => Err(mixed()),
            })
            .collect();
    }
    let mut keys: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for r in rows.iter() {
        if Array::is_array(&r) {
            return Err(mixed());
        }
        if r.is_object() {
            for k in Object::keys(r.unchecked_ref::<Object>()).iter() {
                let k = k.as_string().unwrap_throw();
                if seen.insert(k.clone()) {
                    keys.push(k);
                }
            }
        }
    }
    let mut out = vec![keys
        .iter()
        .map(|k| JsValue::from(k.as_str()))
        .collect::<Array>()];
    for r in rows.iter() {
        out.push(keys.iter().map(|k| get(&r, k)).collect());
    }
    Ok(out)
}

/// Write a whole workbook at once: `{ SheetName: rows }`, rows as arrays or objects
/// (objects get a header row from their keys).
#[wasm_bindgen(js_name = writeXlsx)]
pub fn write_xlsx(
    #[wasm_bindgen(unchecked_param_type = "Record<string, WriteRow[]>")] sheets: Object,
) -> Result<Vec<u8>, JsValue> {
    let wb = XlsxWriter::new();
    for entry in Object::entries(&sheets).iter() {
        let entry: Array = entry.unchecked_into();
        let name = entry.get(0).as_string().unwrap_throw();
        let rows: Array = entry
            .get(1)
            .dyn_into()
            .map_err(|_| invalid(&format!("Sheet '{name}' must be an array of rows")))?;
        let ws = wb.add_sheet(&name)?;
        for row in normalize(&rows)? {
            ws.add_row(row)?;
        }
    }
    wb.save()
}

fn csv_field(v: &JsValue, escape_formulas: bool) -> String {
    if v.is_null() || v.is_undefined() {
        return String::new();
    }
    if let Some(s) = v.as_string() {
        let risky = s.starts_with(['=', '+', '-', '@', '\t', '\r']);
        return if escape_formulas && risky {
            format!("'{s}")
        } else {
            s
        };
    }
    if let Some(d) = v.dyn_ref::<Date>() {
        return if d.get_time().is_nan() {
            String::new()
        } else {
            d.to_iso_string().into()
        };
    }
    if v.is_object() && !Array::is_array(v) {
        let result = get(v, "result");
        let value = if result.is_undefined() {
            get(v, "error")
        } else {
            result
        };
        return csv_field(&value, escape_formulas);
    }
    // numbers and booleans: same text as JS String(v)
    v.unchecked_ref::<Object>().to_string().into()
}

/// Rows (arrays or objects) to CSV text. Formula cells write their `result`, error cells their code.
#[wasm_bindgen(js_name = toCsv)]
pub fn to_csv(
    #[wasm_bindgen(unchecked_param_type = "WriteRow[]")] rows: Array,
    #[wasm_bindgen(unchecked_optional_param_type = "CsvOptions")] options: Option<Object>,
) -> Result<String, JsValue> {
    let opt = |key| options.as_ref().map_or(JsValue::UNDEFINED, |o| get(o, key));
    let delimiter = match opt("delimiter").as_string() {
        None => b',',
        Some(d) if d.len() == 1 => d.as_bytes()[0],
        Some(_) => return Err(invalid("delimiter must be a single ASCII character")),
    };
    let escape_formulas = opt("escapeFormulas").as_bool().unwrap_or(true);
    let mut w = csv::WriterBuilder::new()
        .flexible(true)
        .delimiter(delimiter)
        .from_writer(Vec::new());
    for row in normalize(&rows)? {
        w.write_record(row.iter().map(|v| csv_field(&v, escape_formulas)))
            .map_err(|e| invalid(&e.to_string()))?;
    }
    let bytes = w.into_inner().map_err(|e| invalid(&e.to_string()))?;
    let text = String::from_utf8(bytes).unwrap_throw();
    Ok(if opt("bom").as_bool() == Some(true) {
        format!("\u{FEFF}{text}")
    } else {
        text
    })
}
