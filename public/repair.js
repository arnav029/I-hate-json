/*
 * Repairs the JSON people actually have: what a language model wrapped in prose
 * and code fences, what Python printed, what a config file allowed, what Mongo
 * shell exported, and what got cut off halfway through a paste.
 *
 * Only consulted once JSON.parse has already failed, so valid documents never
 * pay for it. Every change is recorded and reported, because silently altering
 * someone's data is worse than refusing it. When the input stops looking like
 * structured data at all it gives up (returns null) rather than guess.
 *
 * DOM-free like the other cores, so it runs in the worker, on the main thread,
 * and under Node for the tests.
 */
(function (global) {
  'use strict';

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // Display order, and wording. Each takes the number of times it happened.
  var MESSAGES = {
    fence: function () { return 'Took the JSON out of a Markdown code block'; },
    prose: function () { return 'Dropped the text before the JSON'; },
    'trailing-text': function () { return 'Dropped the text after the JSON'; },
    multiple: function (n) { return 'Wrapped ' + n + ' separate top-level values in an array'; },
    comment: function (n) { return 'Removed ' + plural(n, 'comment', 'comments'); },
    'single-quote': function (n) { return 'Switched ' + plural(n, 'single-quoted string', 'single-quoted strings') + ' to double quotes'; },
    'smart-quote': function (n) { return 'Replaced ' + plural(n, 'curly-quoted string’s quotes', 'curly-quoted strings’ quotes') + ' with straight ones'; },
    'unquoted-key': function (n) { return 'Quoted ' + plural(n, 'bare key', 'bare keys'); },
    'unquoted-value': function (n) { return 'Quoted ' + plural(n, 'bare value', 'bare values'); },
    'missing-comma': function (n) { return 'Added ' + plural(n, 'missing comma', 'missing commas'); },
    'trailing-comma': function (n) { return 'Removed ' + plural(n, 'trailing comma', 'trailing commas'); },
    'extra-comma': function (n) { return 'Removed ' + plural(n, 'doubled-up comma', 'doubled-up commas'); },
    'missing-colon': function (n) { return 'Added ' + plural(n, 'missing colon', 'missing colons'); },
    'missing-value': function (n) { return 'Filled ' + plural(n, 'missing value', 'missing values') + ' with null'; },
    literal: function (n) { return 'Converted ' + plural(n, 'Python or JavaScript literal', 'Python or JavaScript literals') + ' (True, None, undefined…)'; },
    'non-finite': function (n) { return 'Replaced ' + plural(n, 'NaN or Infinity', 'NaN or Infinity values') + ' with null — JSON has no way to write them'; },
    wrapper: function (n) { return 'Unwrapped ' + plural(n, 'call', 'calls') + ' like ObjectId(…) or ISODate(…) to the value inside'; },
    number: function (n) { return 'Rewrote ' + plural(n, 'number', 'numbers') + ' JSON does not allow (hex, a leading + or ., leading zeros)'; },
    'inner-quote': function (n) { return 'Escaped ' + plural(n, 'quote', 'quotes') + ' inside a string'; },
    control: function (n) { return 'Escaped ' + plural(n, 'raw line break or tab', 'raw line breaks or tabs') + ' inside strings'; },
    escape: function (n) { return 'Fixed ' + plural(n, 'invalid backslash escape', 'invalid backslash escapes'); },
    whitespace: function (n) { return 'Removed ' + plural(n, 'invisible non-standard space', 'invisible non-standard spaces'); },
    bracket: function (n) { return 'Fixed ' + plural(n, 'mismatched bracket', 'mismatched brackets'); },
    'unclosed-string': function () { return 'Closed a string that was cut off'; },
    'truncated-member': function (n) { return 'Dropped ' + plural(n, 'key with no value', 'keys with no value') + ' at the cut-off'; },
    unclosed: function (n) { return 'Closed ' + plural(n, 'bracket', 'brackets') + ' left open — the input looks cut off'; },
    unwrapped: function () { return 'Unwrapped JSON that had been saved as a string'; }
  };

  var ORDER = Object.keys(MESSAGES);

  var GIVE_UP = { giveUp: true };

  // Opening quote -> the characters that may close it. Curly quotes are often
  // mismatched by whatever produced them, so either curl closes either.
  var QUOTES = {
    '"': '"',
    "'": "'",
    '`': '`',
    '“': '“”"',
    '”': '“”"',
    '‘': '‘’',
    '’': '‘’'
  };

  var LITERALS = {
    'true': 'true', 'false': 'false', 'null': 'null',
    'True': 'true', 'False': 'false', 'None': 'null',
    'TRUE': 'true', 'FALSE': 'false', 'NULL': 'null',
    'undefined': 'null', 'nil': 'null'
  };

  var NON_FINITE = { 'NaN': true, 'Infinity': true };

  var WORD = /[A-Za-z_$][\w$]*/y;
  var BARE_KEY = /[^\s:,{}\[\]"'\/#=]+/y;
  var BARE_VALUE = /[^,\]\}\r\n]+/y;
  var NUMBERISH = /[-+]?(?:0[xX][0-9a-fA-F]+|[0-9_]*\.?[0-9_]*(?:[eE][-+]?[0-9]+)?)/y;
  var JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  var DELIMITER = /[\s,:\]\})]/;

  function lineAt(text, pos) {
    var line = 1;
    var idx = -1;
    while ((idx = text.indexOf('\n', idx + 1)) !== -1 && idx < pos) line++;
    return line;
  }

  function repair(input) {
    var text = input;
    var base = 0; // where `text` starts within `input`, so fixes report real lines
    var fixes = {};

    function note(kind, at, count) {
      var entry = fixes[kind];
      if (!entry) entry = fixes[kind] = { kind: kind, count: 0, at: base + at };
      entry.count += count || 1;
    }

    // A fenced block anywhere wins: models put prose on both sides of it.
    var fence = /```[^\n`]*\n([\s\S]*?)(?:\n[ \t]*```|$)/.exec(text);
    if (fence) {
      note('fence', fence.index);
      base = fence.index + fence[0].indexOf('\n') + 1;
      text = fence[1];
    }

    var n = text.length;
    var i = 0;
    var out = [];
    var stack = [];

    function skip() {
      while (i < n) {
        var ch = text.charAt(i);
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
        if (ch === ' ' || ch === '﻿' || ch === '​' || ch === ' ' || ch === ' ') {
          note('whitespace', i); i++; continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '/' || ch === '#') {
          note('comment', i);
          var eol = text.indexOf('\n', i);
          i = eol === -1 ? n : eol + 1;
          continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '*') {
          note('comment', i);
          var end = text.indexOf('*/', i + 2);
          i = end === -1 ? n : end + 2;
          continue;
        }
        return;
      }
    }

    // After a quote that matches the opener, does the string really end here?
    // Only if what follows could follow a string — otherwise it is a quote the
    // author forgot to escape, as in "she said "hi" twice".
    function endsString(at) {
      var j = at + 1;
      while (j < n && (text.charAt(j) === ' ' || text.charAt(j) === '\t')) j++;
      if (j >= n) return true;
      var ch = text.charAt(j);
      return ch === ',' || ch === ':' || ch === '}' || ch === ']' || ch === ')' || ch === '\n' ||
        ch === '\r' || ch === '"' || ch === '/' || ch === '#';
    }

    function string() {
      var start = i;
      var open = text.charAt(i);
      var closers = QUOTES[open];
      if (open === "'" || open === '`') note('single-quote', start);
      else if (open !== '"') note('smart-quote', start);

      var buf = ['"'];
      i++;
      var run = i;

      function flush() { if (i > run) buf.push(text.slice(run, i)); }

      for (;;) {
        if (i >= n) {
          flush();
          note('unclosed-string', start);
          break;
        }
        var ch = text.charAt(i);

        if (closers.indexOf(ch) !== -1) {
          if (endsString(i)) { flush(); i++; break; }
          flush();
          buf.push(ch === '"' ? '\\"' : ch);
          note('inner-quote', i);
          run = ++i;
          continue;
        }

        if (ch === '\\') {
          flush();
          var next = text.charAt(i + 1);
          if (next && '"\\/bfnrt'.indexOf(next) !== -1) {
            buf.push('\\' + next); i += 2;
          } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) {
            buf.push(text.substr(i, 6)); i += 6;
          } else if (next === "'" || next === '`') {
            buf.push(next); i += 2;
          } else if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.substr(i + 2, 2))) {
            buf.push('\\u00' + text.substr(i + 2, 2)); note('escape', i); i += 4;
          } else if (next === '') {
            i++; // a lone backslash at the very end — nothing to escape
          } else {
            // Windows paths, regexes: keep the backslash as a literal one.
            buf.push('\\\\'); note('escape', i); i++;
          }
          run = i;
          continue;
        }

        if (ch === '"') {
          // Only reachable inside a single- or curly-quoted string.
          flush(); buf.push('\\"'); run = ++i;
          continue;
        }

        var code = text.charCodeAt(i);
        if (code < 0x20) {
          flush();
          buf.push(code === 10 ? '\\n' : code === 13 ? '\\r' : code === 9 ? '\\t'
            : '\\u' + ('000' + code.toString(16)).slice(-4));
          note('control', i);
          run = ++i;
          continue;
        }
        i++;
      }

      buf.push('"');
      out.push(buf.join(''));
    }

    function key() {
      if (QUOTES[text.charAt(i)]) { string(); return; }
      BARE_KEY.lastIndex = i;
      var match = BARE_KEY.exec(text);
      if (!match) throw GIVE_UP;
      note('unquoted-key', i);
      out.push(JSON.stringify(match[0]));
      i += match[0].length;
    }

    // Anything unquoted that is not a number or a known literal: a date, an
    // enum, a word. Runs to the next delimiter and is kept as a string.
    function bareValue() {
      BARE_VALUE.lastIndex = i;
      var match = BARE_VALUE.exec(text);
      var raw = match ? match[0].replace(/\s+$/, '') : '';
      if (!raw) throw GIVE_UP;
      note('unquoted-value', i);
      out.push(JSON.stringify(raw));
      i += raw.length;
    }

    function number() {
      var start = i;
      var sign = text.charAt(i);
      if ((sign === '-' || sign === '+') && text.substr(i + 1, 8) === 'Infinity') {
        note('non-finite', start); out.push('null'); i += 9;
        return;
      }

      NUMBERISH.lastIndex = i;
      var raw = NUMBERISH.exec(text)[0];
      var after = text.charAt(i + raw.length);

      // 2024-01-31, 10:30, 1.2.3 — not numbers; keep them as text.
      if (!raw || (after && !DELIMITER.test(after) && after !== '/' && after !== '#')) {
        bareValue();
        return;
      }

      var normal;
      if (/^[-+]?0[xX]/.test(raw)) {
        normal = String(parseInt(raw, 16));
      } else {
        normal = raw.replace(/_/g, '').replace(/^\+/, '')
          .replace(/^(-?)\./, '$10.')
          .replace(/\.(?=[eE]|$)/, '')
          .replace(/^(-?)0+(?=\d)/, '$1');
      }

      if (!JSON_NUMBER.test(normal)) { bareValue(); return; }
      if (normal !== raw) note('number', start);
      out.push(normal);
      i += raw.length;
    }

    function word() {
      var start = i;
      WORD.lastIndex = i;
      var name = WORD.exec(text)[0];
      var j = i + name.length;

      if (name === 'new') {
        // new Date("…"): read past it to the constructor name.
        while (j < n && text.charAt(j) === ' ') j++;
        WORD.lastIndex = j;
        var ctor = WORD.exec(text);
        if (ctor && ctor.index === j) { name = ctor[0]; j += name.length; }
      }

      if (text.charAt(j) === '(') {
        // ObjectId("…"), ISODate("…"), NumberLong(42): keep what is inside.
        note('wrapper', start);
        i = j + 1;
        skip();
        if (text.charAt(i) === ')') out.push('null');
        else value();
        skip();
        if (text.charAt(i) !== ')') throw GIVE_UP;
        i++;
        return;
      }

      var after = text.charAt(j);
      if (after && !DELIMITER.test(after) && after !== '/' && after !== '#') { bareValue(); return; }

      if (LITERALS.hasOwnProperty(name)) {
        if (LITERALS[name] !== name) note('literal', start);
        out.push(LITERALS[name]);
      } else if (NON_FINITE[name]) {
        note('non-finite', start);
        out.push('null');
      } else {
        bareValue();
        return;
      }
      i = j;
    }

    function value() {
      skip();
      if (i >= n) throw GIVE_UP;
      var ch = text.charAt(i);
      if (ch === '{') return container('{', '}');
      if (ch === '[') return container('[', ']');
      if (QUOTES[ch]) return string();
      if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return number();
      if (/[A-Za-z_$]/.test(ch)) return word();
      throw GIVE_UP;
    }

    // A closer that belongs to some enclosing container ends this one without
    // being consumed, so the parent can use it. One that matches nothing open
    // is just the wrong character, and stands in for the right one.
    function closesAncestor(closer) {
      for (var k = stack.length - 2; k >= 0; k--) if (stack[k] === closer) return true;
      return false;
    }

    function container(opener, closer) {
      var isObject = opener === '{';
      var other = isObject ? ']' : '}';
      var start = i;
      var count = 0;
      var pendingComma = -1;

      out.push(opener);
      stack.push(closer);
      i++;

      if (stack.length > 4000) throw GIVE_UP;

      for (;;) {
        skip();
        if (i >= n) { note('unclosed', start); break; }

        var ch = text.charAt(i);
        if (ch === closer) {
          if (pendingComma >= 0) note('trailing-comma', pendingComma);
          i++;
          break;
        }
        if (ch === other) {
          note('bracket', i);
          if (pendingComma >= 0) note('trailing-comma', pendingComma);
          if (!closesAncestor(other)) i++;
          break;
        }
        if (ch === ',') {
          if (count === 0 || pendingComma >= 0) note('extra-comma', i);
          else pendingComma = i;
          i++;
          continue;
        }

        if (count > 0 && pendingComma < 0) note('missing-comma', i);
        pendingComma = -1;

        var mark = out.length;
        if (count > 0) out.push(',');

        if (!isObject) {
          value();
          count++;
          continue;
        }

        key();
        skip();
        if (i >= n) {
          out.length = mark;
          note('truncated-member', i);
          continue;
        }
        if (text.charAt(i) === ':' || text.charAt(i) === '=') {
          if (text.charAt(i) === '=') note('missing-colon', i);
          i++;
        } else {
          note('missing-colon', i);
        }
        out.push(':');

        skip();
        if (i >= n) {
          out.length = mark;
          note('truncated-member', i);
          continue;
        }
        ch = text.charAt(i);
        if (ch === ',' || ch === '}' || ch === ']') {
          note('missing-value', i);
          out.push('null');
        } else {
          value();
        }
        count++;
      }

      out.push(closer);
      stack.pop();
    }

    // Where the document starts: straight away, or after some prose a model or
    // a log line put in front of it ("Here is the JSON:", "callback(").
    function startsValue(at) {
      var ch = text.charAt(at);
      if (ch === '{' || ch === '[' || QUOTES[ch] || /[-+.0-9]/.test(ch)) return true;
      WORD.lastIndex = at;
      var w = WORD.exec(text);
      return !!w && w.index === at && (LITERALS.hasOwnProperty(w[0]) || NON_FINITE[w[0]]);
    }

    try {
      skip();
      if (i < n && !startsValue(i)) {
        var brace = text.slice(i).search(/[{\[]/);
        if (brace === -1) return null;
        note('prose', i);
        i += brace;
      }
      if (i >= n) return null;

      var values = 1;
      var firstChar = text.charAt(i);
      value();

      for (;;) {
        skip();
        if (i >= n) break;
        var ch = text.charAt(i);
        var j = i;
        if (ch === ',') { j++; while (j < n && /\s/.test(text.charAt(j))) j++; }
        var next = text.charAt(j);

        // NDJSON, or objects pasted one after another.
        if ((next === '{' || next === '[') && (firstChar === '{' || firstChar === '[')) {
          i = j;
          out.push(',');
          value();
          values++;
          continue;
        }

        // A lone scalar followed by more text means we never found the real
        // document — `"a": 1, "b": 2}` is not the string "a".
        if (firstChar !== '{' && firstChar !== '[') return null;
        note('trailing-text', i);
        break;
      }

      if (values > 1) {
        out.unshift('[');
        out.push(']');
        note('multiple', 0, values - 1);
        fixes.multiple.count = values;
      }
    } catch (err) {
      if (err === GIVE_UP || err instanceof RangeError) return null;
      throw err;
    }

    var list = ORDER.filter(function (kind) { return fixes[kind]; }).map(function (kind) {
      var entry = fixes[kind];
      return {
        kind: kind,
        count: entry.count,
        line: lineAt(input, entry.at),
        message: MESSAGES[kind](entry.count)
      };
    });

    return { text: out.join(''), fixes: list };
  }

  // A JSON document that is itself a string holding JSON — what you get from
  // a log line, a database column or a double JSON.stringify.
  function unwrap(value, fixes) {
    for (var depth = 0; depth < 3 && typeof value === 'string' && /^\s*[\[{]/.test(value); depth++) {
      try {
        value = JSON.parse(value);
      } catch (err) {
        break;
      }
      if (depth === 0) fixes.push({ kind: 'unwrapped', count: 1, line: 1, message: MESSAGES.unwrapped() });
    }
    return value;
  }

  global.JSONRepairCore = {
    repair: repair,
    unwrap: unwrap
  };
})(typeof self !== 'undefined' ? self : globalThis);
