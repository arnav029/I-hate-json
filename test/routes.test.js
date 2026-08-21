/*
 * Boots the real server on an ephemeral port and checks the things a crawler
 * cares about: one URL per tool, unique metadata, canonical tags, redirects,
 * robots and sitemap.
 */
'use strict';

const assert = require('assert');
const http = require('http');

process.env.SITE_ORIGIN = 'https://www.ihatejson.com';
const { server } = require('../server');
const { routes } = require('../routes');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const pick = (html, re) => { const m = re.exec(html); return m && m[1]; };

test('every tool has its own URL with unique title, description and h1', async (port) => {
  const seen = { title: new Set(), description: new Set(), h1: new Set() };

  for (const route of routes) {
    const res = await get(port, route.path);
    assert.strictEqual(res.status, 200, route.path);

    const title = pick(res.body, /<title>([\s\S]*?)<\/title>/);
    const description = pick(res.body, /<meta name="description" content="([\s\S]*?)">/);
    const h1 = pick(res.body, /<h1 id="page-title">([\s\S]*?)<\/h1>/);

    assert.ok(title && title.length > 20 && title.length < 70, route.path + ' title length: ' + title);
    assert.ok(description && description.length > 80 && description.length < 200, route.path + ' description length');
    assert.ok(h1, route.path + ' has an h1');
    assert.ok(!/I Hate JSON/.test(h1), 'the h1 carries keywords, not just the brand');

    seen.title.add(title);
    seen.description.add(description);
    seen.h1.add(h1);
  }

  assert.strictEqual(seen.title.size, routes.length, 'titles are unique');
  assert.strictEqual(seen.description.size, routes.length, 'descriptions are unique');
  assert.strictEqual(seen.h1.size, routes.length, 'headings are unique');
});

test('each page canonicalises to itself on the canonical origin', async (port) => {
  for (const route of routes) {
    const res = await get(port, route.path);
    const canonical = pick(res.body, /<link rel="canonical" href="([^"]+)">/);
    assert.strictEqual(canonical, 'https://www.ihatejson.com' + route.path);
  }
});

test('each page carries social tags and valid structured data', async (port) => {
  for (const route of routes) {
    const res = await get(port, route.path);
    assert.ok(/property="og:title"/.test(res.body), route.path + ' og:title');
    assert.ok(/name="twitter:card"/.test(res.body), route.path + ' twitter:card');

    const json = pick(res.body, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const data = JSON.parse(json);
    assert.strictEqual(data.length, 2);
    assert.strictEqual(data[0]['@type'], 'SoftwareApplication');
    assert.strictEqual(data[1]['@type'], 'FAQPage');
    assert.ok(data[1].mainEntity.length >= 4, route.path + ' has at least four FAQ entries');
    assert.ok(data[1].mainEntity.every((q) => q.name && q.acceptedAnswer.text), 'every FAQ entry is complete');
  }
});

test('each page carries enough copy to be indexable', async (port) => {
  for (const route of routes) {
    const res = await get(port, route.path);
    const words = res.body
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/).filter(Boolean).length;
    assert.ok(words > 300, route.path + ' only has ' + words + ' words');
  }
});

test('the tools link to each other', async (port) => {
  for (const route of routes) {
    const res = await get(port, route.path);
    for (const other of routes) {
      assert.ok(res.body.includes('href="' + other.path + '"'), route.path + ' links to ' + other.path);
    }
    assert.ok(/rail-item is-active/.test(res.body), route.path + ' marks its own rail item active');
    assert.strictEqual((res.body.match(/aria-current="page"/g) || []).length, 1, 'exactly one active item');
  }
});

test('duplicate URLs redirect to the canonical one', async (port) => {
  for (const [from, to] of [['/json-formatter', '/'], ['/index.html', '/'], ['/json-diff/', '/json-diff']]) {
    const res = await get(port, from);
    assert.strictEqual(res.status, 301, from);
    assert.strictEqual(res.headers.location, to, from);
  }
});

test('robots.txt points at the sitemap', async (port) => {
  const res = await get(port, '/robots.txt');
  assert.strictEqual(res.status, 200);
  assert.ok(/^User-agent: \*/m.test(res.body));
  assert.ok(res.body.includes('Sitemap: https://www.ihatejson.com/sitemap.xml'));
});

test('sitemap.xml lists every route once', async (port) => {
  const res = await get(port, '/sitemap.xml');
  assert.strictEqual(res.status, 200);
  assert.ok(/application\/xml/.test(res.headers['content-type']));

  const locations = (res.body.match(/<loc>([^<]+)<\/loc>/g) || []).map((l) => l.replace(/<\/?loc>/g, ''));
  assert.deepStrictEqual(locations, routes.map((r) => 'https://www.ihatejson.com' + r.path));
});

test('static assets and unknown paths still behave', async (port) => {
  const app = await get(port, '/app.js');
  assert.strictEqual(app.status, 200);
  assert.ok(/javascript/.test(app.headers['content-type']));

  const missing = await get(port, '/nope');
  assert.strictEqual(missing.status, 404);

  const traversal = await get(port, '/%2e%2e/server.js');
  assert.ok(traversal.status === 400 || traversal.status === 404, 'traversal blocked');
});

test('html is gzipped and revalidates', async (port) => {
  const res = await get(port, '/', { 'accept-encoding': 'gzip' });
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.strictEqual(res.headers['cache-control'], 'no-cache');
  assert.ok(res.headers.etag, 'has an ETag');

  const cached = await get(port, '/', { 'if-none-match': res.headers.etag });
  assert.strictEqual(cached.status, 304);
});

(async function main() {
  console.log('routes + seo');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    for (const { name, fn } of tests) {
      const started = Date.now();
      await fn(port);
      passed++;
      console.log(`  ok  ${name} (${Date.now() - started}ms)`);
    }
    console.log(`\n${passed} passing`);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
