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

mod rules;
mod styles;
use styles::{Kind, Styles};

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r##"
export type WriteValue = string | number | boolean | Date | null | undefined;
declare const formatBrand: unique symbol;
/** A cell format, made by `XlsxWriter.format()`. Only valid on the writer that made it. */
export type Format = number & { readonly [formatBrand]: true };
export type WriteCell =
  | WriteValue
  | { value: WriteValue; format?: Format }
  | { value?: WriteValue; format: Format }
  | { formula: string; result?: string | number | boolean; format?: Format }
  | { error: string; format?: Format };
export type BorderStyle =
  | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair" | "mediumDashed"
  | "dashDot" | "mediumDashDot" | "dashDotDot" | "mediumDashDotDot" | "slantDashDot";
export interface FormatSpec {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font name. Default Calibri. */
  font?: string;
  /** Font size in points. Default 11. */
  size?: number;
  /** Font color, like "#1f6feb". */
  color?: string;
  /** Background color, like "#e8f5e9". */
  fill?: string;
  /** One style for all four sides, or per side. */
  border?: BorderStyle | { top?: BorderStyle; bottom?: BorderStyle; left?: BorderStyle; right?: BorderStyle };
  borderColor?: string;
  align?: "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
  valign?: "top" | "center" | "bottom" | "justify" | "distributed";
  wrap?: boolean;
  /** Excel number format code, like "#,##0.00", "0%" or "dd/mm/yyyy". */
  numFmt?: string;
}
export interface ColumnOptions {
  /** Width in characters. */
  width?: number;
  /** Format for this column's cells that don't set their own (row formats win over it). */
  format?: Format;
  hidden?: boolean;
}
export interface SheetOptions {
  /** Per column, from A. Use `null` to skip a column. */
  columns?: (ColumnOptions | null | undefined)[];
  /** Keep the top rows and/or left columns visible while scrolling. */
  freeze?: { rows?: number; cols?: number };
  /** `true` filters the written range (header in the first row), or give a range like "A1:D1". */
  autofilter?: boolean | string;
}
export interface RowOptions {
  /** Format for this row's cells that don't set their own. */
  format?: Format;
  /** Row height in points. */
  height?: number;
}
export type WriteRow = WriteCell[] | Record<string, WriteCell>;
export interface CsvOptions {
  /** Field separator. Default `,`. */
  delimiter?: string;
  /** Prefix `'` to strings starting with `= + - @`, tab or CR, so spreadsheet apps don't run them as formulas. Default `true`. */
  escapeFormulas?: boolean;
  /** Start with a UTF-8 BOM, so Excel reads non-ASCII text correctly. Default `false`. */
  bom?: boolean;
}
export type RuleValue = number | string | Date | { formula: string };
export type Operator =
  | "between" | "notBetween" | "equal" | "notEqual"
  | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual";
export type ConditionalFormat =
  /** Compare each cell's value. Strings are text; use `{ formula }` for formulas. */
  | { type: "cell"; operator?: Operator; value: RuleValue; value2?: RuleValue; format: Format }
  /** Formula relative to the range's top-left cell, like "$C2>100". */
  | { type: "formula"; formula: string; format: Format }
  | { type: "colorScale"; min?: string; mid?: string; max?: string }
  | { type: "dataBar"; color?: string };
export interface ValidationMessages {
  /** Shown when the cell is selected. */
  input?: { title?: string; message?: string };
  /** Shown on invalid input. `stop` (default) rejects it. */
  error?: { title?: string; message?: string; style?: "stop" | "warning" | "information" };
  /** Allow empty cells. Default `true`. */
  allowBlank?: boolean;
}
export type Validation = ValidationMessages & (
  /** A dropdown of `values`, or of the cells in `source` (like "$H$1:$H$9"). */
  | { type: "list"; values?: (string | number)[]; source?: string; dropdown?: boolean }
  | { type: "whole" | "decimal" | "date" | "textLength"; operator?: Operator; value: RuleValue; value2?: RuleValue }
  | { type: "custom"; formula: string }
);
export interface TableOptions {
  /** Header names; the header row is written for you. */
  columns: string[];
  /** Unique in the workbook, letters/digits/_/. only. Default Table1, Table2, ... */
  name?: string;
  /** An Excel table style like "TableStyleMedium2" (default), "TableStyleLight9" or "TableStyleDark1". */
  style?: string;
  headerFormat?: Format;
}
export type WriterErrorCode = "INVALID_INPUT" | "CLOSED";
"##;

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

const XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NS: &str = "http://schemas.openxmlformats.org";

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

