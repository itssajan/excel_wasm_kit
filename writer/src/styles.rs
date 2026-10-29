//! Cell formats: parsed from JS `format({...})` specs, deduped into the parts of styles.xml.
use std::collections::HashMap;
use std::fmt::Write as _;

use js_sys::{Object, Reflect};
use wasm_bindgen::prelude::*;

use crate::{invalid, push_escaped};

/// What kind of value a cell holds, so dates get a date number format unless the format sets one.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Plain,
    Date,
    DateTime,
}

const DATE_FMT: &str = r"yyyy\-mm\-dd";
const DATETIME_FMT: &str = r"yyyy\-mm\-dd\ hh:mm:ss";
const BORDER_STYLES: [&str; 13] = [
    "thin",
    "medium",
    "thick",
    "dashed",
    "dotted",
    "double",
    "hair",
    "mediumDashed",
    "dashDot",
    "mediumDashDot",
    "dashDotDot",
    "mediumDashDotDot",
    "slantDashDot",
];
const KEYS: [&str; 14] = [
    "bold",
    "italic",
    "underline",
    "strike",
    "font",
    "size",
    "color",
    "fill",
    "border",
    "borderColor",
    "align",
    "valign",
    "wrap",
    "numFmt",
];
const DEFAULT_FONT: &str = r#"<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>"#;

/// A list of XML snippets where equal snippets share one index.
struct Interner {
    list: Vec<String>,
    index: HashMap<String, usize>,
}

impl Interner {
    fn new(initial: &[&str]) -> Self {
        let mut i = Interner {
            list: Vec::new(),
            index: HashMap::new(),
        };
        for s in initial {
            i.id(s.to_string());
        }
        i
    }

    fn id(&mut self, xml: String) -> usize {
        if let Some(&i) = self.index.get(&xml) {
            return i;
        }
        self.list.push(xml.clone());
        self.index.insert(xml, self.list.len() - 1);
        self.list.len() - 1
    }
}

/// One `format({...})`, as the XML pieces it contributes.
struct Format {
    font: String,
    fill: Option<String>,
    border: Option<String>,
    num_fmt: Option<String>,
    alignment: Option<String>,
}

pub struct Styles {
    formats: Vec<Format>,
    fonts: Interner,
    fills: Interner,
    borders: Interner,
    num_fmts: Interner,
    xfs: Interner,
    cache: HashMap<(Option<u32>, Kind), u32>,
}

fn get(o: &JsValue, key: &str) -> JsValue {
    Reflect::get(o, &key.into()).unwrap_or(JsValue::UNDEFINED)
}

/// "#1f6feb" or "1F6FEB" -> "FF1F6FEB" (ARGB).
fn color(v: &JsValue, key: &str) -> Result<Option<String>, JsValue> {
    if v.is_undefined() {
        return Ok(None);
    }
    let s = v.as_string().unwrap_or_default();
    let hex = s.strip_prefix('#').unwrap_or(&s);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid(&format!("{key} must be a color like \"#1f6feb\"")));
    }
    Ok(Some(format!("FF{}", hex.to_ascii_uppercase())))
}

fn flag(spec: &JsValue, key: &str) -> Result<bool, JsValue> {
    let v = get(spec, key);
    if v.is_undefined() {
        return Ok(false);
    }
    v.as_bool()
        .ok_or_else(|| invalid(&format!("{key} must be true or false")))
}

fn one_of<'a>(v: &JsValue, key: &str, allowed: &[&'a str]) -> Result<Option<&'a str>, JsValue> {
    if v.is_undefined() {
        return Ok(None);
    }
    let s = v.as_string().unwrap_or_default();
    match allowed.iter().find(|a| **a == s) {
        Some(a) => Ok(Some(a)),
        None => Err(invalid(&format!(
            "{key} must be one of: {}",
            allowed.join(", ")
        ))),
    }
}

