# JSON Formatter — Project Plan

## 1. Goal
A single-purpose, no-login, no-signup website: paste or upload JSON → get it instantly pretty-printed. Smooth, fast UI, works with files up to 50MB without freezing the browser tab.

This is v1 of a broader idea (eventually more JSON operations later — validate, minify, tree view, diff, etc.) but scope is deliberately locked to **formatting only** for now.

## 2. Core User Flow
1. User lands on the page — no auth, no popups, no "sign up to continue."
2. User either:
   - Pastes JSON directly into a text area, or
   - Drags & drops / selects a `.json` file (up to 50MB)
3. App formats (pretty-prints) the JSON with proper indentation.
4. Formatted output appears in a read-only/output panel.
5. User can copy the output (one-click copy button) or download it as a `.json` file.

No data ever leaves the browser — everything runs client-side. This matches the trust pitch used by similar tools (ihatepdf.cv, etc.): "your file never leaves your device."

## 3. Why 50MB Needs Special Handling
`JSON.parse` + `JSON.stringify(obj, null, 2)` on a 50MB string can lock up the main thread for several seconds, which feels broken (page appears frozen, unresponsive scroll/typing).

**Approach:**
- Run parsing + formatting inside a **Web Worker**, not the main thread.
- Main thread stays responsive; show a lightweight progress/spinner state while the worker processes.
- For file uploads, read the file via `FileReader` (or `File.text()`) off the main thread where possible, then hand the string to the worker.
- Textarea paste events for very large text can also be laggy in some browsers — debounce the "Format" trigger (explicit button click) rather than auto-formatting on every keystroke, so typing/pasting itself stays smooth.
- Enforce a soft 50MB cap client-side with a clear error message if exceeded (rather than silently hanging).

## 4. Tech Stack
**Plain HTML + CSS + vanilla JS (+ a Web Worker), no framework, no build step.**

Reasoning:
- This is a single-page utility with one core interaction — a framework (React/Next.js) adds build tooling, bundle size, and hosting complexity for zero real benefit here.
- Vanilla JS keeps the page load instant, which matters a lot for a "paste and go" tool — first impression = speed.
- A Web Worker is plain JS regardless of framework choice, so this doesn't cost us anything.
- Easiest to deploy anywhere static (Vercel/Netlify/GitHub Pages/Cloudflare Pages) — no server needed at all, keeps it free to run at scale.

## 5. Page Structure / UI
- **Header:** Simple logo/name + one-line tagline ("Paste JSON. Get it formatted. Nothing leaves your browser.")
- **Two-panel layout** (side-by-side on desktop, stacked on mobile):
  - Left: Input panel — textarea + "Upload file" / drag-and-drop zone + "Format" button + file size indicator
  - Right: Output panel — formatted result, syntax-highlighted, with "Copy" and "Download .json" buttons
- **Error state:** If JSON is invalid, show a friendly inline error (still useful even though v1 doesn't do full validation UX — at minimum, a parse failure needs a clear, non-scary message, since `JSON.parse` will throw on malformed input either way)
- **Empty state:** Placeholder text/example JSON snippet so the UI doesn't feel blank on first load
- **No ads, no tracking-heavy analytics, no account/login UI anywhere**

## 6. Formatting Logic (v1)
- Parse: `JSON.parse(input)`
- Format: `JSON.stringify(parsedObject, null, 2)` (2-space indent; consider a toggle for 2 vs 4 spaces / tabs later, not in v1)
- Since parsing is required to format, invalid JSON will naturally throw — surface that error message cleanly rather than trying to "format" broken JSON. (This is not full validation UX, just unavoidable fallout of using `JSON.parse`.)

## 7. Out of Scope for v1 (explicitly deferred)
- Minify
- Collapsible tree/node view
- Key search/filter
- Schema validation / detailed error location highlighting
- Diff between two JSON blobs
- Dark/light theme toggle (nice-to-have, can add fast later if time allows)

## 8. Build Steps
1. Static HTML skeleton — two-panel layout, header, buttons
2. CSS — clean, modern, smooth (matches the "very good UI" ask); mobile-responsive stacked layout
3. Web Worker script (`format-worker.js`) — receives raw string, runs parse + stringify, posts back result or error
4. Main script (`app.js`):
   - Wire up textarea input
   - Wire up file upload / drag-and-drop → read file → pass to worker
   - Wire up "Format" button → send current input to worker
   - Handle worker response → render output or error
   - Copy-to-clipboard button
   - Download-as-file button
   - 50MB size guard with clear messaging
5. Basic syntax highlighting for the output panel (lightweight, e.g. a small regex-based highlighter — avoid a heavy library given the "keep it fast" goal)
6. Test with a range of file sizes (small snippet → ~50MB) to confirm the worker approach keeps the UI responsive
7. Deploy as a static site (Vercel/Netlify/Cloudflare Pages — free tier, no backend needed)

## 9. Later (post-v1, not now)
- Validation with precise error line/column highlighting
- Minify mode
- Collapsible tree view
- JSON → CSV / YAML conversion
- Shareable link (would require *some* backend or a URL-encoded state — breaks the "nothing leaves your browser" pitch, so needs a deliberate decision if pursued)