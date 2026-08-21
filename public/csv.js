/*
 * JSON -> CSV core. DOM-free like formatter.js so it runs in the worker and
 * under Node. Handles the common shape: an array of flat(ish) objects.
 */
(function (global) {
  'use strict';

  var PREVIEW_ROWS = 20;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function describeType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    var type = typeof value;
    return (type === 'object' ? 'an ' : 'a ') + type;
  }

  function cellValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function flatten(source, prefix, out) {
    var keys = Object.keys(source);
    for (var i = 0; i < keys.length; i++) {
      var name = prefix ? prefix + '.' + keys[i] : keys[i];
      var value = source[keys[i]];
      if (isPlainObject(value) && Object.keys(value).length) flatten(value, name, out);
      else out[name] = cellValue(value);
    }
    return out;
  }

  function escapeCell(value) {
    if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"';
    return value;
  }

  function shapeError(message) {
    return { kind: 'shape', message: message };
  }

  function convert(text, opts) {
    var onStage = (opts && opts.onStage) || function () {};
    var parsed = global.JSONFormatterCore.parse(text);

    onStage('shaping');

    if (!Array.isArray(parsed)) {
      throw shapeError('CSV export needs an array of objects, but this is ' + describeType(parsed) +
        '. Wrap it in [ ] or pick the array you want to export.');
    }
    if (!parsed.length) {
      throw shapeError('That array is empty, so there are no rows to export.');
    }

    var rows = [];
    var columns = [];
    var seen = {};

    for (var i = 0; i < parsed.length; i++) {
      if (!isPlainObject(parsed[i])) {
        throw shapeError('Item ' + (i + 1) + ' is ' + describeType(parsed[i]) +
          ', not an object. CSV export needs every item to be an object.');
      }
      var flat = flatten(parsed[i], '', {});
      rows.push(flat);
      for (var key in flat) {
        if (Object.prototype.hasOwnProperty.call(flat, key) && !seen[key]) {
          seen[key] = true;
          columns.push(key);
        }
      }
    }

    onStage('building');

    var lines = [columns.map(escapeCell).join(',')];
    var preview = [];

    for (i = 0; i < rows.length; i++) {
      var cells = [];
      for (var c = 0; c < columns.length; c++) {
        var value = rows[i][columns[c]];
        cells.push(value === undefined ? '' : value);
      }
      lines.push(cells.map(escapeCell).join(','));
      if (preview.length < PREVIEW_ROWS) preview.push(cells);
    }

    var csv = lines.join('\r\n');

    return {
      csv: csv,
      columns: columns,
      preview: preview,
      stats: {
        rows: rows.length,
        columns: columns.length,
        bytes: global.JSONFormatterCore.utf8ByteLength(csv)
      }
    };
  }

  global.JSONCsvCore = {
    convert: convert,
    escapeCell: escapeCell,
    flatten: function (source) { return flatten(source, '', {}); },
    PREVIEW_ROWS: PREVIEW_ROWS
  };
})(typeof self !== 'undefined' ? self : globalThis);
