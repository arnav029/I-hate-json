/*
 * Every module runs here so a 50MB document never blocks the main thread.
 * The worker also reads uploaded files, which keeps the huge string off the
 * UI thread entirely — it only ever sees the finished output.
 *
 * A module receives its inputs as an array of texts, so multi-input modules
 * (diff) need nothing special from the caller beyond a second source.
 *
 * Cores are imported on demand rather than up front: csv.js and diff.js are
 * dead weight on the formatter and minifier pages. Their content hashes arrive
 * on the job message, so this worker keeps one cacheable URL of its own.
 */
'use strict';

// Every mode parses, and parsing lives in the formatter core.
var NEEDS = {
  format: ['formatter.js'],
  minify: ['formatter.js'],
  csv: ['formatter.js', 'csv.js'],
  diff: ['formatter.js', 'diff.js']
};

var loaded = {};

function loadCores(mode, versions) {
  var pending = (NEEDS[mode] || NEEDS.format).filter(function (name) { return !loaded[name]; });
  if (!pending.length) return;

  importScripts.apply(null, pending.map(function (name) {
    return versions && versions[name] ? name + '?v=' + versions[name] : name;
  }));

  pending.forEach(function (name) { loaded[name] = true; });
}

var MODES = {
  format: function (texts, onStage) {
    return self.JSONFormatterCore.format(texts[0], { indent: 2, onStage: onStage });
  },
  minify: function (texts, onStage) {
    return self.JSONFormatterCore.minify(texts[0], { onStage: onStage });
  },
  csv: function (texts, onStage) {
    return self.JSONCsvCore.convert(texts[0], { onStage: onStage });
  },
  diff: function (texts, onStage) {
    return self.JSONDiffCore.compare(texts[0], texts[1], { onStage: onStage });
  }
};

function reply(msg) {
  self.postMessage(msg);
}

function readSource(source) {
  return source.source === 'file' ? source.file.text() : Promise.resolve(source.text || '');
}

self.onmessage = function (event) {
  var data = event.data || {};
  var id = data.id;
  var mode = MODES[data.mode] ? data.mode : 'format';
  var sources = data.sources || [];

  var stage = function (name) {
    reply({ type: 'stage', id: id, stage: name });
  };

  try {
    loadCores(mode, data.cores);
  } catch (err) {
    return reply({
      type: 'error',
      id: id,
      mode: mode,
      error: { kind: 'unknown', message: 'Could not load the tools. Try reloading the page.' }
    });
  }

  if (sources.some(function (source) { return source.source === 'file'; })) stage('reading');

  Promise.all(sources.map(readSource)).then(function (texts) {
    var startedAt = Date.now();
    try {
      var result = MODES[mode](texts, stage);
      result.type = 'result';
      result.id = id;
      result.mode = mode;
      result.stats.ms = Date.now() - startedAt;
      reply(result);
    } catch (err) {
      reply({
        type: 'error',
        id: id,
        mode: mode,
        error: err && err.kind ? err : { kind: 'unknown', message: String(err && err.message ? err.message : err) }
      });
    }
  }, function (err) {
    reply({
      type: 'error',
      id: id,
      mode: mode,
      error: { kind: 'read', message: 'Could not read that file: ' + (err && err.message ? err.message : err) }
    });
  });
};
