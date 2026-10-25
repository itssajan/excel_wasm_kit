import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileDrop } from "./FileDrop";
import { PAGE, SheetGrid, type Selection } from "./SheetGrid";
import { cellKind, columnName, formatBytes, formatCell, formatMs, type CellKind } from "./cells";
import type { Cell, Progress, SheetInfo, ViewerRequest, ViewerResponse } from "./protocol";

type Opened = { sheets: SheetInfo[]; size: number; readMs: number; openMs: number };
type ActiveSheet = { name: string; height: number; width: number; parseMs: number };
type LogEntry = { id: number; call: string; detail: string };
type Step = "open" | "sheet" | "rows" | null;

const LEGEND: [CellKind, string][] = [
  ["string", "text"],
  ["number", "number"],
  ["date", "date"],
  ["boolean", "bool"],
  ["error", "error"],
];
const LOG_MAX = 40;

function progressView(p: Progress): { label: string; value?: number } {
  switch (p.phase) {
    case "read":
      return { label: `Reading file… ${formatBytes(p.done)} / ${formatBytes(p.total)}`, value: (p.done / p.total) * 100 };
    case "open":
      return { label: "Opening workbook (shared strings and sheet list)…" };
    case "parse":
      return {
        label: `Parsing “${p.name}”… ${p.done.toLocaleString()} / ${p.total.toLocaleString()} rows`,
        value: Math.min(100, (p.done / p.total) * 100),
      };
  }
}

