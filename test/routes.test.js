/*
 * Boots the real server on an ephemeral port and checks the things a crawler
 * cares about: one URL per tool, unique metadata, canonical tags, redirects,
 * robots and sitemap.
 */
'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.SITE_ORIGIN = 'https://www.ihatejson.com';
const { server } = require('../server');
const { routes } = require('../routes');
const { pageFor } = require('../build');

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
    assert.strictEqual(data[0]['@type'], route.article ? 'TechArticle' : 'SoftwareApplication');
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
    if (!route.article) {
      assert.ok(/rail-item is-active/.test(res.body), route.path + ' marks its own rail item active');
      assert.strictEqual((res.body.match(/aria-current="page"/g) || []).length, 1, 'exactly one active item');
    }
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

test('the privacy claim is enforced by a CSP, not just stated', async (port) => {
  const res = await get(port, '/');
  const csp = res.headers['content-security-policy'];

  assert.ok(csp, 'sends a CSP');
  // The whole point: no script on this origin can send anything anywhere.
  assert.ok(/connect-src 'none'/.test(csp), 'connect-src is none');
  assert.ok(/default-src 'self'/.test(csp), 'default-src is self');
  assert.ok(/worker-src 'self'/.test(csp), 'workers are still allowed');
  assert.ok(/img-src 'self' data:/.test(csp), 'the inline SVG favicon still loads');
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'no escape hatches');

  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
  assert.ok(/camera=\(\)/.test(res.headers['permissions-policy']), 'permissions are denied');
  assert.strictEqual(res.headers['cross-origin-opener-policy'], 'same-origin');
  // Browsers ignore HSTS over plain HTTP, so it is not announced there.
  assert.ok(!res.headers['strict-transport-security'], 'no HSTS without TLS');
});

test('every input and output pane has an accessible name', async (port) => {
  for (const route of routes) {
    const res = await get(port, route.path);
    for (const id of ['input', 'a-text', 'b-text']) {
      const tag = new RegExp('<textarea id="' + id + '"[^>]*>').exec(res.body);
      assert.ok(tag, route.path + ' has #' + id);
      assert.ok(/aria-label="[^"]+"/.test(tag[0]), route.path + ' #' + id + ' is labelled');
    }
    assert.ok(/<a class="skip-link" href="#input-panel">/.test(res.body), route.path + ' has a skip link');
    assert.ok(/id="input-panel" tabindex="-1"/.test(res.body), route.path + ' skip target takes focus');
  }
});

test('every page has a share card that exists on disk', async (port) => {
  const seen = new Set();

  for (const route of routes) {
    const res = await get(port, route.path);
    const image = pick(res.body, /<meta property="og:image" content="([^"]+)">/);

    assert.ok(image, route.path + ' has an og:image');
    assert.ok(/name="twitter:card" content="summary_large_image"/.test(res.body),
      route.path + ' asks for a large card');

    const file = path.join(__dirname, '..', 'public', image.replace(/^https?:\/\/[^/]+/, ''));
    assert.ok(fs.existsSync(file), 'missing card: ' + file + ' (regenerate with tools/og.html)');
    assert.ok(fs.statSync(file).size > 1024, image + ' looks empty');

    seen.add(image);
  }

  assert.strictEqual(seen.size, routes.length, 'each tool has its own card');
});

test('assets are versioned and cached only when the version matches', async (port) => {
  const home = await get(port, '/');
  const version = pick(home.body, /src="app\.js\?v=([a-f0-9]+)"/);
  assert.ok(version, 'app.js is referenced with a content hash');
  assert.ok(/href="styles\.css\?v=[a-f0-9]+"/.test(home.body), 'so is styles.css');

  // The worker and its cores are versioned through a body attribute rather than
  // an inline script, which is what lets the CSP stay nonce-free.
  const manifest = pick(home.body, /data-assets="([^"]+)"/);
  assert.ok(manifest, 'the page carries an asset manifest');
  for (const name of ['format-worker.js', 'formatter.js', 'csv.js', 'diff.js']) {
    assert.ok(new RegExp(name + ':[a-f0-9]+').test(manifest), manifest + ' covers ' + name);
  }

  const matched = await get(port, '/app.js?v=' + version);
  assert.strictEqual(matched.headers['cache-control'], 'public, max-age=31536000, immutable');

  const stale = await get(port, '/app.js?v=00000000');
  assert.strictEqual(stale.headers['cache-control'], 'no-cache', 'a stale hash revalidates');

  const bare = await get(port, '/app.js');
  assert.strictEqual(bare.headers['cache-control'], 'no-cache', 'an unversioned URL revalidates');
});

