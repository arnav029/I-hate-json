/*
 * Per-route metadata and page copy. Server-side only — server.js substitutes
 * these into public/index.html so each module is a real, crawlable URL with its
 * own title, description, heading and content.
 */
'use strict';

var PRIVACY = 'Everything runs in your browser. Your JSON is parsed by a Web Worker on your own ' +
  'machine and never sent anywhere — there is no upload, no account, and no server-side ' +
  'processing. You can check: open the network tab and format a file, and you will see no requests.';

var routes = [
  {
    path: '/',
    module: 'formatter',
    updated: '2026-08-25',
    title: 'JSON Formatter — format and beautify JSON online, up to 50MB',
    description: 'Paste JSON or drop a file and get it pretty-printed instantly, with syntax ' +
      'highlighting and errors pinpointed to the exact token. Handles 50MB files without freezing. ' +
      'Nothing leaves your browser.',
    heading: 'JSON formatter — paste, format, done',
    keywords: 'json formatter, json beautifier, pretty print json, format json online',
    content: [
      '<h2>Format JSON without uploading it anywhere</h2>',
      '<p>Paste JSON into the left panel, press <strong>Format</strong> or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>, ',
      'and the formatted result appears on the right with two-space indentation and syntax highlighting. ',
      'Copy it with one click or download it as a <code>.json</code> file.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>Built for files that break other formatters</h2>',
      '<p>Parsing and formatting a 50MB document with <code>JSON.parse</code> on the main thread locks ',
      'the browser tab for seconds — the page stops scrolling and looks crashed. This tool does that work ',
      'in a Web Worker instead, and reads uploaded files inside the worker too, so the large string never ',
      'touches the UI thread. A 44.8MB file formats in about 2.7 seconds with the page still responsive.</p>',
      '<h2>Errors that tell you where the problem is</h2>',
      '<p>When JSON does not parse, most tools hand you the browser message verbatim — often ',
      '"Unexpected token" with no position at all. This one scans the grammar itself to find the first ',
      'construct that cannot be parsed, then reports the line and column, draws a caret under the ',
      'offending token, and selects that exact token in your input so you can fix it immediately.</p>',
    ].join(''),
    faq: [
      { q: 'Is my JSON uploaded to a server?', a: 'No. Formatting happens entirely in your browser using a Web Worker. Nothing is transmitted, stored or logged.' },
      { q: 'What is the maximum file size?', a: 'A hard cap of 50MB, enforced in the browser with a clear message rather than a silent hang. Files above 1MB stay out of the editor so typing remains smooth.' },
      { q: 'What indentation does it use?', a: 'Two spaces. The output is exactly what <code>JSON.stringify(value, null, 2)</code> produces, so it matches most linters and editors out of the box.' },
      { q: 'Does it work offline?', a: 'Yes, properly — not just once loaded. After your first visit the whole site is stored on your device, so every tool keeps working with no connection at all, and a repeat visit loads without touching the network. You can add it to your home screen or dock like any other app.' }
    ]
  },

  {
    path: '/json-to-csv',
    module: 'csv',
    updated: '2026-08-24',
    title: 'JSON to CSV Converter — nested objects to columns, in your browser',
    description: 'Convert a JSON array of objects to CSV online. Nested objects become dotted ' +
      'columns, missing keys become empty cells, and quoting follows RFC 4180. Runs entirely ' +
      'client-side — no upload.',
    heading: 'JSON to CSV — arrays of objects, converted',
    keywords: 'json to csv, convert json to csv, json to csv converter, nested json to csv',
    content: [
      '<h2>Convert a JSON array into a spreadsheet</h2>',
      '<p>Paste a JSON array of objects and press <strong>Convert to CSV</strong>. You get a preview ',
      'table of the first 20 rows to sanity-check the shape, and a <code>.csv</code> download containing ',
      'every row. The download carries a UTF-8 byte order mark so Excel opens accented characters ',
      'correctly instead of mangling them.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>How nested data is handled</h2>',
      '<p>Columns are the union of every object’s keys, in first-seen order, so objects with missing ',
      'or extra fields convert cleanly — a key one row lacks simply becomes an empty cell. Nested objects ',
      'are flattened with dot notation, so <code>{"address":{"city":"London"}}</code> becomes a column ',
      'named <code>address.city</code>. Arrays are kept as JSON inside a single cell rather than exploded ',
      'into extra rows, which keeps the row count equal to your array length.</p>',
      '<h2>Correct CSV, not string concatenation</h2>',
      '<p>Values containing commas, quotes or newlines are quoted and escaped per RFC 4180, and rows ',
      'end with CRLF, so the output opens correctly in Excel, Google Sheets, Numbers and pandas. Empty ',
      'objects and empty arrays are written as <code>{}</code> and <code>[]</code> so they stay ',
      'distinguishable from a genuinely missing value.</p>',
    ].join(''),
    faq: [
      { q: 'What JSON shape does it need?', a: 'A top-level array of objects. Anything else — a single object, an array of numbers — gets an explanation of what is wrong rather than a broken file.' },
      { q: 'What happens to nested arrays?', a: 'They are written as JSON text inside one cell, for example <code>"[1,2,3]"</code>. Exploding them into additional rows is not supported.' },
      { q: 'How are null values written?', a: 'As empty cells. <code>false</code>, <code>0</code> and <code>""</code> are written literally, so they remain distinguishable from null.' },
      { q: 'Is there a row limit?', a: 'No. The preview table shows the first 20 rows and 40 columns for speed, but Copy and Download always contain every row.' }
    ]
  },

  {
    path: '/json-minifier',
    module: 'minify',
    updated: '2026-08-24',
    title: 'JSON Minifier — compress JSON online and see the bytes saved',
    description: 'Minify JSON in your browser: strip every optional space and newline and see ' +
      'exactly how many bytes you saved. Handles files up to 50MB. Nothing is uploaded.',
    heading: 'JSON minifier — strip every spare byte',
    keywords: 'json minifier, minify json, compress json, json compressor',
    content: [
      '<h2>Make JSON as small as JSON gets</h2>',
      '<p>Paste JSON and press <strong>Minify</strong>. Every optional space, newline and indent is ',
      'removed, and the result panel reports the before and after size with the percentage saved — a ',
      'typical pretty-printed API response shrinks by 25–40%.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>Lossless by construction</h2>',
      '<p>Minifying parses your document and re-serialises it, so the output is guaranteed to be valid ',
      'JSON that parses back to exactly the same value. Only insignificant whitespace is removed: keys, ',
      'values, ordering, numeric precision and Unicode escapes are all preserved. If the input will not ',
      'parse, you get the line, column and the offending token highlighted rather than a corrupted file.</p>',
      '<h2>When minifying is worth it</h2>',
      '<p>Minified JSON is smaller over the wire and in storage, which matters for API payloads, config ',
      'baked into bundles, and documents held in a database column. It is worth noting that gzip or ',
      'brotli already removes most of the cost of whitespace in transit, so the biggest wins are where ',
      'compression is not applied — local storage, embedded strings, and size-capped fields.</p>',
    ].join(''),
    faq: [
      { q: 'Does minifying change my data?', a: 'No. The document is parsed and re-serialised, so the result parses back to an identical value. Only whitespace between tokens is dropped.' },
      { q: 'Can I get the formatted version back?', a: 'Yes — minifying is fully reversible. Paste the minified output into the formatter and you get an indented document again.' },
      { q: 'Why does my file get slightly larger sometimes?', a: 'Rarely, re-serialising normalises a value — <code>1e2</code> becomes <code>100</code>, for instance. The size line tells you honestly when this happens.' },
      { q: 'Is there a size limit?', a: 'The same 50MB cap as the other tools, with the work done in a Web Worker so the page stays responsive.' }
    ]
  },

  {
    path: '/json-diff',
    module: 'diff',
    updated: '2026-08-24',
    title: 'JSON Diff — compare two JSON files structurally, online',
    description: 'Compare two JSON documents and see exactly what changed. A structural diff, so ' +
      'reordered keys and different indentation are not treated as changes. Runs entirely in your browser.',
    heading: 'JSON diff — compare two documents',
    keywords: 'json diff, compare json, json compare online, diff two json files',
    content: [
      '<h2>Compare values, not text</h2>',
      '<p>Paste one document into A and the other into B, then press <strong>Compare</strong>. Because ',
      'this compares parsed values rather than lines of text, reordering keys or changing indentation ',
      'produces no differences at all — the noise that makes a general-purpose text diff painful for ',
      'JSON simply does not appear.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>What you get back</h2>',
      '<p>Every difference is reported against a path you can act on, such as ',
      '<code>limits.indent</code> or <code>modules[2]</code>, labelled as added, removed or changed, ',
      'with the old and new values side by side. A key that exists in one document and not the other is ',
      'reported as added or removed; a key present in both with a different value is reported as changed, ',
      'including when the type changed. Missing keys stay distinguishable from keys set to null. The ',
      'full change list can be copied or downloaded as JSON.</p>',
      '<h2>How arrays are compared</h2>',
      '<p>Arrays are compared element by element, by index. This is exact and fast, but worth ',
      'understanding: inserting an element at the front of a long array reports every later index as ',
      'changed, rather than reporting a single insertion. For comparing records, giving each element a ',
      'stable position — or comparing objects keyed by id — gives the most readable result.</p>',
    ].join(''),
    faq: [
      { q: 'Does key order count as a difference?', a: 'No. Two documents holding the same values are reported as identical however their keys are ordered or their whitespace is arranged.' },
      { q: 'Can I compare two files rather than pasting?', a: 'Yes. Each side has its own upload button, and dropping a file onto a pane loads it into that pane. Files above 1MB are read inside the worker.' },
      { q: 'What if one side is invalid JSON?', a: 'The error says which side failed, gives the line and column, and selects the offending token in that pane.' },
      { q: 'Is there a limit on the number of differences?', a: 'It stops at 20,000 differences and says so, which keeps a comparison between two unrelated documents from exhausting memory.' }
    ]
  }
];

// Rendered for anything that does not resolve, so a stale or mistyped link lands
// on a page with a way back into the tools rather than nine bytes of plain text.
var notFound = {
  path: '/404',
  module: 'formatter',
  noindex: true,
  title: 'Page not found — I Hate JSON',
  description: 'That URL does not exist. Every tool on this site is listed below.',
  heading: 'That page does not exist',
  keywords: '',
  content: [
    '<h2>Nothing lives at that address</h2>',
    '<p>The link may be out of date, or the address may have a typo in it. Nothing here needs an ',
    'account or a session, so there is nothing to recover — pick a tool below and carry on.</p>',
    '<p>If you followed a link from somewhere on this site, that is a bug worth telling me about; ',
    'there is a link to do that at the bottom of the page.</p>'
  ].join('')
};

// Keyword-bearing URL people may try; the formatter itself lives at /.
var redirects = {
  '/json-formatter': '/',
  '/json-beautifier': '/',
  '/index.html': '/'
};

module.exports = {
  routes: routes,
  notFound: notFound,
  redirects: redirects,
  byPath: routes.reduce(function (map, route) {
    map[route.path] = route;
    return map;
  }, {})
};
