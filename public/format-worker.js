/*
 * Every module runs here so a 50MB document never blocks the main thread.
 * The worker also reads uploaded files, which keeps the huge string off the
 * UI thread entirely — it only ever sees the finished output.
 *
 * A module receives its inputs as an array of texts, so multi-input modules
 * (diff) need nothing special from the caller beyond a second source.
 */
'use strict';

/*
 * app.js passes each core's content hash on this worker's query string, so the
 * cores can be cached for a year alongside everything else. Without it (a worker
 * started some other way) the plain names still resolve.
 */
var CORE_VERSIONS = (function () {
  var map = {};
  var match = /[?&]c=([^&]*)/.exec(self.location.search || '');
  if (!match) return map;
  decodeURIComponent(match[1]).split(',').forEach(function (pair) {
    var at = pair.lastIndexOf(':');
    if (at > 0) map[pair.slice(0, at)] = pair.slice(at + 1);
  });
  return map;
})();

function core(name) {
  return CORE_VERSIONS[name] ? name + '?v=' + CORE_VERSIONS[name] : name;
}

importScripts(core('formatter.js'), core('csv.js'), core('diff.js'));

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