test('an unknown URL gets a real page, not nine bytes of plain text', async (port) => {
  const res = await get(port, '/json-fromatter');

  assert.strictEqual(res.status, 404);
  assert.ok(/text\/html/.test(res.headers['content-type']), 'renders HTML');
  assert.strictEqual(res.headers['x-robots-tag'], 'noindex');
  assert.ok(/<meta name="robots" content="noindex, follow">/.test(res.body));
  assert.ok(!/rel="canonical"/.test(res.body), 'a 404 does not canonicalise itself');
  assert.ok(!/application\/ld\+json/.test(res.body), 'and carries no structured data');

  for (const route of routes) {
    assert.ok(res.body.includes('href="' + route.path + '"'), '404 links to ' + route.path);
  }
});

test('sitemap dates come from the content, not the clock', async (port) => {
  const res = await get(port, '/sitemap.xml');
  const dates = (res.body.match(/<lastmod>([^<]+)<\/lastmod>/g) || [])
    .map((d) => d.replace(/<\/?lastmod>/g, ''));

  assert.strictEqual(dates.length, routes.length);
  assert.deepStrictEqual(dates, routes.map((r) => r.updated));

  assert.ok(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), 'dates are well formed');

  // Comparing against today only catches new Date() on days nobody edited, so
  // move a route's date and check the sitemap actually follows it.
  const route = routes[0];
  const original = route.updated;
  route.updated = '2019-03-04';
  try {
    const moved = await get(port, '/sitemap.xml');
    assert.ok(moved.body.includes('<lastmod>2019-03-04</lastmod>'),
      'lastmod comes from the route table, not the clock');
  } finally {
    route.updated = original;
  }
});

test('the service worker precaches every route and asset', async (port) => {
  const res = await get(port, '/sw.js');

  assert.strictEqual(res.status, 200);
  assert.ok(/javascript/.test(res.headers['content-type']));
  // Revalidated every load, which is the only reason the kill switch can reach
  // anyone who already has it installed.
  assert.strictEqual(res.headers['cache-control'], 'no-cache');

  // Its own context, its own policy: connect-src 'none' would stop it filling
  // its cache, so it gets 'self' while every other script keeps 'none'.
  const csp = res.headers['content-security-policy'];
  assert.ok(/connect-src 'self'/.test(csp), 'the worker may fetch same-origin');
  assert.ok(!/connect-src 'none'/.test(csp));
  assert.ok(/default-src 'self'/.test(csp), 'and nothing cross-origin');

  const manifest = JSON.parse(/^var MANIFEST = (.*);$/m.exec(res.body)[1]);
  assert.strictEqual(manifest.disabled, false);
  assert.ok(/^[a-f0-9]{12}$/.test(manifest.version), 'version is derived from the hashes');

  for (const route of routes) {
    assert.ok(manifest.precache.includes(route.path), 'precaches ' + route.path);
  }
  for (const name of ['styles.css', 'app.js', 'format-worker.js', 'formatter.js', 'csv.js', 'diff.js']) {
    assert.ok(manifest.precache.some((url) => url.startsWith('/' + name + '?v=')),
      'precaches a versioned ' + name);
  }

  // Every precached URL has to actually resolve, or install() fails wholesale.
  for (const url of manifest.precache) {
    assert.strictEqual((await get(port, url)).status, 200, 'precache entry 404s: ' + url);
  }
});

test('the service worker can be switched off from the environment', async (port) => {
  process.env.SW_DISABLED = '1';
  try {
    const res = await get(port, '/sw.js');
    const manifest = JSON.parse(/^var MANIFEST = (.*);$/m.exec(res.body)[1]);
    assert.strictEqual(manifest.disabled, true);
    assert.deepStrictEqual(manifest.precache, []);
    // It has to take over before it can retire itself, or it sits waiting forever.
    assert.ok(/MANIFEST\.disabled[\s\S]{0,160}skipWaiting/.test(res.body),
      'a disabled worker skips waiting so activate runs');
    assert.ok(/unregister\(\)/.test(res.body), 'and unregisters');
  } finally {
    delete process.env.SW_DISABLED;
  }
});

