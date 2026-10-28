# Troubleshooting

## The wasm file fails to load

You see one of these, usually only after deploying (it worked locally), or only in dev:

```
WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f @+0
CompileError: wasm validation error: at offset 4: failed to match magic number
WebAssembly.Module doesn't parse at byte 0: module doesn't start with '\0asm'
@kuramajs/excel: the .wasm file didn't load. The server most likely returned an HTML page ...
```

`00 61 73 6d` is `\0asm`, how every wasm file starts. `3c 21 44 4f` is `<!DO`, the start of `<!DOCTYPE html>`. **The browser asked for `web_index_bg.wasm` and got an HTML page back**, almost always your app's `index.html`.

`init()` loads the binary with `new URL("web_index_bg.wasm", import.meta.url)`. Bundlers copy it into your build, e.g. `assets/web_index_bg-<hash>.wasm`. If that request misses the real file, a single-page-app fallback answers with `index.html` and status 200, so it doesn't look like an error.

**Check it:** in DevTools → Network, find the `.wasm` request. The real file is about 730 KB with `Content-Type: application/wasm`. An HTML page is a few KB of `text/html`.

There are three common causes. More than one can apply at once, so check each.

## 1. Vite dev server: dependency pre-bundling

**Only in `vite dev`, builds are fine.** Vite pre-bundles dependencies into `node_modules/.vite/deps`. `import.meta.url` then points there, the `.wasm` file isn't next to it, and Vite's fallback serves `index.html`.

Exclude the package from pre-bundling:

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ["@kuramajs/excel"] },
};
```

Restart the dev server after changing this. If you use the package in a Web Worker, this applies there too.

## 2. Host rewrite rule sends `.wasm` to `index.html`

**Only when deployed.** Single-page apps rewrite unknown paths to `/index.html` so client-side routes work. If the rule decides which paths are "real files" by extension and `wasm` isn't in the list, the wasm request gets the HTML page. The same happens if the file never made it into the deployed output and the fallback catches the 404.

Make sure `.wasm` files are served as files, with `Content-Type: application/wasm`:

- **AWS Amplify:** the usual rewrite rule allowlists extensions. Add `wasm`:
  ```
  Source:  </^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp|wasm)$)([^.]+$)/>
  Target:  /index.html
  Type:    200 (Rewrite)
  ```
  Any other static file type you serve (`.mjs`, `.avif`, `.pdf`, ...) needs to be in that list too.
- **nginx:** `try_files $uri $uri/ /index.html;` serves real files first, so the problem is a missing file. Make missing assets a 404 instead of HTML, and make sure the MIME type is set:
  ```nginx
  location /assets/ { try_files $uri =404; }
  types { application/wasm wasm; }   # if your mime.types is older and lacks it
  ```
- **S3 + CloudFront:** "custom error responses" that map 403/404 to `/index.html` hide missing files. Check that the `.wasm` object was uploaded and has `Content-Type: application/wasm` (`aws s3 cp ... --content-type application/wasm`).
- **Netlify / Vercel:** a catch-all rewrite (`/* /index.html 200`, or `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`) only applies when no file matches, so this is normally fine. If you still get HTML, the file is missing from the deploy output, or a Netlify rule is forced (`200!`).

## 3. The CDN still has the old HTML response cached

**You fixed the rule, `curl` returns the wasm, but the browser still gets HTML.** CDNs cache hashed assets for a long time (often a year) and keep a separate copy for each `Accept-Encoding`. Browsers ask for Brotli (`br`), so the `br` copy can still be the HTML page cached before your fix, while a plain `curl` gets a fresh uncompressed copy.

Test every encoding:

```sh
U=https://your-site.example/assets/web_index_bg-<hash>.wasm
for E in br gzip zstd identity; do
  curl -s "$U" -H "Accept-Encoding: $E" -o /dev/null -D - \
    | grep -iE '^content-type|^age|^content-encoding' | tr '\r\n' '  '; echo " <- $E"
done
```

Any `text/html` line means a stale cache. Waiting won't fix it; clear the cache:

- **AWS Amplify:** start a new deployment (it clears Amplify's CDN cache).
- **CloudFront:** `aws cloudfront create-invalidation --distribution-id <id> --paths "/assets/*"`.
- **Others:** purge the CDN cache for that path, or change the file name (a new build hash does it).

## Load the wasm from an explicit URL

If your bundler or host keeps getting in the way, skip `import.meta.url` and tell `init()` where the file is. With Vite, import the file's URL:

```js
import init, { Workbook } from "@kuramajs/excel";
import wasmUrl from "@kuramajs/excel/wasm?url";

await init({ module_or_path: wasmUrl });
```

Or copy `node_modules/@kuramajs/excel/pkg/web/web_index_bg.wasm` to your static files yourself and pass its path: `init({ module_or_path: "/kurama-excel.wasm" })`. `module_or_path` also accepts a `URL`, a `Response`, bytes, or a compiled `WebAssembly.Module`.

You still need causes 2 and 3 fixed: the file has to be served as wasm, not HTML.

## Checklist

1. Error mentions `3c 21 44 4f` or "returned an HTML page"? Something served HTML for the `.wasm` request.
2. Only in `vite dev`? Add the package to `optimizeDeps.exclude`.
3. Only when deployed? Check the host's rewrite rule lets `.wasm` through, and that the file is in the deploy output.
4. Fixed but the browser still fails? Test with `Accept-Encoding: br` and clear the CDN cache.
