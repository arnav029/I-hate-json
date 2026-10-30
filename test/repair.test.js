/*
 * Runs the repair core under Node, through the formatter's parse() the way the
 * worker does. Each case is a kind of broken JSON people actually paste.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: undefined, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['formatter.js', 'repair.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
  vm.runInContext(source, sandbox, { filename: file });
}

const core = sandbox.JSONFormatterCore;
const repairCore = sandbox.JSONRepairCore;
assert.ok(repairCore, 'repair.js should expose JSONRepairCore');

let passed = 0;
function test(name, fn) {
  const started = Date.now();
  fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - started}ms)`);
}

// Parses with repair on; returns the value (as plain JSON) and the fix kinds.
function fix(text) {
  const repairs = [];
  const value = core.parse(text, repairs);
  return { value: JSON.parse(JSON.stringify(value)), kinds: repairs.map((r) => r.kind), repairs };
}

function same(text, expected, kinds) {
  const out = fix(text);
  assert.deepStrictEqual(out.value, expected);
  if (kinds) assert.deepStrictEqual(out.kinds.slice().sort(), kinds.slice().sort(), 'fix kinds for ' + text);
  return out;
}

console.log('repair core');

test('valid JSON passes through untouched, with nothing reported', () => {
  same('{"a":[1,2,{"b":null}]}', { a: [1, 2, { b: null }] }, []);
});

test('without opting in, parse still throws on broken input', () => {
  assert.throws(() => core.parse('{"a":1,}'), (err) => err.kind === 'parse');
});

test('trailing commas', () => {
  same('{"a":[1,2,],}', { a: [1, 2] }, ['trailing-comma']);
});

test('single quotes, bare keys and comments — a JS object literal', () => {
  same("{\n  // the user\n  name: 'Ada', /* id */ id: 7\n}", { name: 'Ada', id: 7 },
    ['comment', 'single-quote', 'unquoted-key']);
});

test('Python repr: True, False, None and single quotes', () => {
  same("{'ok': True, 'err': None, 'flags': [False]}", { ok: true, err: null, flags: [false] },
    ['literal', 'single-quote']);
});

test('apostrophes inside single-quoted strings survive', () => {
  same("{'msg': 'it's fine'}", { msg: "it's fine" });
});

test('a model reply: prose and a fenced block around the JSON', () => {
  const reply = 'Sure! Here is the data:\n\n```json\n{"name": "Ada", "langs": ["en", "fr"],}\n```\n\nLet me know!';
  same(reply, { name: 'Ada', langs: ['en', 'fr'] }, ['fence', 'trailing-comma']);
});

test('prose without a fence', () => {
  same('Here is the JSON: {"a": 1} hope that helps', { a: 1 }, ['prose', 'trailing-text']);
});

test('JSONP callback wrapper', () => {
  same('callback({"a": 1});', { a: 1 }, ['prose', 'trailing-text']);
});

test('truncated mid-string closes everything that was open', () => {
  const out = same('{"users": [{"name": "Ada"}, {"name": "Gra', { users: [{ name: 'Ada' }, { name: 'Gra' }] },
    ['unclosed-string', 'unclosed']);
  assert.strictEqual(out.repairs.find((r) => r.kind === 'unclosed').count, 3);
});

test('truncated after a key drops the dangling key', () => {
  same('{"a": 1, "b":', { a: 1 }, ['truncated-member', 'unclosed']);
  same('{"a": 1, "b"', { a: 1 }, ['truncated-member', 'unclosed']);
});

test('missing commas between members and items', () => {
  same('{"a": 1\n "b": [1 2 3]}', { a: 1, b: [1, 2, 3] }, ['missing-comma']);
});

test('unescaped quotes inside a string', () => {
  same('{"quote": "she said "hi" twice"}', { quote: 'she said "hi" twice' }, ['inner-quote']);
});

