# I Hate JSON

Paste JSON, get it pretty-printed. No account, no upload, no waiting.

**Nothing leaves your browser** — parsing and formatting happen client-side in a Web Worker.
The server in this repo only hands over static files.

## Modules

Each tool is its own URL so it can be found, linked and indexed on its own terms.
A slim rail on the left links between them, and what you pasted is carried across
through `sessionStorage` (capped at 100KB; files are never persisted).

| URL | Module |
| --- | --- |
| `/` | Formatter |
| `/json-to-csv` | CSV |
| `/json-minifier` | Minify |
| `/json-diff` | Diff |

| Module | Does |
| --- | --- |
| Formatter | Pretty-prints with a 2-space indent, syntax highlighted |
| CSV | Converts an array of objects to CSV — union of all keys, nested keys as dotted columns |
| Minify | Strips every optional byte, reporting how much smaller the result is |
| Diff | Compares two documents structurally and lists what changed |
| TypeScript | Listed as coming soon, not clickable |

Adding a module means one `MODULES` entry in `app.js` and one mode in the worker.

### Diff specifics

- Compares **values, not text**: reordered keys and different indentation are not changes
- Two input panes (A and B), each taking paste, upload or a drop onto that pane
- Reports `added` / `removed` / `changed` against a path such as `a.b[0].c`; a parse failure
  says which side it came from and highlights the token in that pane
- Arrays are compared **by index** — inserting an element at the front reports every later
  index as changed rather than as a single insertion
- Stops at 20,000 differences so a wildly mismatched pair cannot exhaust memory
- Copy and Download give the change list as JSON

### CSV specifics

- Input must be a JSON **array of objects**; anything else gets an explanatory error
- Columns are the union of every object's keys, in first-seen order; missing values are empty cells
- Nested objects flatten to `address.city`; arrays and empty objects stay as JSON in one cell
- Quoting follows RFC 4180 (commas, quotes and newlines), rows end `\r\n`, and the download
  carries a UTF-8 BOM so Excel does not mangle accented text
- The table previews the first 20 rows and 40 columns; Copy and Download always give everything

## What the formatter does

- Paste JSON, or drag & drop / pick a `.json` file (up to 50MB)
- Pretty-prints with a 2-space indent, syntax highlighted
- Copy to clipboard, or download as `.json`
- Clear inline errors with line, column and a caret under the offending token
- On a parse failure the input scrolls to the broken token and selects it; **Show me in
  the input** re-selects it. Where the engine gives no usable position the line is
  selected instead and the message says "near line N"
- Long values soft-wrap in both panels (toggleable, remembered per browser)

Still out of scope: tree view, key search, schema validation, JSON to TypeScript.

## Why it does not freeze on big files

`JSON.parse` + `JSON.stringify` on 50MB blocks the main thread for seconds. So:

- All parsing, formatting and highlighting runs in `format-worker.js`, off the main thread.
- Uploaded files are read *inside* the worker (`File.text()`), so the huge string never
  touches the UI thread.
- Files over 1MB stay out of the textarea — the editor would lag — and show as a file chip instead.
- Formatting is triggered explicitly (button or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>), never on keystroke.
- Only the first ~400KB of output is rendered to the DOM; the full document is kept in memory
  for copy/download and the preview says so.

Measured in Chrome on a 44.8MB file: 2.7s end to end, UI responsive throughout.

## Layout

```
public/           everything the browser gets
  index.html
  styles.css
  app.js          UI wiring + module registry
  format-worker.js  worker shell, dispatches by mode
  formatter.js    pure parse/format/highlight core (no DOM — testable in Node)
  csv.js          pure JSON -> CSV core (no DOM)
  diff.js         pure structural diff core (no DOM)
  sw.js           service worker; its precache list is filled in at serve time
  manifest.webmanifest
  og/             1200×630 social cards, one per route
  icons/          app icons the manifest points at
routes.js         per-route metadata and page copy (server-side only)
server.js         zero-dependency static server + per-route rendering
build.js          renders the same output to dist/ for a static host
tools/images.html regenerates public/og/ and public/icons/ — open it, click
test/             Node tests for every core, incl. multi-MB fixtures
```

## Run locally

```sh
npm start          # http://localhost:3000
npm test           # every core, ~15s (builds multi-MB fixtures)
npm run build      # render the whole site to dist/ as plain files
```

No build step and no dependencies. `public/` is plain static files, but the per-route
titles, canonical tags and page copy are applied by `server.js`, so serve it through that.

## The privacy claim is enforced, not just stated

"Nothing leaves your browser" is a promise you would otherwise have to take on trust.
The server sends a Content Security Policy with **`connect-src 'none'`**, so no script on
this origin can open a fetch, XHR, WebSocket or beacon to anywhere — including back to
this server. Even a compromised deploy could not exfiltrate what you pasted.

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; worker-src 'self'; manifest-src 'self'; connect-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

