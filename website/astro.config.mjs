import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://kuramajs.github.io",
  base: "/excel",
  integrations: [react(), sitemap({ filter: (page) => !page.endsWith("/404/") })],
  markdown: {
    shikiConfig: { theme: "github-dark-dimmed" },
    // the README starts with its own "# @kuramajs/excel"; the docs page supplies its own h1
    rehypePlugins: [() => (tree) => void (tree.children = tree.children.filter((n) => !(n.type === "element" && n.tagName === "h1")))],
  },
  vite: {
    // @kuramajs/excel is linked from the repo root (file:..); let Vite serve its wasm
    server: { fs: { allow: [".."] } },
    optimizeDeps: {
      exclude: ["@kuramajs/excel"],
      // islands load these lazily; pre-bundle them so a mid-session re-optimize can't create a second React
      include: ["react", "react-dom", "react/jsx-runtime", "@tanstack/react-virtual", "xlsx", "exceljs"],
    },
    worker: { format: "es" },
  },
});
