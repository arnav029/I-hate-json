/*
 * Runs the browser CSV core under Node, same trick as formatter.test.js.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: undefined, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['formatter.js', 'csv.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), sandbox, { filename: file });
}

const csv = sandbox.JSONCsvCore;
assert.ok(csv, 'csv.js should expose JSONCsvCore');

let passed = 0;
function test(name, fn) {
  const started = Date.now();
  fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - started}ms)`);
}

function failure(text) {
  try { csv.convert(text); } catch (e) { return e; }
  throw new Error('expected convert() to throw for: ' + text);
}

const lines = (result) => result.csv.split('\r\n');

console.log('csv core');

test('converts a flat array of objects', () => {
  const out = csv.convert('[{"a":1,"b":"x"},{"a":2,"b":"y"}]');
  assert.deepStrictEqual(lines(out), ['a,b', '1,x', '2,y']);
  assert.deepStrictEqual(Array.from(out.columns), ['a', 'b']);
  assert.strictEqual(out.stats.rows, 2);
  assert.strictEqual(out.stats.columns, 2);
});

test('unions keys across rows, leaving missing cells empty', () => {
  const out = csv.convert('[{"a":1},{"b":2},{"a":3,"c":4}]');
  assert.deepStrictEqual(Array.from(out.columns), ['a', 'b', 'c']);
  assert.deepStrictEqual(lines(out), ['a,b,c', '1,,', ',2,', '3,,4']);
});

test('flattens nested objects to dotted columns', () => {
  const out = csv.convert('[{"id":1,"address":{"city":"London","zip":{"code":"W1"}}}]');
  assert.deepStrictEqual(Array.from(out.columns), ['id', 'address.city', 'address.zip.code']);
  assert.deepStrictEqual(lines(out)[1], '1,London,W1');
});

test('keeps arrays as JSON inside one cell', () => {
  const out = csv.convert('[{"tags":[1,2,3]}]');
  assert.deepStrictEqual(lines(out), ['tags', '"[1,2,3]"']);
});

test('escapes commas, quotes and newlines', () => {
  const out = csv.convert('[{"a":"x,y","b":"say \\"hi\\"","c":"line1\\nline2"}]');
  assert.strictEqual(lines(out)[1], '"x,y","say ""hi""","line1\nline2"');
  assert.strictEqual(lines(out).length, 2, 'an embedded newline does not start a new CSV row');
});

test('distinguishes null from falsy values and empty containers', () => {
  const out = csv.convert('[{"a":null,"b":{},"c":0,"d":false,"e":"","f":[]}]');
  assert.deepStrictEqual(lines(out), ['a,b,c,d,e,f', ',{},0,false,,[]']);
});

test('uses CRLF row endings', () => {
  const out = csv.convert('[{"a":1},{"a":2}]');
  assert.ok(out.csv.includes('\r\n'), 'RFC 4180 line endings');
});

test('previews at most PREVIEW_ROWS rows but converts all of them', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
  const out = csv.convert(JSON.stringify(rows));
  assert.strictEqual(out.preview.length, csv.PREVIEW_ROWS);
  assert.strictEqual(out.stats.rows, 500);
  assert.strictEqual(lines(out).length, 501);
});

test('rejects a shape it cannot export', () => {
  assert.strictEqual(failure('{"a":1}').kind, 'shape');
  assert.strictEqual(failure('[]').kind, 'shape');
  assert.strictEqual(failure('[1,2,3]').kind, 'shape');
  assert.strictEqual(failure('"just a string"').kind, 'shape');
  assert.ok(/array of objects/.test(failure('{"a":1}').message));
  assert.ok(/empty/.test(failure('[]').message));
  assert.ok(/Item 1 is a number/.test(failure('[1,2,3]').message));
});

test('reports bad JSON through the shared parse errors', () => {
  const err = failure('[{"a": ,}]');
  assert.strictEqual(err.kind, 'parse');
  assert.ok(err.range, 'carries a range so the input can be highlighted');
});

test('handles a large array without choking', () => {
  const rows = [];
  for (let i = 0; i < 200000; i++) {
    rows.push({ id: i, name: 'record ' + i, nested: { score: i * 1.5, active: i % 2 === 0 } });
  }
  const raw = JSON.stringify(rows);
  const started = Date.now();
  const out = csv.convert(raw);
  const elapsed = Date.now() - started;

  assert.strictEqual(out.stats.rows, 200000);
  assert.deepStrictEqual(Array.from(out.columns), ['id', 'name', 'nested.score', 'nested.active']);
  console.log(`      ${(raw.length / 1048576).toFixed(1)}MB JSON → ${(out.stats.bytes / 1048576).toFixed(1)}MB CSV, ${elapsed}ms`);
  assert.ok(elapsed < 60000, 'should finish well inside a minute');
});

console.log(`\n${passed} passing`);
