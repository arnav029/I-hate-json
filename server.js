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

const { routes, redirects, byPath } = require('./routes');

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

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

function head(route, url) {
  return [
    '<link rel="canonical" href="' + url + '">',
    '<meta name="keywords" content="' + escapeAttr(route.keywords) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="I Hate JSON">',
    '<meta property="og:url" content="' + url + '">',
    '<meta property="og:title" content="' + escapeAttr(route.title) + '">',
    '<meta property="og:description" content="' + escapeAttr(route.description) + '">',
    '<meta name="twitter:card" content="summary">',
    '<meta name="twitter:title" content="' + escapeAttr(route.title) + '">',
    '<meta name="twitter:description" content="' + escapeAttr(route.description) + '">',
    '<script type="application/ld+json">' + structuredData(route, url) + '</script>'
  ].join('\n');
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
    .replace('<body>', '<body data-module="' + route.module + '">')
    .replace(/(<h1 id="page-title">)[\s\S]*?(<\/h1>)/, '$1' + route.heading + '$2')
    .replace('<a class="rail-item" href="' + route.path + '"',
      '<a class="rail-item is-active" aria-current="page" href="' + route.path + '"')
    .replace('<!--CONTENT-->',
      '<section class="prose">' + route.content + faqHtml(route.faq) + nav() + '</section>');
}

function robots() {
  return ['User-agent: *', 'Allow: /', 'Disallow: /_', '', 'Sitemap: ' + ORIGIN + '/sitemap.xml', ''].join('\n');
}

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    routes.map(function (route) {
      return '  <url><loc>' + ORIGIN + route.path + '</loc><lastmod>' + today +
        '</lastmod><changefreq>monthly</changefreq><priority>' +
        (route.path === '/' ? '1.0' : '0.8') + '</priority></url>';
    }).join('\n') +
    '\n</urlset>\n';
}

/* ── serving ─────────────────────────────────────────────── */

function send(res, status, body, headers) {
  const buffer = Buffer.from(body);
  res.writeHead(status, Object.assign({ 'Content-Length': buffer.length }, SECURITY_HEADERS, headers));
  res.end(buffer);
}

function sendText(req, res, body, type, extra) {
  const buffer = Buffer.from(body);
  const etag = '"' + buffer.length.toString(16) + '-' + hash(buffer) + '"';
  const headers = Object.assign({ 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' },
    SECURITY_HEADERS, extra || {});

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, Object.assign({ 'Content-Length': buffer.length }, headers));
    return res.end();
  }

  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gzipped = zlib.gzipSync(buffer);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
    headers['Content-Length'] = gzipped.length;
    res.writeHead(200, headers);
    return res.end(gzipped);
  }

  headers['Content-Length'] = buffer.length;
  res.writeHead(200, headers);
  res.end(buffer);
}

function hash(buffer) {
  let value = 0;
  for (let i = 0; i < buffer.length; i++) value = (value * 31 + buffer[i]) >>> 0;
  return value.toString(16);
}

function redirect(res, location, status) {
  res.writeHead(status || 301, Object.assign({ Location: location, 'Content-Length': 0 }, SECURITY_HEADERS));
  res.end();
}

function resolveRequestPath(pathname) {
  const filePath = path.join(ROOT, pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split('?')[0]);
  } catch (err) {
    return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });
  }

  if (CANONICAL_HOST && req.headers.host && req.headers.host !== CANONICAL_HOST) {
    return redirect(res, 'https://' + CANONICAL_HOST + req.url);
  }

  // One URL per page: no trailing-slash or .html duplicates for crawlers to split over.
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return redirect(res, pathname.replace(/\/+$/, '') || '/');
  }
  if (redirects[pathname]) return redirect(res, redirects[pathname]);

  if (byPath[pathname]) return sendText(req, res, render(byPath[pathname]), TYPES['.html']);
  if (pathname === '/robots.txt') return sendText(req, res, robots(), TYPES['.txt']);
  if (pathname === '/sitemap.xml') return sendText(req, res, sitemap(), TYPES['.xml']);

  const filePath = resolveRequestPath(pathname);
  if (!filePath) return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
    const headers = Object.assign({ 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({ 'Content-Length': stat.size }, headers));
      return res.end();
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
      else res.destroy();
    });

    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.test(type)) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      res.writeHead(200, headers);
      stream.pipe(zlib.createGzip()).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      stream.pipe(res);
    }
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
