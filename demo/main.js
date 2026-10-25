import init, { Workbook } from "@milojs/excel-kit";

const ROW_LIMIT = 500;
const $ = (id) => document.getElementById(id);
let wb = null;
let bytes = null;

await init();

const fmt = (cell) =>
  cell === null ? "" : cell instanceof Date ? cell.toISOString() : typeof cell === "object" ? cell.error : String(cell);

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(name) {
  for (const b of $("tabs").children) b.setAttribute("aria-pressed", b.textContent === name);
  const t0 = performance.now();
  const rows = [];
  for (const row of wb.iterRows(name)) {
    rows.push(row);
    if (rows.length === ROW_LIMIT) break; // breaking frees the iterator
  }
  const ms = (performance.now() - t0).toFixed(1);
  $("grid").replaceChildren(
    ...rows.map((row, i) => {
      const tr = el("tr");
      tr.append(el("th", i + 1), ...row.map((cell) => el("td", fmt(cell))));
      return tr;
    }),
  );
  $("status").textContent = `${name}: first ${rows.length} rows in ${ms} ms (iterRows)`;
}

$("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  bytes = new Uint8Array(await file.arrayBuffer());
  wb?.free();
  wb = null;
  $("grid").replaceChildren();
  $("tabs").replaceChildren();
  try {
    wb = Workbook.open(bytes);
  } catch (err) {
    $("status").textContent = `${err.code}: ${err.message}`;
    $("bench").disabled = true;
    return;
  }
  const sheets = wb.sheets().filter((s) => s.visibility === "Visible");
  $("tabs").replaceChildren(
    ...sheets.map((s) => {
      const b = el("button", s.name);
      b.addEventListener("click", () => show(s.name));
      return b;
    }),
  );
  $("bench").disabled = false;
  if (sheets.length) show(sheets[0].name);
});

$("bench").addEventListener("click", () => {
  $("bench").disabled = true;
  $("status").textContent = "Benchmarking in a worker (3 runs each)…";
  const table = $("results");
  table.hidden = false;
  const head = el("tr");
  head.append(el("th", "Library"), el("th", "Median time"), el("th", "Rows"));
  table.replaceChildren(head);

  const worker = new Worker(new URL("./bench.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "result") {
      const tr = el("tr");
      tr.append(el("td", data.name), el("td", data.ms == null ? `failed: ${data.error}` : `${data.ms.toFixed(0)} ms`), el("td", data.rows ?? ""));
      table.append(tr);
    } else if (data.type === "done") {
      $("status").textContent = "Benchmark done. Time = parse + read every row of the first sheet.";
      $("bench").disabled = false;
      worker.terminate();
    }
  };
  worker.postMessage(bytes.slice()); // copy: worker owns its buffer
});