test('the article stands alone from the tools', async (port) => {
  const article = routes.find((route) => route.article);
  assert.ok(article, 'there is an article route');

  const res = await get(port, article.path);
  assert.ok(/data-layout="article"/.test(res.body), 'renders in the article layout');

  // Every factual claim on that page is attributed, so the sources have to be there.
  for (const host of ['labs.watchtowr.com', 'thehackernews.com', 'csoonline.com', 'securityaffairs.com']) {
    assert.ok(res.body.includes(host), 'cites ' + host);
  }

  // It is the destination for the header badge on every tool page.
  for (const tool of routes.filter((route) => !route.article)) {
    const page = await get(port, tool.path);
    assert.ok(/class="privacy-badge" href="\/json-privacy"/.test(page.body),
      tool.path + ' links its privacy badge to the article');
  }

  const words = res.body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ')
    .split(/\s+/).filter(Boolean).length;
  assert.ok(words > 800, 'the article is substantial, got ' + words);
});

test('the app is installable', async (port) => {
  const res = await get(port, '/manifest.webmanifest');
  assert.strictEqual(res.status, 200);
  assert.ok(/manifest\+json/.test(res.headers['content-type']));

  const manifest = JSON.parse(res.body);
  assert.strictEqual(manifest.start_url, '/');
  assert.ok(manifest.name && manifest.icons.length >= 2);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon');

  for (const icon of manifest.icons) {
    const file = await get(port, icon.src);
    assert.strictEqual(file.status, 200, 'missing icon: ' + icon.src);
  }

  const home = await get(port, '/');
  assert.ok(/<link rel="manifest" href="\/manifest.webmanifest">/.test(home.body));
  assert.ok(/name="theme-color"[^>]*prefers-color-scheme: dark/.test(home.body),
    'theme-color follows the scheme');
  assert.strictEqual((await get(port, '/icons/apple-touch-icon.png')).status, 200);
});

test('text is served brotli when the browser takes it', async (port) => {
  const br = await get(port, '/app.js', { 'accept-encoding': 'br, gzip' });
  assert.strictEqual(br.headers['content-encoding'], 'br');
  assert.strictEqual(br.headers.vary, 'Accept-Encoding');

  const gzip = await get(port, '/app.js', { 'accept-encoding': 'gzip' });
  assert.strictEqual(gzip.headers['content-encoding'], 'gzip');
  assert.ok(Number(br.headers['content-length']) < Number(gzip.headers['content-length']),
    'brotli is the smaller of the two');

  const plain = await get(port, '/app.js', { 'accept-encoding': 'identity' });
  assert.ok(!plain.headers['content-encoding'], 'and nothing is forced on a client that declined');

  // Images are already compressed; running them through brotli is wasted work.
  const png = await get(port, '/og/formatter.png', { 'accept-encoding': 'br, gzip' });
  assert.ok(!png.headers['content-encoding'], 'images stream uncompressed');
});

test('the static build covers everything the server serves', async (port) => {
  const { build } = require('../build');
  const dist = path.join(__dirname, '..', 'dist');
  build();

  for (const route of routes) {
    const file = path.join(dist, pageFor(route.path));
    assert.ok(fs.existsSync(file), 'built ' + route.path);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), (await get(port, route.path)).body,
      route.path + ' differs between the server and the build');
  }

  for (const name of ['404.html', 'robots.txt', 'sitemap.xml', 'sw.js', '_headers',
    '_redirects', 'app.js', 'styles.css', 'manifest.webmanifest']) {
    assert.ok(fs.existsSync(path.join(dist, name)), 'built ' + name);
  }

  const headers = fs.readFileSync(path.join(dist, '_headers'), 'utf8');
  assert.ok(/connect-src 'none'/.test(headers), 'carries the page CSP');
  assert.ok(/\/sw\.js\n(  .*\n)*  Content-Security-Policy: [^\n]*connect-src 'self'/.test(headers),
    'and the looser one for the worker');
  assert.ok(headers.indexOf('/*.js') < headers.indexOf('/sw.js'),
    'sw.js comes last so its no-cache wins');

  const redirects = fs.readFileSync(path.join(dist, '_redirects'), 'utf8');
  assert.ok(/^\/json-formatter \/ 301$/m.test(redirects));

  // The draft in public/ must never be published.
  assert.ok(!fs.existsSync(path.join(dist, '_draft-brutalist.html')), 'drafts stay out of dist');
});

test('static assets and unknown paths still behave', async (port) => {
  const app = await get(port, '/app.js');
  assert.strictEqual(app.status, 200);
  assert.ok(/javascript/.test(app.headers['content-type']));

  const missing = await get(port, '/nope');
  assert.strictEqual(missing.status, 404);
  assert.ok(missing.body.length > 1000, 'the 404 is a page, not a stub');

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
