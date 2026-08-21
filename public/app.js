/*
 * UI wiring. Everything expensive is delegated to format-worker.js so the
 * main thread only ever touches finished output.
 */
(function () {
  'use strict';

  var MAX_BYTES = 50 * 1024 * 1024;   // hard cap, matches the "up to 50MB" promise
  var INLINE_FILE_LIMIT = 1024 * 1024; // below this a dropped file is editable in the textarea

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    input: $('input'),
    inputMeta: $('input-meta'),
    outputMeta: $('output-meta'),
    outputCode: $('output-code'),
    outputPre: $('output'),
    placeholder: $('output-placeholder'),
    errorBox: $('error-box'),
    errorTitle: $('error-title'),
    errorMessage: $('error-message'),
    errorSnippet: $('error-snippet'),
    truncation: $('truncation-note'),
    formatBtn: $('format-btn'),
    copyBtn: $('copy-btn'),
    downloadBtn: $('download-btn'),
    clearBtn: $('clear-btn'),
    exampleBtn: $('example-btn'),
    uploadBtn: $('upload-btn'),
    fileInput: $('file-input'),
    fileChip: $('file-chip'),
    fileChipName: $('file-chip-name'),
    fileChipSize: $('file-chip-size'),
    fileChipRemove: $('file-chip-remove'),
    dropOverlay: $('drop-overlay'),
    toast: $('toast'),
    live: $('status-live')
  };

  var state = {
    pendingFile: null,   // a File too big to show in the textarea
    formatted: '',       // full formatted output (source of truth for copy/download)
    sourceName: '',      // original file name, used to suggest a download name
    busy: false,
    requestId: 0
  };

  var EXAMPLE = '{"name":"i-hate-json","version":"1.0.0","private":true,' +
    '"tagline":"Paste JSON. Get it formatted.","limits":{"maxFileSizeMB":50,"indent":2},' +
    '"features":["pretty-print","drag & drop","copy","download"],' +
    '"runsOnServer":false,"stars":null,"score":9.5}';

  /* ── helpers ─────────────────────────────────────────── */

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = bytes / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
  }

  function formatNumber(n) {
    return n.toLocaleString('en-US');
  }

  var toastTimer = null;
  function toast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.hidden = false;
    requestAnimationFrame(function () { el.toast.classList.add('show'); });
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
      toastTimer = setTimeout(function () { el.toast.hidden = true; }, 200);
    }, 2000);
  }

  function announce(message) {
    el.live.textContent = message;
  }

  /* ── input state ─────────────────────────────────────── */

  function updateInputMeta() {
    if (state.pendingFile) {
      el.inputMeta.textContent = formatBytes(state.pendingFile.size) + ' file';
      return;
    }
    var len = el.input.value.length;
    el.inputMeta.textContent = len === 0 ? 'empty' : formatNumber(len) + ' characters';
  }

  function showFileChip(file) {
    state.pendingFile = file;
    state.sourceName = file.name;
    el.fileChipName.textContent = file.name;
    el.fileChipSize.textContent = formatBytes(file.size);
    el.fileChip.hidden = false;
    el.input.value = '';
    updateInputMeta();
  }

  function clearFileChip() {
    state.pendingFile = null;
    el.fileChip.hidden = true;
    updateInputMeta();
  }

  /* ── output state ────────────────────────────────────── */

  function clearOutput() {
    state.formatted = '';
    el.outputCode.textContent = '';
    el.outputMeta.textContent = '';
    el.placeholder.hidden = false;
    el.truncation.hidden = true;
    el.copyBtn.disabled = true;
    el.downloadBtn.disabled = true;
  }

  function hideError() {
    el.errorBox.hidden = true;
    el.errorSnippet.hidden = true;
  }

  function showError(error) {
    clearOutput();
    el.placeholder.hidden = true;

    var title = 'That doesn’t look like valid JSON';
    var message = error.message;

    if (error.kind === 'empty') {
      title = 'Nothing to format';
      message = error.message;
    } else if (error.kind === 'too-big') {
      title = 'That file is too large';
    } else if (error.kind === 'read') {
      title = 'Couldn’t read that file';
    } else if (error.kind === 'parse' && error.line) {
      var where = error.approximate
        ? 'Near line ' + error.line
        : 'Line ' + error.line + ', column ' + error.column;
      message = where + ' — ' + error.message;
    }

    el.errorTitle.textContent = title;
    el.errorMessage.textContent = message;

    if (error.snippet) {
      // textContent, never innerHTML: the snippet is raw user input.
      var snippet = error.snippet.line;
      if (error.snippet.caret >= 0) {
        snippet += '\n' + new Array(error.snippet.caret + 1).join(' ') + '^';
      }
      el.errorSnippet.textContent = snippet;
      el.errorSnippet.hidden = false;
    } else {
      el.errorSnippet.hidden = true;
    }

    el.errorBox.hidden = false;
    announce(title + '. ' + message);
  }

  function showResult(result) {
    state.formatted = result.formatted;

    hideError();
    el.placeholder.hidden = true;
    el.outputCode.innerHTML = result.previewHtml;
    el.outputPre.scrollTop = 0;
    el.truncation.hidden = !result.truncated;
    el.copyBtn.disabled = false;
    el.downloadBtn.disabled = false;

    var s = result.stats;
    el.outputMeta.textContent =
      formatNumber(s.lines) + ' lines · ' + formatBytes(s.outputBytes) + ' · ' + s.ms + 'ms';
    announce('Formatted ' + formatNumber(s.lines) + ' lines in ' + s.ms + ' milliseconds.');
  }

  function setBusy(busy, stage) {
    state.busy = busy;
    el.formatBtn.classList.toggle('is-busy', busy);
    el.formatBtn.disabled = busy;
    if (busy) el.outputMeta.textContent = stage || 'Working…';
  }

  /* ── worker ──────────────────────────────────────────── */

  var STAGE_LABEL = {
    reading: 'Reading file…',
    parsing: 'Parsing…',
    formatting: 'Formatting…',
    highlighting: 'Highlighting…'
  };

  var worker = null;
  var workerBroken = false;

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('format-worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = function () {
        // Fall back to the main thread rather than leaving the user stuck.
        workerBroken = true;
        worker = null;
        if (state.busy) { setBusy(false); formatOnMainThread(); }
      };
    } catch (err) {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function onWorkerMessage(event) {
    var data = event.data;
    if (data.id !== state.requestId) return; // a newer request superseded this one

    if (data.type === 'stage') {
      if (state.busy) el.outputMeta.textContent = STAGE_LABEL[data.stage] || 'Working…';
      return;
    }

    setBusy(false);
    if (data.type === 'error') showError(data.error);
    else showResult(data);
  }

  /* ── formatting ──────────────────────────────────────── */

  function format() {
    if (state.busy) return;

    var file = state.pendingFile;
    var text = el.input.value;

    if (file && file.size > MAX_BYTES) {
      showError({
        kind: 'too-big',
        message: formatBytes(file.size) + ' is over the 50MB limit. Try splitting the file first.'
      });
      return;
    }

    // Cheap guard: a UTF-8 string is never fewer bytes than characters, so this
    // catches anything genuinely oversized without walking a 50MB string here.
    if (!file && text.length > MAX_BYTES) {
      showError({
        kind: 'too-big',
        message: 'That input is over the 50MB limit. Try splitting it first.'
      });
      return;
    }

    if (!file && text.trim() === '') {
      showError({ kind: 'empty', message: 'Paste some JSON or drop a file in first.' });
      return;
    }

    hideError();
    state.requestId++;
    setBusy(true, file ? STAGE_LABEL.reading : STAGE_LABEL.parsing);

    var w = getWorker();
    if (!w) { formatOnMainThread(); return; }

    if (file) w.postMessage({ id: state.requestId, source: 'file', file: file });
    else w.postMessage({ id: state.requestId, source: 'text', text: text });
  }

  // Fallback path for browsers where Workers are blocked. Same core module, so
  // the behaviour is identical — it just blocks the UI while it runs.
  function formatOnMainThread() {
    loadCore(function () {
      setBusy(true);
      // Yield once so the busy state actually paints before we block.
      setTimeout(function () {
        var run = function (text) {
          var startedAt = Date.now();
          try {
            var result = self.JSONFormatterCore.format(text, { indent: 2 });
            result.stats.ms = Date.now() - startedAt;
            setBusy(false);
            showResult(result);
          } catch (err) {
            setBusy(false);
            showError(err && err.kind ? err : { kind: 'unknown', message: String(err) });
          }
        };

        if (state.pendingFile) {
          state.pendingFile.text().then(run, function (err) {
            setBusy(false);
            showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
          });
        } else {
          run(el.input.value);
        }
      }, 16);
    });
  }

  function loadCore(done) {
    if (self.JSONFormatterCore) { done(); return; }
    var script = document.createElement('script');
    script.src = 'formatter.js';
    script.onload = done;
    script.onerror = function () {
      setBusy(false);
      showError({ kind: 'unknown', message: 'Could not load the formatter. Try reloading the page.' });
    };
    document.head.appendChild(script);
  }

  /* ── file intake ─────────────────────────────────────── */

  function acceptFile(file) {
    if (!file) return;

    if (file.size > MAX_BYTES) {
      clearFileChip();
      showError({
        kind: 'too-big',
        message: '"' + file.name + '" is ' + formatBytes(file.size) + ' — over the 50MB limit.'
      });
      return;
    }

    hideError();

    if (file.size <= INLINE_FILE_LIMIT) {
      // Small enough to edit comfortably: drop it straight into the textarea.
      file.text().then(function (text) {
        clearFileChip();
        el.input.value = text;
        state.sourceName = file.name;
        updateInputMeta();
        format();
      }, function (err) {
        showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
      });
      return;
    }

    showFileChip(file);
    format();
  }

  /* ── copy / download ─────────────────────────────────── */

  function copyOutput() {
    if (!state.formatted) return;

    var fallback = function () {
      var scratch = document.createElement('textarea');
      scratch.value = state.formatted;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(scratch);
      toast(ok ? 'Copied to clipboard' : 'Copy failed — select the output manually');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.formatted).then(function () {
        toast('Copied to clipboard');
      }, fallback);
    } else {
      fallback();
    }
  }

  function downloadOutput() {
    if (!state.formatted) return;

    var name = state.sourceName ? state.sourceName.replace(/\.json$/i, '') : 'formatted';
    var blob = new Blob([state.formatted], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name + '.formatted.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Downloading ' + link.download);
  }

  /* ── events ──────────────────────────────────────────── */

  el.formatBtn.addEventListener('click', format);
  el.copyBtn.addEventListener('click', copyOutput);
  el.downloadBtn.addEventListener('click', downloadOutput);

  el.uploadBtn.addEventListener('click', function () { el.fileInput.click(); });

  el.fileInput.addEventListener('change', function () {
    acceptFile(el.fileInput.files && el.fileInput.files[0]);
    el.fileInput.value = ''; // allow re-picking the same file
  });

  el.fileChipRemove.addEventListener('click', function () {
    clearFileChip();
    state.sourceName = '';
    el.input.focus();
  });

  el.clearBtn.addEventListener('click', function () {
    el.input.value = '';
    state.sourceName = '';
    clearFileChip();
    clearOutput();
    hideError();
    updateInputMeta();
    el.input.focus();
  });

  el.exampleBtn.addEventListener('click', function () {
    clearFileChip();
    state.sourceName = '';
    el.input.value = EXAMPLE;
    updateInputMeta();
    format();
  });

  // Formatting is explicit, never on keystroke — that is what keeps typing and
  // pasting smooth on very large documents.
  el.input.addEventListener('input', updateInputMeta);

  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      format();
    }
  });

  // Drag & drop anywhere on the page.
  var dragDepth = 0;

  function hasFiles(event) {
    var dt = event.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.prototype.indexOf.call(dt.types, 'Files') !== -1;
  }

  window.addEventListener('dragenter', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    el.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) el.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    el.dropOverlay.hidden = true;
    acceptFile(event.dataTransfer.files && event.dataTransfer.files[0]);
  });

  /* ── init ────────────────────────────────────────────── */

  updateInputMeta();
  clearOutput();
  getWorker(); // warm the worker up so the first format is not slowed by startup
})();
