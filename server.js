/*
 * Minimal static file server, plus the small amount of server-side rendering
 * that makes each module a real URL: title, description, heading, canonical,
 * social tags, structured data and page copy are substituted per route.
 *
 * Still zero dependencies — nothing to audit, nothing to install.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { routes, notFound, redirects, byPath } = require('./routes');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');
const TEMPLATE = path.join(ROOT, 'index.html');
const ORIGIN = (process.env.SITE_ORIGIN || 'https://www.ihatejson.com').replace(/\/$/, '');
// Set to redirect every other host to the canonical one. Off by default so
// localhost and preview deploys keep working.
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

const COMPRESSIBLE = /^(text\/|application\/(json|xml|manifest\+json)|image\/svg)/;

/*
 * The privacy claim is the product, so the browser is asked to enforce it rather
 * than being trusted to take our word for it: connect-src 'none' means no script
 * on this origin can open a fetch, XHR, WebSocket or beacon to anywhere at all.
 * Even a compromised server could not exfiltrate what someone pasted.
 *
 * data: is allowed for images only — the favicon is an inline SVG.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), usb=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

// Browsers ignore HSTS over plain HTTP, but sending it there is still noise —
// and on localhost a proxy could make it stick. Only announce it on real TLS.
function secure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !!(req.socket && req.socket.encrypted);
}

function baseHeaders(req) {
  const headers = Object.assign({}, SECURITY_HEADERS);
  if (secure(req)) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/* ── asset versioning ────────────────────────────────────── */

/*
 * Every asset the page references carries a content hash in its query string, so
 * it can be cached for a year and still change the instant the file does. Hashes
 * are recomputed when a file's mtime moves, which keeps edit-and-reload working
 * without introducing a build step.
 */
const CORES = ['formatter.js', 'csv.js', 'diff.js'];
const WORKER_ASSETS = ['format-worker.js'].concat(CORES);

const versions = new Map();

function assetVersion(name) {
  let stat;
  try {
    stat = fs.statSync(path.join(ROOT, name));
  } catch (err) {
    return '';
  }

  const cachedEntry = versions.get(name);
  if (cachedEntry && cachedEntry.mtimeMs === stat.mtimeMs) return cachedEntry.digest;

  const digest = crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(ROOT, name)))
    .digest('hex').slice(0, 8);
  versions.set(name, { mtimeMs: stat.mtimeMs, digest: digest });
  return digest;
}

function versioned(name) {
  const digest = assetVersion(name);
  return digest ? name + '?v=' + digest : name;
}

// Handed to the page as one attribute so app.js can version the worker, and the
// worker can version its own importScripts — no inline script, so the CSP above
// needs no nonce and no 'unsafe-inline'.
function assetManifest() {
  return WORKER_ASSETS
    .map(function (name) { return name + ':' + assetVersion(name); })
    .filter(function (pair) { return !/:$/.test(pair); })
    .join(',');
}

/* ── rendering ───────────────────────────────────────────── */

let cached = { mtimeMs: 0, html: '' };

function template() {
  const stat = fs.statSync(TEMPLATE);
  if (stat.mtimeMs !== cached.mtimeMs) {
    cached = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(TEMPLATE, 'utf8') };
  }
  return cached.html;
}

function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function faqHtml(faq) {
  return '<h2>Questions</h2>' + faq.map(function (entry) {
    return '<h3>' + entry.q + '</h3><p>' + entry.a + '</p>';
  }).join('');
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function structuredData(route, url) {
  const application = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: route.title.split('—')[0].trim(),
    url: url,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any browser',
    description: route.description,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    isAccessibleForFree: true,
    browserRequirements: 'Requires JavaScript and Web Workers'
  };

  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: route.faq.map(function (entry) {
      return {
        '@type': 'Question',
        name: stripTags(entry.q),
        acceptedAnswer: { '@type': 'Answer', text: stripTags(entry.a) }
      };
    })
  };

  // A closing script tag inside JSON would end the block early.
  return JSON.stringify([application, faq]).replace(/<\//g, '<\\/');
}

function socialImage(route) {
  return ORIGIN + '/og/' + route.module + '.png';
}

function head(route, url) {
  const shared = [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="I Hate JSON">',
    '<meta property="og:title" content="' + escapeAttr(route.title) + '">',
    '<meta property="og:description" content="' + escapeAttr(route.description) + '">'
  ];

  // A 404 gets social tags so a shared bad link still reads sensibly, but no
  // canonical and no structured data — there is nothing here to index.
  if (route.noindex) {
    return ['<meta name="robots" content="noindex, follow">'].concat(shared).join('\n');
  }

  return [
    '<link rel="canonical" href="' + url + '">',
    '<meta name="keywords" content="' + escapeAttr(route.keywords) + '">'
  ].concat(shared, [
    '<meta property="og:url" content="' + url + '">',
    '<meta property="og:image" content="' + socialImage(route) + '">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="' + escapeAttr(route.heading) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + escapeAttr(route.title) + '">',
    '<meta name="twitter:description" content="' + escapeAttr(route.description) + '">',
    '<meta name="twitter:image" content="' + socialImage(route) + '">',
    '<script type="application/ld+json">' + structuredData(route, url) + '</script>'
  ]).join('\n');
}

function nav() {
  return '<nav class="prose-nav" aria-label="Other tools">' + routes.map(function (route) {
    return '<a href="' + route.path + '">' + route.title.split('—')[0].trim() + '</a>';
  }).join('') + '</nav>';
}

