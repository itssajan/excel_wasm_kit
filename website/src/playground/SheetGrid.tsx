import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell } from "./protocol";
import { KIND_CLASS, cellKind, columnName, formatCell, rawCell } from "./cells";
import { isFormula, key, parseInput, type Edit, type Edits } from "./edits";

const ROW_HEIGHT = 28;
export const PAGE = 200;
const COL_WIDTH = 140;
const NUM_WIDTH = 64;
// ponytail: columns are not virtualized; very wide sheets are capped
const MAX_COLS = 200;

export type Selection = { row: number; col: number };
export type Value = Edit["v"];

/** The file's cell with any edit on top. `undefined` = that page isn't loaded yet. */
export function cellAt(pages: Map<number, Cell[][]>, edits: Edits, baseHeight: number, row: number, col: number): Value {
  const e = edits.get(key(row, col));
  if (e && "v" in e) return e.v;
  if (row >= baseHeight) return null;
  const r = pages.get(Math.floor(row / PAGE))?.[row % PAGE];
  return r && (r[col] ?? null);
}

/** Text for the editor and the formula bar: formulas with `=`, text that would parse as something else with `'`. */
export function inputText(v: Value): string {
  if (v === undefined || v === null) return "";
  if (isFormula(v)) return `=${v.formula}`;
  if (typeof v === "string") return parseInput(v) === v ? v : `'${v}`;
  return formatCell(v);
}

type Props = {
  height: number;
  width: number;
  /** Rows in the file; rows below it are blank. */
  baseHeight: number;
  pages: Map<number, Cell[][]>;
  edits: Edits;
  requestPage: (page: number) => void;
  selected: Selection | null;
  onSelect: (sel: Selection) => void;
  onEdit: (sel: Selection, text: string) => void;
};

export function SheetGrid({ height, width, baseHeight, pages, edits, requestPage, selected, onSelect, onEdit }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ sel: Selection; text: string } | null>(null);
  // Unmounting the input may fire blur; after Enter/Tab/Escape that blur must not commit again
  const closed = useRef(false);
  const startEdit = (sel: Selection, text: string) => {
    closed.current = false;
    setEditing({ sel, text });
  };
  const cols = Math.min(width, MAX_COLS);
  const virtualizer = useVirtualizer({
    count: height,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 30,
  });
  const items = virtualizer.getVirtualItems();

  // Ask for every visible page of the file's rows; the parent dedupes requests
  const first = items[0]?.index ?? 0;
  const last = Math.min(items.at(-1)?.index ?? 0, baseHeight - 1);
  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) requestPage(p);
  }, [first, last, requestPage]);

  // Keep the selected cell on screen when moving with the keyboard
  useEffect(() => {
    const el = scrollRef.current;
    if (!selected || !el) return;
    virtualizer.scrollToIndex(selected.row, { align: "auto" });
    const x = selected.col * COL_WIDTH;
    if (x < el.scrollLeft) el.scrollLeft = x;
    else if (NUM_WIDTH + x + COL_WIDTH > el.scrollLeft + el.clientWidth) el.scrollLeft = NUM_WIDTH + x + COL_WIDTH - el.clientWidth;
  }, [selected?.row, selected?.col]);

  const move = (sel: Selection, dr: number, dc: number) =>
    onSelect({ row: Math.max(0, Math.min(height - 1, sel.row + dr)), col: Math.max(0, Math.min(cols - 1, sel.col + dc)) });

  function commit(dr: number, dc: number) {
    if (!editing || closed.current) return;
    closed.current = true;
    onEdit(editing.sel, editing.text);
    setEditing(null);
    move(editing.sel, dr, dc);
    scrollRef.current?.focus();
  }

  function onGridKey(e: KeyboardEvent) {
    if (!selected || editing || e.target !== scrollRef.current) return;
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    if (arrows[e.key]) {
      e.preventDefault();
      move(selected, ...arrows[e.key]);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(selected, inputText(cellAt(pages, edits, baseHeight, selected.row, selected.col)));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onEdit(selected, "");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(selected, e.key);
    }
  }

  const totalWidth = NUM_WIDTH + cols * COL_WIDTH;
  const colStyle = { width: COL_WIDTH };
  const numStyle = { width: NUM_WIDTH };

  return (
    <div ref={scrollRef} className="biggrid" role="grid" aria-rowcount={height} aria-colcount={cols} tabIndex={0} onKeyDown={onGridKey}>
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
          const r = item.index;
          return (
            <div key={item.key} role="row" aria-rowindex={r + 1} className="vrow" style={{ top: item.start, width: totalWidth }}>
              <div style={numStyle} className={`vnum ${selected?.row === r ? "sel" : ""}`} role="rowheader">
                {r + 1}
              </div>
              {Array.from({ length: cols }, (_, c) => {
                const v = cellAt(pages, edits, baseHeight, r, c);
                if (v === undefined) return <div key={c} style={colStyle} className="skel" />;
                const isSel = selected?.row === r && selected.col === c;
                if (isSel && editing) {
                  return (
                    <div key={c} style={colStyle} className="sel editing">
                      <input
                        autoFocus
                        aria-label={`Edit ${columnName(c)}${r + 1}`}
                        value={editing.text}
                        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                        onBlur={() => commit(0, 0)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit(1, 0);
                          else if (e.key === "Tab") {
                            e.preventDefault();
                            commit(0, e.shiftKey ? -1 : 1);
                          } else if (e.key === "Escape") {
                            closed.current = true;
                            setEditing(null);
                            scrollRef.current?.focus();
                          }
                        }}
                      />
                    </div>
                  );
                }
                const f = edits.get(key(r, c))?.f;
                const style = f ? { ...colStyle, fontWeight: f.bold ? 700 : undefined, background: f.fill } : colStyle;
                return (
                  <div
                    key={c}
                    role="gridcell"
                    aria-selected={isSel}
                    title={isFormula(v) ? `formula: =${v.formula}` : rawCell(v)}
                    style={style}
                    className={`${isFormula(v) ? "fx" : KIND_CLASS[cellKind(v)]} ${isSel ? "sel" : ""}`}
                    onClick={() => onSelect({ row: r, col: c })}
                    onDoubleClick={() => {
                      onSelect({ row: r, col: c });
                      startEdit({ row: r, col: c }, inputText(v));
                    }}
                  >
                    {isFormula(v) ? `=${v.formula}` : formatCell(v)}
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
