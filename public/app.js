/*
 * UI wiring. Everything expensive is delegated to format-worker.js so the
 * main thread only ever touches finished output.
 *
 * Modules share the input panel and swap the output side. Adding one means
 * adding a MODULES entry plus a worker mode — nothing else here changes.
 */
(function () {
  'use strict';

  var MAX_BYTES = 50 * 1024 * 1024;   // hard cap, matches the "up to 50MB" promise
  var INLINE_FILE_LIMIT = 1024 * 1024; // below this a dropped file is editable in the textarea
  var PREVIEW_COLUMNS = 40;            // columns rendered in the CSV preview table

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    input: $('input'),
    inputMeta: $('input-meta'),
    outputTitle: $('output-title'),
    outputMeta: $('output-meta'),
    outputCode: $('output-code'),
    outputPre: $('output'),
    outputPanel: $('output-panel'),
    csvView: $('csv-view'),
    csvHead: $('csv-head'),
    csvBody: $('csv-body'),
    placeholder: $('output-placeholder'),
    placeholderText: $('placeholder-text'),
    placeholderSub: $('placeholder-sub'),
    tagline: $('brand-tagline'),
    errorBox: $('error-box'),
    errorTitle: $('error-title'),
    errorMessage: $('error-message'),
    errorSnippet: $('error-snippet'),
    jumpBtn: $('jump-btn'),
    truncation: $('truncation-note'),
    formatBtn: $('format-btn'),
    formatBtnLabel: $('format-btn-label'),
    copyBtn: $('copy-btn'),
    wrapBtn: $('wrap-btn'),
    downloadBtn: $('download-btn'),
    clearBtn: $('clear-btn'),
    exampleBtn: $('example-btn'),
    uploadBtn: $('upload-btn'),
    fileInput: $('file-input'),
    fileChip: $('file-chip'),
    fileChipName: $('file-chip-name'),
    fileChipSize: $('file-chip-size'),
    fileChipRemove: $('file-chip-remove'),
    rail: document.querySelector('.rail'),
    dropOverlay: $('drop-overlay'),
    toast: $('toast'),
    live: $('status-live')
  };

  var state = {
    module: 'formatter',
    pendingFile: null,   // a File too big to show in the textarea
    output: '',          // full result text, the source of truth for copy/download
    sourceName: '',      // original file name, used to suggest a download name
    errorRange: null,    // {start, end} of the offending token in the input
    truncated: false,    // preview shows less than the full output
    busy: false,
    requestId: 0
  };

  var EXAMPLE = '{"name":"i-hate-json","version":"1.0.0","private":true,' +
    '"tagline":"Paste JSON. Get it formatted.","limits":{"maxFileSizeMB":50,"indent":2},' +
    '"features":["pretty-print","drag & drop","copy","download"],' +
    '"runsOnServer":false,"stars":null,"score":9.5}';

  var CSV_EXAMPLE = '[{"id":1,"name":"Ada Lovelace","role":"engineer",' +
    '"address":{"city":"London","zip":"W1"},"tags":["math","first"]},' +
    '{"id":2,"name":"Grace Hopper","role":"admiral",' +
    '"address":{"city":"New York","zip":"10001"},"tags":["compilers"],"active":true}]';

  /* ── modules ─────────────────────────────────────────── */

  var MODULES = {
    formatter: {
      mode: 'format',
      title: 'Formatted',
      action: 'Format',
      download: 'Download .json',
      extension: '.formatted.json',
      mime: 'application/json',
      tagline: 'Paste JSON. Get it formatted. Nothing leaves your browser.',
      placeholder: ['Your formatted JSON will appear here.', 'Two-space indent, syntax highlighted, ready to copy.'],
      example: EXAMPLE,
      wrappable: true,
      view: el.outputPre,
      text: function (result) { return result.formatted; },
      render: renderFormatted,
      meta: function (stats) {
        return formatNumber(stats.lines) + ' lines · ' + formatBytes(stats.outputBytes) + ' · ' + stats.ms + 'ms';
      },
      note: function () {
        return 'Preview truncated for speed — the full document is intact. Use Copy or Download to get all of it.';
      }
    },

    csv: {
      mode: 'csv',
      title: 'CSV',
      action: 'Convert to CSV',
      download: 'Download .csv',
      extension: '.csv',
      mime: 'text/csv',
      tagline: 'Paste a JSON array. Get a CSV. Nothing leaves your browser.',
      placeholder: ['Your CSV preview will appear here.', 'Needs an array of objects — nested keys become dotted columns.'],
      example: CSV_EXAMPLE,
      wrappable: false,
      view: el.csvView,
      text: function (result) { return result.csv; },
      render: renderCsv,
      meta: function (stats) {
        return formatNumber(stats.rows) + ' rows × ' + formatNumber(stats.columns) + ' cols · ' +
          formatBytes(stats.bytes) + ' · ' + stats.ms + 'ms';
      },
      note: function (result) {
        return 'Previewing the first ' + formatNumber(result.preview.length) + ' of ' +
          formatNumber(result.stats.rows) + ' rows — Copy and Download give you all of them.';
      }
    }
  };

  function current() {
    return MODULES[state.module];
  }

  function selectModule(name) {
    if (!MODULES[name] || state.module === name) return;

    state.module = name;
    var module = current();

    Array.prototype.forEach.call(el.rail.querySelectorAll('[data-module]'), function (item) {
      var active = item.getAttribute('data-module') === name;
      item.classList.toggle('is-active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });

    el.outputTitle.textContent = module.title;
    el.formatBtnLabel.textContent = module.action;
    el.downloadBtn.textContent = module.download;
    el.tagline.textContent = module.tagline;
    el.wrapBtn.hidden = !module.wrappable;

    clearOutput();
    hideError();
    announce(module.title + ' module selected.');
  }

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
    var module = current();

    state.output = '';
    state.truncated = false;
    el.outputCode.textContent = '';
    el.csvHead.innerHTML = '';
    el.csvBody.innerHTML = '';
    el.outputMeta.textContent = '';
    el.outputPre.hidden = module.view !== el.outputPre;
    el.csvView.hidden = module.view !== el.csvView;
    el.placeholderText.textContent = module.placeholder[0];
    el.placeholderSub.textContent = module.placeholder[1];
    el.placeholder.hidden = false;
    el.truncation.hidden = true;
    el.copyBtn.disabled = true;
    el.downloadBtn.disabled = true;
  }

  function hideError() {
    el.errorBox.hidden = true;
    el.errorSnippet.hidden = true;
    el.jumpBtn.hidden = true;
    clearMark();
  }

  function clearMark() {
    state.errorRange = null;
    el.input.classList.remove('marked');
  }

  function markable(range) {
    return !!range && !state.pendingFile && range.end <= el.input.value.length;
  }

  function scrollRangeIntoView(start) {
    var before = el.input.value.slice(0, start);
    var line = before.length ? before.split('\n').length : 1;
    var lineHeight = parseFloat(getComputedStyle(el.input).lineHeight) || 20;
    var target = (line - 1) * lineHeight;
    var padding = el.input.clientHeight / 3;

    if (target < el.input.scrollTop + padding || target > el.input.scrollTop + el.input.clientHeight - padding) {
      el.input.scrollTop = Math.max(0, target - padding);
    }
  }

  function markError() {
    var range = state.errorRange;
    if (!markable(range)) return;

    el.input.classList.add('marked');
    el.input.focus({ preventScroll: true });
    el.input.setSelectionRange(range.start, range.end);
    scrollRangeIntoView(range.start);
  }

  var ERROR_TITLES = {
    empty: 'Nothing to work with',
    'too-big': 'That file is too large',
    read: 'Couldn’t read that file',
    shape: 'CSV needs a different shape'
  };

  function showError(error) {
    clearOutput();
    el.placeholder.hidden = true;

    var title = ERROR_TITLES[error.kind] || 'That doesn’t look like valid JSON';
    var message = error.message;

    if (error.kind === 'parse' && error.line) {
      message = (error.approximate ? 'Near line ' + error.line
        : 'Line ' + error.line + ', column ' + error.column) + ' — ' + error.message;
    }

    el.errorTitle.textContent = title;
    el.errorMessage.textContent = message;

    if (error.snippet) {
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
    state.errorRange = error.range || null;
    el.jumpBtn.hidden = !markable(state.errorRange);
    markError();
    announce(title + '. ' + message);
  }

  function renderFormatted(result) {
    el.outputCode.innerHTML = result.previewHtml;
    el.outputPre.scrollTop = 0;
  }

  function renderCsv(result) {
    var columns = result.columns.slice(0, PREVIEW_COLUMNS);
    var head = document.createDocumentFragment();
    var body = document.createDocumentFragment();
    var headRow = document.createElement('tr');

    columns.forEach(function (name) {
      var th = document.createElement('th');
      th.textContent = name;
      headRow.appendChild(th);
    });
    if (result.columns.length > columns.length) {
      var more = document.createElement('th');
      more.className = 'is-more';
      more.textContent = '+' + (result.columns.length - columns.length) + ' more';
      headRow.appendChild(more);
    }
    head.appendChild(headRow);

    result.preview.forEach(function (cells) {
      var tr = document.createElement('tr');
      for (var i = 0; i < columns.length; i++) {
        var td = document.createElement('td');
        td.textContent = cells[i];
        if (cells[i] === '') td.className = 'is-empty';
        tr.appendChild(td);
      }
      if (result.columns.length > columns.length) tr.appendChild(document.createElement('td'));
      body.appendChild(tr);
    });

    el.csvHead.innerHTML = '';
    el.csvBody.innerHTML = '';
    el.csvHead.appendChild(head);
    el.csvBody.appendChild(body);
    el.csvView.scrollTop = 0;
  }

  function showResult(result) {
    var module = current();

    hideError();
    clearOutput();

    state.output = module.text(result);
    state.truncated = !!result.truncated || (result.preview && result.stats.rows > result.preview.length);

    module.render(result);

    el.placeholder.hidden = true;
    el.truncation.textContent = module.note(result);
    el.truncation.hidden = !state.truncated;
    el.copyBtn.disabled = false;
    el.downloadBtn.disabled = false;
    el.outputMeta.textContent = module.meta(result.stats);
    announce(module.title + ' ready. ' + el.outputMeta.textContent);
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
    highlighting: 'Highlighting…',
    shaping: 'Reading rows…',
    building: 'Building CSV…'
  };

  var worker = null;
  var workerBroken = false;

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('format-worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = function () {
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
    if (data.id !== state.requestId) return;

    if (data.type === 'stage') {
      if (state.busy) el.outputMeta.textContent = STAGE_LABEL[data.stage] || 'Working…';
      return;
    }

    setBusy(false);
    if (data.type === 'error') showError(data.error);
    else showResult(data);
  }

  /* ── running a module ────────────────────────────────── */

  function run() {
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

    // A UTF-8 string is never fewer bytes than characters, so this catches
    // anything oversized without walking a 50MB string on the main thread.
    if (!file && text.length > MAX_BYTES) {
      showError({ kind: 'too-big', message: 'That input is over the 50MB limit. Try splitting it first.' });
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

    var message = { id: state.requestId, mode: current().mode };
    if (file) { message.source = 'file'; message.file = file; }
    else { message.source = 'text'; message.text = text; }
    w.postMessage(message);
  }

  // Fallback for browsers where Workers are blocked. Same cores, so behaviour
  // is identical — it just blocks the UI while it runs.
  function formatOnMainThread() {
    loadCores(function () {
      setBusy(true);
      setTimeout(function () {
        var module = current();
        var execute = function (text) {
          var startedAt = Date.now();
          try {
            var result = module.mode === 'csv'
              ? self.JSONCsvCore.convert(text, {})
              : self.JSONFormatterCore.format(text, { indent: 2 });
            result.stats.ms = Date.now() - startedAt;
            setBusy(false);
            showResult(result);
          } catch (err) {
            setBusy(false);
            showError(err && err.kind ? err : { kind: 'unknown', message: String(err) });
          }
        };

        if (state.pendingFile) {
          state.pendingFile.text().then(execute, function (err) {
            setBusy(false);
            showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
          });
        } else {
          execute(el.input.value);
        }
      }, 16);
    });
  }

  function loadCores(done) {
    var pending = ['formatter.js', 'csv.js'].filter(function (src) {
      return src === 'csv.js' ? !self.JSONCsvCore : !self.JSONFormatterCore;
    });

    if (!pending.length) { done(); return; }

    var remaining = pending.length;
    pending.forEach(function (src) {
      var script = document.createElement('script');
      script.src = src;
      script.onload = function () { if (--remaining === 0) done(); };
      script.onerror = function () {
        setBusy(false);
        showError({ kind: 'unknown', message: 'Could not load the tools. Try reloading the page.' });
      };
      document.head.appendChild(script);
    });
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
      file.text().then(function (text) {
        clearFileChip();
        el.input.value = text;
        state.sourceName = file.name;
        updateInputMeta();
        run();
      }, function (err) {
        showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
      });
      return;
    }

    showFileChip(file);
    run();
  }

  /* ── copy / download ─────────────────────────────────── */

  function copyOutput() {
    if (!state.output) return;

    var fallback = function () {
      var scratch = document.createElement('textarea');
      scratch.value = state.output;
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
      navigator.clipboard.writeText(state.output).then(function () {
        toast('Copied to clipboard');
      }, fallback);
    } else {
      fallback();
    }
  }

  function downloadOutput() {
    if (!state.output) return;

    var module = current();
    var name = state.sourceName ? state.sourceName.replace(/\.json$/i, '') : 'output';
    // The BOM keeps Excel from mangling non-ASCII cells.
    var parts = module.mode === 'csv' ? ['﻿', state.output] : [state.output];
    var url = URL.createObjectURL(new Blob(parts, { type: module.mime }));
    var link = document.createElement('a');

    link.href = url;
    link.download = name + module.extension;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('Downloading ' + link.download);
  }

  /* ── line wrapping ───────────────────────────────────── */

  var WRAP_KEY = 'ihj:wrap';

  function setWrap(on) {
    document.body.classList.toggle('wrap', on);
    el.wrapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.wrapBtn.textContent = on ? 'Wrap' : 'No wrap';
    try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch (err) { /* private mode */ }
  }

  function initialWrap() {
    try {
      var stored = localStorage.getItem(WRAP_KEY);
      if (stored !== null) return stored === '1';
    } catch (err) { /* storage blocked */ }
    return true;
  }

  el.wrapBtn.addEventListener('click', function () {
    setWrap(el.wrapBtn.getAttribute('aria-pressed') !== 'true');
  });

  /* ── events ──────────────────────────────────────────── */

  el.rail.addEventListener('click', function (event) {
    var item = event.target.closest('[data-module]');
    if (item) selectModule(item.getAttribute('data-module'));
  });

  el.formatBtn.addEventListener('click', run);
  el.copyBtn.addEventListener('click', copyOutput);
  el.downloadBtn.addEventListener('click', downloadOutput);

  el.uploadBtn.addEventListener('click', function () { el.fileInput.click(); });

  el.fileInput.addEventListener('change', function () {
    acceptFile(el.fileInput.files && el.fileInput.files[0]);
    el.fileInput.value = '';
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
    el.input.value = current().example;
    updateInputMeta();
    run();
  });

  // Running is explicit, never on keystroke — that is what keeps typing and
  // pasting smooth on very large documents.
  el.input.addEventListener('input', function () {
    updateInputMeta();
    clearMark();
    el.jumpBtn.hidden = true;
  });

  el.jumpBtn.addEventListener('click', markError);

  function selectOutput() {
    var node = current().view === el.csvView ? el.csvView : el.outputCode;
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function ownsSelectAll(target) {
    if (!target || !target.closest) return false;
    if (target.closest('textarea, input')) return false;
    return target === document.body || el.outputPanel.contains(target);
  }

  document.addEventListener('keydown', function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      run();
      return;
    }

    if ((event.key || '').toLowerCase() === 'a' && state.output && ownsSelectAll(event.target)) {
      event.preventDefault();
      current().view.focus({ preventScroll: true });
      selectOutput();
      if (state.truncated) toast('Preview only — use Copy for the whole document');
    }
  });

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

  setWrap(initialWrap());
  updateInputMeta();
  clearOutput();
  getWorker();
})();