fn parse_border(spec: &JsValue, color: Option<&str>) -> Result<Option<String>, JsValue> {
    let border = get(spec, "border");
    if border.is_undefined() {
        return Ok(None);
    }
    // "thin" for every side, or { top, bottom, left, right } each a style
    if !border.is_string() && !border.is_object() {
        return Err(invalid(
            "border must be a style like \"thin\" or { top, bottom, left, right }",
        ));
    }
    let mut xml = String::from("<border>");
    for side in ["left", "right", "top", "bottom"] {
        let v = if border.is_string() {
            border.clone()
        } else {
            get(&border, side)
        };
        match one_of(&v, "border", &BORDER_STYLES)? {
            Some(style) => {
                let _ = write!(xml, "<{side} style=\"{style}\">");
                match color {
                    Some(c) => {
                        let _ = write!(xml, "<color rgb=\"{c}\"/>");
                    }
                    None => xml.push_str("<color auto=\"1\"/>"),
                }
                let _ = write!(xml, "</{side}>");
            }
            None => {
                let _ = write!(xml, "<{side}/>");
            }
        }
    }
    xml.push_str("<diagonal/></border>");
    Ok(Some(xml))
}

fn parse(spec: &Object) -> Result<Format, JsValue> {
    for k in Object::keys(spec).iter() {
        let k = k.as_string().unwrap_throw();
        if !KEYS.contains(&k.as_str()) {
            return Err(invalid(&format!(
                "Unknown format option '{k}' (expected {})",
                KEYS.join(", ")
            )));
        }
    }
    let spec: &JsValue = spec.as_ref();

    let mut font = String::from("<font>");
    for (key, tag) in [
        ("bold", "b"),
        ("italic", "i"),
        ("strike", "strike"),
        ("underline", "u"),
    ] {
        if flag(spec, key)? {
            let _ = write!(font, "<{tag}/>");
        }
    }
    let size = get(spec, "size");
    let size = match size.as_f64() {
        Some(n) if (1.0..=409.0).contains(&n) => n,
        None if size.is_undefined() => 11.0,
        _ => return Err(invalid("size must be a number from 1 to 409")),
    };
    let _ = write!(font, "<sz val=\"{size}\"/>");
    if let Some(c) = color(&get(spec, "color"), "color")? {
        let _ = write!(font, "<color rgb=\"{c}\"/>");
    }
    let name = get(spec, "font");
    match name.as_string() {
        Some(n) if !n.is_empty() && n.chars().count() <= 31 => {
            font.push_str("<name val=\"");
            push_escaped(&mut font, &n);
            font.push_str("\"/>");
        }
        None if name.is_undefined() => font.push_str("<name val=\"Calibri\"/><family val=\"2\"/>"),
        _ => return Err(invalid("font must be a font name, up to 31 characters")),
    }
    font.push_str("</font>");

    let fill = color(&get(spec, "fill"), "fill")?.map(|c| {
        format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"{c}\"/><bgColor indexed=\"64\"/></patternFill></fill>")
    });
    let border_color = color(&get(spec, "borderColor"), "borderColor")?;
    let border = parse_border(spec, border_color.as_deref())?;

    let num_fmt = get(spec, "numFmt");
    let num_fmt = match num_fmt.as_string() {
        Some(s) if !s.is_empty() && s.len() <= 255 => Some(s),
        None if num_fmt.is_undefined() => None,
        _ => return Err(invalid("numFmt must be a format code like \"#,##0.00\"")),
    };

    let align = one_of(
        &get(spec, "align"),
        "align",
        &[
            "left",
            "center",
            "right",
            "fill",
            "justify",
            "centerContinuous",
            "distributed",
        ],
    )?;
    let valign = one_of(
        &get(spec, "valign"),
        "valign",
        &["top", "center", "bottom", "justify", "distributed"],
    )?;
    let wrap = flag(spec, "wrap")?;
    let alignment = (align.is_some() || valign.is_some() || wrap).then(|| {
        let mut a = String::from("<alignment");
        if let Some(h) = align {
            let _ = write!(a, " horizontal=\"{h}\"");
        }
        if let Some(v) = valign {
            let _ = write!(a, " vertical=\"{v}\"");
        }
        if wrap {
            a.push_str(" wrapText=\"1\"");
        }
        a.push_str("/>");
        a
    });

    Ok(Format {
        font,
        fill,
        border,
        num_fmt,
        alignment,
    })
}

impl Styles {
    pub fn new() -> Self {
        Styles {
            formats: Vec::new(),
            fonts: Interner::new(&[DEFAULT_FONT]),
            fills: Interner::new(&[
                r#"<fill><patternFill patternType="none"/></fill>"#,
                r#"<fill><patternFill patternType="gray125"/></fill>"#,
            ]),
            borders: Interner::new(&["<border><left/><right/><top/><bottom/><diagonal/></border>"]),
            num_fmts: Interner::new(&[]),
            xfs: Interner::new(&[
                r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#,
            ]),
            cache: HashMap::new(),
        }
    }

