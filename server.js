/*
 * Minimal static file server — the only reason this exists is that Railway
 * needs a process listening on $PORT. The app itself is pure static assets.
 * No dependencies on purpose: nothing to audit, nothing to install.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/;

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers));
  res.end(body);
}

function resolveRequestPath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0]);
  } catch (err) {
    return null; // malformed percent-encoding
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // path.join normalises away ../ segments; the prefix check is the backstop.
  const filePath = path.join(ROOT, pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
  }

  const filePath = resolveRequestPath(req.url);
  if (!filePath) return send(res, 400, 'Bad Request', { 'Content-Type': 'text/plain' });

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';

    const headers = {
      'Content-Type': type,
      ETag: etag,
      // Assets are unhashed, so always revalidate; 304s keep it cheap anyway.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({ 'Content-Length': stat.size }, headers));
      return res.end();
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) send(res, 500, 'Internal Server Error', { 'Content-Type': 'text/plain' });
      else res.destroy();
    });

    if (acceptsGzip && COMPRESSIBLE.test(type)) {
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

server.listen(PORT, HOST, () => {
  console.log(`i-hate-json serving ${ROOT} on http://${HOST}:${PORT}`);
});

// Railway sends SIGTERM on redeploy; exit cleanly so deploys are not held open.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
