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
routes.js         per-route metadata and page copy (server-side only)
server.js         zero-dependency static server + per-route rendering
test/             Node tests for every core, incl. multi-MB fixtures
```

## Run locally

```sh
npm start          # http://localhost:3000
npm test           # every core, ~15s (builds multi-MB fixtures)
```

No build step and no dependencies. `public/` is plain static files, but the per-route
titles, canonical tags and page copy are applied by `server.js`, so serve it through that.

## SEO

`server.js` substitutes per-route values from `routes.js` into `public/index.html`:
title, meta description, `<h1>`, canonical, Open Graph and Twitter tags,
`SoftwareApplication` + `FAQPage` JSON-LD, and 300+ words of page copy with an FAQ.
`/robots.txt` and `/sitemap.xml` are generated from the same table, so adding a route
updates everything at once.

Duplicate URLs (`/json-formatter`, `/index.html`, trailing slashes) 301 to the canonical
path. `SITE_ORIGIN` sets the origin used in canonical tags and the sitemap
(default `https://www.ihatejson.com`). Set `CANONICAL_HOST` to also 301 every other host
to one — off by default so localhost and preview deploys work.

## Deploy on Railway

1. Create a project from this GitHub repo.
2. Railway autodetects Node via `package.json` and runs `npm start` (also pinned in `railway.json`).
3. It injects `PORT`; the server binds `0.0.0.0:$PORT`.
4. Generate a domain under **Settings → Networking**.

No environment variables, no database, no build command required.