test('raw newlines and tabs inside strings are escaped', () => {
  same('{"text": "line one\nline\ttwo"}', { text: 'line one\nline\ttwo' }, ['control']);
});

test('Windows paths keep their backslashes', () => {
  same('{"path": "C:\\Users\\ada"}', { path: 'C:\\Users\\ada' }, ['escape']);
});

test('curly quotes from a word processor or chat app', () => {
  same('{\u201cname\u201d: \u201cAda\u201d}', { name: 'Ada' }, ['smart-quote']);
});

test('NaN and Infinity become null', () => {
  same('{"a": NaN, "b": -Infinity, "c": Infinity}', { a: null, b: null, c: null }, ['non-finite']);
});

test('numbers JSON does not allow', () => {
  same('[0x1F, +5, .5, 5., 007, 1_000]', [31, 5, 0.5, 5, 7, 1000], ['number']);
});

test('dates and words without quotes become strings', () => {
  same('{"when": 2024-01-31, "status": active}', { when: '2024-01-31', status: 'active' }, ['unquoted-value']);
});

test('Mongo shell output: ObjectId, ISODate, NumberLong', () => {
  same('{"_id": ObjectId("507f1f77bcf86cd799439011"), "at": ISODate("2024-01-31T10:00:00Z"), "n": NumberLong(42)}',
    { _id: '507f1f77bcf86cd799439011', at: '2024-01-31T10:00:00Z', n: 42 }, ['wrapper']);
});

test('NDJSON becomes an array', () => {
  const out = same('{"a":1}\n{"a":2}\n{"a":3}\n', [{ a: 1 }, { a: 2 }, { a: 3 }], ['multiple']);
  assert.strictEqual(out.repairs[0].count, 3);
});

test('mismatched closers', () => {
  same('[{"a": 1]', [{ a: 1 }], ['bracket']);
  same('{"a": [1, 2}', { a: [1, 2] }, ['bracket']);
});

test('JSON stored as a string is unwrapped, even when otherwise valid', () => {
  same('"{\\"a\\":1,\\"b\\":[2]}"', { a: 1, b: [2] }, ['unwrapped']);
});

test('a plain string that only looks like JSON is left alone', () => {
  same('"[not json"', '[not json', []);
});

test('repairs report the line they first happened on', () => {
  const out = fix('{\n"a": 1,\n"b": 2,\n}');
  assert.strictEqual(out.repairs[0].line, 3);
  assert.strictEqual(out.repairs[0].message, 'Removed 1 trailing comma');
});

test('gives up on things that are not JSON at all', () => {
  for (const text of ['hello world', '"a": 1, "b": 2}', '<html><body>x</body></html>', '{"a": @@@}']) {
    assert.throws(() => fix(text), (err) => err.kind === 'parse', text);
  }
});

test('gives up cleanly on absurd nesting rather than overflowing', () => {
  assert.throws(() => fix('['.repeat(100000) + 'x'), (err) => err.kind === 'parse');
});

test('format() and minify() carry the repairs to the UI', () => {
  assert.deepStrictEqual(Array.from(core.format("{'a': 1,}").repairs, (r) => r.kind), ['single-quote', 'trailing-comma']);
  assert.strictEqual(core.format("{'a': 1,}").formatted, '{\n  "a": 1\n}');
  assert.strictEqual(core.minify('{a: 1}').minified, '{"a":1}');
  assert.strictEqual(core.format('{"a":1}').repairs.length, 0);
});

test('a big broken document repairs in reasonable time', () => {
  const row = "{id: 1, name: 'row', tags: ['a', 'b'], ok: True},\n";
  const text = '[' + row.repeat(100000) + ']';
  const started = Date.now();
  const out = fix(text);
  assert.strictEqual(out.value.length, 100000);
  assert.ok(Date.now() - started < 5000, 'took ' + (Date.now() - started) + 'ms');
});

console.log(`\n${passed} passed`);
