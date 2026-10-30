/*
 * Share links under Node, which has the same CompressionStream, Blob and
 * base64 globals the browser does. A link is untrusted input, so most of this
 * is about what happens when one is wrong.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Runs in this realm so the browser globals it needs are the real ones.
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'share.js'), 'utf8'), { filename: 'share.js' });
const share = globalThis.JSONShare;
assert.ok(share, 'share.js should expose JSONShare');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function rejectsWith(promise, pattern) {
  return promise.then(
    () => assert.fail('expected a rejection'),
    (err) => {
      assert.strictEqual(err.kind, 'share', 'a displayable error, not a raw exception');
      if (pattern) assert.ok(pattern.test(err.message), err.message);
    }
  );
}

test('is available here', async () => {
  assert.strictEqual(share.supported(), true);
});

test('round-trips one document, including non-ASCII text', async () => {
  const text = '{"name":"Zoë","city":"Kraków","emoji":"🦄","quote":"she said \\"hi\\""}';
  const fragment = await share.encode([text]);
  assert.ok(/^share=1\.[A-Za-z0-9_-]+$/.test(fragment), 'URL-safe, no padding: ' + fragment);
  assert.deepStrictEqual(await share.decode('#' + fragment), [text]);
  assert.deepStrictEqual(await share.decode(fragment), [text], 'leading # is optional');
});

test('round-trips both sides of a diff', async () => {
  const texts = ['{"a":1}', '{"a":2,"b":[1,2,3]}'];
  assert.deepStrictEqual(await share.decode(await share.encode(texts)), texts);
});

test('broken input is carried exactly, not "fixed" on the way', async () => {
  const text = "{'a': 1, // comment\n b: True,}";
  assert.deepStrictEqual(await share.decode(await share.encode([text])), [text]);
});

test('compresses typical JSON well', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: 'user ' + i, active: i % 2 === 0, role: 'member' }));
  const text = JSON.stringify(rows, null, 2);
  const fragment = await share.encode([text]);
  assert.ok(fragment.length < text.length / 5, fragment.length + ' chars for ' + text.length);
});

test('recognises share fragments and nothing else', async () => {
  assert.strictEqual(share.isShare('#share=1.abc'), true);
  assert.strictEqual(share.isShare('share=1.abc'), true);
  assert.strictEqual(share.isShare('#section-2'), false);
  assert.strictEqual(share.isShare(''), false);
});

test('a truncated link is reported as damaged', async () => {
  const fragment = await share.encode([JSON.stringify({ hello: 'world'.repeat(50) })]);
  await rejectsWith(share.decode(fragment.slice(0, fragment.length - 12)), /damaged|incomplete/);
});

test('garbage is reported as damaged', async () => {
  await rejectsWith(share.decode('#share=1.!!!not-base64!!!'));
  await rejectsWith(share.decode('#share=1.AAAA'));
  await rejectsWith(share.decode('#share=1'));
  await rejectsWith(share.decode('#nope'));
});

test('a link from a future version says so', async () => {
  await rejectsWith(share.decode('#share=9.AAAA'), /newer version/);
});

test('valid compression of the wrong shape is rejected', async () => {
  for (const payload of ['{"a":1}', '[]', '[1]', '["a","b","c"]', 'not json']) {
    const bytes = new Uint8Array(await new Response(
      new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const b64 = Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await rejectsWith(share.decode('share=1.' + b64));
  }
});

test('a decompression bomb is stopped at 50MB', async () => {
  // ~60MB of zeros deflates to a few dozen kilobytes.
  const zeros = new Uint8Array(60 * 1024 * 1024);
  const bytes = new Uint8Array(await new Response(
    new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const b64 = Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.ok(b64.length < 200 * 1024, 'the bomb itself is small: ' + b64.length);
  await rejectsWith(share.decode('share=1.' + b64), /50MB/);
});

(async () => {
  console.log('share links');
  for (const { name, fn } of tests) {
    const started = Date.now();
    await fn();
    passed++;
    console.log(`  ok  ${name} (${Date.now() - started}ms)`);
  }
  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