/// Whole numbers skip float formatting (most cells: ids, counts, dates).
fn push_number(out: &mut String, n: f64) {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        let _ = write!(out, "{}", n as i64);
    } else {
        let _ = write!(out, "{n}");
    }
}

const EMPTY: u32 = 0;
const NUMBER: u32 = 1;
const STRING: u32 = 2;
const FALSE: u32 = 3;
const TRUE: u32 = 4;
const DATE: u32 = 5;
const OBJECT: u32 = 6;

#[wasm_bindgen(inline_js = "export function cell_kind(v) {
  switch (typeof v) {
    case 'number': return 1;
    case 'string': return 2;
    case 'boolean': return v ? 4 : 3;
    case 'undefined': return 0;
    case 'object': return v === null ? 0 : v instanceof Date ? 5 : 6;
    default: return 7;
  }
}")]
extern "C" {
    /// One call instead of a chain of is_null/as_f64/as_string/... checks per cell.
    fn cell_kind(v: &JsValue) -> u32;
}

fn get(obj: &JsValue, key: &str) -> JsValue {
    Reflect::get(obj, &key.into()).unwrap_or(JsValue::UNDEFINED)
}

fn has(obj: &JsValue, key: &str) -> bool {
    Reflect::has(obj, &key.into()).unwrap_or(false)
}

