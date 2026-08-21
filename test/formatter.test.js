/*
 * Runs the browser formatting core under Node. formatter.js is written to be
 * DOM-free precisely so this is possible: no build step, no test framework.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'formatter.js'), 'utf8');
const sandbox = { self: undefined, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'formatter.js' });

const core = sandbox.JSONFormatterCore;
assert.ok(core, 'formatter.js should expose JSONFormatterCore');

let passed = 0;
function test(name, fn) {
  const started = Date.now();
  fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - started}ms)`);
}

console.log('formatter core');

test('pretty-prints with two-space indent', () => {
  const out = core.format('{"a":1,"b":[1,2]}');
  assert.strictEqual(out.formatted, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  assert.strictEqual(out.stats.lines, 7);
  assert.strictEqual(out.truncated, false);
});

test('highlights keys, strings, numbers and literals', () => {
  const html = core.highlight('{\n  "k": "v",\n  "n": -1.5e3,\n  "t": true\n}');
  assert.ok(html.includes('<span class="tok-key">"k"</span>:'), 'key span');
  assert.ok(html.includes('<span class="tok-str">"v"</span>'), 'string span');
  assert.ok(html.includes('<span class="tok-num">-1.5e3</span>'), 'number span');
  assert.ok(html.includes('<span class="tok-lit">true</span>'), 'literal span');
});

test('escapes HTML so JSON content cannot inject markup', () => {
  const out = core.format('{"x":"<img src=x onerror=alert(1)>"}');
  assert.ok(!out.previewHtml.includes('<img'), 'raw tag must not survive');
  assert.ok(out.previewHtml.includes('&lt;img'), 'tag must be escaped');
});

function failure(text) {
  try { core.format(text); } catch (e) { return e; }
  throw new Error('expected format() to throw for: ' + text);
}

// V8 reports an offset for some errors...
test('reports line and column when the engine gives a position', () => {
  const err = failure('{\n  "a": 1\n  "b": 2\n}');
  assert.strictEqual(err.kind, 'parse');
  assert.strictEqual(err.line, 3, 'error is on line 3');
  assert.strictEqual(err.column, 3);
  assert.ok(!/at position/i.test(err.message), 'raw position tail is stripped');
  assert.ok(err.snippet.line.includes('"b"'), 'snippet shows the offending line');
  assert.strictEqual(err.snippet.caret, 2, 'caret sits under the bad token');
});

// ...and only a quoted context for others, which we locate ourselves.
test('locates the error from the engine context snippet', () => {
  const err = failure('{\n  "alpha": 1,\n  "beta": ,\n  "gamma": 3\n}');
  assert.strictEqual(err.kind, 'parse');
  assert.strictEqual(err.approximate, false, 'context was unambiguous');
  assert.strictEqual(err.line, 3, 'error is on line 3');
  assert.strictEqual(err.snippet.line.trim(), '"beta": ,');
  assert.strictEqual(err.snippet.line[err.snippet.caret], ',', 'caret lands on the stray comma');
  assert.ok(!err.message.includes('is not valid JSON'), 'noisy engine text is cleaned up');
});

test('ranges cover exactly the offending token', () => {
  const src = '{\n  "alpha": 1,\n  "beta": ,\n  "gamma": 3\n}';
  const err = failure(src);
  assert.strictEqual(src.slice(err.range.start, err.range.end), ',');
});

test('ranges cover a whole word, not just its first character', () => {
  const src = '{alpha: 1}';
  const err = failure(src);
  assert.strictEqual(src.slice(err.range.start, err.range.end), 'alpha');
});

test('ranges cover a whole string token', () => {
  const src = '{"a": "one" "b": 2}';
  const err = failure(src);
  assert.strictEqual(src.slice(err.range.start, err.range.end), '"b"');
});

test('an approximate error ranges over the line, not a guessed token', () => {
  const err = failure('nope');
  if (err.approximate) {
    assert.strictEqual(err.range.start, 0);
    assert.strictEqual(err.range.end, 4);
  }
});

test('explains truncated documents', () => {
  const err = failure('{"a": [1, 2,');
  assert.strictEqual(err.kind, 'parse');
  assert.ok(/ends before/.test(err.message), err.message);
});

test('never reports a line it cannot justify', () => {
  const err = failure('nope');
  assert.strictEqual(err.kind, 'parse');
  // Either an exact hit or nothing — an approximate answer must say so.
  assert.ok(err.line === null || err.approximate === false || err.column === null);
});

test('windows a very long offending line', () => {
  const err = failure('{"k":"' + 'x'.repeat(5000) + '" "next":1}');
  assert.ok(err.snippet, 'still produces a snippet');
  assert.ok(err.snippet.line.length < 140, 'snippet stays short: ' + err.snippet.line.length);
});

test('rejects empty input with a friendly kind', () => {
  let err;
  try { core.format('   \n  '); } catch (e) { err = e; }
  assert.strictEqual(err.kind, 'empty');
});

test('counts UTF-8 bytes, not characters', () => {
  assert.strictEqual(core.utf8ByteLength('abc'), 3);
  assert.strictEqual(core.utf8ByteLength('é'), 2);
  assert.strictEqual(core.utf8ByteLength('☃'), 3);
  assert.strictEqual(core.utf8ByteLength('😀'), 4);
  const out = core.format('{"e":"😀"}');
  assert.ok(out.stats.outputBytes > out.formatted.length, 'multi-byte chars counted');
});

test('truncates the preview but keeps the full output', () => {
  const big = JSON.stringify(Array.from({ length: 60000 }, (_, i) => ({ id: i, name: 'row ' + i })));
  const out = core.format(big);
  assert.strictEqual(out.truncated, true);
  assert.ok(out.formatted.length > core.PREVIEW_LIMIT, 'full output retained');
  assert.ok(out.previewHtml.length > 0 && out.previewHtml.length < out.formatted.length * 3);
});

test('reports stages in order', () => {
  const stages = [];
  core.format('{"a":1}', { onStage: (s) => stages.push(s) });
  assert.deepStrictEqual(stages, ['parsing', 'formatting', 'highlighting']);
});

// The whole point of the Web Worker is 50MB documents; make sure the core can
// actually chew through one in a sane amount of time.
test('handles a ~50MB document', () => {
  const rows = [];
  for (let i = 0; i < 420000; i++) {
    rows.push({ id: i, uuid: 'a3f1c9de-' + i, name: 'record number ' + i, active: i % 2 === 0, score: i * 1.5, tags: ['alpha', 'beta', 'gamma'] });
  }
  const raw = JSON.stringify(rows);
  const mb = raw.length / 1024 / 1024;
  assert.ok(mb > 50, `fixture should be large, got ${mb.toFixed(1)}MB`);

  const started = Date.now();
  const out = core.format(raw);
  const elapsed = Date.now() - started;

  assert.ok(out.formatted.length > raw.length, 'indented output is larger');
  assert.strictEqual(out.truncated, true);
  console.log(`      ${mb.toFixed(1)}MB in → ${(out.stats.outputBytes / 1024 / 1024).toFixed(1)}MB out, ${core.countLines(out.formatted).toLocaleString('en-US')} lines, ${elapsed}ms`);
  assert.ok(elapsed < 60000, 'should finish well inside a minute');
});

console.log(`\n${passed} passing`);
