import { defineConfig } from "vite";

export default defineConfig({
  // excel-kit is linked from the repo root (file:..); let Vite serve its wasm
  server: { fs: { allow: [".."] } },
  optimizeDeps: { exclude: ["@milojs/excel-kit"] },
  worker: { format: "es" },
});