/// Append one `<c>` for `v` at (`row`, `col`). `default` is the row or column format, used when
/// the cell sets none. Empty cells write nothing unless they carry a format.
fn push_cell(
    out: &mut String,
    styles: &mut Styles,
    row: u32,
    col: usize,
    v: &JsValue,
    default: Option<u32>,
) -> Result<(), JsValue> {
    // Every check is a call into JS, so the type comes from one call (cell_kind) up front
    let mut kind = cell_kind(v);
    if kind == EMPTY {
        return Ok(());
    }
    // { value, format }: unwrap; { formula | error, format }: keep the object, take its format
    let mut format = default;
    let unwrapped;
    let mut v = v;
    if kind == OBJECT && !Array::is_array(v) {
        if has(v, "format") {
            format = styles.id(&get(v, "format"))?.or(default);
        }
        if has(v, "value") {
            unwrapped = get(v, "value");
            v = &unwrapped;
            kind = cell_kind(v);
        } else if has(v, "format") && !has(v, "formula") && !has(v, "error") {
            kind = EMPTY;
        }
    }
    let serial = if kind == DATE {
        Some(excel_serial(v.unchecked_ref::<Date>())?)
    } else {
        None
    };
    let style = match serial {
        Some(s) if s.fract() == 0.0 => Kind::Date,
        Some(_) => Kind::DateTime,
        None => Kind::Plain,
    };
    if kind == EMPTY && format.is_none() {
        return Ok(());
    }
    out.push_str("<c r=\"");
    push_col(out, col);
    let _ = write!(out, "{row}\"");
    let xf = styles.xf(format, style);
    if xf != 0 {
        let _ = write!(out, " s=\"{xf}\"");
    }
    if kind == EMPTY {
        out.push_str("/>");
    } else if kind == NUMBER {
        out.push_str("><v>");
        push_number(out, number(v.as_f64().unwrap_throw())?);
        out.push_str("</v></c>");
    } else if kind == STRING {
        push_inline_str(out, &v.as_string().unwrap_throw())?;
    } else if kind == FALSE || kind == TRUE {
        let _ = write!(out, " t=\"b\"><v>{}</v></c>", (kind == TRUE) as u8);
    } else if let Some(serial) = serial {
        out.push_str("><v>");
        push_number(out, serial);
        out.push_str("</v></c>");
    } else if kind != OBJECT {
        return Err(invalid(
            "Cells must be string, number, boolean, Date, null, { value, format }, { formula } or { error }",
        ));
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
            "Cells must be string, number, boolean, Date, null, { value, format }, { formula } or { error }",
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

/// "B3" -> (row 2, col 1), 0-based.
fn parse_ref(s: &str) -> Option<(u32, usize)> {
    let split = s.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = s.split_at(split);
    if letters.is_empty() || letters.len() > 3 || !letters.bytes().all(|b| b.is_ascii_uppercase()) {
        return None;
    }
    let col = letters
        .bytes()
        .fold(0usize, |n, b| n * 26 + (b - b'A' + 1) as usize)
        - 1;
    let row: u32 = digits.parse().ok()?;
    (!digits.starts_with('0') && (1..=MAX_ROWS).contains(&row) && col < MAX_COLS)
        .then_some((row - 1, col))
}

/// A cell range, 0-based and inclusive, top-left first.
#[derive(Clone, Copy)]
struct Area {
    r1: u32,
    c1: usize,
    r2: u32,
    c2: usize,
}

impl Area {
    /// "A1:C3" (or one cell "B2"), any corner order.
    fn parse(s: &str) -> Result<Area, JsValue> {
        let bad = || invalid(&format!("'{s}' is not a range like \"A1:C3\""));
        let (a, b) = s.split_once(':').unwrap_or((s, s));
        let (ra, ca) = parse_ref(a).ok_or_else(bad)?;
        let (rb, cb) = parse_ref(b).ok_or_else(bad)?;
        Ok(Area {
            r1: ra.min(rb),
            c1: ca.min(cb),
            r2: ra.max(rb),
            c2: ca.max(cb),
        })
    }

    fn overlaps(&self, o: &Area) -> bool {
        self.r1 <= o.r2 && o.r1 <= self.r2 && self.c1 <= o.c2 && o.c1 <= self.c2
    }

    /// "A1:C3", or "$A$1:$C$3" with `abs`.
    fn push(&self, out: &mut String, abs: bool) {
        let d = if abs { "$" } else { "" };
        for (i, (r, c)) in [(self.r1, self.c1), (self.r2, self.c2)]
            .into_iter()
            .enumerate()
        {
            if i == 1 {
                out.push(':');
            }
            out.push_str(d);
            push_col(out, c);
            let _ = write!(out, "{d}{}", r + 1);
        }
    }
}

fn non_negative(v: &JsValue, what: &str, max: f64) -> Result<Option<f64>, JsValue> {
    if v.is_undefined() || v.is_null() {
        return Ok(None);
    }
    match v.as_f64() {
        Some(n) if (0.0..=max).contains(&n) => Ok(Some(n)),
        _ => Err(invalid(&format!("{what} must be a number from 0 to {max}"))),
    }
}

fn check_keys(obj: &JsValue, what: &str, allowed: &[&str]) -> Result<(), JsValue> {
    for k in Object::keys(obj.unchecked_ref::<Object>()).iter() {
        let k = k.as_string().unwrap_throw();
        if !allowed.contains(&k.as_str()) {
            return Err(invalid(&format!(
                "Unknown {what} option '{k}' (expected {})",
                allowed.join(", ")
            )));
        }
    }
    Ok(())
}

/// Autofilter for a sheet: the written range (`true`) or a fixed one.
enum Filter {
    Written,
    Range(Area),
}

/// The sheet currently being written.
/// An Excel table: header row at `first`, data rows until `last` (`None` while still open).
struct Table {
    /// Workbook-wide id, also its file number (xl/tables/table{id}.xml)
    id: usize,
    name: String,
    columns: Vec<String>,
    style: String,
    first: u32,
    last: Option<u32>,
}

impl Table {
    fn area(&self) -> Area {
        Area {
            r1: self.first,
            c1: 0,
            r2: self.last.unwrap_or(MAX_ROWS - 1),
            c2: self.columns.len() - 1,
        }
    }
}

fn check_table_name(name: &str, taken: &[String]) -> Result<(), JsValue> {
    let valid = name.len() <= 255
        && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_' || c == '\\')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '\\'));
    let upper = name.to_ascii_uppercase();
    let cell_like = parse_ref(&upper).is_some()
        || upper == "R"
        || upper == "C"
        || (upper.starts_with('R')
            && upper[1..]
                .split('C')
                .all(|p| p.bytes().all(|b| b.is_ascii_digit())));
    if !valid || cell_like {
        return Err(invalid(&format!(
            "'{name}' isn't a valid table name: use letters, digits, _ and ., start with a letter, and don't look like a cell (A1, R1C1)"
        )));
    }
    if taken.iter().any(|t| t.eq_ignore_ascii_case(name)) {
        return Err(invalid(&format!("A table named '{name}' already exists")));
    }
    Ok(())
}

/// Excel's built-in table styles (anything else makes Excel repair the file).
fn check_table_style(style: &str) -> Result<(), JsValue> {
    let ok = [
        ("TableStyleLight", 21),
        ("TableStyleMedium", 28),
        ("TableStyleDark", 11),
    ]
    .iter()
    .any(|(prefix, max)| {
        style.strip_prefix(prefix).is_some_and(|digits| {
            // "Medium2", not "Medium02"
            digits
                .parse::<u32>()
                .is_ok_and(|n| (1..=*max).contains(&n) && digits == n.to_string())
        })
    });
    if ok {
        Ok(())
    } else {
        Err(invalid(&format!(
            "'{style}' isn't an Excel table style: use TableStyleLight1-21, TableStyleMedium1-28 or TableStyleDark1-11"
        )))
    }
}

#[derive(Default)]
struct Sheet {
    rows: u32,
    /// Widest row so far (columns)
    width: usize,
    columns: Vec<Option<u32>>,
    merges: Vec<Area>,
    filter: Option<Filter>,
    /// <conditionalFormatting> elements, and the rule priority counter they share
    conditionals: Vec<String>,
    priority: u32,
    validations: Vec<String>,
    tables: Vec<Table>,
}

struct Inner {
    /// `None` once saved
    zip: Option<ZipWriter<Cursor<Vec<u8>>>>,
    sheets: Vec<String>,
    /// The open sheet (the last in `sheets`)
    sheet: Sheet,
    /// (sheet index, range) of each autofilter, for workbook.xml's _FilterDatabase names
    filters: Vec<(usize, Area)>,
    /// Table names across the workbook, and how many tables were written (their ids)
    table_names: Vec<String>,
    table_count: usize,
    styles: Styles,
    buf: String,
}

impl Inner {
    fn zip(&mut self) -> Result<&mut ZipWriter<Cursor<Vec<u8>>>, JsValue> {
        self.zip
            .as_mut()
            .ok_or_else(|| error("CLOSED", "The workbook was already saved"))
    }

    fn add_sheet(&mut self, name: &str, options: &JsValue) -> Result<usize, JsValue> {
        self.zip()?;
        check_sheet_name(name, &self.sheets)?;
        // Everything before <sheetData> has to be known now: parse options before writing anything.
        let mut head = format!("{XML}<worksheet xmlns=\"{NS}/spreadsheetml/2006/main\" xmlns:r=\"{NS}/officeDocument/2006/relationships\">");
        let mut sheet = Sheet::default();
        if !options.is_undefined() && !options.is_null() {
            check_keys(options, "sheet", &["columns", "freeze", "autofilter"])?;
            self.push_freeze(&mut head, &get(options, "freeze"))?;
            self.push_columns(&mut head, &get(options, "columns"), &mut sheet)?;
            let filter = get(options, "autofilter");
            sheet.filter = match filter.as_bool() {
                Some(true) => Some(Filter::Written),
                Some(false) => None,
                None if filter.is_undefined() => None,
                None => match filter.as_string() {
                    Some(r) => Some(Filter::Range(Area::parse(&r)?)),
                    None => {
                        return Err(invalid("autofilter must be true or a range like \"A1:D1\""))
                    }
                },
            };
        }
        head.push_str("<sheetData>");

        self.close_sheet()?;
        let n = self.sheets.len() + 1;
        let zip = self.zip()?;
        zip.start_file(format!("xl/worksheets/sheet{n}.xml"), opts())
            .map_err(zip_error)?;
        zip.write_all(head.as_bytes()).map_err(io_error)?;
        self.sheets.push(name.to_owned());
        self.sheet = sheet;
        Ok(n - 1)
    }

    fn push_freeze(&self, out: &mut String, freeze: &JsValue) -> Result<(), JsValue> {
        if freeze.is_undefined() || freeze.is_null() {
            return Ok(());
        }
        if !freeze.is_object() {
            return Err(invalid("freeze must be { rows, cols }"));
        }
        check_keys(freeze, "freeze", &["rows", "cols"])?;
        let count = |key, max: u32| -> Result<u32, JsValue> {
            match non_negative(
                &get(freeze, key),
                &format!("freeze.{key}"),
                (max - 1) as f64,
            )? {
                Some(n) if n.fract() == 0.0 => Ok(n as u32),
                None => Ok(0),
                Some(_) => Err(invalid(&format!("freeze.{key} must be a whole number"))),
            }
        };
        let (rows, cols) = (count("rows", MAX_ROWS)?, count("cols", MAX_COLS as u32)?);
        if rows == 0 && cols == 0 {
            return Ok(());
        }
        let pane = match (rows > 0, cols > 0) {
            (true, true) => "bottomRight",
            (true, false) => "bottomLeft",
            _ => "topRight",
        };
        out.push_str("<sheetViews><sheetView workbookViewId=\"0\"><pane");
        if cols > 0 {
            let _ = write!(out, " xSplit=\"{cols}\"");
        }
        if rows > 0 {
            let _ = write!(out, " ySplit=\"{rows}\"");
        }
        out.push_str(" topLeftCell=\"");
        push_col(out, cols as usize);
        let _ = write!(out, "{}\" activePane=\"{pane}\" state=\"frozen\"/><selection pane=\"{pane}\"/></sheetView></sheetViews>", rows + 1);
        Ok(())
    }

    fn push_columns(
        &mut self,
        out: &mut String,
        columns: &JsValue,
        sheet: &mut Sheet,
    ) -> Result<(), JsValue> {
        if columns.is_undefined() || columns.is_null() {
            return Ok(());
        }
        let columns: &Array = columns
            .dyn_ref()
            .ok_or_else(|| invalid("columns must be an array"))?;
        if columns.length() as usize > MAX_COLS {
            return Err(invalid("xlsx sheets are limited to 16,384 columns"));
        }
        let mut cols = String::new();
        for (i, c) in columns.iter().enumerate() {
            if c.is_undefined() || c.is_null() {
                sheet.columns.push(None);
                continue;
            }
            if !c.is_object() {
                return Err(invalid(
                    "Each column must be { width, format, hidden } or null",
                ));
            }
            check_keys(&c, "column", &["width", "format", "hidden"])?;
            let width = non_negative(&get(&c, "width"), "width", 255.0)?;
            let format = self.styles.id(&get(&c, "format"))?;
            let hidden = get(&c, "hidden").as_bool() == Some(true);
            sheet.columns.push(format);
            if width.is_none() && format.is_none() && !hidden {
                continue;
            }
            let _ = write!(cols, "<col min=\"{0}\" max=\"{0}\"", i + 1);
            // Excel needs a width on every <col>; 8.43 is its default
            let _ = write!(cols, " width=\"{}\"", width.unwrap_or(8.43));
            if width.is_some() {
                cols.push_str(" customWidth=\"1\"");
            }
            if let Some(f) = format {
                let _ = write!(cols, " style=\"{}\"", self.styles.xf(Some(f), Kind::Plain));
            }
            if hidden {
                cols.push_str(" hidden=\"1\"");
            }
            cols.push_str("/>");
        }
        if !cols.is_empty() {
            let _ = write!(out, "<cols>{cols}</cols>");
        }
        Ok(())
    }

    fn close_sheet(&mut self) -> Result<(), JsValue> {
        if self.sheets.is_empty() {
            return Ok(());
        }
        self.end_table()?;
        let sheet = std::mem::take(&mut self.sheet);
        let mut tail = String::from("</sheetData>");
        let filter = match sheet.filter {
            Some(Filter::Range(a)) => Some(a),
            Some(Filter::Written) if sheet.rows > 0 && sheet.width > 0 => Some(Area {
                r1: 0,
                c1: 0,
                r2: sheet.rows - 1,
                c2: sheet.width - 1,
            }),
            _ => None,
        };
        if let Some(a) = filter {
            tail.push_str("<autoFilter ref=\"");
            a.push(&mut tail, false);
            tail.push_str("\"/>");
            self.filters.push((self.sheets.len() - 1, a));
        }
        if !sheet.merges.is_empty() {
            let _ = write!(tail, "<mergeCells count=\"{}\">", sheet.merges.len());
            for m in &sheet.merges {
                tail.push_str("<mergeCell ref=\"");
                m.push(&mut tail, false);
                tail.push_str("\"/>");
            }
            tail.push_str("</mergeCells>");
        }
        tail.push_str(&sheet.conditionals.concat());
        if !sheet.validations.is_empty() {
            let _ = write!(
                tail,
                "<dataValidations count=\"{}\">{}</dataValidations>",
                sheet.validations.len(),
                sheet.validations.concat()
            );
        }
        if !sheet.tables.is_empty() {
            let _ = write!(tail, "<tableParts count=\"{}\">", sheet.tables.len());
            for i in 1..=sheet.tables.len() {
                let _ = write!(tail, "<tablePart r:id=\"rId{i}\"/>");
            }
            tail.push_str("</tableParts>");
        }
        tail.push_str("</worksheet>");
        let n = self.sheets.len();
        let zip = self.zip()?;
        zip.write_all(tail.as_bytes()).map_err(io_error)?;
        if sheet.tables.is_empty() {
            return Ok(());
        }
        let mut rels = format!("{XML}<Relationships xmlns=\"{NS}/package/2006/relationships\">");
        for (i, t) in sheet.tables.iter().enumerate() {
            let _ = write!(rels, "<Relationship Id=\"rId{}\" Type=\"{NS}/officeDocument/2006/relationships/table\" Target=\"../tables/table{}.xml\"/>", i + 1, t.id);
            zip.start_file(format!("xl/tables/table{}.xml", t.id), opts())
                .map_err(zip_error)?;
            zip.write_all(table_xml(t).as_bytes()).map_err(io_error)?;
        }
        rels.push_str("</Relationships>");
        zip.start_file(format!("xl/worksheets/_rels/sheet{n}.xml.rels"), opts())
            .map_err(zip_error)?;
        zip.write_all(rels.as_bytes()).map_err(io_error)
    }

    fn add_table(&mut self, sheet: usize, options: &JsValue) -> Result<(), JsValue> {
        self.open_sheet(sheet)?;
        if !options.is_object() {
            return Err(invalid("addTable needs { columns: [...] }"));
        }
        check_keys(
            options,
            "table",
            &["columns", "name", "style", "headerFormat"],
        )?;
        if self.sheet.filter.is_some() {
            return Err(invalid(
                "This sheet has an autofilter; tables bring their own filter, so use one or the other",
            ));
        }
        let columns: Vec<String> = get(options, "columns")
            .dyn_into::<Array>()
            .ok()
            .and_then(|a| a.iter().map(|c| c.as_string()).collect::<Option<Vec<_>>>())
            .filter(|c| !c.is_empty() && c.len() <= MAX_COLS)
            .ok_or_else(|| invalid("columns must be a non-empty array of header names"))?;
        let mut seen = HashSet::new();
        for c in &columns {
            if c.is_empty() || c.chars().count() > 255 || c.chars().any(char::is_control) {
                return Err(invalid(&format!(
                    "Table column '{c}' must be 1 to 255 characters, without line breaks"
                )));
            }
            if !seen.insert(c.to_lowercase()) {
                return Err(invalid(&format!("Table column '{c}' appears twice")));
            }
        }
        let name = match get(options, "name").as_string() {
            Some(n) => n,
            None if get(options, "name").is_undefined() => {
                format!("Table{}", self.table_count + 1)
            }
            None => return Err(invalid("name must be a string")),
        };
        check_table_name(&name, &self.table_names)?;
        let style = get(options, "style")
            .as_string()
            .unwrap_or_else(|| "TableStyleMedium2".into());
        check_table_style(&style)?;

        self.end_table()?;
        let area = Area {
            r1: self.sheet.rows,
            c1: 0,
            r2: MAX_ROWS - 1,
            c2: columns.len() - 1,
        };
        if self.sheet.merges.iter().any(|m| m.overlaps(&area)) {
            return Err(invalid("This table would overlap a merged range"));
        }
        let header: Array = columns.iter().map(|c| JsValue::from(c.as_str())).collect();
        self.add_row(sheet, &header, &get(options, "headerFormat"))?;
        self.table_count += 1;
        self.table_names.push(name.clone());
        self.sheet.tables.push(Table {
            id: self.table_count,
            name,
            columns,
            style,
            first: self.sheet.rows - 1,
            last: None,
        });
        Ok(())
    }

    /// Close the open table (if any) at the last written row.
    fn end_table(&mut self) -> Result<(), JsValue> {
        let rows = self.sheet.rows;
        let Some(t) = self.sheet.tables.last_mut().filter(|t| t.last.is_none()) else {
            return Ok(());
        };
        if rows == t.first + 1 {
            // A table needs a data row: reserve an empty one
            self.sheet.rows += 1;
        }
        t.last = Some(self.sheet.rows - 1);
        let area = t.area();
        if self.sheet.merges.iter().any(|m| m.overlaps(&area)) {
            return Err(invalid(&format!(
                "Table '{}' overlaps a merged range",
                t.name
            )));
        }
        Ok(())
    }

    fn conditional_format(
        &mut self,
        sheet: usize,
        range: &str,
        rule: &JsValue,
    ) -> Result<(), JsValue> {
        self.open_sheet(sheet)?;
        let area = Area::parse(range)?;
        let xml = rules::conditional(&area, rule, &mut self.styles, &mut self.sheet.priority)?;
        self.sheet.conditionals.push(xml);
        Ok(())
    }

    fn validate(&mut self, sheet: usize, range: &str, rule: &JsValue) -> Result<(), JsValue> {
        self.open_sheet(sheet)?;
        let area = Area::parse(range)?;
        let xml = rules::validation(&area, rule)?;
        self.sheet.validations.push(xml);
        Ok(())
    }

    fn open_sheet(&mut self, sheet: usize) -> Result<(), JsValue> {
        self.zip()?;
        if sheet + 1 != self.sheets.len() {
            return Err(error(
                "CLOSED",
                &format!(
                    "Sheet '{}' is finished: only the last added sheet can change",
                    self.sheets[sheet]
                ),
            ));
        }
        Ok(())
    }

    fn merge(&mut self, sheet: usize, range: &str) -> Result<(), JsValue> {
        self.open_sheet(sheet)?;
        let area = Area::parse(range)?;
        if area.r1 == area.r2 && area.c1 == area.c2 {
            return Err(invalid("A merge needs at least two cells"));
        }
        // ponytail: O(n) per merge, O(n²) per sheet; fine for hand-made reports, index if someone merges 100k ranges
        if self.sheet.merges.iter().any(|m| m.overlaps(&area)) {
            return Err(invalid(&format!("'{range}' overlaps another merged range")));
        }
        if self.sheet.tables.iter().any(|t| t.area().overlaps(&area)) {
            return Err(invalid(&format!("'{range}' overlaps a table")));
        }
        self.sheet.merges.push(area);
        Ok(())
    }

    fn add_row(&mut self, sheet: usize, row: &Array, options: &JsValue) -> Result<(), JsValue> {
        self.open_sheet(sheet)?;
        // a Format, or { format, height }
        let (format, height) = if options.is_object() {
            check_keys(options, "row", &["format", "height"])?;
            (
                self.styles.id(&get(options, "format"))?,
                non_negative(&get(options, "height"), "height", 409.0)?,
            )
        } else {
            (self.styles.id(options)?, None)
        };
        if self.sheet.rows == MAX_ROWS {
            return Err(invalid("xlsx sheets are limited to 1,048,576 rows"));
        }
        if row.length() as usize > MAX_COLS {
            return Err(invalid("xlsx rows are limited to 16,384 columns"));
        }
        let r = self.sheet.rows + 1;
        // Build the whole row first, so a bad cell throws without leaving half a row in the file.
        let mut buf = std::mem::take(&mut self.buf);
        buf.clear();
        let _ = write!(buf, "<row r=\"{r}\"");
        if let Some(h) = height {
            let _ = write!(buf, " ht=\"{h}\" customHeight=\"1\"");
        }
        buf.push('>');
        let (styles, columns) = (&mut self.styles, &self.sheet.columns);
        let built = row.iter().enumerate().try_for_each(|(c, v)| {
            let default = format.or_else(|| columns.get(c).copied().flatten());
            push_cell(&mut buf, styles, r, c, &v, default)
        });
        buf.push_str("</row>");
        let written = built.and_then(|()| self.zip()?.write_all(buf.as_bytes()).map_err(io_error));
        self.buf = buf;
        written?;
        self.sheet.rows = r;
        self.sheet.width = self.sheet.width.max(row.length() as usize);
        Ok(())
    }

    fn save(&mut self) -> Result<Vec<u8>, JsValue> {
        self.zip()?;
        if self.sheets.is_empty() {
            self.add_sheet("Sheet1", &JsValue::UNDEFINED)?;
        }
        self.close_sheet()?;
        let mut zip = self.zip.take().unwrap_throw();
        let sheets = &self.sheets;

        let mut types = format!("{XML}<Types xmlns=\"{NS}/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
        let mut book = format!("{XML}<workbook xmlns=\"{NS}/spreadsheetml/2006/main\" xmlns:r=\"{NS}/officeDocument/2006/relationships\"><bookViews><workbookView/></bookViews><sheets>");
        let mut rels = format!("{XML}<Relationships xmlns=\"{NS}/package/2006/relationships\">");
        for (i, name) in sheets.iter().enumerate() {
            let n = i + 1;
            let _ = write!(types, "<Override PartName=\"/xl/worksheets/sheet{n}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
            book.push_str("<sheet name=\"");
            push_escaped(&mut book, name);
            let _ = write!(book, "\" sheetId=\"{n}\" r:id=\"rId{n}\"/>");
            let _ = write!(rels, "<Relationship Id=\"rId{n}\" Type=\"{NS}/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{n}.xml\"/>");
        }
        for id in 1..=self.table_count {
            let _ = write!(types, "<Override PartName=\"/xl/tables/table{id}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml\"/>");
        }
        types.push_str("</Types>");
        // fullCalcOnLoad: formulas written without a cached result get computed when Excel opens the file
        book.push_str("</sheets>");
        // Excel expects a hidden _FilterDatabase name for each autofilter
        if !self.filters.is_empty() {
            book.push_str("<definedNames>");
            for (i, area) in &self.filters {
                let _ = write!(book, "<definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"{i}\" hidden=\"1\">'");
                push_escaped(&mut book, &sheets[*i].replace('\'', "''"));
                book.push_str("'!");
                area.push(&mut book, true);
                book.push_str("</definedName>");
            }
            book.push_str("</definedNames>");
        }
        book.push_str("<calcPr calcId=\"0\" fullCalcOnLoad=\"1\"/></workbook>");
        let _ = write!(rels, "<Relationship Id=\"rId{}\" Type=\"{NS}/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>", sheets.len() + 1);
        let root_rels = format!("{XML}<Relationships xmlns=\"{NS}/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{NS}/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
        let styles = format!("{XML}{}", self.styles.xml());

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

fn table_xml(t: &Table) -> String {
    let mut ref_ = String::new();
    t.area().push(&mut ref_, false);
    let mut out = format!("{XML}<table xmlns=\"{NS}/spreadsheetml/2006/main\" id=\"{0}\" name=\"{1}\" displayName=\"{1}\" ref=\"{ref_}\" totalsRowShown=\"0\"><autoFilter ref=\"{ref_}\"/><tableColumns count=\"{2}\">", t.id, t.name, t.columns.len());
    for (i, c) in t.columns.iter().enumerate() {
        let _ = write!(out, "<tableColumn id=\"{}\" name=\"", i + 1);
        push_escaped(&mut out, c);
        out.push_str("\"/>");
    }
    let _ = write!(out, "</tableColumns><tableStyleInfo name=\"{}\" showFirstColumn=\"0\" showLastColumn=\"0\" showRowStripes=\"1\" showColumnStripes=\"0\"/></table>", t.style);
    out
}

fn opts() -> SimpleFileOptions {
    // Level 4 is ~35% faster than the default 6 and, on spreadsheet XML, no bigger
    SimpleFileOptions::default().compression_level(Some(4))
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
                sheet: Sheet::default(),
                filters: Vec::new(),
                table_names: Vec::new(),
                table_count: 0,
                styles: Styles::new(),
                buf: String::new(),
            })),
        }
    }

    /// Make a cell format to use in cells (`{ value, format }`), rows and columns.
    #[wasm_bindgen(unchecked_return_type = "Format")]
    pub fn format(
        &self,
        #[wasm_bindgen(unchecked_param_type = "FormatSpec")] spec: Object,
    ) -> Result<u32, JsValue> {
        self.inner.borrow_mut().styles.add(&spec)
    }

    /// Start a new sheet. The previous sheet is finished and takes no more rows.
    /// Column widths and frozen panes come first in the file, so they are set here.
    #[wasm_bindgen(js_name = addSheet)]
    pub fn add_sheet(
        &self,
        name: &str,
        #[wasm_bindgen(unchecked_optional_param_type = "SheetOptions")] options: JsValue,
    ) -> Result<SheetWriter, JsValue> {
        let index = self.inner.borrow_mut().add_sheet(name, &options)?;
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
    /// Append a row. `null`/`undefined` leave a cell empty. Pass a `Format` (or `{ format, height }`)
    /// to style every cell in the row that doesn't set its own format.
    #[wasm_bindgen(js_name = addRow)]
    pub fn add_row(
        &self,
        #[wasm_bindgen(unchecked_param_type = "WriteCell[]")] row: Array,
        #[wasm_bindgen(unchecked_optional_param_type = "Format | RowOptions")] options: JsValue,
    ) -> Result<(), JsValue> {
        self.inner.borrow_mut().add_row(self.index, &row, &options)
    }

    /// Merge a range like "A1:C1". Write the value into its top-left cell as usual.
    pub fn merge(&self, range: &str) -> Result<(), JsValue> {
        self.inner.borrow_mut().merge(self.index, range)
    }

    /// Highlight cells in `range` by rule: compare values, a formula, a color scale or data bars.
    #[wasm_bindgen(js_name = conditionalFormat)]
    pub fn conditional_format(
        &self,
        range: &str,
        #[wasm_bindgen(unchecked_param_type = "ConditionalFormat")] rule: JsValue,
    ) -> Result<(), JsValue> {
        self.inner
            .borrow_mut()
            .conditional_format(self.index, range, &rule)
    }

    /// Restrict what can be typed into `range`: a dropdown list, numbers, dates, text length or a formula.
    pub fn validate(
        &self,
        range: &str,
        #[wasm_bindgen(unchecked_param_type = "Validation")] rule: JsValue,
    ) -> Result<(), JsValue> {
        self.inner.borrow_mut().validate(self.index, range, &rule)
    }

    /// Start an Excel table (banded rows, filter buttons) at the next row, from column A. Its
    /// header row is written now; the rows you add next are the table, until `endTable()`,
    /// the next `addTable()`, or the end of the sheet.
    #[wasm_bindgen(js_name = addTable)]
    pub fn add_table(
        &self,
        #[wasm_bindgen(unchecked_param_type = "TableOptions")] options: JsValue,
    ) -> Result<(), JsValue> {
        self.inner.borrow_mut().add_table(self.index, &options)
    }

    /// End the open table; rows added afterwards are outside it.
    #[wasm_bindgen(js_name = endTable)]
    pub fn end_table(&self) -> Result<(), JsValue> {
        let mut inner = self.inner.borrow_mut();
        inner.open_sheet(self.index)?;
        inner.end_table()
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
        let ws = wb.add_sheet(&name, JsValue::UNDEFINED)?;
        for row in normalize(&rows)? {
            ws.add_row(row, JsValue::UNDEFINED)?;
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
        if has(v, "value") || has(v, "format") {
            return csv_field(&get(v, "value"), escape_formulas);
        }
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
