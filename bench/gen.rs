//! Benchmark fixtures: `cargo run --release --example gen_bench -- <rows> <out.xlsx> [data_sheets=1]`
//! One sheet holds at most 1,048,575 data rows (~47 MB); use more data sheets for bigger files.
use rust_xlsxwriter::{Format, Formula, Workbook};

fn main() {
    let mut args = std::env::args().skip(1);
    let rows: u32 = args
        .next()
        .expect("rows")
        .parse()
        .expect("rows must be a number");
    let out = args.next().expect("output path");
    let sheets: u32 = args
        .next()
        .map_or(1, |s| s.parse().expect("data_sheets must be a number"));

    let mut wb = Workbook::new();
    let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
    let cities = ["Colombo", "Kandy", "Galle", "Jaffna", "Negombo", "Matara"];
    let base = 43831.0; // 2020-01-01
    for sheet in 0..sheets {
        let name = if sheet == 0 {
            "Data".to_string()
        } else {
            format!("Data {}", sheet + 1)
        };
        // low-memory mode streams rows to a temp file but keeps shared strings, like Excel output
        let ws = wb
            .add_worksheet_with_low_memory()
            .unwrap()
            .set_name(&name)
            .unwrap();
        ws.write_row(
            0,
            0,
            [
                "id", "name", "city", "price", "qty", "date", "active", "note",
            ],
        )
        .unwrap();
        for r in 1..=rows {
            let id = sheet as u64 * rows as u64 + r as u64;
            ws.write(r, 0, id as f64).unwrap();
            ws.write(r, 1, format!("Customer {}", r % 5000)).unwrap();
            ws.write(r, 2, cities[(r % 6) as usize]).unwrap();
            ws.write(r, 3, (r % 1000) as f64 * 1.25).unwrap();
            ws.write(r, 4, r % 97).unwrap();
            ws.write_with_format(r, 5, base + (r % 1500) as f64, &date_fmt)
                .unwrap();
            ws.write(r, 6, r % 3 == 0).unwrap();
            ws.write(r, 7, format!("Order note number {id} with some text"))
                .unwrap();
        }
    }

    // Small edge-case sheets for manual UI testing (benchmarks only read "Data").
    let dt_fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
    let mixed = wb.add_worksheet().set_name("Mixed types").unwrap();
    mixed.write_row(0, 0, ["label", "value", "label"]).unwrap(); // duplicate header, D1 blank
    mixed.write(0, 4, "extra").unwrap();
    mixed.write_row(1, 0, ["string", "hello"]).unwrap();
    mixed.write(2, 0, "float").unwrap();
    mixed.write(2, 1, 2.5).unwrap();
    mixed.write(3, 0, "bool").unwrap();
    mixed.write(3, 1, true).unwrap();
    mixed.write(4, 0, "datetime").unwrap();
    mixed
        .write_with_format(4, 1, 45293.5515625, &dt_fmt)
        .unwrap(); // 2024-01-02 13:14:15
    mixed.write(5, 0, "error").unwrap();
    mixed
        .write_formula(5, 1, Formula::new("=1/0").set_result("#DIV/0!"))
        .unwrap();
    mixed.write(7, 0, "after blank row").unwrap();

    let offset = wb.add_worksheet().set_name("Offset C3").unwrap();
    offset.write(2, 2, "starts at C3").unwrap();
    offset.write(3, 3, "D4").unwrap();

    let hidden = wb.add_worksheet().set_name("Hidden").unwrap();
    hidden.write(0, 0, "you should not see this tab").unwrap();
    hidden.set_hidden(true);

    wb.save(&out).unwrap();
}
