use std::collections::HashSet;
use std::io::Cursor;
use std::rc::Rc;

use calamine::{Data, Range, Reader, SheetType, SheetVisible, Sheets};
use js_sys::{Array, ArrayBuffer, Date, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type Cell = string | number | boolean | Date | null | { error: string };
export type Visibility = "Visible" | "Hidden" | "VeryHidden";
export interface SheetInfo { name: string; visibility: Visibility }
export interface ToObjectsOptions { header?: number }
export type ErrorCode = "INVALID_INPUT" | "INVALID_FILE" | "PASSWORD_PROTECTED" | "SHEET_NOT_FOUND" | "OUT_OF_BOUNDS";
export interface ExcelKitError extends Error { code: ErrorCode }
"#;

fn error(code: &str, message: &str) -> JsValue {
    let err = js_sys::Error::new(message);
    Reflect::set(&err, &"code".into(), &code.into()).unwrap_throw();
    err.into()
}

type Bytes = Cursor<Rc<[u8]>>;

fn error_code(e: &calamine::Error) -> &'static str {
    use calamine::{Error as E, OdsError, XlsError, XlsbError, XlsxError};
    match e {
        E::Xlsx(XlsxError::Password)
        | E::Xls(XlsError::Password)
        | E::Xlsb(XlsbError::Password)
        | E::Ods(OdsError::Password) => "PASSWORD_PROTECTED",
        E::Xlsx(XlsxError::WorksheetNotFound(_))
        | E::Xls(XlsError::WorksheetNotFound(_))
        | E::Xlsb(XlsbError::WorksheetNotFound(_))
        | E::Ods(OdsError::WorksheetNotFound(_)) => "SHEET_NOT_FOUND",
        _ => "INVALID_FILE",
    }
}

fn calamine_error(e: calamine::Error) -> JsValue {
    error(error_code(&e), &e.to_string())
}

