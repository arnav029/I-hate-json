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
      column: pos - lineStart + 1,
      lineStart: lineStart,
      lineEnd: lineEnd
    };
  }

  function tokenLengthAt(text, pos) {
    var rest = text.slice(pos, pos + 256);
    if (!rest) return 0;
    if (rest.charAt(0) === '"') {
      var string = /^"(?:\\.|[^"\\\n])*"?/.exec(rest);
      return string ? string[0].length : 1;
    }
    var word = /^[\w+.\-]+/.exec(rest);
    return word ? word[0].length : 1;
  }

  var NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  var ESCAPES = '"\\/bfnrt';

  /*
   * Single pass over the grammar, returning the offset of the first construct
   * that cannot be parsed. Engine messages are only consulted for wording —
   * they carry no usable offset in half the cases, and the context window they
   * do carry is ambiguous on short documents.
   */
  function findErrorOffset(text) {
    var n = text.length;
    var i = 0;
    var stack = [];
    var state = 'value';
    var fail = -1;

    function atEnd() { return Math.max(0, n - 1); }

    function skipWhitespace() {
      while (i < n && ' \t\n\r'.indexOf(text.charAt(i)) !== -1) i++;
    }

    function scanString() {
      i++;
      while (i < n) {
        var ch = text.charAt(i);
        if (ch === '"') { i++; return true; }
        if (ch === '\\') {
          var esc = text.charAt(i + 1);
          if (esc && ESCAPES.indexOf(esc) !== -1) { i += 2; continue; }
          if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) { i += 6; continue; }
          fail = i;
          return false;
        }
        if (text.charCodeAt(i) < 0x20) { fail = i; return false; }
        i++;
      }
      fail = atEnd();
      return false;
    }

    function scanWord(word) {
      if (text.substr(i, word.length) === word) { i += word.length; return true; }
      fail = i;
      return false;
    }

    function scanNumber() {
      NUMBER.lastIndex = i;
      var match = NUMBER.exec(text);
      if (!match || match.index !== i) { fail = i; return false; }
      i += match[0].length;
      return true;
    }

    function scanScalar(ch) {
      if (ch === '"') return scanString();
      if (ch === 't') return scanWord('true');
      if (ch === 'f') return scanWord('false');
      if (ch === 'n') return scanWord('null');
      if (ch === '-' || (ch >= '0' && ch <= '9')) return scanNumber();
      fail = i;
      return false;
    }

    for (;;) {
      skipWhitespace();
      var ch = i < n ? text.charAt(i) : '';
      var here = i < n ? i : atEnd();

      if (state === 'value' || state === 'value-or-close') {
        if (state === 'value-or-close' && ch === ']') {
          i++; stack.pop(); state = 'after-value'; continue;
        }
        if (ch === '') { fail = here; return fail; }
        if (ch === '{') { i++; stack.push('object'); state = 'key-or-close'; continue; }
        if (ch === '[') { i++; stack.push('array'); state = 'value-or-close'; continue; }
        if (!scanScalar(ch)) return fail;
        state = 'after-value';
        continue;
      }

      if (state === 'key-or-close' && ch === '}') {
        i++; stack.pop(); state = 'after-value'; continue;
      }

      if (state === 'key' || state === 'key-or-close') {
        if (ch !== '"') { fail = here; return fail; }
        if (!scanString()) return fail;
        state = 'colon';
        continue;
      }

      if (state === 'colon') {
        if (ch !== ':') { fail = here; return fail; }
        i++;
        state = 'value';
        continue;
      }

      if (!stack.length) {
        if (i < n) { fail = i; return fail; }
        return -1;
      }

      var container = stack[stack.length - 1];
      if (ch === ',') {
        i++;
        state = container === 'object' ? 'key' : 'value';
        continue;
      }
      if (ch === (container === 'object' ? '}' : ']')) {
        i++; stack.pop();
        continue;
      }
      fail = here;
      return fail;
    }
  }

  function friendlyMessage(raw) {
    if (/Unexpected end of (JSON )?input/i.test(raw)) {
      return 'The document ends before the JSON is complete — something is left unclosed.';
    }
    var context = /^Unexpected token (.+?), (?:\.\.\.)?"[\s\S]*?"(?:\.\.\.)? is not valid JSON$/.exec(raw);
    if (context) return 'Unexpected token ' + context[1] + '.';
    return raw.replace(/\s*in JSON at position \d+(\s*\(line \d+ column \d+\))?/i, '.');
  }

  function describeParseError(err, text) {
    var raw = String(err && err.message ? err.message : err);
    var detail = { message: raw, line: null, column: null, snippet: null, range: null, approximate: false };
    var pos = findErrorOffset(text);

    if (pos < 0) {
      // The scanner and the engine disagree; fall back to the reported offset.
      var atPosition = /at position (\d+)/i.exec(raw);
      pos = atPosition ? Math.min(parseInt(atPosition[1], 10), Math.max(text.length - 1, 0)) : null;
    }

    if (pos === null || text.length === 0) return detail;

    detail.message = friendlyMessage(raw);

    var excerpt = excerptAt(text, pos, !detail.approximate);
    detail.line = excerpt.lineNumber;
    detail.column = detail.approximate ? null : excerpt.column;
    detail.snippet = { line: excerpt.line, caret: excerpt.caret };
    detail.range = detail.approximate
      ? { start: excerpt.lineStart, end: excerpt.lineEnd }
      : { start: pos, end: pos + tokenLengthAt(text, pos) };
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
  function parse(text) {
    if (text.trim() === '') {
      throw { kind: 'empty', message: 'Nothing here yet — paste some JSON or drop a file in.' };
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      var detail = describeParseError(err, text);
      detail.kind = 'parse';
      throw detail;
    }
  }

  function format(text, opts) {
    var indent = (opts && opts.indent) || 2;
    var onStage = (opts && opts.onStage) || function () {};

    onStage('parsing');
    var parsed = parse(text);

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
    parse: parse,
    highlight: highlight,
    escapeHtml: escapeHtml,
    countLines: countLines,
    utf8ByteLength: utf8ByteLength,
    describeParseError: describeParseError,
    PREVIEW_LIMIT: PREVIEW_LIMIT
  };
})(typeof self !== 'undefined' ? self : globalThis);
