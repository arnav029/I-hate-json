/*
 * The tree's pure half — paths, search and the filter trie — under Node. The
 * DOM half is exercised in a real browser; these are the parts whose answers
 * have to be exactly right.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { self: undefined, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'tree.js'), 'utf8'), sandbox, { filename: 'tree.js' });

const tree = sandbox.JSONTree;
assert.ok(tree, 'tree.js should expose JSONTree');

let passed = 0;
function test(name, fn) {
  const started = Date.now();
  fn();
  passed++;
  console.log(`  ok  ${name} (${Date.now() - started}ms)`);
}

// Results cross a vm realm, so compare as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const DOC = {
  users: [
    { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', tags: ['math'] },
    { id: 2, name: 'Grace Hopper', email: 'grace@example.com', active: true, manager: null }
  ],
  'content-type': 'application/json',
  'first name': 'Alan',
  meta: { count: 2, Name: 'listing' }
};

console.log('tree core');

test('paths use dots, brackets for indices, and quoting where a key needs it', () => {
  assert.strictEqual(tree.formatPath([]), '');
  assert.strictEqual(tree.formatPath(['users', 0, 'email']), 'users[0].email');
  assert.strictEqual(tree.formatPath(['content-type']), '["content-type"]');
  assert.strictEqual(tree.formatPath(['a', 'first name', 2]), 'a["first name"][2]');
  assert.strictEqual(tree.formatPath([0, 1]), '[0][1]');
  assert.strictEqual(tree.formatPath(['$ref', '_id']), '$ref._id');
  assert.strictEqual(tree.formatPath(['say "hi"']), '["say \\"hi\\""]');
});

test('search matches values, case-insensitively, in document order', () => {
  const result = plain(tree.search(DOC, 'example.com'));
  assert.deepStrictEqual(result.matches, [['users', 0, 'email'], ['users', 1, 'email']]);
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.capped, false);
  assert.strictEqual(plain(tree.search(DOC, 'GRACE')).total, 2, 'name and email');
});

test('search matches keys too', () => {
  const result = plain(tree.search(DOC, 'name'));
  assert.deepStrictEqual(result.matches, [
    ['users', 0, 'name'], ['users', 1, 'name'], ['first name'], ['meta', 'Name']
  ]);
});

test('search finds numbers, booleans and null by their text', () => {
  assert.deepStrictEqual(plain(tree.search(DOC, 'null').matches), [['users', 1, 'manager']]);
  assert.deepStrictEqual(plain(tree.search(DOC, 'true').matches), [['users', 1, 'active']]);
});

test('array indices are never matches on their own', () => {
  assert.strictEqual(tree.search([10, 20, 30, 40], '3').total, 1, 'only the value 30');
  assert.strictEqual(tree.search(['a', 'b'], '1').total, 0);
});

test('a scalar root can match, with an empty path', () => {
  assert.deepStrictEqual(plain(tree.search('hello', 'ell').matches), [[]]);
});

test('match paths are capped, the total is not', () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, kind: 'row' }));
  const result = tree.search(big, 'row', 100);
  assert.strictEqual(result.matches.length, 100);
  assert.strictEqual(result.total, 5000);
  assert.strictEqual(result.capped, true);
});

test('the filter trie keeps exactly the branches that lead to a match', () => {
  const trie = tree.buildFilter(tree.search(DOC, 'example.com').matches);
  assert.deepStrictEqual(Array.from(trie.kids.keys()), ['users']);
  const users = trie.kids.get('users');
  assert.deepStrictEqual(Array.from(users.kids.keys()), [0, 1]);
  assert.strictEqual(users.hit, false);
  assert.strictEqual(users.kids.get(0).kids.get('email').hit, true);
  assert.strictEqual(users.kids.get(0).kids.has('name'), false);
});

test('searching a large document stays quick', () => {
  const big = { rows: Array.from({ length: 200000 }, (_, i) => ({ id: i, name: 'user ' + i, tags: ['a', 'b'] })) };
  const started = Date.now();
  const result = tree.search(big, 'user 199999');
  assert.strictEqual(result.total, 1);
  assert.deepStrictEqual(plain(result.matches), [['rows', 199999, 'name']]);
  assert.ok(Date.now() - started < 2000, 'took ' + (Date.now() - started) + 'ms');
});

console.log(`\n${passed} passed`);
