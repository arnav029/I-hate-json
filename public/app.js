/*
 * UI wiring. Everything expensive is delegated to format-worker.js so the
 * main thread only ever touches finished output.
 *
 * Modules share the input panel and swap the output side. Adding one means
 * adding a MODULES entry plus a worker mode — nothing else here changes.
 */
(function () {
  'use strict';

  // The article pages carry no tool, so none of the wiring below applies to
  // them. They still register the service worker, so they are cached and
  // readable offline like every other page.
  if (document.body.getAttribute('data-layout') === 'article') {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
    return;
  }

  var MAX_BYTES = 50 * 1024 * 1024;   // hard cap, matches the "up to 50MB" promise
  var INLINE_FILE_LIMIT = 1024 * 1024; // below this a dropped file is editable in the textarea
  var PREVIEW_COLUMNS = 40;            // columns rendered in the CSV preview table

  var $ = function (id) { return document.getElementById(id); };

  /*
   * Asset versions come in on a body attribute rather than an inline script, so
   * the page needs no CSP nonce. Each name maps to a content hash; appending it
   * lets the server cache the file for a year and still serve a new one the
   * moment it changes. Missing manifest (opened as a bare file) falls back to
   * the unversioned name.
   */
  var ASSETS = (function () {
    var map = {};
    (document.body.getAttribute('data-assets') || '').split(',').forEach(function (pair) {
      var at = pair.lastIndexOf(':');
      if (at > 0) map[pair.slice(0, at)] = pair.slice(at + 1);
    });
    return map;
  })();

  function assetUrl(name) {
    return ASSETS[name] ? name + '?v=' + ASSETS[name] : name;
  }

  var CORES = ['formatter.js', 'csv.js', 'diff.js'];

  // The worker cannot read the document, so core versions ride along on each job
  // message. Keeping them off the worker's own URL leaves it with a single
  // cacheable address the service worker can precache.
  function coreVersions() {
    var map = {};
    CORES.forEach(function (name) { if (ASSETS[name]) map[name] = ASSETS[name]; });
    return map;
  }

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
    diffInputs: $('diff-inputs'),
    diffView: $('diff-view'),
    diffBody: $('diff-body'),
    diffIdentical: $('diff-identical'),
    placeholder: $('output-placeholder'),
    placeholderText: $('placeholder-text'),
    placeholderSub: $('placeholder-sub'),
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
    module: document.body.getAttribute('data-module') || 'formatter',
    pendingFile: null,   // a File too big to show in the textarea
    output: '',          // full result text, the source of truth for copy/download
    sourceName: '',      // original file name, used to suggest a download name
    errorRange: null,    // {start, end} of the offending token in the input
    errorEditor: null,   // which editor that range belongs to
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

  var DIFF_EXAMPLE_A = '{"name":"i-hate-json","version":"1.0.0","limits":{"maxFileSizeMB":50,"indent":2},' +
    '"modules":["format","csv"],"beta":true,"stars":null}';

  var DIFF_EXAMPLE_B = '{"name":"i-hate-json","version":"1.1.0","limits":{"maxFileSizeMB":50,"indent":4},' +
    '"modules":["format","csv","minify"],"stars":null,"license":"MIT"}';

  /* ── diff panes ──────────────────────────────────────── */

  function makePane(side) {
    return {
      side: side.toUpperCase(),
      text: $(side + '-text'),
      meta: $(side + '-meta'),
      card: $(side + '-card'),
      cardName: $(side + '-card-name'),
      uploadBtn: $(side + '-upload'),
      removeBtn: $(side + '-remove'),
      fileInput: $(side + '-file'),
      file: null
    };
  }

  var panes = { a: makePane('a'), b: makePane('b') };

  function paneInput(pane) {
    return { label: 'Side ' + pane.side, file: pane.file, text: pane.text.value };
  }

  function updatePaneMeta(pane) {
    if (pane.file) pane.meta.textContent = formatBytes(pane.file.size) + ' file';
    else {
      var len = pane.text.value.length;
      pane.meta.textContent = len === 0 ? 'empty' : formatNumber(len) + ' chars';
    }
  }

  function setPaneFile(pane, file) {
    pane.file = file;
    pane.cardName.textContent = file.name + ' · ' + formatBytes(file.size);
    pane.card.hidden = false;
    pane.text.hidden = true;
    pane.text.value = '';
    updatePaneMeta(pane);
  }

  function clearPaneFile(pane) {
    pane.file = null;
    pane.card.hidden = true;
    pane.text.hidden = false;
    updatePaneMeta(pane);
  }

  function acceptPaneFile(pane, file) {
    if (!file) return;

    if (file.size > MAX_BYTES) {
      showError({ kind: 'too-big', message: '"' + file.name + '" is ' + formatBytes(file.size) + ' — over the 50MB limit.' });
      return;
    }

    hideError();

    if (file.size <= INLINE_FILE_LIMIT) {
      file.text().then(function (text) {
        clearPaneFile(pane);
        pane.text.value = text;
        updatePaneMeta(pane);
      }, function (err) {
        showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
      });
      return;
    }

    setPaneFile(pane, file);
  }

  Object.keys(panes).forEach(function (key) {
    var pane = panes[key];
    pane.text.addEventListener('input', function () { updatePaneMeta(pane); });
    pane.uploadBtn.addEventListener('click', function () { pane.fileInput.click(); });
    pane.removeBtn.addEventListener('click', function () { clearPaneFile(pane); pane.text.focus(); });
    pane.fileInput.addEventListener('change', function () {
      acceptPaneFile(pane, pane.fileInput.files && pane.fileInput.files[0]);
      pane.fileInput.value = '';
    });
  });

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
      example: function () { el.input.value = EXAMPLE; },
      inputs: mainInput,
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

    minify: {
      mode: 'minify',
      title: 'Minified',
      action: 'Minify',
      download: 'Download .json',
      extension: '.min.json',
      mime: 'application/json',
      tagline: 'Paste JSON. Squeeze every byte out. Nothing leaves your browser.',
      placeholder: ['Your minified JSON will appear here.', 'Every optional space and newline removed.'],
      example: function () { el.input.value = JSON.stringify(JSON.parse(EXAMPLE), null, 2); },
      inputs: mainInput,
      wrappable: true,
      view: el.outputPre,
      text: function (result) { return result.minified; },
      render: renderFormatted,
      meta: function (stats) {
        return formatBytes(stats.inputBytes) + ' → ' + formatBytes(stats.outputBytes) +
          ' · ' + savedLabel(stats) + ' · ' + stats.ms + 'ms';
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
      example: function () { el.input.value = CSV_EXAMPLE; },
      inputs: mainInput,
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
    },

    diff: {
      mode: 'diff',
      title: 'Differences',
      action: 'Compare',
      download: 'Download .json',
      extension: '.diff.json',
      mime: 'application/json',
      tagline: 'Paste two JSON documents. See what actually changed. Nothing leaves your browser.',
      placeholder: ['Differences between A and B will appear here.', 'Values are compared, so key order and formatting are ignored.'],
      example: function () {
        panes.a.text.value = JSON.stringify(JSON.parse(DIFF_EXAMPLE_A), null, 2);
        panes.b.text.value = JSON.stringify(JSON.parse(DIFF_EXAMPLE_B), null, 2);
        clearPaneFile(panes.a);
        clearPaneFile(panes.b);
      },
      inputs: function () { return [paneInput(panes.a), paneInput(panes.b)]; },
      twoUp: true,
      wrappable: false,
      view: el.diffView,
      text: function (result) { return JSON.stringify(result.changes, null, 2); },
      render: renderDiff,
      meta: function (stats) {
        if (!stats.total) return 'identical · ' + stats.ms + 'ms';
        return '+' + formatNumber(stats.added) + ' −' + formatNumber(stats.removed) +
          ' ~' + formatNumber(stats.changed) + ' · ' + stats.ms + 'ms';
      },
      note: function (result) {
        return 'Stopped after ' + formatNumber(result.changes.length) +
          ' differences — these two documents have very little in common.';
      }
    }
  };

  function mainInput() {
    return [{ label: 'The input', file: state.pendingFile, text: el.input.value }];
  }

  function current() {
    return MODULES[state.module];
  }

  function applyModule() {
    var module = current();

    el.outputTitle.textContent = module.title;
    el.formatBtnLabel.textContent = module.action;
    el.downloadBtn.textContent = module.download;
    el.wrapBtn.hidden = !module.wrappable;

    el.diffInputs.hidden = !module.twoUp;
    el.input.hidden = !!module.twoUp;
    el.uploadBtn.hidden = !!module.twoUp;
    updateInputMeta();
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

  function savedLabel(stats) {
    if (!stats.inputBytes || stats.saved === 0) return 'same size';
    var percent = Math.round(Math.abs(stats.saved) / stats.inputBytes * 100);
    return percent + '% ' + (stats.saved > 0 ? 'smaller' : 'larger');
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
    if (current().twoUp) {
      updatePaneMeta(panes.a);
      updatePaneMeta(panes.b);
      el.inputMeta.textContent = 'A vs B';
      return;
    }
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
    el.diffBody.innerHTML = '';
    el.diffIdentical.hidden = true;
    el.outputMeta.textContent = '';
    [el.outputPre, el.csvView, el.diffView].forEach(function (view) {
      view.hidden = view !== module.view;
    });
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
    panes.a.text.classList.remove('marked');
    panes.b.text.classList.remove('marked');
  }

  function errorEditor(error) {
    if (error && error.side) return panes[error.side.toLowerCase()].text;
    return el.input;
  }

  function markable(range) {
    var editor = state.errorEditor;
    return !!range && !!editor && !editor.hidden && range.end <= editor.value.length;
  }

  function scrollRangeIntoView(editor, start) {
    var before = editor.value.slice(0, start);
    var line = before.length ? before.split('\n').length : 1;
    var lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
    var target = (line - 1) * lineHeight;
    var padding = editor.clientHeight / 3;

    if (target < editor.scrollTop + padding || target > editor.scrollTop + editor.clientHeight - padding) {
      editor.scrollTop = Math.max(0, target - padding);
    }
  }

  function markError() {
    var range = state.errorRange;
    if (!markable(range)) return;

    var editor = state.errorEditor;
    editor.classList.add('marked');
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(range.start, range.end);
    scrollRangeIntoView(editor, range.start);
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
      var where = error.approximate ? 'line ' + error.line
        : 'line ' + error.line + ', column ' + error.column;
      message = (error.side ? 'Side ' + error.side + ', ' + where : where.charAt(0).toUpperCase() + where.slice(1)) +
        ' — ' + error.message;
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
    state.errorEditor = errorEditor(error);
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

  var DIFF_LABEL = { added: '+', removed: '−', changed: '~' };

  function renderDiff(result) {
    el.diffIdentical.hidden = !result.identical;

    var body = document.createDocumentFragment();

    result.changes.forEach(function (change) {
      var tr = document.createElement('tr');
      tr.className = 'diff-' + change.kind;

      var mark = document.createElement('td');
      mark.className = 'diff-mark';
      mark.textContent = DIFF_LABEL[change.kind];
      tr.appendChild(mark);

      var path = document.createElement('td');
      path.className = 'diff-path';
      path.textContent = change.path;
      tr.appendChild(path);

      var values = document.createElement('td');
      values.className = 'diff-values';
      if (change.from !== undefined) values.appendChild(valueSpan('from', change.from));
      if (change.from !== undefined && change.to !== undefined) {
        var arrow = document.createElement('span');
        arrow.className = 'diff-arrow';
        arrow.textContent = '→';
        values.appendChild(arrow);
      }
      if (change.to !== undefined) values.appendChild(valueSpan('to', change.to));
      tr.appendChild(values);

      body.appendChild(tr);
    });

    el.diffBody.innerHTML = '';
    el.diffBody.appendChild(body);
    el.diffView.scrollTop = 0;
  }

  function valueSpan(kind, text) {
    var span = document.createElement('span');
    span.className = 'diff-value is-' + kind;
    span.textContent = text.length > 200 ? text.slice(0, 200) + '…' : text;
    if (text.length > 200) span.title = text;
    return span;
  }

  function showResult(result) {
    var module = current();

    hideError();
    clearOutput();

    state.output = module.text(result);
    state.truncated = !!result.truncated || !!result.capped ||
      !!(result.preview && result.stats.rows > result.preview.length);

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
    minifying: 'Minifying…',
    comparing: 'Comparing…',
    highlighting: 'Highlighting…',
    shaping: 'Reading rows…',
    building: 'Building CSV…'
  };

  var worker = null;
  var workerBroken = false;

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker(assetUrl('format-worker.js'));
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

  // Throws a displayable error rather than returning one, so every guard reads
  // the same way regardless of how many inputs a module takes.
  function toSource(input) {
    if (input.file) {
      if (input.file.size > MAX_BYTES) {
        throw { kind: 'too-big', message: formatBytes(input.file.size) + ' is over the 50MB limit. Try splitting the file first.' };
      }
      return { source: 'file', file: input.file };
    }

    // A UTF-8 string is never fewer bytes than characters, so this catches
    // anything oversized without walking a 50MB string on the main thread.
    if (input.text.length > MAX_BYTES) {
      throw { kind: 'too-big', message: input.label + ' is over the 50MB limit. Try splitting it first.' };
    }
    if (input.text.trim() === '') {
      throw { kind: 'empty', message: input.label + ' is empty — paste some JSON or drop a file in.' };
    }
    return { source: 'text', text: input.text };
  }

  function run() {
    if (state.busy) return;

    var inputs = current().inputs();
    var sources;

    try {
      sources = inputs.map(toSource);
    } catch (err) {
      showError(err);
      return;
    }

    var reading = sources.some(function (source) { return source.source === 'file'; });

    hideError();
    state.requestId++;
    setBusy(true, reading ? STAGE_LABEL.reading : STAGE_LABEL.parsing);

    var w = getWorker();
    if (!w) { runOnMainThread(sources); return; }

    w.postMessage({ id: state.requestId, mode: current().mode, cores: coreVersions(), sources: sources });
  }

  // Fallback for browsers where Workers are blocked. Same cores, so behaviour
  // is identical — it just blocks the UI while it runs.
  var MAIN_THREAD_MODES = {
    format: function (texts) { return self.JSONFormatterCore.format(texts[0], { indent: 2 }); },
    minify: function (texts) { return self.JSONFormatterCore.minify(texts[0], {}); },
    csv: function (texts) { return self.JSONCsvCore.convert(texts[0], {}); },
    diff: function (texts) { return self.JSONDiffCore.compare(texts[0], texts[1], {}); }
  };

  function runOnMainThread(sources) {
    loadCores(function () {
      setBusy(true);
      var reads = sources.map(function (source) {
        return source.source === 'file' ? source.file.text() : Promise.resolve(source.text);
      });

      Promise.all(reads).then(function (texts) {
        // Yield once so the busy state paints before we block.
        setTimeout(function () {
          var startedAt = Date.now();
          try {
            var result = MAIN_THREAD_MODES[current().mode](texts);
            result.stats.ms = Date.now() - startedAt;
            setBusy(false);
            showResult(result);
          } catch (err) {
            setBusy(false);
            showError(err && err.kind ? err : { kind: 'unknown', message: String(err) });
          }
        }, 16);
      }, function (err) {
        setBusy(false);
        showError({ kind: 'read', message: String(err && err.message ? err.message : err) });
      });
    });
  }

  function loadCores(done) {
    var globals = { 'formatter.js': 'JSONFormatterCore', 'csv.js': 'JSONCsvCore', 'diff.js': 'JSONDiffCore' };
    var pending = CORES.filter(function (src) { return !self[globals[src]]; });

    if (!pending.length) { done(); return; }

    var remaining = pending.length;
    pending.forEach(function (src) {
      var script = document.createElement('script');
      script.src = assetUrl(src);
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

  /* ── carrying input between tools ────────────────────── */

  // Modules are separate pages now, so what you pasted is handed to the next
  // one through sessionStorage. Capped: a 50MB paste does not belong in storage,
  // and files are never persisted at all.
  var CARRY_KEY = 'ihj:carry';
  var CARRY_LIMIT = 100 * 1024;

  function saveInput() {
    var payload = { input: el.input.value, a: panes.a.text.value, b: panes.b.text.value };
    var total = payload.input.length + payload.a.length + payload.b.length;

    try {
      if (total === 0 || total > CARRY_LIMIT) sessionStorage.removeItem(CARRY_KEY);
      else sessionStorage.setItem(CARRY_KEY, JSON.stringify(payload));
    } catch (err) { /* storage blocked or full */ }
  }

  function restoreInput() {
    var payload;
    try { payload = JSON.parse(sessionStorage.getItem(CARRY_KEY) || 'null'); } catch (err) { payload = null; }
    if (!payload) { updateInputMeta(); return; }

    if (current().twoUp) {
      // Coming from a single-input tool, the one document seeds side A.
      panes.a.text.value = payload.a || payload.input || '';
      panes.b.text.value = payload.b || '';
    } else {
      el.input.value = payload.input || payload.a || '';
    }
    updateInputMeta();
  }

  window.addEventListener('pagehide', saveInput);

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
    panes.a.text.value = '';
    panes.b.text.value = '';
    clearPaneFile(panes.a);
    clearPaneFile(panes.b);
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
    current().example();
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

    var file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!current().twoUp) { acceptFile(file); return; }

    var pane = event.target.closest && event.target.closest('.diff-pane');
    acceptPaneFile(pane ? panes[pane.getAttribute('data-side')] : panes.a, file);
  });

  /* ── init ────────────────────────────────────────────── */

  setWrap(initialWrap());
  applyModule();
  restoreInput();
  clearOutput();
  getWorker();

  /* ── offline ─────────────────────────────────────────── */

  // Registered after load so it never competes with the first paint. A failure
  // here is silent on purpose: the site works exactly as before without it.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();
