/*
 * Renders the whole site to dist/ as plain files, so it can be served from a
 * CDN edge instead of one box. Everything server.js does per request — the
 * per-route HTML, the 404, robots, the sitemap, the service worker — happens
 * once here, and the headers server.js sends become a _headers file.
 *
 * Nothing about `npm start` changes: this is an alternative way to ship the
 * same output, not a build step the dev loop depends on.
 *
 *   node build.js            -> dist/
 *   SITE_ORIGIN=... node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { render, robots, sitemap, serviceWorker, headers } = require('./server');
const { routes, notFound, redirects } = require('./routes');

const ROOT = path.join(__dirname, 'public');
const DIST = path.join(__dirname, 'dist');

// Everything the browser is meant to reach. index.html is a template rendered
// per route, and sw.js needs its precache list substituted, so neither is copied.
const ASSETS = ['styles.css', 'app.js', 'format-worker.js', 'formatter.js', 'csv.js',
  'diff.js', 'manifest.webmanifest'];
const ASSET_DIRS = ['og', 'icons'];

function write(relative, contents) {
  const target = path.join(DIST, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return Buffer.byteLength(contents);
}

// '/' -> index.html, '/json-to-csv' -> json-to-csv.html. Cloudflare Pages and
// Netlify both serve those at the extensionless URL, which is the canonical one.
function pageFor(routePath) {
  return routePath === '/' ? 'index.html' : routePath.replace(/^\//, '') + '.html';
}

function headersFile() {
  const shared = headers({ headers: {}, socket: { encrypted: true } });
  const lines = ['/*'];

  for (const [name, value] of Object.entries(shared)) lines.push('  ' + name + ': ' + value);
  lines.push('  Cache-Control: no-cache', '');

  // Assets carry a content hash in the query string, so the bytes behind a given
  // URL never change and a year is safe.
  // The manifest is referenced without a hash, so it stays on revalidation.
  for (const glob of ['/*.js', '/*.css']) {
    lines.push(glob, '  Cache-Control: public, max-age=31536000, immutable', '');
  }
  for (const glob of ['/og/*', '/icons/*']) {
    lines.push(glob, '  Cache-Control: public, max-age=604800', '');
  }

  // Must come after /*.js so it wins: the worker revalidates every load, which
  // is what keeps its kill switch able to reach anyone who has it installed.
  lines.push('/sw.js',
    '  Cache-Control: no-cache',
    '  Content-Security-Policy: ' + headers({ headers: {}, socket: {} }, true)['Content-Security-Policy'],
    '');

  return lines.join('\n');
}

function redirectsFile() {
  return Object.entries(redirects)
    .map(([from, to]) => from + ' ' + to + ' 301')
    .join('\n') + '\n';
}

function copy(relative) {
  const source = path.join(ROOT, relative);
  if (!fs.existsSync(source)) return 0;
  const target = path.join(DIST, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return fs.statSync(target).size;
}

function build() {
  fs.rmSync(DIST, { recursive: true, force: true });

  let bytes = 0;
  let files = 0;

  for (const route of routes) {
    bytes += write(pageFor(route.path), render(route));
    files++;
  }

  // Both hosts serve this automatically for anything that does not resolve.
  bytes += write('404.html', render(notFound));
  bytes += write('robots.txt', robots());
  bytes += write('sitemap.xml', sitemap());
  bytes += write('sw.js', serviceWorker());
  bytes += write('_headers', headersFile());
  bytes += write('_redirects', redirectsFile());
  files += 6;

  for (const asset of ASSETS) {
    bytes += copy(asset);
    files++;
  }

  for (const dir of ASSET_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      bytes += copy(path.join(dir, name));
      files++;
    }
  }

  return { files, bytes };
}

if (require.main === module) {
  const { files, bytes } = build();
  console.log('built dist/ — ' + files + ' files, ' + (bytes / 1024).toFixed(1) + ' KB');
  console.log('deploy it to any static host; _headers and _redirects cover ' +
    'Cloudflare Pages and Netlify.');
}

module.exports = { build, pageFor };