No `unsafe-inline` and no nonce: there are no inline scripts, and asset versions reach
`app.js` on a `data-` attribute rather than through a generated `<script>` block.
Verified in Chrome — the Web Worker and its `importScripts` run fine under this policy,
while `fetch()` to any host, same-origin included, is blocked.

Also sent: `Strict-Transport-Security` (over TLS only), `Permissions-Policy` denying
camera/mic/geolocation/USB/payment, `Cross-Origin-Opener-Policy`, `X-Content-Type-Options`
and `Referrer-Policy: no-referrer`.

## It works offline

After the first visit the whole site lives on the device. A service worker precaches
every route and every asset — ten entries, 25KB gzipped — and **every tool keeps
working with no connection at all**. Verified by killing the server and running a
diff: page, styles, worker and `diff.js` all came from cache.

Online, a repeat visit costs exactly one request: the page itself, about 4KB over the
wire. Pages are network-first so a deploy lands on the next navigation, with the
cached copy standing in only when there is genuinely nothing. Every asset — the CSS,
`app.js`, the worker and its cores — is served from cache with no request at all,
because each URL carries a content hash and can only ever mean one thing. A deploy
changes those hashes, which changes the cache name, and the previous cache is dropped
whole.

One measurement gotcha: `PerformanceResourceTiming.encodedBodySize` reports the
*decoded* size for anything a service worker served, so DevTools makes cached
navigations look uncompressed. They are not — the cached response carries
`Content-Encoding: br` and a 4218-byte `Content-Length`.

`public/manifest.webmanifest` plus `theme-color` make it installable — a real icon in a
dock or on a home screen.

**Rollback.** Set `SW_DISABLED=1` and redeploy. Every installed worker then unregisters
itself and clears its caches on the next load, and everyone is back on plain network
fetches. `/sw.js` is served `no-cache` for exactly this reason: it is the one file that
must always be revalidated, or the switch could never reach the people who need it.

The worker gets `connect-src 'self'` rather than `'none'` — it has to be able to fetch
what it caches. That is the one relaxation in the whole policy, it is same-origin only,
and every other script on the site still cannot open a connection to anywhere.

## Caching

Assets are referenced with a content hash — `app.js?v=e16aab0f` — and a URL whose hash
still matches the file is served `max-age=31536000, immutable`. A stale or missing hash
revalidates instead. Hashes are recomputed when a file's mtime moves, so edit-and-reload
works with no build step.

The hashes for the worker and its three cores travel on `<body data-assets>`, and the
core hashes go to the worker on each job message — which keeps the worker itself at one
cacheable URL the service worker can precache, and lets it import only what a mode needs
(`csv.js` and `diff.js` are dead weight on the formatter and minifier pages).

Text is served brotli where the browser accepts it — 13–19% smaller than gzip across
this bundle — and each payload is compressed once and kept, since none of them change
between requests. Images stream through untouched.

## SEO

`server.js` substitutes per-route values from `routes.js` into `public/index.html`:
title, meta description, `<h1>`, canonical, Open Graph and Twitter tags, a
`summary_large_image` card from `public/og/`, `SoftwareApplication` + `FAQPage` JSON-LD,
and 300+ words of page copy with an FAQ. `/robots.txt` and `/sitemap.xml` are generated
from the same table, so adding a route updates everything at once.

Each route carries an `updated` date that becomes its `<lastmod>`. **Bump it by hand when
you change that page's copy** — a sitemap that stamps every URL with today's date on every
request teaches crawlers to ignore the field.

Anything that does not resolve renders a real 404 page — `noindex`, no canonical, no
structured data, and links to every tool — rather than a plain-text stub.

Duplicate URLs (`/json-formatter`, `/index.html`, trailing slashes) 301 to the canonical
path. `SITE_ORIGIN` sets the origin used in canonical tags and the sitemap
(default `https://www.ihatejson.com`). Set `CANONICAL_HOST` to also 301 every other host
to one — off by default so localhost and preview deploys work.

## Deploy as static files

`npm run build` renders every route, the 404, `robots.txt`, `sitemap.xml` and the
service worker into `dist/`, alongside `_headers` and `_redirects` so Cloudflare Pages
and Netlify apply the same CSP, caching and 301s the server does. A test asserts the
built pages are byte-identical to what `server.js` serves.

This is the route to a global edge instead of one region — worth doing, since a
single-origin TTFB is 250–350ms from the US or Europe. `npm start` is unaffected.

## Deploy on Railway

1. Create a project from this GitHub repo.
2. Railway autodetects Node via `package.json` and runs `npm start` (also pinned in `railway.json`).
3. It injects `PORT`; the server binds `0.0.0.0:$PORT`.
4. Generate a domain under **Settings → Networking**.

No environment variables, no database, no build command required.
