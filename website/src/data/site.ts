import pkg from "../../../package.json";

export const VERSION = pkg.version;
export const GITHUB = "https://github.com/itssajan/excel_wasm_kit";
export const NPM = "https://www.npmjs.com/package/@milojs/excel-kit";

/** Prefix a site path with the GitHub Pages base path. */
export const url = (path: string) => import.meta.env.BASE_URL.replace(/\/$/, "") + path;
