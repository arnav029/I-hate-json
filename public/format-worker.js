/*
 * Formatting happens here so a 50MB document never blocks the main thread.
 * The worker also reads uploaded files, which keeps the huge string off the
 * UI thread entirely — it only ever sees the finished output.
 */
'use strict';

importScripts('formatter.js');

function reply(msg) {
  self.postMessage(msg);
}

self.onmessage = function (event) {
  var data = event.data || {};
  var id = data.id;

  var stage = function (name) {
    reply({ type: 'stage', id: id, stage: name });
  };

  var run = function (text) {
    var startedAt = Date.now();
    try {
      var result = self.JSONFormatterCore.format(text, { indent: 2, onStage: stage });
      result.type = 'result';
      result.id = id;
      result.stats.ms = Date.now() - startedAt;
      reply(result);
    } catch (err) {
      reply({
        type: 'error',
        id: id,
        error: err && err.kind ? err : { kind: 'unknown', message: String(err && err.message ? err.message : err) }
      });
    }
  };

  if (data.source === 'file') {
    stage('reading');
    data.file.text().then(run, function (err) {
      reply({
        type: 'error',
        id: id,
        error: { kind: 'read', message: 'Could not read that file: ' + (err && err.message ? err.message : err) }
      });
    });
    return;
  }

  run(data.text || '');
};
