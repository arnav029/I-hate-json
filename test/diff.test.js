/*
 * Runs the browser diff core under Node, same trick as the other suites.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: undefined, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['formatter.js', 'diff.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), sandbox, { filename: file });
}

const diff = sandbox.JSONDiffCore;
assert.ok(diff, 'diff.js should expose JSONDiffCore');

let passed = 0;
function test(name, fn) {
  const started = Date.now();
  fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - started}ms)`);
}

// changes cross the vm realm boundary, so normalise before comparing
const changes = (a, b) => JSON.parse(JSON.stringify(diff.compare(a, b).changes));
const compare = (a, b) => diff.compare(a, b);

console.log('diff core');

test('reports nothing for equal documents', () => {
  const out = compare('{"a":1,"b":[1,2]}', '{"a":1,"b":[1,2]}');
  assert.strictEqual(out.identical, true);
  assert.strictEqual(out.stats.total, 0);
});

test('ignores key order and formatting', () => {
  const out = compare('{"a":1,"b":2}', '{\n  "b": 2,\n  "a": 1\n}');
  assert.strictEqual(out.identical, true, 'a structural diff must not see reordering as a change');
});

test('reports added, removed and changed keys', () => {
  const out = changes('{"keep":1,"drop":2,"edit":3}', '{"keep":1,"edit":4,"new":5}');
  // ordered by A's keys, with B-only keys appended
  assert.deepStrictEqual(out, [
    { kind: 'removed', path: 'drop', from: '2', fromType: 'number' },
    { kind: 'changed', path: 'edit', from: '3', fromType: 'number', to: '4', toType: 'number' },
    { kind: 'added', path: 'new', to: '5', toType: 'number' }
  ]);
});

test('counts each kind', () => {
  const out = compare('{"a":1,"b":2,"c":3}', '{"a":9,"c":3,"d":4}');
  assert.deepStrictEqual(
    { added: out.stats.added, removed: out.stats.removed, changed: out.stats.changed },
    { added: 1, removed: 1, changed: 1 }
  );
});

test('builds readable paths, quoting awkward keys', () => {
  const out = changes('{"a":{"b":[{"c":1}]}}', '{"a":{"b":[{"c":2}]}}');
  assert.strictEqual(out[0].path, 'a.b[0].c');

  const awkward = changes('{"we ird":1}', '{"we ird":2}');
  assert.strictEqual(awkward[0].path, '["we ird"]');
});

test('flags a type change rather than diffing across types', () => {
  const out = changes('{"a":[1]}', '{"a":"1"}');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'changed');
  assert.strictEqual(out[0].fromType, 'array');
  assert.strictEqual(out[0].toType, 'string');
});

test('distinguishes null from a missing key', () => {
  const missing = changes('{"a":1}', '{}');
  assert.strictEqual(missing[0].kind, 'removed');

  const nulled = changes('{"a":1}', '{"a":null}');
  assert.strictEqual(nulled[0].kind, 'changed');
  assert.strictEqual(nulled[0].toType, 'null');
});

test('compares arrays by index, reporting length changes', () => {
  const shorter = changes('[1,2,3]', '[1,2]');
  assert.deepStrictEqual(shorter, [{ kind: 'removed', path: '[2]', from: '3', fromType: 'number' }]);

  const longer = changes('[1]', '[1,2]');
  assert.deepStrictEqual(longer, [{ kind: 'added', path: '[1]', to: '2', toType: 'number' }]);
});

test('handles a root-level change', () => {
  const out = changes('1', '2');
  assert.strictEqual(out[0].path, '(root)');
});

test('labels which side failed to parse', () => {
  let err;
  try { compare('{"a":1}', '{"a":,}'); } catch (e) { err = e; }
  assert.strictEqual(err.kind, 'parse');
  assert.strictEqual(err.side, 'B');
  assert.ok(!/Side/.test(err.message), 'the side is a field, not message noise: ' + err.message);
  assert.ok(err.range, 'carries a range so that pane can highlight it');

  try { compare('nope', '{"a":1}'); } catch (e) { err = e; }
  assert.strictEqual(err.side, 'A');
});

test('caps runaway diffs instead of exhausting memory', () => {
  const a = JSON.stringify(Array.from({ length: 40000 }, (_, i) => ({ v: i })));
  const b = JSON.stringify(Array.from({ length: 40000 }, (_, i) => ({ v: -i })));
  const out = compare(a, b);
  assert.strictEqual(out.capped, true);
  assert.strictEqual(out.changes.length, diff.MAX_CHANGES);
});

test('compares large documents quickly', () => {
  const rows = [];
  for (let i = 0; i < 200000; i++) rows.push({ id: i, name: 'record ' + i, nested: { score: i * 1.5 } });
  const a = JSON.stringify(rows);
  rows[199999] = { id: 199999, name: 'changed', nested: { score: 0 } };
  const b = JSON.stringify(rows);

  const started = Date.now();
  const out = compare(a, b);
  const elapsed = Date.now() - started;

  assert.strictEqual(out.stats.total, 2, 'one changed name and one changed score');
  console.log(`      2 × ${(a.length / 1048576).toFixed(1)}MB compared in ${elapsed}ms`);
  assert.ok(elapsed < 60000, 'should finish well inside a minute');
});

console.log(`\n${passed} passing`);