/// Same detection order as calamine's `open_workbook_auto_from_rs`, but keeps
/// password errors instead of collapsing everything into "Cannot detect file format".
fn open_any(bytes: &Rc<[u8]>) -> Result<Sheets<Bytes>, JsValue> {
    use calamine::{open_workbook_from_rs as open, Error as E, Ods, Xls, Xlsb, Xlsx};
    let c = || Cursor::new(bytes.clone());
    let errors: [E; 4] = [
        match open::<Xls<_>, _>(c()) {
            Ok(b) => return Ok(Sheets::Xls(b)),
            Err(e) => e.into(),
        },
        match open::<Xlsx<_>, _>(c()) {
            Ok(b) => return Ok(Sheets::Xlsx(b)),
            Err(e) => e.into(),
        },
        match open::<Xlsb<_>, _>(c()) {
            Ok(b) => return Ok(Sheets::Xlsb(b)),
            Err(e) => e.into(),
        },
        match open::<Ods<_>, _>(c()) {
            Ok(b) => return Ok(Sheets::Ods(b)),
            Err(e) => e.into(),
        },
    ];
    match errors
        .into_iter()
        .find(|e| error_code(e) == "PASSWORD_PROTECTED")
    {
        Some(e) => Err(calamine_error(e)),
        None => Err(error(
            "INVALID_FILE",
            "Unrecognized workbook (expected xlsx, xlsm, xlsb, xls or ods)",
        )),
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Excel datetime as UTC epoch milliseconds. Excel has no timezone; we treat it as UTC.
fn epoch_ms(dt: &calamine::ExcelDateTime) -> f64 {
    let (y, mo, d, h, mi, s, ms) = dt.to_ymd_hms_milli();
    let days = days_from_civil(y as i64, mo as i64, d as i64);
    (((days * 24 + h as i64) * 60 + mi as i64) * 60 + s as i64) as f64 * 1000.0 + ms as f64
}

/// ISO 8601 duration (`PT10H10M10.5S`, `P1DT2H`) in seconds. Years/months are ambiguous: None.
fn iso_duration_secs(s: &str) -> Option<f64> {
    let (sign, s) = s.strip_prefix('-').map_or((1.0, s), |r| (-1.0, r));
    let (mut total, mut num, mut time) = (0.0, String::new(), false);
    for ch in s.strip_prefix('P')?.chars() {
        match ch {
            'T' => time = true,
            '0'..='9' | '.' => num.push(ch),
            unit => {
                let unit_secs = match (unit, time) {
                    ('W', false) => 604800.0,
                    ('D', false) => 86400.0,
                    ('H', true) => 3600.0,
                    ('M', true) => 60.0,
                    ('S', true) => 1.0,
                    _ => return None,
                };
                total += num.parse::<f64>().ok()? * unit_secs;
                num.clear();
            }
        }
    }
    num.is_empty().then_some(sign * total)
}

/// ISO date/datetime as a UTC Date. Timezone-less datetimes get "Z" so JS doesn't use local time.
fn iso_date(s: &str) -> Option<JsValue> {
    let has_tz = s
        .split_once('T')
        .is_some_and(|(_, t)| t.ends_with('Z') || t.contains(['+', '-']));
    let iso = if s.contains('T') && !has_tz {
        format!("{s}Z")
    } else {
        s.to_string()
    };
    let date = Date::new(&iso.into());
    (!date.get_time().is_nan()).then(|| date.into())
}

fn cell_value(cell: &Data) -> JsValue {
    match cell {
        Data::Empty => JsValue::NULL,
        Data::String(s) => s.into(),
        Data::DateTimeIso(s) => iso_date(s).unwrap_or_else(|| s.into()),
        Data::DurationIso(s) => iso_duration_secs(s).map_or_else(|| s.into(), JsValue::from),
        Data::Float(f) => (*f).into(),
        Data::Int(i) => (*i as f64).into(),
        Data::Bool(b) => (*b).into(),
        Data::Error(e) => {
            let obj = Object::new();
            Reflect::set(&obj, &"error".into(), &e.to_string().into()).unwrap_throw();
            obj.into()
        }
        // ponytail: durations as seconds, no Duration type in JS
        Data::DateTime(dt) if dt.is_duration() => {
            ((dt.as_f64() * 86_400_000.0).round() / 1000.0).into()
        }
        Data::DateTime(dt) => Date::new(&epoch_ms(dt).into()).into(),
    }
}

fn row_value(row: &[Data]) -> Array {
    row.iter().map(cell_value).collect()
}

/// Call `f(row, index)`; stop when it returns `false`. JS exceptions propagate.
fn emit(f: &Function, row: &Array, index: u32) -> Result<bool, JsValue> {
    Ok(f.call2(&JsValue::NULL, row, &index.into())? != JsValue::FALSE)
}

/// Header keys: stringified cells, `__EMPTY_<col>` for blanks, `_<n>` suffix for duplicates.
fn header_keys(row: &[Data]) -> Vec<String> {
    let mut seen = HashSet::new();
    row.iter()
        .enumerate()
        .map(|(i, cell)| {
            let base = match cell {
                Data::Empty => format!("__EMPTY_{i}"),
                other => other.to_string(),
            };
            let mut key = base.clone();
            let mut n = 1;
            while !seen.insert(key.clone()) {
                key = format!("{base}_{n}");
                n += 1;
            }
            key
        })
        .collect()
}

/// Re-anchor a range at A1 so row/column indexes match Excel (row i = Excel row i+1).
fn from_a1(range: Range<Data>) -> Range<Data> {
    match range.end() {
        Some(end) if range.start() != Some((0, 0)) => range.range((0, 0), end),
        _ => range,
    }
}

type CellReader<'a> = calamine::XlsxCellReader<'a, Bytes>;

/// Groups streamed xlsx cells (row order) into full rows, with blank rows for gaps.
struct RowAssembler {
    width: usize,
    next_index: u32,
    buf: Vec<Data>,
    buf_row: Option<u32>,
    done: bool,
}

impl RowAssembler {
    fn new(reader: &CellReader) -> Self {
        // ponytail: row width comes from the sheet's <dimension> tag; matches Sheet.rows() unless the tag is wrong
        RowAssembler {
            width: reader.dimensions().end.1 as usize + 1,
            next_index: 0,
            buf: Vec::new(),
            buf_row: None,
            done: false,
        }
    }

    fn take_row(&mut self) -> Vec<Data> {
        let mut row = std::mem::take(&mut self.buf);
        row.resize(row.len().max(self.width), Data::Empty);
        self.next_index += 1;
        row
    }

    fn next(&mut self, reader: &mut CellReader) -> Result<Option<Vec<Data>>, JsValue> {
        loop {
            // buffered row is ahead: emit blank rows until we reach it
            if self.buf_row.is_some_and(|r| r > self.next_index) {
                self.next_index += 1;
                return Ok(Some(vec![Data::Empty; self.width]));
            }
            if self.done {
                return Ok(self.buf_row.take().map(|_| self.take_row()));
            }
            let Some(cell) = reader.next_cell().map_err(|e| calamine_error(e.into()))? else {
                self.done = true;
                continue;
            };
            let (r, c) = cell.get_position();
            // a cell from a new row completes the buffered one
            let finished = match self.buf_row.replace(r) {
                Some(cur) if cur != r => Some(self.take_row()),
                _ => None,
            };
            let c = c as usize;
            if self.buf.len() <= c {
                self.buf.resize(c + 1, Data::Empty);
            }
            self.buf[c] = cell.get_value().clone().into();
            if finished.is_some() {
                return Ok(finished);
            }
        }
    }
}

/// An xlsx workbook plus a cell reader borrowing it, so a JS iterator can outlive the call.
#[ouroboros::self_referencing]
struct XlsxStream {
    xlsx: calamine::Xlsx<Bytes>,
    #[borrows(mut xlsx)]
    #[not_covariant]
    reader: CellReader<'this>,
}

enum RowSource {
    Xlsx(Box<XlsxStream>, RowAssembler),
    Loaded(Range<Data>, usize),
}

/// Pull-based row reader. Prefer `Workbook.iterRows()`, which wraps this in a generator.
#[wasm_bindgen]
pub struct RowIter {
    source: RowSource,
}

#[wasm_bindgen]
impl RowIter {
    /// Next row, or `undefined` when finished.
    #[wasm_bindgen(js_name = next, unchecked_return_type = "Cell[] | undefined")]
    pub fn next_row(&mut self) -> Result<JsValue, JsValue> {
        let row = match &mut self.source {
            RowSource::Xlsx(stream, asm) => stream
                .with_reader_mut(|reader| asm.next(reader))?
                .map(|r| row_value(&r)),
            RowSource::Loaded(range, i) => {
                *i += 1;
                range.rows().nth(*i - 1).map(row_value)
            }
        };
        Ok(row.map_or(JsValue::UNDEFINED, JsValue::from))
    }
}

#[wasm_bindgen(inline_js = "
export function rows_generator(it) {
  return (function* () {
    try { for (let row; (row = it.next()) !== undefined; ) yield row; }
    finally { it.free(); }
  })();
}")]
extern "C" {
    fn rows_generator(it: JsValue) -> JsValue;
}

#[wasm_bindgen]
pub struct Workbook {
    book: Sheets<Bytes>,
    bytes: Rc<[u8]>,
}

#[wasm_bindgen]
impl Workbook {
    /// Parse a workbook (xlsx, xlsm, xlsb, xls, ods) from bytes.
    pub fn open(
        #[wasm_bindgen(unchecked_param_type = "Uint8Array | ArrayBuffer")] data: JsValue,
    ) -> Result<Workbook, JsValue> {
        if !data.is_instance_of::<Uint8Array>() && !data.is_instance_of::<ArrayBuffer>() {
            return Err(error("INVALID_INPUT", "Expected Uint8Array or ArrayBuffer"));
        }
        let bytes: Rc<[u8]> = Uint8Array::new(&data).to_vec().into();
        Ok(Workbook {
            book: open_any(&bytes)?,
            bytes,
        })
    }

    /// Worksheets in workbook order. Chart sheets are skipped.
    #[wasm_bindgen(unchecked_return_type = "SheetInfo[]")]
    pub fn sheets(&self) -> Array {
        self.book
            .sheets_metadata()
            .iter()
            .filter(|s| s.typ == SheetType::WorkSheet)
            .map(|s| {
                let visibility = match s.visible {
                    SheetVisible::Visible => "Visible",
                    SheetVisible::Hidden => "Hidden",
                    SheetVisible::VeryHidden => "VeryHidden",
                };
                let obj = Object::new();
                Reflect::set(&obj, &"name".into(), &s.name.as_str().into()).unwrap_throw();
                Reflect::set(&obj, &"visibility".into(), &visibility.into()).unwrap_throw();
                JsValue::from(obj)
            })
            .collect()
    }

    /// Parse one worksheet. Parse once, then read rows from the returned Sheet.
    pub fn sheet(&mut self, name: &str) -> Result<Sheet, JsValue> {
        let range = self.book.worksheet_range(name).map_err(calamine_error)?;
        Ok(Sheet {
            range: from_a1(range),
        })
    }

    /// Lazily iterate rows: `for (const row of wb.iterRows("Sheet1"))`. Breaking early frees memory.
    /// Low-memory for xlsx/xlsm (reopens the workbook, re-reading shared strings);
    /// other formats load the sheet first.
    #[wasm_bindgen(js_name = iterRows, unchecked_return_type = "Generator<Cell[], void, undefined>")]
    pub fn iter_rows(&mut self, name: &str) -> Result<JsValue, JsValue> {
        let source = if matches!(self.book, Sheets::Xlsx(_)) {
            let xlsx: calamine::Xlsx<Bytes> =
                calamine::open_workbook_from_rs(Cursor::new(self.bytes.clone()))
                    .map_err(|e: calamine::XlsxError| calamine_error(e.into()))?;
            let stream = XlsxStream::try_new(xlsx, |x| x.worksheet_cells_reader(name))
                .map_err(|e| calamine_error(e.into()))?;
            let asm = stream.with_reader(RowAssembler::new);
            RowSource::Xlsx(Box::new(stream), asm)
        } else {
            let range = self.book.worksheet_range(name).map_err(calamine_error)?;
            RowSource::Loaded(from_a1(range), 0)
        };
        Ok(rows_generator(RowIter { source }.into()))
    }

    /// Stream rows to `callback(row, index)` without loading the whole sheet; return `false` to stop.
    /// Low-memory for xlsx/xlsm; other formats load the sheet first, then stream.
    #[wasm_bindgen(js_name = forEachRow)]
    pub fn for_each_row(
        &mut self,
        name: &str,
        #[wasm_bindgen(unchecked_param_type = "(row: Cell[], index: number) => boolean | void")]
        callback: Function,
    ) -> Result<(), JsValue> {
        let Sheets::Xlsx(xlsx) = &mut self.book else {
            let range = from_a1(self.book.worksheet_range(name).map_err(calamine_error)?);
            for (i, row) in range.rows().enumerate() {
                if !emit(&callback, &row_value(row), i as u32)? {
                    break;
                }
            }
            return Ok(());
        };

        let mut reader = xlsx
            .worksheet_cells_reader(name)
            .map_err(|e| calamine_error(e.into()))?;
        let mut asm = RowAssembler::new(&reader);
        let mut index = 0;
        while let Some(row) = asm.next(&mut reader)? {
            if !emit(&callback, &row_value(&row), index)? {
                break;
            }
            index += 1;
        }
        Ok(())
    }
}

#[wasm_bindgen]
pub struct Sheet {
    range: Range<Data>,
}

#[wasm_bindgen]
impl Sheet {
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> usize {
        self.range.height()
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> usize {
        self.range.width()
    }

    #[wasm_bindgen(unchecked_return_type = "Cell[][]")]
    pub fn rows(&self) -> Array {
        self.range
            .rows()
            .map(|r| JsValue::from(row_value(r)))
            .collect()
    }

    #[wasm_bindgen(unchecked_return_type = "Cell[]")]
    pub fn row(&self, index: usize) -> Result<Array, JsValue> {
        self.range
            .rows()
            .nth(index)
            .map(row_value)
            .ok_or_else(|| error("OUT_OF_BOUNDS", "Row index out of bounds"))
    }

    /// Rows below the header row as objects keyed by header cells. Default header row: 0.
    #[wasm_bindgen(js_name = toObjects, unchecked_return_type = "Record<string, Cell>[]")]
    pub fn to_objects(
        &self,
        #[wasm_bindgen(unchecked_param_type = "ToObjectsOptions")] options: Option<Object>,
    ) -> Result<Array, JsValue> {
        let header = match options {
            Some(o) => Reflect::get(&o, &"header".into())?.as_f64().unwrap_or(0.0) as usize,
            None => 0,
        };
        let mut rows = self.range.rows().skip(header);
        let keys: Vec<JsValue> = header_keys(
            rows.next()
                .ok_or_else(|| error("OUT_OF_BOUNDS", "Header row out of bounds"))?,
        )
        .into_iter()
        .map(JsValue::from)
        .collect();
        Ok(rows
            .map(|row| {
                let obj = Object::new();
                for (key, cell) in keys.iter().zip(row) {
                    Reflect::set(&obj, key, &cell_value(cell)).unwrap_throw();
                }
                JsValue::from(obj)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{ExcelDateTime, ExcelDateTimeType};

    fn ms(serial: f64, is_1904: bool) -> f64 {
        epoch_ms(&ExcelDateTime::new(
            serial,
            ExcelDateTimeType::DateTime,
            is_1904,
        ))
    }

    #[test]
    fn dates_to_utc_ms() {
        assert_eq!(ms(25569.0, false), 0.0); // 1970-01-01
        assert_eq!(ms(45293.5515625, false), 1704201255000.0); // 2024-01-02T13:14:15Z
        assert_eq!(ms(24107.0, true), 0.0); // 1970-01-01 in 1904 epoch
        assert_eq!(days_from_civil(1900, 3, 1), -25508);
    }

    #[test]
    fn iso_durations() {
        assert_eq!(iso_duration_secs("PT10H10M10S"), Some(36610.0));
        assert_eq!(iso_duration_secs("PT10H10M10.123456S"), Some(36610.123456));
        assert_eq!(iso_duration_secs("-P1DT1S"), Some(-86401.0));
        assert_eq!(iso_duration_secs("P1Y"), None);
        assert_eq!(iso_duration_secs("PT5"), None);
        assert_eq!(iso_duration_secs("nope"), None);
    }

    #[test]
    fn header_keys_dedupe_and_fill_blanks() {
        let row = [
            Data::String("a".into()),
            Data::Empty,
            Data::String("a".into()),
            Data::Float(3.0),
        ];
        assert_eq!(header_keys(&row), ["a", "__EMPTY_1", "a_1", "3"]);
    }

    /// Regenerate JS test fixture: `cargo test -- --ignored write_fixture`
    #[test]
    #[ignore]
    fn write_fixture() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Formula, Workbook};
        let mut wb = Workbook::new();
        let date_fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        let ws = wb.add_worksheet().set_name("Data").unwrap();
        ws.write(0, 0, "name").unwrap();
        ws.write(0, 1, 42.5).unwrap();
        ws.write(0, 2, true).unwrap();
        let dt = ExcelDateTime::parse_from_str("2024-01-02 13:14:15").unwrap();
        ws.write_with_format(0, 3, &dt, &date_fmt).unwrap();
        ws.write_formula(0, 4, Formula::new("=1/0").set_result("#DIV/0!"))
            .unwrap();
        ws.write(1, 1, 7).unwrap();
        wb.add_worksheet()
            .set_name("Secret")
            .unwrap()
            .set_hidden(true);
        let people = wb.add_worksheet().set_name("People").unwrap();
        people.write_row(0, 0, ["id", "name"]).unwrap();
        people.write(0, 3, "name").unwrap(); // C1 blank, D1 duplicate
        people.write(1, 0, 1).unwrap();
        people.write(1, 1, "Ann").unwrap();
        people.write(3, 0, 3).unwrap(); // row 2 left blank to exercise gap handling
        let offset = wb.add_worksheet().set_name("Offset").unwrap();
        offset.write(2, 2, "C3").unwrap();
        offset.write(3, 3, "D4").unwrap();
        wb.save("tests/fixtures/basic.xlsx").unwrap();
    }
}
