Node v22.21.1, 3 runs (median time, max peak RSS). Baseline process RSS: 43 MB.

### 1mb.xlsx (1.0 MB)

| Library | Time | Peak RSS | Rows |
|---|---:|---:|---:|
| kurama rows() | 0.11 s | 130 MB | 22001 |
| kurama iterRows() | 0.10 s | 89 MB | 22001 |
| kurama forEachRow() | 0.10 s | 96 MB | 22001 |
| sheetjs | 0.34 s | 166 MB | 22001 |
| exceljs | 0.41 s | 208 MB | 22001 |
| exceljs stream | 0.28 s | 146 MB | 22001 |

### 10mb.xlsx (10.0 MB)

| Library | Time | Peak RSS | Rows |
|---|---:|---:|---:|
| kurama rows() | 0.76 s | 379 MB | 220001 |
| kurama iterRows() | 0.72 s | 126 MB | 220001 |
| kurama forEachRow() | 0.73 s | 127 MB | 220001 |
| sheetjs | 2.55 s | 675 MB | 220001 |
| exceljs | 2.87 s | 1000 MB | 220001 |
| exceljs stream | 1.71 s | 327 MB | 220001 |

### 50mb.xlsx (47.5 MB)

| Library | Time | Peak RSS | Rows |
|---|---:|---:|---:|
| kurama rows() | 3.55 s | 1326 MB | 1040001 |
| kurama iterRows() | 3.37 s | 276 MB | 1040001 |
| kurama forEachRow() | 3.41 s | 282 MB | 1040001 |
| sheetjs | 12.29 s | 2913 MB | 1040001 |
| exceljs | 16.24 s | 4111 MB | 1040001 |
| exceljs stream | 7.51 s | 730 MB | 1040001 |

### Browser bundle size

| Library | Raw | Gzip |
|---|---:|---:|
| kurama (wasm + js) | 712 KB | 361 KB |
| sheetjs (xlsx.full.min.js) | 930 KB | 328 KB |
| exceljs (exceljs.min.js) | 925 KB | 252 KB |
