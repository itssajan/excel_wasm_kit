import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell } from "./protocol";
import { KIND_CLASS, cellKind, columnName, formatCell, rawCell } from "./cells";

const ROW_HEIGHT = 28;
export const PAGE = 200;
const COL_WIDTH = 140;
const NUM_WIDTH = 64;
// ponytail: columns are not virtualized; very wide sheets are capped
const MAX_COLS = 200;

export type Selection = { row: number; col: number };

type Props = {
  height: number;
  width: number;
  pages: Map<number, Cell[][]>;
  requestPage: (page: number) => void;
  selected: Selection | null;
  onSelect: (sel: Selection, cell: Cell) => void;
};

export function SheetGrid({ height, width, pages, requestPage, selected, onSelect }: Props) {
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
  const colStyle = { width: COL_WIDTH };
  const numStyle = { width: NUM_WIDTH };

  return (
    <div ref={scrollRef} className="biggrid" role="grid" aria-rowcount={height} aria-colcount={cols}>
      <div style={{ width: totalWidth }} className="vhead" role="row">
        <div style={numStyle} className="vnum">
          {width > MAX_COLS ? `${MAX_COLS}/${width}` : ""}
        </div>
        {Array.from({ length: cols }, (_, c) => (
          <div key={c} style={colStyle} className={selected?.col === c ? "sel" : ""} role="columnheader">
            {columnName(c)}
          </div>
        ))}
      </div>
      <div style={{ height: virtualizer.getTotalSize(), width: totalWidth }} className="vbody">
        {items.map((item) => {
          const row = rowAt(item.index);
          return (
            <div key={item.key} role="row" aria-rowindex={item.index + 1} className="vrow" style={{ top: item.start, width: totalWidth }}>
              <div style={numStyle} className={`vnum ${selected?.row === item.index ? "sel" : ""}`} role="rowheader">
                {item.index + 1}
              </div>
              {Array.from({ length: cols }, (_, c) => {
                if (!row) return <div key={c} style={colStyle} className="skel" />;
                const cell = row[c] ?? null;
                const isSel = selected?.row === item.index && selected.col === c;
                return (
                  <div
                    key={c}
                    role="gridcell"
                    aria-selected={isSel}
                    title={rawCell(cell)}
                    style={colStyle}
                    className={`${KIND_CLASS[cellKind(cell)]} ${isSel ? "sel" : ""}`}
                    onClick={() => onSelect({ row: item.index, col: c }, cell)}
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
  );
}
