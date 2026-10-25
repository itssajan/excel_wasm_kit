# Benchmarks

```bash
npm run build                      # repo root: builds pkg/
cd bench && npm install
mkdir -p fixtures
cargo run --release --example gen_bench -- 22000   fixtures/1mb.xlsx
cargo run --release --example gen_bench -- 220000  fixtures/10mb.xlsx
cargo run --release --example gen_bench -- 1040000 fixtures/50mb.xlsx
node run.mjs                       # writes results.md
```

Each case runs in a fresh Node process. Time = parse + read every row of the first sheet (file read excluded).
Peak RSS includes the ~43 MB Node baseline.

Release profile: opt-level 3 + LTO + `wasm-opt -O3`. Measured alternatives (10 MB file, `rows()`):

| Profile | Gzip wasm | Time |
|---|---:|---:|
| opt 3, no LTO | 381 KB | 739 ms |
| **opt 3 + LTO, -O3** | **354 KB** | **741 ms** |
| opt s + LTO, -Os | 328 KB | 836 ms |
| opt z + LTO, -Oz | 315 KB | 1278 ms |

Latest results: [results.md](results.md).
