// Prepend `/// <reference lib>` directives to the generated typings, so consumers don't need
// matching `lib` settings in their tsconfig.
const fs = require("fs");

const refs = {
  // esnext.disposable: Symbol.dispose on Workbook and Sheet
  "pkg/web/web_index.d.ts": ["esnext.disposable", "dom"], // dom: init() takes fetch/WebAssembly types
  "pkg/nodejs/nodejs_index.d.ts": ["esnext.disposable"],
};

for (const [file, libs] of Object.entries(refs)) {
  const header = libs.map((lib) => `/// <reference lib="${lib}" />\n`).join("");
  fs.writeFileSync(file, header + fs.readFileSync(file, "utf8"));
}
