/*
 * Per-route metadata and page copy. Server-side only — server.js substitutes
 * these into public/index.html so each module is a real, crawlable URL with its
 * own title, description, heading and content.
 */
'use strict';

var PRIVACY = 'Everything runs in your browser. Your JSON is parsed by a Web Worker on your own ' +
  'machine and never sent anywhere — there is no upload, no account, and no server-side ' +
  'processing. You can check: open the network tab and format a file, and you will see no requests. ' +
  '<a href="/json-privacy">Here is why that matters</a>, and how to verify it on any tool.';

var routes = [
  {
    path: '/',
    module: 'formatter',
    updated: '2026-10-30',
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
      '<h2>Broken JSON gets fixed, not just flagged</h2>',
      '<p>Trailing commas, single quotes, unquoted keys, comments, Python’s <code>True</code> and ',
      '<code>None</code>, a chat assistant’s reply with prose and a code fence around the data, a ',
      'response cut off halfway — the formatter repairs all of these and formats the result, then lists ',
      'every change it made with the line it was on. Nothing is altered silently. ',
      '<a href="/fix-json">More on what gets repaired</a>.</p>',
      '<p>When something genuinely cannot be repaired, you get the line and column, a caret under the ',
      'offending token, and that exact token selected in your input — not a bare "Unexpected token".</p>',
      '<h2>Explore it as a tree, share it as a link</h2>',
      '<p>Switch the output to <strong>Tree</strong> to open and close nodes, search every key and value, ',
      'and click anything to copy its path — <code>users[3].address.city</code>. ',
      '<a href="/json-viewer">More on the tree view</a>. <strong>Share link</strong> copies a link with ',
      'your JSON compressed inside it, after the <code>#</code>, which browsers never send to a server — ',
      'so the link works without anything being uploaded.</p>',
    ].join(''),
    faq: [
      { q: 'Is my JSON uploaded to a server?', a: 'No. Formatting happens entirely in your browser using a Web Worker. Nothing is transmitted, stored or logged.' },
      { q: 'What is the maximum file size?', a: 'A hard cap of 50MB, enforced in the browser with a clear message rather than a silent hang. Files above 1MB stay out of the editor so typing remains smooth.' },
      { q: 'What indentation does it use?', a: 'Two spaces. The output is exactly what <code>JSON.stringify(value, null, 2)</code> produces, so it matches most linters and editors out of the box.' },
      { q: 'Does it work offline?', a: 'Yes, properly — not just once loaded. After your first visit the whole site is stored on your device, so every tool keeps working with no connection at all, and a repeat visit loads without touching the network. You can add it to your home screen or dock like any other app.' }
    ]
  },

  {
    path: '/json-viewer',
    module: 'viewer',
    updated: '2026-10-30',
    title: 'JSON Viewer — explore JSON as a tree, search it, copy paths',
    label: 'JSON viewer',
    description: 'View JSON as a collapsible tree. Search every key and value, click any node to ' +
      'copy its path like users[3].address.city, and open files up to 25MB. Runs in your browser.',
    heading: 'JSON viewer — open it, search it, find your path',
    keywords: 'json viewer, json tree viewer, view json online, json explorer, json path finder',
    content: [
      '<h2>Big API responses, made walkable</h2>',
      '<p>Paste JSON or drop a file and it opens as a tree: objects and arrays collapse and expand, each ',
      'one showing how many keys or items it holds before you open it. The first few levels open by ',
      'themselves; the rest stay closed until you want them. Arrow keys move through it like a file ',
      'explorer — right to open, left to close.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>Search keys and values</h2>',
      '<p>Type in the search box and the tree narrows to just the branches that contain a match, opened ',
      'down to each one, with the matching text highlighted. It searches every object key and every ',
      'value, case-insensitively — find the record with a given email, or every field called ',
      '<code>id</code>, without scrolling.</p>',
      '<h2>Click a value, get its path</h2>',
      '<p>Choosing any row shows its path at the bottom of the panel, written the way you would type it in ',
      'code — <code>users[3].address.city</code>, or <code>headers["content-type"]</code> where a key needs ',
      'quoting. <strong>Copy path</strong> puts that on your clipboard; <strong>Copy value</strong> copies the ',
      'value itself, as JSON for objects and arrays and as plain text for a string.</p>',
      '<h2>Fast on large files</h2>',
      '<p>The tree only ever builds what is open. Children appear when their parent does, 200 at a time ',
      'with a button for the next 200, and closing a node discards them again — so a 20MB document costs ',
      'no more to open than a small one. Parsing and formatting happen in a Web Worker, and broken input is ',
      '<a href="/fix-json">repaired</a> before it is shown.</p>'
    ].join(''),
    faq: [
      { q: 'How big a file can the tree show?', a: 'Up to 25MB. The tree is built lazily, so size mostly affects the initial parse. Beyond 25MB the formatter still handles files up to 50MB as text.' },
      { q: 'What path format does Copy path use?', a: 'JavaScript-style: dots for plain keys, brackets for array indices and for keys with spaces or symbols — <code>items[0]["unit price"]</code>. It pastes straight into code, and reads naturally as a jq or JSONPath expression too.' },
      { q: 'Can I send someone the tree?', a: 'Yes. <strong>Share link</strong> copies a link with the JSON compressed into the part after the <code>#</code>, which browsers never send to a server. Whoever opens it sees the same document — and nothing was uploaded to make that work.' },
      { q: 'Does search include array indices?', a: 'No — only object keys and values. Searching for <code>3</code> would otherwise match the fourth element of every array in the document.' }
    ]
  },

  {
    path: '/fix-json',
    module: 'repair',
    updated: '2026-10-30',
    title: 'Fix JSON — repair broken or invalid JSON online, instantly',
    label: 'Fix broken JSON',
    description: 'Paste broken JSON, get valid JSON back: trailing commas, single quotes, ' +
      'comments, Python True/None, ChatGPT replies, cut-off output. Every fix is listed. ' +
      'Nothing is uploaded.',
    heading: 'Fix JSON — paste it broken, get it back valid',
    keywords: 'fix json, json repair, repair json online, fix invalid json, json fixer, fix chatgpt json',
    content: [
      '<h2>Paste the JSON you actually have</h2>',
      '<p>Not every “JSON” is JSON. A config file with comments, a JavaScript object with bare keys, ',
      'a Python dict printed with <code>True</code> and <code>None</code>, a chat assistant’s answer ',
      'wrapped in “Sure! Here you go:” and a <code>```json</code> fence, an API response cut off ',
      'mid-string. Every one of those fails <code>JSON.parse</code>. Paste it here, press ',
      '<strong>Fix JSON</strong>, and you get valid, formatted JSON back.</p>',
      '<p>' + PRIVACY + '</p>',
      '<h2>Every change is listed</h2>',
      '<p>A repair that quietly rewrites your data is worse than an error. So alongside the result you ',
      'get a list of exactly what was changed and the line it first happened on — “Removed 2 trailing ',
      'commas · line 4”, “Converted 3 Python literals”, “Closed 2 brackets left open — the input looks ',
      'cut off”. Read it, then copy the result, download it, or put it straight back into the input.</p>',
      '<h2>What it repairs</h2>',
      '<ul>',
      '<li><strong>Chat assistant output</strong> — prose before and after, Markdown code fences, ',
      'and replies that stopped mid-object</li>',
      '<li><strong>Commas</strong> — trailing, doubled, or missing between items</li>',
      '<li><strong>Quotes</strong> — single quotes, curly “smart” quotes from documents and chat apps, ',
      'unquoted keys, and unescaped quotes inside strings</li>',
      '<li><strong>Comments</strong> — <code>//</code>, <code>/* */</code> and <code>#</code></li>',
      '<li><strong>Python and JavaScript values</strong> — <code>True</code>, <code>False</code>, ',
      '<code>None</code>, <code>undefined</code>, <code>NaN</code> and <code>Infinity</code></li>',
      '<li><strong>MongoDB shell output</strong> — <code>ObjectId("…")</code>, <code>ISODate("…")</code>, ',
      '<code>NumberLong(…)</code></li>',
      '<li><strong>Truncated documents</strong> — open strings, arrays and objects are closed, and a key ',
      'left with no value is dropped</li>',
      '<li><strong>Strings</strong> — raw line breaks and tabs, invalid escapes such as Windows paths</li>',
      '<li><strong>Numbers</strong> — hex, a leading <code>+</code> or <code>.</code>, leading zeros</li>',
      '<li><strong>Several documents at once</strong> — NDJSON or pasted-together objects become an array</li>',
      '<li><strong>JSON inside a string</strong> — <code>"{\\"a\\":1}"</code> from a log line or a ',
      'database column is unwrapped</li>',
      '</ul>',
      '<h2>When it will not guess</h2>',
      '<p>If the input stops looking like structured data at all — an HTML page, a sentence with no ',
      'braces in it — the repair gives up rather than inventing something. You get the usual precise ',
      'error instead: line, column, and the offending token selected in your input.</p>'
    ].join(''),
    faq: [
      { q: 'Will it change my data?', a: 'Only what it has to for the input to parse, and every change is listed with its line. Values are never reordered, renamed or reformatted beyond that — a number stays the same number and a string the same string.' },
      { q: 'Why does ChatGPT give me invalid JSON?', a: 'Language models write text that looks like JSON, and usually is, but they add a sentence before it, wrap it in a code fence, leave a trailing comma, or run out of tokens halfway through. All of those are repaired here.' },
      { q: 'Is my JSON uploaded to fix it?', a: 'No. The repair runs in a Web Worker in your browser. Nothing is sent anywhere — the page’s security policy blocks outgoing connections entirely, and it keeps working with your network switched off.' },
      { q: 'What if the JSON was cut off?', a: 'Open strings, arrays and objects are closed at the cut-off, and a key that never got its value is dropped. The result is valid, but it is still missing whatever came after — the list of changes says so.' }
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
  },

  /*
   * Not a tool — the one page here that argues rather than converts. It exists
   * because "nothing leaves your browser" is a line every JSON site uses, and in
   * November 2025 two of the biggest were shown to be publishing what people
   * pasted into them. Every claim below is sourced and linked.
   */
  {
    path: '/json-privacy',
    module: 'privacy',
    article: true,
    updated: '2026-10-30',
    title: 'Is it safe to paste JSON into an online formatter?',
    label: 'Is it safe to paste JSON online?',
    description: 'Researchers recovered 80,000 files of pasted data — passwords, cloud keys, AD ' +
      'credentials — from two popular JSON sites. What happened, and three ways to check any tool ' +
      'yourself.',
    heading: 'Is it safe to paste JSON into an online tool?',
    keywords: 'is jsonformatter safe, json formatter privacy, safe json formatter, paste json online',
    content: [
      '<p class="lede">Usually yes, and occasionally very much not. What separates the two is not how ',
      'trustworthy the site looks — it is whether the tool has anywhere to put your data in the first ',
      'place. Here is the case that made that concrete, and three ways to check any tool in under a ',
      'minute.</p>',

      '<h2>What happened in November 2025</h2>',
      '<p>Researchers at <a href="https://labs.watchtowr.com/" rel="noopener">watchTowr Labs</a> published ',
      'an analysis of two of the most-used JSON tools on the web, <strong>JSONFormatter</strong> and ',
      '<strong>CodeBeautify</strong>. They recovered <strong>more than 80,000 files</strong> — around 5GB — ',
      'of what people had pasted into them: five years’ worth from one site, a year from the other.</p>',
      '<p>The contents read like an incident report. Passwords. Active Directory credentials. Database and ',
      'FTP logins. Cloud environment keys. LDAP configuration. Repository keys. Helpdesk API keys. Recorded ',
      'SSH sessions. The organisations it came from spanned critical national infrastructure, government, ',
      'banking, insurance, healthcare, aerospace, telecommunications, education and — with a certain irony — ',
      'cybersecurity.</p>',
      '<p>Nobody broke in. There was no exploit and no breach. Both sites offered a <strong>save ',
      'button</strong> that turned a paste into a shareable link, and both listed those links on a public ',
      '“Recent Links” page. The identifiers were predictable. Anyone willing to write a loop could walk ',
      'the entire history.</p>',
      '<p>And people were. The researchers planted fake AWS keys to see what would happen; attackers were ',
      'trying them <strong>within 48 hours</strong>. This was not a dormant exposure waiting to be found — ',
      'it was already being harvested.</p>',
      '<p>To their credit, both sites appear to have disabled the save feature around September 2025, after ',
      'affected organisations were notified. That specific hole is closed.</p>',

      '<h2>The feature was the vulnerability</h2>',
      '<p>That is the part worth carrying away, because this is not really a story about two websites being ',
      'careless. It is a story about what a convenience feature costs.</p>',
      '<p>Saving a paste so you can send it to a colleague is a genuinely useful thing to offer. But the ',
      'moment a tool can save your data, it has a copy of your data — and every copy is something that can ',
      'be enumerated, indexed, leaked, subpoenaed, or sold along with the company. A privacy policy is a ',
      'statement of intent about that copy. It is not a constraint on what can happen to it.</p>',
      '<p>The only architecture that cannot leak what you paste is the one where what you paste never ',
      'arrives.</p>',

      '<h2>How this site is built</h2>',
      '<p>Every tool here — formatting, minifying, CSV conversion, diffing — runs inside a Web Worker on ',
      'your own machine. There is no account, no upload, no logging, no analytics and no third-party script ',
      'of any kind. The server in front of you hands over static files and does nothing else; it has no ',
      'database to put anything in.</p>',
      '<p>There is <strong>no save button, and there will not be one</strong>. Sharing works differently: ',
      '<strong>Share link</strong> compresses what you pasted into the URL fragment — the part after the ',
      '<code>#</code>, which browsers never send to a server. The link does not point at your data; it ',
      '<em>is</em> your data. There is no stored copy to enumerate, no list of recent links, and nothing to ',
      'delete, because nothing was kept. The flip side is said plainly on the button: anyone you send the ',
      'link to can read what is in it.</p>',

      '<h2>Three ways to check, here or anywhere else</h2>',
      '<p><strong>1. Watch the network.</strong> Open your browser’s developer tools, switch to the Network ',
      'tab, and format something large. A client-side tool makes no request at all while it works. If you ',
      'can see your document leaving in a request body, you have your answer.</p>',
      '<p><strong>2. Read the security header.</strong> In the same panel, click the page itself and look at ',
      'its response headers. This site sends a Content Security Policy containing ',
      '<code>connect-src \'none\'</code>, which tells your browser to block every outbound connection any ',
      'script on this page might attempt — fetch, XHR, WebSocket, beacon, all of it. That is not a promise ',
      'from us. It is a rule your browser enforces on us, and it would hold even if this server were ',
      'compromised tomorrow.</p>',
      '<p><strong>3. Unplug.</strong> The most convincing test needs no tooling at all. Load this page, turn ',
      'off your Wi-Fi, and carry on working. Every tool here keeps running with no network, because none of ',
      'them ever needed one. A tool that stops working offline was doing the work somewhere else.</p>',

      '<h2>If you have already pasted something sensitive</h2>',
      '<p>Assume it is public and act accordingly: rotate the credential, revoke the key, and check your ',
      'logs for use you did not authorise. This is unglamorous, and it is the only thing that actually ',
      'helps — deleting a paste tells you nothing about who copied it first. It is also worth looking at ',
      'the habit rather than the incident, because whoever did it once at six on a Friday will do it ',
      'again.</p>',

      '<h2>Sources</h2>',
      '<ul class="sources">',
      '<li><a href="https://labs.watchtowr.com/" rel="noopener">watchTowr Labs</a> — the original research, ',
      'by Jake Knott</li>',
      '<li><a href="https://thehackernews.com/2025/11/years-of-jsonformatter-and-codebeautify.html" ',
      'rel="noopener">The Hacker News</a> — “Years of JSONFormatter and CodeBeautify Leaks Expose Thousands ',
      'of Passwords and API Keys”</li>',
      '<li><a href="https://www.csoonline.com/article/4096193/developers-left-large-cache-of-credentials-exposed-on-code-generation-websites-2.html" ',
      'rel="noopener">CSO Online</a> — on the range of sectors affected</li>',
      '<li><a href="https://securityaffairs.com/185150/security/thousands-of-sensitive-secrets-published-on-jsonformatter-and-codebeautify.html" ',
      'rel="noopener">Security Affairs</a></li>',
      '</ul>'
    ].join(''),
    faq: [
      { q: 'Was this a hack?', a: 'No. Nothing was broken into. Both sites offered a save button that turned a paste into a shareable link and listed those links publicly with predictable identifiers — the data was published by the feature working exactly as designed.' },
      { q: 'Are those sites safe to use now?', a: 'Both appear to have disabled the save feature around September 2025, which closes this particular exposure. Whether to paste sensitive data into any tool with a server behind it is a separate judgement, since a feature that was removed can be added back.' },
      { q: 'How can I tell whether a tool sends my data anywhere?', a: 'Open the Network tab in your developer tools and use the tool on something large. A client-side tool makes no request while it works. As a second check, look for a Content Security Policy on the page with <code>connect-src</code> set to <code>none</code>, which makes your browser enforce it rather than the site merely promising it.' },
      { q: 'I pasted an API key into one of these. What now?', a: 'Treat it as public. Rotate or revoke it, then check your logs for unauthorised use. Deleting the paste does not help, because you cannot know who copied it first — researchers found planted keys being tried by attackers within 48 hours.' }
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
