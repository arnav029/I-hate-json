# JSON Tool — Plan v1.1 (Conversion + Module Sidebar)

This builds on `plan.md` (v1: formatter only). It does not replace v1 — the formatter stays the default, first-loaded view. This adds a **JSON → CSV conversion module** plus a **sidebar to navigate between modules**, laying the groundwork for future modules (TypeScript conversion, minify, diff, etc.) without disrupting the core paste-and-format flow.

## 1. Goal of this phase
- Add JSON → CSV conversion as a second module.
- Introduce a lightweight sidebar/module nav so the tool can grow into a small suite over time — **without** demoting the formatter from being the first thing a visitor sees and uses.

## 2. UI Structure Change

**Layout:**
- Add a **slim sidebar** on the left (collapsible on mobile, maybe icon-only by default with labels on hover/expand — keep it unobtrusive).
- Sidebar lists modules: **Formatter** (default/active on load), **CSV Export**, and greyed-out/"coming soon" placeholders for future modules (TypeScript, Minify, Diff) so the roadmap is visible but not clickable yet.
- The **Formatter module loads by default** on `/` — nothing changes about the paste-first, auto-focused, Ctrl+Enter, Copy-prominent flow from `plan.md`. The sidebar must not visually compete with the paste textarea for attention on first load.
- Clicking "CSV Export" in the sidebar switches the main panel to the conversion module. This can be a simple client-side view swap (no page reload needed) since everything is already client-side JS.

**Why a sidebar and not tabs across the top:**
- Keeps the horizontal space for the two-panel (input/output) layout intact — tabs across the top would visually compress the input/output panels.
- Scales better as more modules get added later (a top tab bar gets cramped past 4–5 items; a sidebar doesn't).

## 3. CSV Export Module

**Scope (v1.1 — the "low effort" version discussed):**
- Works on the common case: a JSON array of flat(ish) objects with reasonably consistent keys.
- Steps:
  1. Parse JSON (reuse the same Web Worker parsing logic from the formatter).
  2. Validate shape: must be an array of objects. If not (e.g., a single object, or an array of primitives), show a clear message explaining CSV export needs an array of objects, rather than silently failing.
  3. Collect the **union of all keys** across every object (handles objects with missing/extra fields gracefully — missing values become empty cells).
  4. Flatten nested objects using dot-notation column names (e.g., `address.city`, `address.zip`).
  5. Arrays as values: stringify as JSON within the cell (e.g., `"[1,2,3]"`) rather than trying to explode into extra rows — keeps this in "low effort" territory.
  6. Escape/quote values containing commas, quotes, or newlines per standard CSV rules.
  7. Output a downloadable `.csv` file (and optionally show a quick preview table of the first ~20 rows in the UI before download, so users can sanity-check before exporting).

**Where it runs:** Same Web Worker as formatting — no new infra, just a second message type the worker can handle (`format` vs `convert-csv`).

**UI for this module:**
- Reuses the existing paste/upload input pattern from the formatter (paste-first, upload secondary) — consistency matters more than novelty here.
- Output side: preview table + "Download .csv" button (prominent, matching the Copy button's visual weight from the formatter).
- Clear inline error if the JSON isn't array-of-objects shaped.

## 4. What's explicitly NOT in this phase
- JSON → TypeScript interface generation (flagged separately as a bigger, more involved feature — union types, optional fields, nested interface naming — deferred to its own future plan once CSV is shipped and usage is validated)
- Array-of-arrays-becomes-multiple-rows explosion logic for nested arrays
- CSV → JSON (reverse direction) — not requested, would be a separate module
- Any account/save-your-conversions functionality — stays fully stateless and client-side, consistent with the rest of the tool

## 5. Build Steps
1. Refactor layout: introduce sidebar shell, formatter view becomes the first of two "views" rendered in the same main panel area.
2. Add CSV conversion logic to the Web Worker (new message type).
3. Build CSV module UI (input reuse + preview table + download button).
4. Wire sidebar navigation (client-side view switch, formatter active by default, CSV Export second item, remaining modules shown as disabled/"coming soon").
5. Test with varied JSON shapes: flat arrays, nested objects, missing keys across objects, arrays-of-arrays, non-array input (error path), and large arrays (confirm Web Worker keeps things smooth at scale, same as formatting).
6. Confirm mobile behavior: sidebar collapses sensibly, doesn't push the formatter's paste box below the fold.

## 6. Later (post-v1.1)
- JSON → TypeScript module (bigger effort, separate plan)
- Minify toggle module
- Diff mode module
- Sidebar becomes a real nav once 4+ modules exist — revisit whether icon-only default still makes sense at that point