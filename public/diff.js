/*
 * Structural JSON diff. Compares values, not text, so key order and whitespace
 * never show up as changes. DOM-free like the other cores.
 *
 * Arrays are compared index by index: inserting an element at the front reports
 * every later index as changed rather than as one insertion.
 */
(function (global) {
  'use strict';

  var MAX_CHANGES = 20000;   // stop before a wildly different pair exhausts memory
  var MAX_VALUE = 5000;      // per-value cap so one huge string cannot be duplicated

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  function render(value) {
    var text = JSON.stringify(value);
    if (text === undefined) return 'undefined';
    return text.length > MAX_VALUE ? text.slice(0, MAX_VALUE) + '…' : text;
  }

  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function joinPath(base, key) {
    if (typeof key === 'number') return base + '[' + key + ']';
    if (IDENTIFIER.test(key)) return base ? base + '.' + key : key;
    return base + '[' + JSON.stringify(key) + ']';
  }

  function Collector() {
    this.changes = [];
    this.capped = false;
  }

  Collector.prototype.push = function (kind, path, from, to) {
    if (this.changes.length >= MAX_CHANGES) {
      this.capped = true;
      return false;
    }
    var change = { kind: kind, path: path || '(root)' };
    if (kind !== 'added') { change.from = render(from); change.fromType = typeOf(from); }
    if (kind !== 'removed') { change.to = render(to); change.toType = typeOf(to); }
    this.changes.push(change);
    return true;
  };

  Collector.prototype.full = function () {
    return this.capped;
  };

  function walk(a, b, path, out) {
    if (out.full()) return;
    if (a === b) return;

    var typeA = typeOf(a);
    var typeB = typeOf(b);

    if (typeA !== typeB) {
      out.push('changed', path, a, b);
      return;
    }

    if (typeA === 'object') {
      var keys = Object.keys(a);
      var seen = {};
      var i;

      for (i = 0; i < keys.length; i++) seen[keys[i]] = true;
      for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!Object.prototype.hasOwnProperty.call(b, key)) out.push('removed', joinPath(path, key), a[key]);
        else walk(a[key], b[key], joinPath(path, key), out);
        if (out.full()) return;
      }

      var added = Object.keys(b);
      for (i = 0; i < added.length; i++) {
        if (!seen[added[i]]) {
          out.push('added', joinPath(path, added[i]), undefined, b[added[i]]);
          if (out.full()) return;
        }
      }
      return;
    }

    if (typeA === 'array') {
      var length = Math.max(a.length, b.length);
      for (var index = 0; index < length; index++) {
        if (index >= b.length) out.push('removed', joinPath(path, index), a[index]);
        else if (index >= a.length) out.push('added', joinPath(path, index), undefined, b[index]);
        else walk(a[index], b[index], joinPath(path, index), out);
        if (out.full()) return;
      }
      return;
    }

    out.push('changed', path, a, b);
  }

  function compare(textA, textB, opts) {
    var onStage = (opts && opts.onStage) || function () {};
    var core = global.JSONFormatterCore;

    onStage('parsing');
    var a = parseSide(core, textA, 'A');
    var b = parseSide(core, textB, 'B');

    onStage('comparing');
    var out = new Collector();
    walk(a, b, '', out);

    var counts = { added: 0, removed: 0, changed: 0 };
    for (var i = 0; i < out.changes.length; i++) counts[out.changes[i].kind]++;

    return {
      changes: out.changes,
      capped: out.capped,
      identical: out.changes.length === 0,
      stats: {
        added: counts.added,
        removed: counts.removed,
        changed: counts.changed,
        total: out.changes.length
      }
    };
  }

  // Parse errors carry no hint of which side failed, so tag it for the UI.
  function parseSide(core, text, side) {
    try {
      return core.parse(text);
    } catch (err) {
      err.side = side;
      throw err;
    }
  }

  global.JSONDiffCore = {
    compare: compare,
    joinPath: joinPath,
    MAX_CHANGES: MAX_CHANGES
  };
})(typeof self !== 'undefined' ? self : globalThis);
