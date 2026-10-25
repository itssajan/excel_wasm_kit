import { useState } from "react";
import { FileDrop } from "./FileDrop";
import { formatBytes, formatMs } from "./cells";
import { BENCH_LIBS, type BenchLib, type BenchRequest, type BenchResponse } from "./protocol";

type Result = { lib: BenchLib; ms?: number; rows?: number; error?: string };

const benchWorker = () => new Worker(new URL("./bench.worker.ts", import.meta.url), { type: "module" });

export default function BrowserBench() {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  const [libs, setLibs] = useState<BenchLib[]>(BENCH_LIBS);
  const [runs, setRuns] = useState(3);
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(f: File) {
    setFile(f);
    setSheets([]);
    setResults([]);
    setError(null);
    setRuns(f.size > 50e6 ? 1 : 3);
    const w = benchWorker();
    w.onmessage = ({ data }: MessageEvent<BenchResponse>) => {
      if (data.type === "sheets") {
        setSheets(data.names);
        setSheet(data.names[0] ?? "");
      } else if (data.type === "error") setError(data.message);
      w.terminate();
    };
    w.postMessage({ type: "list", file: f } satisfies BenchRequest);
  }

  function run() {
    if (!file) return;
    setRunning(true);
    setResults([]);
    const pending = [...libs];
    const w = benchWorker();
    w.onmessage = ({ data }: MessageEvent<BenchResponse>) => {
      if (data.type === "done") {
        setRunning(false);
        w.terminate();
      } else if (data.type === "result" || data.type === "failed") {
        pending.splice(pending.indexOf(data.lib), 1);
        setResults((r) => [...r, data.type === "result" ? { lib: data.lib, ms: data.ms, rows: data.rows } : { lib: data.lib, error: data.error }]);
      }
    };
    // a crashed worker (e.g. out of memory) never sends "done"; blame the library that was running
    w.onerror = (e) => {
      const lib = pending[0];
      if (lib) setResults((r) => [...r, { lib, error: `worker crashed: ${e.message || "out of memory?"}` }]);
      setRunning(false);
      w.terminate();
    };
    w.postMessage({ type: "run", file, sheet, libs, runs } satisfies BenchRequest);
  }

  const toggle = (lib: BenchLib, on: boolean) =>
    setLibs((l) => (on ? BENCH_LIBS.filter((x) => x === lib || l.includes(x)) : l.filter((x) => x !== lib)));
  const times = results.filter((r) => r.ms != null).map((r) => r.ms!);
  const fastest = Math.min(...times);
  const slowest = Math.max(...times);

  return (
    <div className="runcard">
      <FileDrop onFile={pick} disabled={running} className="big">
        {file ? (
          <span>
            <b>{file.name}</b> · {formatBytes(file.size)}
          </span>
        ) : (
          <span>Drop an xlsx, xlsm, xlsb, xls or ods file, or</span>
        )}
      </FileDrop>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <fieldset className="libs" disabled={running}>
          <legend className="sr-only">Libraries</legend>
          {BENCH_LIBS.map((lib) => (
            <label key={lib} className="check">
              <input type="checkbox" checked={libs.includes(lib)} onChange={(e) => toggle(lib, e.target.checked)} />
              {lib}
            </label>
          ))}
        </fieldset>
        <label>
          Sheet{" "}
          <select value={sheet} onChange={(e) => setSheet(e.target.value)} disabled={running || !sheets.length}>
            {sheets.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Runs{" "}
          <select value={runs} onChange={(e) => setRuns(Number(e.target.value))} disabled={running}>
            {[1, 3, 5].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button className="btn primary sm" onClick={run} disabled={running || !sheet || libs.length === 0}>
          {running ? "Running…" : "Run benchmark"}
        </button>
      </div>
      <div className="warn">
        Time = parse + read every row of the sheet, median of the runs, in a Web Worker. Files over ~50 MB can crash the worker for
        libraries that load everything into memory. Nothing is uploaded.
      </div>

      {results.length > 0 && (
        <div className="bars results" aria-live="polite">
          {results.map((r) => (
            <div key={r.lib} className={`bar ${r.lib.startsWith("excel-kit") ? "us" : ""}`}>
              <span className="lbl">{r.lib}</span>
              {r.error ? (
                <span className="err-text">{r.error}</span>
              ) : (
                <span className="track">
                  <span className="fill" style={{ width: `${(r.ms! / slowest) * 100}%` }} />
                </span>
              )}
              <span className="val">{r.ms != null ? `${formatMs(r.ms)} · ${(r.ms / fastest).toFixed(1)}×` : "failed"}</span>
            </div>
          ))}
          {running && <p className="chartnote">Running {libs[results.length]}…</p>}
        </div>
      )}
    </div>
  );
}
