extern crate calamine;
extern crate serde_json;
extern crate wasm_bindgen;

use calamine::{Reader, SheetVisible, Xlsx, DataType};
use serde_json::json;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn get_worksheet_names(data: &[u8]) -> Result<JsValue, JsValue> {
    // Create a cursor for in-memory data
    let cursor = std::io::Cursor::new(data);

    let excel = match Xlsx::new(cursor) {
        Ok(book) => book,
        Err(_) => return Err(JsValue::from_str("Failed to open Excel file")),
    };

    let metadata = excel
        .sheets_metadata()
        .into_iter()
        .map(|s| {
            let visibility = match s.visible {
                SheetVisible::Visible => "Visible",
                SheetVisible::Hidden => "Hidden",
                SheetVisible::VeryHidden => "Hidden",
            };

            json!({
                "name": s.name,
                "visibility": visibility
            })
        })
        .collect::<Vec<serde_json::Value>>();

    let json_names = json!({ "worksheets": metadata });

    // Serialize to a JSON string and then convert to JsValue
    match serde_json::to_string(&json_names) {
        Ok(json_str) => Ok(JsValue::from_str(&json_str)),
        Err(e) => Err(JsValue::from_str(&e.to_string())),
    }
}


#[wasm_bindgen]
pub fn get_worksheet_data(data: &[u8], worksheet_name: String) -> Result<JsValue, JsValue> {
    let cursor = std::io::Cursor::new(data);

    let mut excel = match Xlsx::new(cursor) {
        Ok(book) => book,
        Err(_) => return Err(JsValue::from_str("Failed to open Excel file")),
    };

    let range = match excel.worksheet_range(&worksheet_name) {
        Ok(range) => range,
        Err(_) => return Err(JsValue::from_str("Worksheet not found or unreadable")),
    };

    let mut rows = Vec::new();
    for row in range.rows() {
        let cells = row.iter()
                       .map(|cell| match cell {
                           DataType::Empty => "".to_string(),
                           DataType::String(s) => s.clone(),
                           DataType::Float(f) => f.to_string(),
                           DataType::Int(i) => i.to_string(),
                           DataType::Bool(b) => b.to_string(),
                           DataType::Error(err) => err.to_string(),
                           _ => "Unsupported data type".to_string(),
                       })
                       .collect::<Vec<String>>();
        rows.push(json!(cells));
    }

    // Convert rows to JSON
    match serde_json::to_string(&rows) {
        Ok(json_str) => Ok(JsValue::from_str(&json_str)),
        Err(e) => Err(JsValue::from_str(&e.to_string())),
    }
}