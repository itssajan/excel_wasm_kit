import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { BENCH_LIBS, type BenchLib, type BenchResponse } from "@/protocol";
import { formatMs } from "@/cells";

type Result = { lib: BenchLib; ms?: number; rows?: number; error?: string };

const chartConfig = { ms: { label: "Time (ms)", color: "var(--chart-2)" } } satisfies ChartConfig;

export function BenchPanel({ file, sheets }: { file: File; sheets: string[] }) {
  const [sheet, setSheet] = useState(sheets[0]);
  const [libs, setLibs] = useState<BenchLib[]>(BENCH_LIBS);
  const [runs, setRuns] = useState(file.size > 50e6 ? "1" : "3");
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => setSheet(sheets[0]), [sheets]);

  function run() {
    setRunning(true);
    setResults([]);
    const pending = [...libs];
    const worker = new Worker(new URL("../bench.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<BenchResponse>) => {
      if (data.type === "done") {
        setRunning(false);
        worker.terminate();
        return;
      }
      pending.splice(pending.indexOf(data.lib), 1);
      setResults((r) => [...r, data.type === "result" ? { lib: data.lib, ms: data.ms, rows: data.rows } : { lib: data.lib, error: data.error }]);
    };
    // a crashed worker (e.g. out of memory) never sends "done"; blame the library that was running
    worker.onerror = (e) => {
      const lib = pending[0];
      if (lib) setResults((r) => [...r, { lib, error: `worker crashed: ${e.message || "out of memory?"}` }]);
      setRunning(false);
      worker.terminate();
    };
    worker.postMessage({ file, sheet, libs, runs: Number(runs) });
  }

  const toggle = (lib: BenchLib, on: boolean) =>
    setLibs((l) => (on ? BENCH_LIBS.filter((x) => x === lib || l.includes(x)) : l.filter((x) => x !== lib)));
  const fastest = Math.min(...results.filter((r) => r.ms != null).map((r) => r.ms!));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">Sheet</span>
          <Select value={sheet} onValueChange={setSheet} disabled={running}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sheets.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block text-muted-foreground">Runs (median)</span>
          <Select value={runs} onValueChange={setRuns} disabled={running}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="5">5</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <fieldset className="flex flex-wrap gap-4 text-sm" disabled={running}>
          <legend className="sr-only">Libraries</legend>
          {BENCH_LIBS.map((lib) => (
            <label key={lib} className="flex items-center gap-2">
              <Checkbox checked={libs.includes(lib)} onCheckedChange={(v) => toggle(lib, v === true)} />
              {lib}
            </label>
          ))}
        </fieldset>
        <Button onClick={run} disabled={running || libs.length === 0}>
          {running ? "Running…" : "Run benchmark"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Time = parse + read every row of the sheet, in a worker. On large files, libraries that load everything into memory can
        crash the worker.
      </p>

      {results.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Library</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">vs fastest</TableHead>
                <TableHead className="text-right">Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.lib}>
                  <TableCell className="font-medium">{r.lib}</TableCell>
                  {r.error ? (
                    <TableCell colSpan={3} className="text-red-700">
                      {r.error}
                    </TableCell>
                  ) : (
                    <>
                      <TableCell className="text-right tabular-nums">{formatMs(r.ms!)}</TableCell>
                      <TableCell className="text-right tabular-nums">{(r.ms! / fastest).toFixed(1)}×</TableCell>
                      <TableCell className="text-right tabular-nums">{r.rows!.toLocaleString()}</TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <ChartContainer config={chartConfig} className="min-h-56 w-full">
            <BarChart data={results.filter((r) => r.ms != null)} layout="vertical" margin={{ left: 40 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" dataKey="ms" tickFormatter={(v) => formatMs(v)} />
              <YAxis type="category" dataKey="lib" width={150} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="ms" fill="var(--color-ms)" radius={4} />
            </BarChart>
          </ChartContainer>
        </div>
      )}
    </div>
  );
}
