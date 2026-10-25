import { useCallback, useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress as ProgressBar } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BenchPanel } from "@/components/BenchPanel";
import { PAGE, SheetGrid } from "@/components/SheetGrid";
import { KIND_CLASS, formatBytes, formatMs, type CellKind } from "@/cells";
import type { Cell, Progress, SheetInfo, ViewerRequest, ViewerResponse } from "@/protocol";

type Opened = { sheets: SheetInfo[]; size: number; readMs: number; openMs: number };
type ActiveSheet = { name: string; height: number; width: number; parseMs: number };

const LEGEND: CellKind[] = ["string", "number", "date", "boolean", "error", "empty"];

function progressView(p: Progress): { label: string; value?: number } {
  switch (p.phase) {
    case "read":
      return { label: `Reading file… ${formatBytes(p.done)} / ${formatBytes(p.total)}`, value: (p.done / p.total) * 100 };
    case "open":
      return { label: "Opening workbook (reading shared strings and sheet list)…" };
    case "parse":
      return {
        label: `Parsing “${p.name}”… ${p.done.toLocaleString()} / ${p.total.toLocaleString()} rows`,
        value: Math.min(100, (p.done / p.total) * 100),
      };
  }
}

export default function App() {
  const worker = useRef<Worker>(null);
  const requested = useRef(new Set<number>());
  const [file, setFile] = useState<File | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [active, setActive] = useState<ActiveSheet | null>(null);
  const [pages, setPages] = useState(new Map<number, Cell[][]>());
  const [progress, setProgress] = useState<Progress | null>(null);
  const [memory, setMemory] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

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
          const first = data.sheets.find((s) => s.visibility === "Visible");
          if (first) w.postMessage({ type: "sheet", name: first.name } satisfies ViewerRequest);
          break;
        }
        case "sheet":
          setProgress(null);
          setMemory(data.memory);
          requested.current.clear();
          setPages(new Map());
          setActive(data);
          break;
        case "rows":
          setPages((prev) => new Map(prev).set(data.start / PAGE, data.rows));
          break;
        case "error":
          setProgress(null);
          setError(data.code ? `${data.code}: ${data.message}` : data.message);
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

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <FileSpreadsheet className="size-6" aria-hidden /> excel-kit
        </h1>
        <p className="text-muted-foreground">Fast, low-memory Excel reader in WebAssembly. Everything runs locally in your browser.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Open a workbook</CardTitle>
          <CardDescription>xlsx, xlsm, xlsb, xls or ods. Parsing runs in a Web Worker, so the page stays responsive.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f && !busy) openFile(f);
            }}
            className={`flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              dragging ? "border-primary bg-muted" : "border-border"
            }`}
          >
            <Upload className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{file ? `${file.name} (${formatBytes(file.size)})` : "Drop a file here"}</p>
            <Button asChild variant="outline" disabled={busy}>
              <label>
                Choose file
                <input
                  type="file"
                  className="sr-only"
                  accept=".xlsx,.xlsm,.xlsb,.xls,.ods"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) openFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
          </div>

          {view && (
            <div className="space-y-2" role="status" aria-live="polite">
              <p className="text-sm">{view.label}</p>
              {view.value === undefined ? (
                <div className="h-2 animate-pulse rounded-full bg-primary/40" />
              ) : (
                <ProgressBar value={view.value} aria-label={view.label} />
              )}
            </div>
          )}
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
              {error}
            </p>
          )}

          {opened && (
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="secondary">File {formatBytes(opened.size)}</Badge>
              <Badge variant="secondary">Read {formatMs(opened.readMs)}</Badge>
              <Badge variant="secondary">Open {formatMs(opened.openMs)}</Badge>
              {active && (
                <Badge variant="secondary">
                  Parse “{active.name}” {formatMs(active.parseMs)}
                </Badge>
              )}
              {active && (
                <Badge variant="secondary">
                  {active.height.toLocaleString()} rows × {active.width} cols
                </Badge>
              )}
              <Badge variant="secondary">wasm memory {formatBytes(memory)}</Badge>
            </div>
          )}
        </CardContent>
      </Card>

      {opened && file && (
        <Tabs defaultValue="viewer">
          <TabsList>
            <TabsTrigger value="viewer">Viewer</TabsTrigger>
            <TabsTrigger value="bench">Benchmark</TabsTrigger>
          </TabsList>

          <TabsContent value="viewer" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <nav className="flex flex-wrap gap-2" aria-label="Sheets">
                {visibleSheets.map((s) => (
                  <Button
                    key={s.name}
                    size="sm"
                    variant={active?.name === s.name ? "default" : "outline"}
                    aria-pressed={active?.name === s.name}
                    disabled={busy}
                    onClick={() => loadSheet(s.name)}
                  >
                    {s.name}
                  </Button>
                ))}
                {opened.sheets.length > visibleSheets.length && (
                  <span className="self-center text-xs text-muted-foreground">
                    {opened.sheets.length - visibleSheets.length} hidden sheet(s) not shown
                  </span>
                )}
              </nav>
              <ul className="flex flex-wrap gap-1 text-xs" aria-label="Cell type legend">
                {LEGEND.map((k) => (
                  <li key={k} className={`rounded border px-2 py-0.5 ${KIND_CLASS[k]}`}>
                    {k}
                  </li>
                ))}
              </ul>
            </div>
            {active && (
              <SheetGrid key={active.name} height={active.height} width={active.width} pages={pages} requestPage={requestPage} />
            )}
          </TabsContent>

          <TabsContent value="bench">
            <BenchPanel file={file} sheets={visibleSheets.map((s) => s.name)} />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}
