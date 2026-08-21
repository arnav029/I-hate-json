/*
 * Pure formatting core. Shared by the Web Worker (via importScripts) and by
 * the main thread, which uses it as a fallback when Workers are unavailable.
 * Deliberately free of DOM / Blob / Worker APIs so it can be unit-tested in Node.
 */
(function (global) {
  'use strict';

  var PREVIEW_LIMIT = 400000; // chars of formatted output we hand to the DOM

  // Number of bytes the string occupies as UTF-8, without allocating a copy of it
  // (TextEncoder would materialise a second 50MB buffer).
  function utf8ByteLength(str) {
    var bytes = 0;
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; } // surrogate pair
      else bytes += 3;
    }
    return bytes;
  }

  function countLines(str) {
    if (str.length === 0) return 0;
    var lines = 1;
    var idx = -1;
    while ((idx = str.indexOf('\n', idx + 1)) !== -1) lines++;
    return lines;
  }

  // Builds the excerpt shown under the error message: the offending line, plus a
  // caret. Long lines are windowed so one minified megabyte-long line cannot
  // blow up the UI.
  function excerptAt(text, pos, withCaret) {
    var lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    var lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;

    var line = text.slice(lineStart, lineEnd).replace(/\t/g, '    ');
    var caretAt = pos - lineStart;

    if (line.length > 120) {
      var from = Math.max(0, caretAt - 60);
      var to = Math.min(line.length, from + 120);
      line = (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : '');
      caretAt = caretAt - from + (from > 0 ? 1 : 0);
    }

    return {
      line: line,
      caret: withCaret ? Math.max(0, Math.min(caretAt, line.length)) : -1,
      lineNumber: countLines(text.slice(0, lineStart)) || 1,
      column: pos - lineStart + 1
    };
  }

  /*
   * Turn a JSON.parse failure into something a human can act on. V8 gives us two
   * different message shapes:
   *   "… in JSON at position 42 (line 3 column 8)"  → exact offset, easy
   *   "Unexpected token ',', ..."ctx"... is not valid JSON" → no offset, but the
   *      quoted context can be located in the source instead.
   * When the context (or the token inside it) is ambiguous we say "near line N"
   * rather than pointing confidently at the wrong place.
   */
  function describeParseError(err, text) {
    var raw = String(err && err.message ? err.message : err);
    var detail = { message: raw, line: null, column: null, snippet: null, approximate: false };
    var pos = null;

    var atPosition = /at position (\d+)/i.exec(raw);
    var context = /^Unexpected token (.+?), (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON$/.exec(raw);

    if (atPosition) {
      pos = Math.min(parseInt(atPosition[1], 10), Math.max(text.length - 1, 0));
      // Drop the position tail — we render it ourselves, more legibly.
      detail.message = raw.replace(/\s*in JSON at position \d+(\s*\(line \d+ column \d+\))?/i, '.');
    } else if (/Unexpected end of (JSON input|input)/i.test(raw)) {
      pos = Math.max(text.length - 1, 0);
      detail.message = 'The document ends before the JSON is complete — something is left unclosed.';
    } else if (context) {
      var token = context[1];
      var ctx = context[2];
      detail.message = 'Unexpected token ' + token + '.';

      if (ctx && text.indexOf(ctx) === text.lastIndexOf(ctx)) {
        var start = text.indexOf(ctx);
        if (start !== -1) {
          var ch = /^'([\s\S])'$/.exec(token);
          var at = ch ? ctx.indexOf(ch[1]) : -1;
          if (at !== -1 && at === ctx.lastIndexOf(ch[1])) {
            pos = start + at;              // the token appears once: exact hit
          } else {
            pos = start;                   // ambiguous: point at the region
            detail.approximate = true;
          }
        }
      }
    }

    if (pos === null || text.length === 0) return detail;

    var excerpt = excerptAt(text, pos, !detail.approximate);
    detail.line = excerpt.lineNumber;
    detail.column = detail.approximate ? null : excerpt.column;
    detail.snippet = { line: excerpt.line, caret: excerpt.caret };
    return detail;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>]/g, function (ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;';
    });
  }

  // Lightweight regex highlighter. Only ever runs over the preview slice, so it
  // stays cheap no matter how big the document is. Quotes are left unescaped on
  // purpose: escapeHtml() touches & < > only, so the string pattern still matches.
  var TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

  function highlight(str) {
    return escapeHtml(str).replace(TOKEN, function (whole, string, colon, literal, number) {
      if (string !== undefined) {
        if (colon) return '<span class="tok-key">' + string + '</span>' + colon;
        return '<span class="tok-str">' + string + '</span>';
      }
      if (literal !== undefined) return '<span class="tok-lit">' + literal + '</span>';
      return '<span class="tok-num">' + number + '</span>';
    });
  }

  function previewOf(formatted) {
    if (formatted.length <= PREVIEW_LIMIT) {
      return { text: formatted, truncated: false };
    }
    var cut = formatted.lastIndexOf('\n', PREVIEW_LIMIT);
    if (cut < PREVIEW_LIMIT / 2) cut = PREVIEW_LIMIT; // single enormous line
    return { text: formatted.slice(0, cut), truncated: true };
  }

  /**
   * Parse + pretty-print. Throws a plain object (not an Error) describing the
   * failure so it survives structured cloning back to the main thread.
   */
  function format(text, opts) {
    var indent = (opts && opts.indent) || 2;
    var onStage = (opts && opts.onStage) || function () {};

    if (text.trim() === '') {
      throw { kind: 'empty', message: 'Nothing to format yet — paste some JSON or drop a file in.' };
    }

    onStage('parsing');
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      var detail = describeParseError(err, text);
      detail.kind = 'parse';
      throw detail;
    }

    onStage('formatting');
    var formatted = JSON.stringify(parsed, null, indent);

    onStage('highlighting');
    var preview = previewOf(formatted);

    return {
      formatted: formatted,
      previewHtml: highlight(preview.text),
      truncated: preview.truncated,
      stats: {
        inputBytes: utf8ByteLength(text),
        outputBytes: utf8ByteLength(formatted),
        lines: countLines(formatted)
      }
    };
  }

  global.JSONFormatterCore = {
    format: format,
    highlight: highlight,
    escapeHtml: escapeHtml,
    countLines: countLines,
    utf8ByteLength: utf8ByteLength,
    describeParseError: describeParseError,
    PREVIEW_LIMIT: PREVIEW_LIMIT
  };
})(typeof self !== 'undefined' ? self : globalThis);