    /// Register a `format({...})` spec; returns its id for cells, rows and columns.
    pub fn add(&mut self, spec: &Object) -> Result<u32, JsValue> {
        let f = parse(spec)?;
        self.formats.push(f);
        Ok(self.formats.len() as u32 - 1)
    }

    /// A format id from JS (`undefined` = none), checked against this writer's formats.
    pub fn id(&self, v: &JsValue) -> Result<Option<u32>, JsValue> {
        if v.is_undefined() || v.is_null() {
            return Ok(None);
        }
        match v.as_f64() {
            Some(n) if n.fract() == 0.0 && n >= 0.0 && (n as usize) < self.formats.len() => {
                Ok(Some(n as u32))
            }
            _ => Err(invalid(
                "Unknown format: use a value returned by format() on the same writer",
            )),
        }
    }

    /// cellXfs index for a cell with `format` (if any) holding a `kind` value. 0 = no style.
    pub fn xf(&mut self, format: Option<u32>, kind: Kind) -> u32 {
        if format.is_none() && kind == Kind::Plain {
            return 0; // most cells: skip the hash lookup
        }
        if let Some(&xf) = self.cache.get(&(format, kind)) {
            return xf;
        }
        let f = format.map(|i| &self.formats[i as usize]);
        let code = f.and_then(|f| f.num_fmt.as_deref()).or(match kind {
            Kind::Plain => None,
            Kind::Date => Some(DATE_FMT),
            Kind::DateTime => Some(DATETIME_FMT),
        });
        let num_fmt_id = match code {
            None | Some("General") => 0,
            Some(code) => {
                let mut xml = String::new();
                push_escaped(&mut xml, code);
                164 + self.num_fmts.id(xml)
            }
        };
        let font = f.map_or(0, |f| self.fonts.id(f.font.clone()));
        let fill = f
            .and_then(|f| f.fill.clone())
            .map_or(0, |x| self.fills.id(x));
        let border = f
            .and_then(|f| f.border.clone())
            .map_or(0, |x| self.borders.id(x));
        let alignment = f.and_then(|f| f.alignment.clone());

        let mut xml = format!(
            "<xf numFmtId=\"{num_fmt_id}\" fontId=\"{font}\" fillId=\"{fill}\" borderId=\"{border}\" xfId=\"0\""
        );
        for (on, attr) in [
            (num_fmt_id != 0, "applyNumberFormat"),
            (font != 0, "applyFont"),
            (fill != 0, "applyFill"),
            (border != 0, "applyBorder"),
            (alignment.is_some(), "applyAlignment"),
        ] {
            if on {
                let _ = write!(xml, " {attr}=\"1\"");
            }
        }
        match alignment {
            Some(a) => {
                let _ = write!(xml, ">{a}</xf>");
            }
            None => xml.push_str("/>"),
        }
        let xf = self.xfs.id(xml) as u32;
        self.cache.insert((format, kind), xf);
        xf
    }

    pub fn xml(&self) -> String {
        let mut out = String::from(
            r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
        );
        if !self.num_fmts.list.is_empty() {
            let _ = write!(out, "<numFmts count=\"{}\">", self.num_fmts.list.len());
            for (i, code) in self.num_fmts.list.iter().enumerate() {
                let _ = write!(
                    out,
                    "<numFmt numFmtId=\"{}\" formatCode=\"{code}\"/>",
                    164 + i
                );
            }
            out.push_str("</numFmts>");
        }
        for (tag, list) in [
            ("fonts", &self.fonts.list),
            ("fills", &self.fills.list),
            ("borders", &self.borders.list),
        ] {
            let _ = write!(
                out,
                "<{tag} count=\"{}\">{}</{tag}>",
                list.len(),
                list.concat()
            );
        }
        out.push_str(r#"<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>"#);
        let _ = write!(
            out,
            "<cellXfs count=\"{}\">{}</cellXfs>",
            self.xfs.list.len(),
            self.xfs.list.concat()
        );
        out.push_str(r#"<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#);
        out
    }
}
