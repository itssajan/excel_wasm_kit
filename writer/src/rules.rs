//! Conditional formats and data validation: parsed from JS rule objects into worksheet XML.
use std::fmt::Write as _;

use js_sys::{Array, Date};
use wasm_bindgen::prelude::*;

use crate::styles::Styles;
use crate::{check_keys, excel_serial, get, has, invalid, number, push_escaped, Area};

const OPERATORS: [&str; 8] = [
    "between",
    "notBetween",
    "equal",
    "notEqual",
    "greaterThan",
    "lessThan",
    "greaterThanOrEqual",
    "lessThanOrEqual",
];

/// A rule value as formula text: numbers as-is, Dates as serials, strings as text literals,
/// `{ formula }` as written (leading `=` dropped).
fn operand(v: &JsValue, what: &str) -> Result<String, JsValue> {
    if let Some(n) = v.as_f64() {
        return Ok(number(n)?.to_string());
    }
    if let Some(d) = v.dyn_ref::<Date>() {
        return Ok(excel_serial(d)?.to_string());
    }
    if let Some(s) = v.as_string() {
        return Ok(format!("\"{}\"", s.replace('"', "\"\"")));
    }
    if let Some(f) = get(v, "formula").as_string() {
        return Ok(f.strip_prefix('=').unwrap_or(&f).to_owned());
    }
    Err(invalid(&format!(
        "{what} must be a number, Date, string or {{ formula }}"
    )))
}

fn push_formula(out: &mut String, tag: &str, formula: &str) {
    let _ = write!(out, "<{tag}>");
    push_escaped(out, formula);
    let _ = write!(out, "</{tag}>");
}

/// `operator` (default given) with `value` and, for between/notBetween, `value2`.
fn comparison(rule: &JsValue, default: &str) -> Result<(String, Vec<String>), JsValue> {
    let op = get(rule, "operator");
    let op = match op.as_string() {
        None if op.is_undefined() => default.to_owned(),
        Some(o) if OPERATORS.contains(&o.as_str()) => o,
        _ => {
            return Err(invalid(&format!(
                "operator must be one of: {}",
                OPERATORS.join(", ")
            )))
        }
    };
    let two = op == "between" || op == "notBetween";
    let mut values = vec![operand(&get(rule, "value"), "value")?];
    if two {
        values.push(operand(&get(rule, "value2"), "value2 (for between)")?);
    } else if has(rule, "value2") {
        return Err(invalid("value2 is only used with between and notBetween"));
    }
    Ok((op, values))
}

fn rule_type<'a>(rule: &JsValue, allowed: &[&'a str]) -> Result<&'a str, JsValue> {
    if !rule.is_object() {
        return Err(invalid("A rule must be an object with a type"));
    }
    let t = get(rule, "type").as_string().unwrap_or_default();
    allowed
        .iter()
        .find(|a| **a == t)
        .copied()
        .ok_or_else(|| invalid(&format!("type must be one of: {}", allowed.join(", "))))
}

fn rgb(rule: &JsValue, key: &str, default: &str) -> Result<String, JsValue> {
    let v = get(rule, key);
    let s = if v.is_undefined() {
        default.to_owned()
    } else {
        v.as_string().unwrap_or_default()
    };
    let hex = s.strip_prefix('#').unwrap_or(&s);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid(&format!("{key} must be a color like \"#63be7b\"")));
    }
    Ok(format!("FF{}", hex.to_ascii_uppercase()))
}

/// One `<conditionalFormatting>` for `area`. `priority` is the sheet's rule counter.
pub fn conditional(
    area: &Area,
    rule: &JsValue,
    styles: &mut Styles,
    priority: &mut u32,
) -> Result<String, JsValue> {
    let kind = rule_type(rule, &["cell", "formula", "colorScale", "dataBar"])?;
    let p = *priority + 1;
    let mut body = String::new();
    match kind {
        "cell" | "formula" => {
            let keys: &[&str] = if kind == "cell" {
                &["type", "operator", "value", "value2", "format"]
            } else {
                &["type", "formula", "format"]
            };
            check_keys(rule, "rule", keys)?;
            let format = styles
                .id(&get(rule, "format"))?
                .ok_or_else(|| invalid("A cell or formula rule needs a format"))?;
            if kind == "cell" {
                let (op, values) = comparison(rule, "greaterThan")?;
                let dxf = styles.dxf(format);
                let _ = write!(
                    body,
                    "<cfRule type=\"cellIs\" dxfId=\"{dxf}\" priority=\"{p}\" operator=\"{op}\">"
                );
                for v in values {
                    push_formula(&mut body, "formula", &v);
                }
            } else {
                let f = get(rule, "formula")
                    .as_string()
                    .ok_or_else(|| invalid("formula must be a string like \"$C2>100\""))?;
                let dxf = styles.dxf(format);
                let _ = write!(
                    body,
                    "<cfRule type=\"expression\" dxfId=\"{dxf}\" priority=\"{p}\">"
                );
                push_formula(&mut body, "formula", f.strip_prefix('=').unwrap_or(&f));
            }
            body.push_str("</cfRule>");
        }
        "colorScale" => {
            check_keys(rule, "rule", &["type", "min", "mid", "max"])?;
            let min = rgb(rule, "min", "#f8696b")?;
            let max = rgb(rule, "max", "#63be7b")?;
            let mid = if has(rule, "mid") {
                Some(rgb(rule, "mid", "")?)
            } else {
                None
            };
            let _ = write!(
                body,
                "<cfRule type=\"colorScale\" priority=\"{p}\"><colorScale><cfvo type=\"min\" val=\"0\"/>"
            );
            if mid.is_some() {
                body.push_str("<cfvo type=\"percentile\" val=\"50\"/>");
            }
            body.push_str("<cfvo type=\"max\" val=\"0\"/>");
            for c in std::iter::once(min).chain(mid).chain([max]) {
                let _ = write!(body, "<color rgb=\"{c}\"/>");
            }
            body.push_str("</colorScale></cfRule>");
        }
        _ => {
            check_keys(rule, "rule", &["type", "color"])?;
            let c = rgb(rule, "color", "#638ec6")?;
            let _ = write!(body, "<cfRule type=\"dataBar\" priority=\"{p}\"><dataBar><cfvo type=\"min\"/><cfvo type=\"max\"/><color rgb=\"{c}\"/></dataBar></cfRule>");
        }
    }
    *priority = p;
    let mut out = String::from("<conditionalFormatting sqref=\"");
    area.push(&mut out, false);
    let _ = write!(out, "\">{body}</conditionalFormatting>");
    Ok(out)
}