export default function Playground() {
  const worker = useRef<Worker>(null);
  const requested = useRef(new Set<number>());
  const logId = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [active, setActive] = useState<ActiveSheet | null>(null);
  const [pages, setPages] = useState(new Map<number, Cell[][]>());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [memory, setMemory] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ sel: Selection; cell: Cell } | null>(null);
  const [lastSlice, setLastSlice] = useState<[number, number]>([0, PAGE]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [showCode, setShowCode] = useState(() => !matchMedia("(max-width: 760px)").matches);

  const addLog = (call: string, detail: string) =>
    setLog((l) => [{ id: logId.current++, call, detail }, ...l].slice(0, LOG_MAX));
  const send = (req: ViewerRequest) => worker.current?.postMessage(req);

  useEffect(() => {
    const w = new Worker(new URL("./excel.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = ({ data }: MessageEvent<ViewerResponse>) => {
      switch (data.type) {
        case "progress":
          setProgress(data.progress);
          break;
        case "opened": {
          setProgress(null);
          setMemory(data.memory);
          setOpened(data);
          addLog("Workbook.open(bytes)", `${formatMs(data.openMs)} · ${data.sheets.length} sheets`);
          const first = data.sheets.find((s) => s.visibility === "Visible");
          if (first) w.postMessage({ type: "sheet", name: first.name } satisfies ViewerRequest);
          break;
        }
        case "sheet":
          setProgress(null);
          setMemory(data.memory);
          requested.current.clear();
          setPages(new Map());
          setSelected(null);
          setActive(data);
          addLog(`wb.sheet("${data.name}")`, `${formatMs(data.parseMs)} · ${data.height.toLocaleString()} rows`);
          break;
        case "rows":
          setPages((prev) => new Map(prev).set(data.start / PAGE, data.rows));
          setLastSlice([data.start, data.end]);
          addLog(`sheet.rowsSlice(${data.start}, ${data.end})`, formatMs(data.ms));
          break;
        case "error":
          setProgress(null);
          setError(data.code ? `${data.code}: ${data.message}` : data.message);
          addLog("throw", data.code ?? "Error");
          break;
      }
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  function openFile(f: File) {
    setFile(f);
    setOpened(null);
    setActive(null);
    setError(null);
    setSelected(null);
    send({ type: "open", file: f });
  }

  function loadSheet(name: string) {
    setError(null);
    send({ type: "sheet", name });
  }

  const requestPage = useCallback((page: number) => {
    if (requested.current.has(page)) return;
    requested.current.add(page);
    worker.current?.postMessage({ type: "rows", start: page * PAGE, end: (page + 1) * PAGE } satisfies ViewerRequest);
  }, []);

  const busy = progress !== null;
  const view = progress && progressView(progress);
  const visibleSheets = opened?.sheets.filter((s) => s.visibility === "Visible") ?? [];
  const hidden = (opened?.sheets.length ?? 0) - visibleSheets.length;
  const step: Step =
    progress?.phase === "read" || progress?.phase === "open" ? "open" : progress?.phase === "parse" ? "sheet" : active ? "rows" : null;

  return (
    <div className={`pg ${showCode ? "" : "collapsed"}`}>
      <div className="left">
        <div className="toolbar">
          <FileDrop onFile={openFile} disabled={busy}>
            {file ? (
              <span>
                <b>{file.name}</b> · {formatBytes(file.size)}
              </span>
            ) : (
              <span>⤒ Drop a file</span>
            )}
          </FileDrop>
          {opened && (
            <>
              <span className="badge">
                Read <b>{formatMs(opened.readMs)}</b>
              </span>
              <span className="badge">
                Open <b>{formatMs(opened.openMs)}</b>
              </span>
            </>
          )}
          {active && (
            <>
              <span className="badge">
                Parse <b>{formatMs(active.parseMs)}</b>
              </span>
              <span className="badge">
                <b>{active.height.toLocaleString()}</b> × {active.width}
              </span>
            </>
          )}
          {memory > 0 && (
            <span className="badge" title="WebAssembly memory (it grows but never shrinks)">
              wasm <b>{formatBytes(memory)}</b>
            </span>
          )}
          <button className="codebtn" aria-pressed={showCode} onClick={() => setShowCode((s) => !s)}>
            &lt;/&gt; Code
          </button>
          <ul className="legend" aria-label="Cell type legend">
            {LEGEND.map(([k, label]) => (
              <li key={k} className={`k-${k}`}>
                {label}
              </li>
            ))}
          </ul>
        </div>

        {view && (
          <div className="progress" role="status" aria-live="polite">
            {view.label}
            <div className="track">
              <i className={view.value === undefined ? "indeterminate" : ""} style={view.value === undefined ? undefined : { width: `${view.value}%` }} />
            </div>
          </div>
        )}
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}

        {!file ? (
          <div className="empty">
            <FileDrop onFile={openFile} className="big">
              <div>
                <h2>Drop a spreadsheet to explore it</h2>
                <p>xlsx, xlsm, xlsb, xls or ods. It's parsed by WebAssembly in a Web Worker on your machine; nothing is uploaded.</p>
              </div>
            </FileDrop>
          </div>
        ) : (
          <>
            <div className="fxbar">
              <span className="nm">{selected ? `${columnName(selected.sel.col)}${selected.sel.row + 1}` : ""}</span>
              <span className="fi">fx</span>
              <span className="vl">
                {selected ? (
                  <>
                    {formatCell(selected.cell)} <em>· {cellKind(selected.cell)}</em>
                  </>
                ) : (
                  <em>Click a cell to inspect its value</em>
                )}
              </span>
            </div>
            {active ? (
              <SheetGrid
                key={active.name}
                height={active.height}
                width={active.width}
                pages={pages}
                requestPage={requestPage}
                selected={selected?.sel ?? null}
                onSelect={(sel, cell) => setSelected({ sel, cell })}
              />
            ) : (
              <div className="biggrid" />
            )}
            <nav className="sheettabs" aria-label="Sheets">
              {visibleSheets.map((s) => (
                <button key={s.name} className={active?.name === s.name ? "on" : ""} aria-pressed={active?.name === s.name} disabled={busy} onClick={() => loadSheet(s.name)}>
                  {s.name}
                </button>
              ))}
              {hidden > 0 && <span className="hidden">+{hidden} hidden</span>}
            </nav>
          </>
        )}
      </div>

      <aside className="codepanel" aria-label="Code behind this view">
        <div className="ph">
          <span>Code behind this view</span>
          <span>
            {busy && <span className="live">● running</span>}{" "}
            <button onClick={() => setShowCode(false)} aria-label="Hide code panel">
              ✕
            </button>
          </span>
        </div>
        <pre>
          <L>
            <K>import</K> init, {"{ Workbook }"} <K>from</K> <S>"@milojs/excel-kit"</S>;
          </L>
          <L>
            <K>await</K> <F>init</F>();
          </L>
          <L> </L>
          <L on={step === "open"}>
            <C>// 1 · open (in a Web Worker)</C>
          </L>
          <L on={step === "open"}>
            <K>const</K> wb = Workbook.<F>open</F>(bytes);
          </L>
          <L on={step === "open"}>
            wb.<F>sheets</F>();{" "}
            <C>
              // {opened ? `${opened.sheets.length} sheets${hidden ? `, ${hidden} hidden` : ""}` : "[{ name, visibility }]"}
            </C>
          </L>
          <L> </L>
          <L on={step === "sheet"}>
            <C>// 2 · parse the selected sheet</C>
          </L>
          <L on={step === "sheet"}>
            <K>const</K> sheet = wb.<F>sheet</F>(<S>"{active?.name ?? (progress?.phase === "parse" ? progress.name : "Sheet1")}"</S>, {"{"}
          </L>
          <L on={step === "sheet"}>
            {"  "}
            <F>onProgress</F>: (read, total) =&gt; <F>post</F>(read / total),
          </L>
          <L on={step === "sheet"}>{"});"}</L>
          <L> </L>
          <L on={step === "rows"}>
            <C>// 3 · fetch only the rows on screen</C>
          </L>
          <L on={step === "rows"}>
            sheet.<F>rowsSlice</F>(<P>{lastSlice[0]}</P>, <P>{lastSlice[1]}</P>);
          </L>
        </pre>
        <div className="log" aria-label="Call log">
          {log.length === 0 ? <div>Calls and timings show up here.</div> : log.map((e) => (
            <div key={e.id}>
              <b>{e.call}</b> {e.detail}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

const L = ({ on, children }: { on?: boolean; children: ReactNode }) => <span className={`ln ${on ? "now" : ""}`}>{children}</span>;
const K = ({ children }: { children: ReactNode }) => <span className="k">{children}</span>;
const S = ({ children }: { children: ReactNode }) => <span className="s">{children}</span>;
const F = ({ children }: { children: ReactNode }) => <span className="f">{children}</span>;
const C = ({ children }: { children: ReactNode }) => <span className="c">{children}</span>;
const P = ({ children }: { children: ReactNode }) => <span className="p">{children}</span>;
