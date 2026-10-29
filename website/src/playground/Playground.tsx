import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FileDrop } from "./FileDrop";
import { PAGE, SheetGrid, cellAt, inputText, type Selection } from "./SheetGrid";
import { cellKind, columnName, formatBytes, formatMs, type CellKind } from "./cells";
import { NUM_FMTS, extent, isFormula, key, parseInput, type BookSheet, type Edit, type Fmt } from "./edits";
import type { Cell, ExportFormat, Progress, SheetInfo, ViewerRequest, ViewerResponse } from "./protocol";

type Opened = { sheets: SheetInfo[]; size: number; readMs: number; openMs: number };
/** The file's sheet loaded in the worker (all zero for a new blank sheet). */
type Base = { height: number; width: number; parseMs: number };
type LogEntry = { id: number; call: string; detail: string };
type Step = "open" | "sheet" | "rows" | "export" | null;

const LEGEND: [CellKind, string][] = [
  ["string", "text"],
  ["number", "number"],
  ["date", "date"],
  ["boolean", "bool"],
  ["error", "error"],
];
const LOG_MAX = 40;
const FILLS: [string, string][] = [
  ["", "No fill"],
  ["#fff2cc", "Yellow"],
  ["#e2f0d9", "Green"],
  ["#ddebf7", "Blue"],
  ["#fce4d6", "Orange"],
  ["#f4cccc", "Red"],
];
const MIME: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};
const BAD_NAME = /[[\]:*?/\\]/;

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
  const nextId = useRef(0);
  const [book, setBook] = useState<BookSheet[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pages, setPages] = useState(new Map<number, Cell[][]>());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [memory, setMemory] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [lastSlice, setLastSlice] = useState<[number, number]>([0, PAGE]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
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
          // ponytail: hidden sheets are left out of the editable book (and the export)
          const sheets = data.sheets
            .filter((s) => s.visibility === "Visible")
            .map((s): BookSheet => ({ id: nextId.current++, name: s.name, source: s.name, edits: new Map() }));
          setBook(sheets);
          if (sheets[0]) {
            setActiveId(sheets[0].id);
            w.postMessage({ type: "sheet", name: sheets[0].name } satisfies ViewerRequest);
          }
          break;
        }
        case "sheet":
          setProgress(null);
          setMemory(data.memory);
          requested.current.clear();
          setPages(new Map());
          setBase(data);
          addLog(`wb.sheet("${data.name}")`, `${formatMs(data.parseMs)} · ${data.height.toLocaleString()} rows`);
          break;
        case "rows":
          setPages((prev) => new Map(prev).set(data.start / PAGE, data.rows));
          setLastSlice([data.start, data.end]);
          addLog(`sheet.rowsSlice(${data.start}, ${data.end})`, formatMs(data.ms));
          break;
        case "exported": {
          setExporting(null);
          const blob = new Blob([data.bytes as BlobPart], { type: MIME[data.format] });
          const name = `${fileName.current}.${data.format}`;
          const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
          a.click();
          URL.revokeObjectURL(a.href);
          setDirty(false);
          addLog(data.format === "csv" ? "toCsv(rows)" : "new XlsxWriter() … save()", `${formatMs(data.ms)} · ${data.rows.toLocaleString()} rows · ${formatBytes(data.bytes.length)}`);
          break;
        }
        case "error":
          setExporting(null);
          setProgress(null);
          setError(data.code ? `${data.code}: ${data.message}` : data.message);
          addLog("throw", data.code ?? "Error");
          break;
      }
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  // Edits only live in this tab; warn before they're lost
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const fileName = useRef("workbook");
  const sheet = book.find((s) => s.id === activeId) ?? null;
  const discard = () => !dirty || confirm("Discard your edits?");

  function reset() {
    setOpened(null);
    setBase(null);
    setBook([]);
    setActiveId(null);
    setError(null);
    setSelected(null);
    setDirty(false);
  }

  function openFile(f: File) {
    if (!discard()) return;
    reset();
    setFile(f);
    fileName.current = f.name.replace(/\.[^.]+$/, "") || "workbook";
    send({ type: "open", file: f });
  }

  function newWorkbook() {
    if (!discard()) return;
    reset();
    setFile(null);
    fileName.current = "workbook";
    const s: BookSheet = { id: nextId.current++, name: "Sheet1", source: null, edits: new Map() };
    setBook([s]);
    activate(s);
  }

  function activate(s: BookSheet) {
    setError(null);
    setSelected(null);
    setActiveId(s.id);
    if (s.source) return send({ type: "sheet", name: s.source });
    requested.current.clear();
    setPages(new Map());
    setBase({ height: 0, width: 0, parseMs: 0 });
  }

  /** Checks a new sheet name the way Excel does; returns an error message or null. */
  function nameError(name: string, except?: number): string | null {
    if (!name.trim() || name.length > 31 || BAD_NAME.test(name) || name.startsWith("'") || name.endsWith("'"))
      return "Sheet names are 1–31 characters, without [ ] : * ? / \\ or a leading/trailing '";
    if (book.some((s) => s.id !== except && s.name.toLowerCase() === name.toLowerCase())) return `There's already a sheet named “${name}”`;
    return null;
  }

  function addSheet() {
    let n = book.length + 1;
    while (book.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
    const s: BookSheet = { id: nextId.current++, name: `Sheet${n}`, source: null, edits: new Map() };
    setBook((b) => [...b, s]);
    setDirty(true);
    activate(s);
  }

  function renameSheet(s: BookSheet) {
    const name = prompt("Rename sheet", s.name);
    if (name === null || name === s.name) return;
    const err = nameError(name, s.id);
    if (err) return setError(err);
    setBook((b) => b.map((x) => (x.id === s.id ? { ...x, name } : x)));
    setDirty(true);
  }

  function deleteSheet(s: BookSheet) {
    if (book.length === 1 || !confirm(`Delete “${s.name}”?`)) return;
    const i = book.indexOf(s);
    const rest = book.filter((x) => x !== s);
    setBook(rest);
    setDirty(true);
    if (s.id === activeId) activate(rest[Math.min(i, rest.length - 1)]);
  }

  /** Updates the active sheet's edit at `sel`. */
  function change(sel: Selection, patch: (e: Edit) => void) {
    if (!sheet) return;
    const k = key(sel.row, sel.col);
    const edits = new Map(sheet.edits);
    const e = { ...edits.get(k) };
    patch(e);
    // A blank sheet has nothing underneath, so a cleared, unformatted cell needs no edit at all
    if (e.f && Object.keys(e.f).length === 0) delete e.f;
    if (!e.f && (!("v" in e) || (e.v === null && !sheet.source))) edits.delete(k);
    else edits.set(k, e);
    setBook((b) => b.map((x) => (x.id === sheet.id ? { ...x, edits } : x)));
    setDirty(true);
  }

  const onEdit = (sel: Selection, text: string) =>
    change(sel, (e) => {
      e.v = parseInput(text);
    });

  function setFormat(name: keyof Fmt, value: Fmt[keyof Fmt]) {
    if (!selected) return;
    change(selected, (e) => {
      const f: Fmt = { ...e.f, [name]: value };
      if (!value) delete f[name];
      e.f = f;
    });
  }

  function exportAs(format: ExportFormat) {
    if (!sheet) return;
    setError(null);
    setExporting(format);
    const sheets = (format === "csv" ? [sheet] : book).map(({ name, source, edits }) => ({ name, source, edits }));
    send({ type: "export", format, sheets });
  }

  const requestPage = useCallback((page: number) => {
    if (requested.current.has(page)) return;
    requested.current.add(page);
    worker.current?.postMessage({ type: "rows", start: page * PAGE, end: (page + 1) * PAGE } satisfies ViewerRequest);
  }, []);

  const busy = progress !== null;
  const view = progress && progressView(progress);
  const hidden = opened?.sheets.filter((s) => s.visibility !== "Visible").length ?? 0;
  const step: Step = exporting
    ? "export"
    : progress?.phase === "read" || progress?.phase === "open"
      ? "open"
      : progress?.phase === "parse"
        ? "sheet"
        : base && sheet?.source
          ? "rows"
          : null;
  // Room to type past the end: 100 blank rows below and at least 26 columns
  const ext = sheet ? extent(sheet.edits) : { height: 0, width: 0 };
  const gridHeight = base ? Math.max(base.height, ext.height) + 100 : 0;
  const gridWidth = base ? Math.max(base.width, ext.width + 1, 26) : 0;
  const selValue = selected && sheet && base ? cellAt(pages, sheet.edits, base.height, selected.row, selected.col) : undefined;
  const selFmt = selected && sheet ? sheet.edits.get(key(selected.row, selected.col))?.f : undefined;

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
              <span>⤒ {book.length ? "Open a file" : "Drop a file"}</span>
            )}
          </FileDrop>
          <button className="codebtn" disabled={busy} onClick={newWorkbook}>
            ＋ New
          </button>
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
          {base && sheet?.source && (
            <>
              <span className="badge">
                Parse <b>{formatMs(base.parseMs)}</b>
              </span>
              <span className="badge">
                <b>{base.height.toLocaleString()}</b> × {base.width}
              </span>
            </>
          )}
          {memory > 0 && (
            <span className="badge" title="WebAssembly memory (it grows but never shrinks)">
              wasm <b>{formatBytes(memory)}</b>
            </span>
          )}
          {sheet && (
            <>
              {(["xlsx", "csv"] as const).map((f) => (
                <button
                  key={f}
                  className="codebtn"
                  disabled={busy || exporting !== null}
                  title={f === "csv" ? "Write this sheet to CSV with toCsv()" : "Write every sheet to a new .xlsx with XlsxWriter"}
                  onClick={() => exportAs(f)}
                >
                  {exporting === f ? "Exporting…" : `⤓ ${f}`}
                </button>
              ))}
            </>
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

        {!file && !book.length ? (
          <div className="empty">
            <FileDrop onFile={openFile} className="big">
              <div>
                <h2>Drop a spreadsheet to explore and edit it</h2>
                <p>xlsx, xlsm, xlsb, xls, ods or csv. It's parsed by WebAssembly in a Web Worker on your machine; nothing is uploaded.</p>
              </div>
            </FileDrop>
            <button className="codebtn" onClick={newWorkbook}>
              ＋ Or start a blank workbook
            </button>
          </div>
        ) : (
          <>
            <div className="fxbar">
              <span className="nm">{selected ? `${columnName(selected.col)}${selected.row + 1}` : ""}</span>
              <span className="fi">fx</span>
              <span className="vl">
                {selected && selValue !== undefined ? (
                  <>
                    {inputText(selValue)} <em>· {isFormula(selValue) ? "formula" : cellKind(selValue as Cell)}</em>
                  </>
                ) : (
                  <em>Click a cell, then type to edit. Start with = for a formula.</em>
                )}
              </span>
              <span className="fmt" aria-label="Cell format">
                <button disabled={!selected} aria-pressed={!!selFmt?.bold} title="Bold" onClick={() => setFormat("bold", !selFmt?.bold)}>
                  <b>B</b>
                </button>
                <select disabled={!selected} aria-label="Fill" value={selFmt?.fill ?? ""} onChange={(e) => setFormat("fill", e.target.value)}>
                  {FILLS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <select disabled={!selected} aria-label="Number format" value={selFmt?.numFmt ?? ""} onChange={(e) => setFormat("numFmt", e.target.value)}>
                  {NUM_FMTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </span>
            </div>
            {base && sheet ? (
              <SheetGrid
                key={sheet.id}
                height={gridHeight}
                width={gridWidth}
                baseHeight={base.height}
                pages={pages}
                edits={sheet.edits}
                requestPage={requestPage}
                selected={selected}
                onSelect={setSelected}
                onEdit={onEdit}
              />
            ) : (
              <div className="biggrid" />
            )}
            <nav className="sheettabs" aria-label="Sheets">
              {book.map((s) => (
                <button
                  key={s.id}
                  className={s.id === activeId ? "on" : ""}
                  aria-pressed={s.id === activeId}
                  disabled={busy}
                  title="Double-click to rename"
                  onClick={() => s.id !== activeId && activate(s)}
                  onDoubleClick={() => renameSheet(s)}
                >
                  {s.name}
                </button>
              ))}
              <button disabled={busy} title="Add a sheet" aria-label="Add a sheet" onClick={addSheet}>
                ＋
              </button>
              {sheet && book.length > 1 && (
                <button disabled={busy} title={`Delete “${sheet.name}”`} aria-label={`Delete sheet ${sheet.name}`} onClick={() => deleteSheet(sheet)}>
                  🗑
                </button>
              )}
              {hidden > 0 && <span className="hidden">+{hidden} hidden (not editable or exported)</span>}
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
            <K>import</K> init, {"{ Workbook }"} <K>from</K> <S>"@kuramajs/excel"</S>;
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
            <K>const</K> sheet = wb.<F>sheet</F>(<S>"{progress?.phase === "parse" ? progress.name : (sheet?.source ?? "Sheet1")}"</S>, {"{"}
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
          <L> </L>
          <L on={step === "export"}>
            <C>// 4 · export, with your edits on top</C>
          </L>
          <L on={step === "export"}>
            <K>import</K> {"{ XlsxWriter, toCsv }"} <K>from</K> <S>"@kuramajs/excel/writer"</S>;
          </L>
          <L on={step === "export"}>
            <K>const</K> out = <K>new</K> <F>XlsxWriter</F>();
          </L>
          <L on={step === "export"}>
            <K>const</K> ws = out.<F>addSheet</F>(<S>"{sheet?.name ?? "Sheet1"}"</S>);
          </L>
          <L on={step === "export"}>
            ws.<F>addRow</F>([<P>1</P>, {"{ formula: "}<S>"SUM(A1:A3)"</S>{" }"}, {"{ value, format }"}]);
          </L>
          <L on={step === "export"}>
            out.<F>save</F>(); <C>// or toCsv(rows)</C>
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
