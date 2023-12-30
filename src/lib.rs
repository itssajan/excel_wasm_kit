extern crate wasm_bindgen;
extern crate calamine;
extern crate serde_json;

use wasm_bindgen::prelude::*;
use calamine::{Reader, Xlsx};
use serde_json::json;

#[wasm_bindgen]
pub fn get_worksheet_names(data: &[u8]) -> Result<JsValue, JsValue> {
    // Create a cursor for in-memory data
    let cursor = std::io::Cursor::new(data);

    let mut excel = match Xlsx::new(cursor) {
        Ok(book) => book,
        Err(_) => return Err(JsValue::from_str("Failed to open Excel file")),
    };

    // Collect worksheet names
    let sheet_names = excel.sheet_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect::<Vec<String>>();

    // Convert to JSON
    let json_names = json!({ "worksheets": sheet_names });
    JsValue::from_serde(&json_names).map_err(|e| JsValue::from_str(&e.to_string()))
}
