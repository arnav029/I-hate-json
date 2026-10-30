/*
 * Shareable links with nothing stored anywhere. The input is deflated and put
 * in the URL fragment — the part after the #, which browsers never send in a
 * request — so the link does not point at the data, it *is* the data. There is
 * no server copy to leak, enumerate or delete, because there is no server copy.
 *
 * Loaded on demand: only when someone presses Share, or opens a shared link.
 * DOM-free, so the tests run it under Node.
 */
(function (global) {
  'use strict';

  var PREFIX = 'share=';
  var VERSION = '1';
  var MAX_INFLATED = 50 * 1024 * 1024; // same cap as everything else

  function supported() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  }

  function toBase64Url(bytes) {
    var binary = '';
    // Chunked: String.fromCharCode.apply overflows the stack on large arrays.
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    var binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Reads a stream to the end, refusing to go past `limit` bytes — a link is
  // untrusted input, and a few kilobytes can inflate to gigabytes.
  function collect(readable, limit) {
    var reader = readable.getReader();
    var chunks = [];
    var total = 0;

    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(total);
          var at = 0;
          chunks.forEach(function (chunk) { out.set(chunk, at); at += chunk.length; });
          return out;
        }
        total += step.value.length;
        if (total > limit) {
          reader.cancel().catch(function () {});
          throw damaged('This link holds more than 50MB of data, which is over the limit.');
        }
        chunks.push(step.value);
        return pump();
      });
    }
    return pump();
  }

  function through(bytes, transform, limit) {
    var source = new Blob([bytes]).stream().pipeThrough(transform);
    return collect(source, limit);
  }

  function damaged(message) {
    return { kind: 'share', message: message || 'This share link is damaged or incomplete — it may have been cut off when it was copied.' };
  }

  /**
   * texts: the module's inputs, in order (one for most tools, two for diff).
   * Resolves to the fragment, without the leading #.
   */
  function encode(texts) {
    var json = new TextEncoder().encode(JSON.stringify(texts));
    return through(json, new CompressionStream('deflate-raw'), Infinity).then(function (bytes) {
      return PREFIX + VERSION + '.' + toBase64Url(bytes);
    });
  }

  function isShare(hash) {
    return String(hash || '').replace(/^#/, '').indexOf(PREFIX) === 0;
  }

  /** Resolves to the array of texts, or rejects with a displayable error. */
  function decode(hash) {
    var body = String(hash || '').replace(/^#/, '');
    if (body.indexOf(PREFIX) !== 0) return Promise.reject(damaged());
    body = body.slice(PREFIX.length);

    var dot = body.indexOf('.');
    if (dot === -1) return Promise.reject(damaged());
    if (body.slice(0, dot) !== VERSION) {
      return Promise.reject(damaged('This link was made by a newer version of the site. Reload the page and try again.'));
    }

    var bytes;
    try {
      bytes = fromBase64Url(body.slice(dot + 1));
    } catch (err) {
      return Promise.reject(damaged());
    }

    return through(bytes, new DecompressionStream('deflate-raw'), MAX_INFLATED).then(function (inflated) {
      var texts;
      try {
        texts = JSON.parse(new TextDecoder().decode(inflated));
      } catch (err) {
        throw damaged();
      }
      var valid = Array.isArray(texts) && texts.length >= 1 && texts.length <= 2 &&
        texts.every(function (text) { return typeof text === 'string'; });
      if (!valid) throw damaged();
      return texts;
    }, function (err) {
      throw err && err.kind ? err : damaged();
    });
  }

  global.JSONShare = {
    supported: supported,
    encode: encode,
    decode: decode,
    isShare: isShare
  };
})(typeof self !== 'undefined' ? self : globalThis);
