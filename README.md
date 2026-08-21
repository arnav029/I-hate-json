# I Hate JSON

Paste JSON, get it pretty-printed. No account, no upload, no waiting.

**Nothing leaves your browser** — parsing and formatting happen client-side in a Web Worker.
The server in this repo only hands over static files.

## Modules

A slim rail on the left switches modules; the input panel is shared, so what you
pasted survives the switch. **Formatter** is what loads on `/`.

| Module | Does |
| --- | --- |
| Formatter | Pretty-prints with a 2-space indent, syntax highlighted |
| CSV | Converts an array of objects to CSV — union of all keys, nested keys as dotted columns |
| Minify | Strips every optional byte, reporting how much smaller the result is |
| TypeScript, Diff | Listed as coming soon, not clickable |

Adding a module means one `MODULES` entry in `app.js` and one mode in the worker.

### CSV specifics

- Input must be a JSON **array of objects**; anything else gets an explanatory error
- Columns are the union of every object's keys, in first-seen order; missing values are empty cells
- Nested objects flatten to `address.city`; arrays and empty objects stay as JSON in one cell
- Quoting follows RFC 4180 (commas, quotes and newlines), rows end `\r\n`, and the download
  carries a UTF-8 BOM so Excel does not mangle accented text
- The table previews the first 20 rows and 40 columns; Copy and Download always give everything

## What it does (v1)

- Paste JSON, or drag & drop / pick a `.json` file (up to 50MB)
- Pretty-prints with a 2-space indent, syntax highlighted
- Copy to clipboard, or download as `.json`
- Clear inline errors with line, column and a caret under the offending token
- On a parse failure the input scrolls to the broken token and selects it; **Show me in
  the input** re-selects it. Where the engine gives no usable position the line is
  selected instead and the message says "near line N"
- Long values soft-wrap in both panels (toggleable, remembered per browser)

Deliberately out of scope for v1: minify, tree view, search, diff, schema validation.

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
server.js         zero-dependency static file server (Railway needs a listener on $PORT)
test/             Node tests for both cores, incl. multi-MB fixtures
```

## Run locally

```sh
npm start          # http://localhost:3000
npm test           # both cores, ~10s (builds a 52MB fixture)
```

No build step and no dependencies — `public/` can also be opened through any static server.

## Deploy on Railway

1. Create a project from this GitHub repo.
2. Railway autodetects Node via `package.json` and runs `npm start` (also pinned in `railway.json`).
3. It injects `PORT`; the server binds `0.0.0.0:$PORT`.
4. Generate a domain under **Settings → Networking**.

No environment variables, no database, no build command required.
