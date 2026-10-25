import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  // excel-kit is linked from the repo root (file:..); let Vite serve its wasm
  server: { fs: { allow: [".."] } },
  optimizeDeps: { exclude: ["@milojs/excel-kit"] },
  worker: { format: "es" },
});
