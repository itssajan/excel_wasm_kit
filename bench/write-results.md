Node v22.21.1, 3 runs (median time, max peak RSS). Baseline process RSS: 42 MB.

### Write 100,000 rows x 8 columns

| Library | Time | Peak RSS | File |
|---|---:|---:|---:|
| kurama XlsxWriter | 0.33 s | 86 MB | 4.4 MB |
| sheetjs | 2.03 s | 472 MB | 11.6 MB |
| exceljs | 2.70 s | 1245 MB | 4.6 MB |
| exceljs stream | 0.62 s | 150 MB | 5.2 MB |

### Write 1,000,000 rows x 8 columns

| Library | Time | Peak RSS | File |
|---|---:|---:|---:|
| kurama XlsxWriter | 3.24 s | 239 MB | 44.2 MB |
| sheetjs | 27.11 s | 3557 MB | 117.4 MB |
| exceljs | failed | | |
| exceljs stream | 4.43 s | 510 MB | 52.0 MB |