fn text(v: &JsValue, what: &str, max: usize) -> Result<Option<String>, JsValue> {
    if v.is_undefined() {
        return Ok(None);
    }
    match v.as_string() {
        Some(s) if s.chars().count() <= max => Ok(Some(s)),
        _ => Err(invalid(&format!(
            "{what} must be text up to {max} characters"
        ))),
    }
}

/// `input` / `error` messages: title and message attributes.
fn push_messages(
    attrs: &mut String,
    v: &JsValue,
    what: &str,
    names: [&str; 2],
) -> Result<(), JsValue> {
    for (key, attr, max) in [("title", names[0], 32), ("message", names[1], 255)] {
        if let Some(t) = text(&get(v, key), &format!("{what}.{key}"), max)? {
            let _ = write!(attrs, " {attr}=\"");
            push_escaped(attrs, &t);
            attrs.push('"');
        }
    }
    Ok(())
}

fn list_formula(rule: &JsValue) -> Result<String, JsValue> {
    let values = get(rule, "values");
    let source = get(rule, "source");
    match (values.dyn_ref::<Array>(), source.as_string()) {
        (Some(values), None) => {
            let mut items = Vec::new();
            for v in values.iter() {
                let s = v
                    .as_string()
                    .or_else(|| v.as_f64().map(|n| n.to_string()))
                    .ok_or_else(|| invalid("list values must be strings or numbers"))?;
                if s.contains(',') {
                    return Err(invalid(
                        "list values can't contain commas; put them in cells and use source",
                    ));
                }
                items.push(s.replace('"', "\"\""));
            }
            let list = format!("\"{}\"", items.join(","));
            // 255 characters, plus the two quotes
            if list.chars().count() > 257 {
                return Err(invalid("list values are limited to 255 characters in total; put them in cells and use source"));
            }
            Ok(list)
        }
        (None, Some(s)) => Ok(s.strip_prefix('=').unwrap_or(&s).to_owned()),
        _ => Err(invalid(
            "list needs either values: [...] or source: \"$H$1:$H$9\"",
        )),
    }
}

/// One `<dataValidation>` for `area`.
pub fn validation(area: &Area, rule: &JsValue) -> Result<String, JsValue> {
    let kind = rule_type(
        rule,
        &["list", "whole", "decimal", "date", "textLength", "custom"],
    )?;
    let mut keys = vec!["type", "allowBlank", "input", "error"];
    keys.extend_from_slice(match kind {
        "list" => &["values", "source", "dropdown"][..],
        "custom" => &["formula"][..],
        _ => &["operator", "value", "value2"][..],
    });
    check_keys(rule, "rule", &keys)?;

    let mut attrs = format!("type=\"{kind}\"");
    let formulas = match kind {
        "list" => {
            // Excel's flag is inverted: showDropDown="1" hides the arrow
            if get(rule, "dropdown").as_bool() == Some(false) {
                attrs.push_str(" showDropDown=\"1\"");
            }
            vec![list_formula(rule)?]
        }
        "custom" => {
            let f = get(rule, "formula")
                .as_string()
                .ok_or_else(|| invalid("custom needs a formula like \"ISNUMBER(A2)\""))?;
            vec![f.strip_prefix('=').unwrap_or(&f).to_owned()]
        }
        _ => {
            let (op, values) = comparison(rule, "between")?;
            let _ = write!(attrs, " operator=\"{op}\"");
            values
        }
    };
    if get(rule, "allowBlank").as_bool() != Some(false) {
        attrs.push_str(" allowBlank=\"1\"");
    }
    let input = get(rule, "input");
    if !input.is_undefined() {
        check_keys(&input, "input", &["title", "message"])?;
        attrs.push_str(" showInputMessage=\"1\"");
        push_messages(&mut attrs, &input, "input", ["promptTitle", "prompt"])?;
    }
    // Invalid entries are rejected (with Excel's default message) unless `error` says otherwise
    attrs.push_str(" showErrorMessage=\"1\"");
    let error = get(rule, "error");
    if !error.is_undefined() {
        check_keys(&error, "error", &["title", "message", "style"])?;
        let style = get(&error, "style");
        match style.as_string().as_deref() {
            None if style.is_undefined() => {}
            Some("stop") => {}
            Some(s @ ("warning" | "information")) => {
                let _ = write!(attrs, " errorStyle=\"{s}\"");
            }
            _ => return Err(invalid("error.style must be stop, warning or information")),
        }
        push_messages(&mut attrs, &error, "error", ["errorTitle", "error"])?;
    }

    let mut out = format!("<dataValidation {attrs} sqref=\"");
    area.push(&mut out, false);
    out.push_str("\">");
    for (i, f) in formulas.iter().enumerate() {
        push_formula(&mut out, if i == 0 { "formula1" } else { "formula2" }, f);
    }
    out.push_str("</dataValidation>");
    Ok(out)
}
