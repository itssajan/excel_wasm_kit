import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  site: "https://itssajan.github.io",
  base: "/excel_wasm_kit",
  integrations: [react()],
  markdown: { shikiConfig: { theme: "github-dark-dimmed" } },
  vite: {
    // excel-kit is linked from the repo root (file:..); let Vite serve its wasm
    server: { fs: { allow: [".."] } },
    optimizeDeps: {
      exclude: ["@milojs/excel-kit"],
      // islands load these lazily; pre-bundle them so a mid-session re-optimize can't create a second React
      include: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-virtual", "xlsx", "exceljs"],
    },
    worker: { format: "es" },
  },
});
