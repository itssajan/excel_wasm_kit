import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell } from "@/protocol";
import { KIND_CLASS, cellKind, columnName, formatCell, rawCell } from "@/cells";

const ROW_HEIGHT = 28;
export const PAGE = 200;
const COL_WIDTH = 140;
const NUM_WIDTH = 72;
// ponytail: columns are not virtualized; very wide sheets are capped
const MAX_COLS = 200;

type Props = {
  height: number;
  width: number;
  pages: Map<number, Cell[][]>;
  requestPage: (page: number) => void;
};

export function SheetGrid({ height, width, pages, requestPage }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cols = Math.min(width, MAX_COLS);
  const virtualizer = useVirtualizer({
    count: height,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });
  const items = virtualizer.getVirtualItems();

  // Ask for every visible page of rows; the parent dedupes requests
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) requestPage(p);
  }, [first, last, requestPage]);

  const rowAt = (i: number): Cell[] | undefined => pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  const totalWidth = NUM_WIDTH + cols * COL_WIDTH;

  return (
    <div className="rounded-md border">
      {width > MAX_COLS && (
        <p className="border-b px-3 py-1 text-xs text-muted-foreground">
          Showing first {MAX_COLS} of {width} columns.
        </p>
      )}
      <div ref={scrollRef} className="h-[60vh] overflow-auto text-sm" role="grid" aria-rowcount={height} aria-colcount={cols}>
        <div style={{ width: totalWidth }} className="sticky top-0 z-10 flex border-b bg-muted font-medium text-muted-foreground" role="row">
          <div style={{ width: NUM_WIDTH }} className="sticky left-0 shrink-0 border-r bg-muted px-2 py-1" />
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} style={{ width: COL_WIDTH }} className="shrink-0 border-r px-2 py-1 text-center" role="columnheader">
              {columnName(c)}
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), width: totalWidth }} className="relative">
          {items.map((item) => {
            const row = rowAt(item.index);
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 1}
                className="absolute left-0 flex border-b"
                style={{ top: item.start, height: ROW_HEIGHT, width: totalWidth }}
              >
                <div
                  style={{ width: NUM_WIDTH }}
                  className="sticky left-0 shrink-0 border-r bg-muted px-2 py-1 text-right tabular-nums text-muted-foreground"
                  role="rowheader"
                >
                  {item.index + 1}
                </div>
                {Array.from({ length: cols }, (_, c) => {
                  if (!row) return <div key={c} style={{ width: COL_WIDTH }} className="shrink-0 animate-pulse border-r bg-muted/60" />;
                  const cell = row[c] ?? null;
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      title={rawCell(cell)}
                      style={{ width: COL_WIDTH }}
                      className={`shrink-0 truncate border-r px-2 py-1 ${KIND_CLASS[cellKind(cell)]}`}
                    >
                      {formatCell(cell)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
