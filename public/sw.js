/*
 * Makes the site work with no network at all, and makes a repeat visit cost
 * zero round trips. Everything the app needs is 25KB gzipped across seven
 * files, so the whole thing is precached rather than warmed lazily.
 *
 * MANIFEST is substituted by server.js (and build.js) with the content-hashed
 * URL of every asset plus every route. The version is derived from those
 * hashes, so a deploy names a new cache and the old one is dropped whole.
 *
 * Kill switch: serve a manifest with `disabled: true` and this unregisters
 * itself and clears its caches on the next load, returning every visitor to
 * plain network fetches. That is the rollback if a release ever goes wrong.
 */
'use strict';

var MANIFEST = { version: 'dev', precache: [], disabled: true }; /* replaced at serve time */

var CACHE = 'ihj-' + MANIFEST.version;

function retire() {
  return caches.keys()
    .then(function (names) {
      return Promise.all(names.map(function (name) { return caches.delete(name); }));
    })
    .then(function () { return self.registration.unregister(); });
}

self.addEventListener('install', function (event) {
  // A disabled worker still has to take over before it can retire: left waiting
  // behind the old one, activate never runs and nothing is ever cleaned up.
  if (MANIFEST.disabled) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(MANIFEST.precache); })
      // A precache miss must not wedge the install — the fetch handler falls
      // through to the network for anything it does not hold.
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  if (MANIFEST.disabled) {
    event.waitUntil(retire());
    return;
  }

  event.waitUntil(
    caches.keys()
      .then(function (names) {
        return Promise.all(names
          .filter(function (name) { return name !== CACHE && name.indexOf('ihj-') === 0; })
          .map(function (name) { return caches.delete(name); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function remember(request, response) {
  // Caching is best-effort: private mode and a full quota both reject here, and
  // neither is a reason to fail the request the visitor actually made.
  caches.open(CACHE)
    .then(function (cache) { return cache.put(request, response); })
    .catch(function () {});
}

// Pages revalidate so a deploy lands on the next navigation; the cached copy is
// only reached for when there is genuinely no network.
function networkFirst(request) {
  return fetch(request)
    .then(function (response) {
      if (response && response.ok) remember(request, response.clone());
      return response;
    })
    .catch(function () {
      return caches.match(request).then(function (hit) {
        // Any page of ours beats the browser's offline screen.
        return hit || caches.match('/');
      });
    });
}

// Assets carry a content hash, so a hit is always the right bytes.
function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        remember(request, response.clone());
      }
      return response;
    });
  });
}

self.addEventListener('fetch', function (event) {
  if (MANIFEST.disabled) return;

  var request = event.request;
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Nothing cross-origin is ever touched — there is nothing cross-origin to touch.
  if (url.origin !== self.location.origin) return;

  event.respondWith(request.mode === 'navigate' ? networkFirst(request) : cacheFirst(request));
});