function render(route) {
  const url = ORIGIN + route.path;

  return template()
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + escapeAttr(route.title) + '</title>')
    .replace(/(<meta name="description" content=")[\s\S]*?(">)/, '$1' + escapeAttr(route.description) + '$2')
    .replace('<!--HEAD-->', head(route, url))
    .replace('href="styles.css"', 'href="' + versioned('styles.css') + '"')
    .replace('src="app.js"', 'src="' + versioned('app.js') + '"')
    .replace('<body>', '<body data-module="' + route.module + '" data-assets="' + assetManifest() + '">')
    .replace(/(<h1 id="page-title">)[\s\S]*?(<\/h1>)/, '$1' + route.heading + '$2')
    .replace('<a class="rail-item" href="' + route.path + '"',
      '<a class="rail-item is-active" aria-current="page" href="' + route.path + '"')
    .replace('<!--CONTENT-->',
      '<section class="prose">' + route.content +
      (route.faq ? faqHtml(route.faq) : '') + nav() + '</section>');
}

function robots() {
  return ['User-agent: *', 'Allow: /', 'Disallow: /_', '', 'Sitemap: ' + ORIGIN + '/sitemap.xml', ''].join('\n');
}

function sitemap() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    routes.map(function (route) {
      return '  <url><loc>' + ORIGIN + route.path + '</loc><lastmod>' + route.updated +
        '</lastmod><changefreq>monthly</changefreq><priority>' +
        (route.path === '/' ? '1.0' : '0.8') + '</priority></url>';
    }).join('\n') +
    '\n</urlset>\n';
}

/* ── serving ─────────────────────────────────────────────── */

function send(req, res, status, body, headers) {
  const buffer = Buffer.from(body);
  res.writeHead(status, Object.assign({ 'Content-Length': buffer.length }, baseHeaders(req), headers));
  res.end(buffer);
}

function sendText(req, res, body, type, extra, status) {
  const buffer = Buffer.from(body);
  const etag = '"' + buffer.length.toString(16) + '-' + hash(buffer) + '"';
  const headers = Object.assign({ 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' },
    baseHeaders(req), extra || {});

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const payload = gzip ? zlib.gzipSync(buffer) : buffer;

  if (gzip) {
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = payload.length;

  res.writeHead(status || 200, headers);
  // HEAD must report the same headers a GET would, encoded length included.
  if (req.method === 'HEAD') return res.end();
  res.end(payload);
}

function hash(buffer) {
  let value = 0;
  for (let i = 0; i < buffer.length; i++) value = (value * 31 + buffer[i]) >>> 0;
  return value.toString(16);
}

function redirect(req, res, location, status) {
  res.writeHead(status || 301, Object.assign({ Location: location, 'Content-Length': 0 }, baseHeaders(req)));
  res.end();
}

function resolveRequestPath(pathname) {
  const filePath = path.join(ROOT, pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
  return filePath;
}

// A ?v= that still matches the file's content can be cached for a year: the URL
// changes the moment the file does. A stale or absent one revalidates instead.
function cacheControl(pathname, query) {
  const match = /(?:^|&)v=([^&]*)/.exec(query);
  if (!match) return 'no-cache';
  const digest = assetVersion(pathname.replace(/^\//, ''));
  return digest && match[1] === digest ? 'public, max-age=31536000, immutable' : 'no-cache';
}

function notFoundPage(req, res) {
  return sendText(req, res, render(notFound), TYPES['.html'], { 'X-Robots-Tag': 'noindex' }, 404);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  }

  const split = req.url.indexOf('?');
  const query = split === -1 ? '' : req.url.slice(split + 1);

  let pathname;
  try {
    pathname = decodeURIComponent(split === -1 ? req.url : req.url.slice(0, split));
  } catch (err) {
    return send(req, res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });
  }

  if (CANONICAL_HOST && req.headers.host && req.headers.host !== CANONICAL_HOST) {
    return redirect(req, res, 'https://' + CANONICAL_HOST + req.url);
  }

  // One URL per page: no trailing-slash or .html duplicates for crawlers to split over.
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return redirect(req, res, pathname.replace(/\/+$/, '') || '/');
  }
  if (redirects[pathname]) return redirect(req, res, redirects[pathname]);

  if (byPath[pathname]) return sendText(req, res, render(byPath[pathname]), TYPES['.html']);
  if (pathname === '/robots.txt') return sendText(req, res, robots(), TYPES['.txt']);
  if (pathname === '/sitemap.xml') return sendText(req, res, sitemap(), TYPES['.xml']);

  const filePath = resolveRequestPath(pathname);
  if (!filePath) return send(req, res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFoundPage(req, res);

    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
    const headers = Object.assign(
      { 'Content-Type': type, ETag: etag, 'Cache-Control': cacheControl(pathname, query) },
      baseHeaders(req));

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.test(type);
    if (gzip) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    } else {
      headers['Content-Length'] = stat.size;
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      return res.end();
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) send(req, res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
      else res.destroy();
    });

    res.writeHead(200, headers);
    if (gzip) stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`i-hate-json serving ${ROOT} on http://${HOST}:${PORT} (canonical ${ORIGIN})`);
  });

  // Railway sends SIGTERM on redeploy; exit cleanly so deploys are not held open.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { server, render, robots, sitemap };
