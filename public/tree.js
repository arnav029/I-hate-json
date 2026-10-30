/*
 * Tree view: a collapsible outline of a parsed document, with search and a
 * copyable path for any value. It is DOM, so it runs on the main thread — which
 * is why it only ever renders what is open: children appear when their parent
 * is opened, 200 at a time, and closing a node removes them again. A 20MB
 * document costs no more to show than a 2KB one until you start opening it.
 *
 * Paths and search are pure and exported separately, so the tests can reach
 * them without a DOM. Loaded on demand, the first time the tree is shown.
 */
(function (global) {
  'use strict';

  var PAGE = 200;             // children rendered per "show more"
  var AUTO_OPEN_ROWS = 150;   // how much opens by itself on first render
  var MATCH_LIMIT = 1000;     // matches revealed by a search
  var PREVIEW_CHARS = 300;    // characters of a long string shown inline

  // Same notation as the diff: users[3].address.city, ["first name"].
  var IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  function joinPath(base, key) {
    if (typeof key === 'number') return base + '[' + key + ']';
    if (IDENTIFIER.test(key)) return base ? base + '.' + key : key;
    return base + '[' + JSON.stringify(key) + ']';
  }

  function formatPath(path) {
    var out = '';
    for (var i = 0; i < path.length; i++) out = joinPath(out, path[i]);
    return out;
  }

  function isContainer(value) {
    return value !== null && typeof value === 'object';
  }

  function scalarText(value) {
    return typeof value === 'string' ? value : String(value);
  }

  /*
   * Walks the whole document once, matching object keys and scalar values,
   * case-insensitively. Array indices are deliberately not matched — searching
   * for "3" should not light up the fourth element of every array.
   *
   * Nodes carry a parent link rather than a path, so a two-million-node walk
   * allocates a path only for the matches it keeps.
   */
  function search(root, query, limit) {
    limit = limit || MATCH_LIMIT;
    var needle = String(query).toLowerCase();
    var matches = [];
    var total = 0;
    var stack = [{ value: root, key: undefined, parent: null }];

    function pathOf(item) {
      var path = [];
      for (; item.parent; item = item.parent) path.push(item.key);
      return path.reverse();
    }

    while (stack.length) {
      var item = stack.pop();
      var value = item.value;
      var hit = typeof item.key === 'string' && item.key.toLowerCase().indexOf(needle) !== -1;

      if (!isContainer(value)) {
        hit = hit || scalarText(value).toLowerCase().indexOf(needle) !== -1;
      } else if (Array.isArray(value)) {
        // Pushed in reverse so they come off the stack in document order.
        for (var i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], key: i, parent: item });
      } else {
        var keys = Object.keys(value);
        for (var k = keys.length - 1; k >= 0; k--) stack.push({ value: value[keys[k]], key: keys[k], parent: item });
      }

      if (hit) {
        total++;
        if (matches.length < limit) matches.push(pathOf(item));
      }
    }

    return { matches: matches, total: total, capped: total > matches.length };
  }

  // Folds match paths into a trie: what a filtered tree shows, and which nodes
  // it opens to reveal them.
  function buildFilter(matches) {
    var root = { hit: false, kids: new Map() };
    matches.forEach(function (path) {
      var node = root;
      path.forEach(function (key) {
        var next = node.kids.get(key);
        if (!next) { next = { hit: false, kids: new Map() }; node.kids.set(key, next); }
        node = next;
      });
      node.hit = true;
    });
    return root;
  }

  /* ── DOM ─────────────────────────────────────────────── */

  function span(className, text) {
    var el = document.createElement('span');
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // Text with every case-insensitive occurrence of the needle wrapped in <mark>.
  function appendMarked(parent, text, needle) {
    if (!needle) { parent.appendChild(document.createTextNode(text)); return; }
    var lower = text.toLowerCase();
    var at = 0;
    var found;
    while ((found = lower.indexOf(needle, at)) !== -1) {
      if (found > at) parent.appendChild(document.createTextNode(text.slice(at, found)));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(found, found + needle.length);
      parent.appendChild(mark);
      at = found + needle.length;
    }
    if (at < text.length) parent.appendChild(document.createTextNode(text.slice(at)));
  }

  function plural(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  }

  function summary(value) {
    return Array.isArray(value)
      ? '[ ' + plural(value.length, 'item', 'items') + ' ]'
      : '{ ' + plural(Object.keys(value).length, 'key', 'keys') + ' }';
  }

  function scalarClass(value) {
    if (typeof value === 'string') return 'tok-str';
    if (typeof value === 'number') return 'tok-num';
    return 'tok-lit';
  }

  function scalarDisplay(value) {
    if (typeof value !== 'string') return String(value);
    var shown = value.length > PREVIEW_CHARS ? value.slice(0, PREVIEW_CHARS) + '…' : value;
    return JSON.stringify(shown);
  }

  /**
   * Renders `value` into `list` (a <ul>). onSelect(path, value) fires when a
   * row is chosen. Returns a controller: filter(query) narrows the tree to
   * matches and reports how many there were.
   */
  function mount(list, value, onSelect) {
    var needle = '';
    var selected = null;

    function childCount(node) {
      if (node.filter && node.filter.kids.size) return node.filter.kids.size;
      return Array.isArray(node.value) ? node.value.length : keysOf(node).length;
    }

    function keysOf(node) {
      if (!node.keys) node.keys = Object.keys(node.value);
      return node.keys;
    }

    // Which children this node shows: only the ones leading to a match while a
    // search is active, all of them otherwise.
    function childKeyAt(node, index) {
      if (node.filter && node.filter.kids.size) {
        if (!node.filterKeys) node.filterKeys = Array.from(node.filter.kids.keys());
        return node.filterKeys[index];
      }
      return Array.isArray(node.value) ? index : keysOf(node)[index];
    }

    function makeItem(key, value, path, filter) {
      var li = document.createElement('li');
      li.setAttribute('role', 'treeitem');

      var row = document.createElement('div');
      row.className = 'tree-row';
      row.tabIndex = -1;

      var container = isContainer(value);
      row.appendChild(span(container ? 'tree-caret' : 'tree-caret is-leaf'));

      if (typeof key === 'number') {
        row.appendChild(span('tree-index', String(key)));
        row.appendChild(span('tree-colon', ': '));
      } else if (typeof key === 'string') {
        var keyEl = span('tree-key');
        appendMarked(keyEl, key === '' ? '""' : key, needle);
        row.appendChild(keyEl);
        row.appendChild(span('tree-colon', ': '));
      }

      if (container) {
        row.appendChild(span('tree-summary', summary(value)));
        li.setAttribute('aria-expanded', 'false');
      } else {
        var valueEl = span(scalarClass(value));
        appendMarked(valueEl, scalarDisplay(value), needle);
        row.appendChild(valueEl);
      }

      if (filter && filter.hit) row.classList.add('is-hit');

      li.appendChild(row);
      row._node = { value: value, path: path, filter: filter, li: li, open: false, shown: 0, group: null };
      return li;
    }

    function showMore(node) {
      var total = childCount(node);
      var end = Math.min(total, node.shown + PAGE);
      var fragment = document.createDocumentFragment();

      for (var i = node.shown; i < end; i++) {
        var key = childKeyAt(node, i);
        var childFilter = node.filter ? node.filter.kids.get(key) || null : null;
        fragment.appendChild(makeItem(key, node.value[key], node.path.concat([key]), childFilter));
      }
      node.shown = end;

      var stale = node.group.querySelector(':scope > .tree-more');
      if (stale) stale.remove();

      if (end < total) {
        var more = document.createElement('li');
        more.className = 'tree-more';
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-tiny';
        button.textContent = 'Show ' + Math.min(PAGE, total - end).toLocaleString('en-US') + ' more · ' +
          (total - end).toLocaleString('en-US') + ' left';
        button._owner = node;
        more.appendChild(button);
        fragment.appendChild(more);
      }

      node.group.appendChild(fragment);
    }

    function open(row) {
      var node = row._node;
      if (!isContainer(node.value) || node.open) return;
      node.open = true;
      node.shown = 0;
      node.li.setAttribute('aria-expanded', 'true');
      node.group = document.createElement('ul');
      node.group.setAttribute('role', 'group');
      node.li.appendChild(node.group);
      showMore(node);
    }

    function close(row) {
      var node = row._node;
      if (!node.open) return;
      node.open = false;
      node.li.setAttribute('aria-expanded', 'false');
      node.group.remove();
      node.group = null;
      if (selected && !selected.isConnected) select(row);
    }

    function toggle(row) {
      if (row._node.open) close(row); else open(row);
    }

    function childRows(row) {
      var group = row._node.group;
      if (!group) return [];
      return Array.prototype.map.call(group.querySelectorAll(':scope > li > .tree-row'), function (r) { return r; });
    }

    function select(row, focus) {
      if (selected) {
        selected.classList.remove('is-selected');
        selected.tabIndex = -1;
      }
      selected = row;
      row.classList.add('is-selected');
      row.tabIndex = 0;
      if (focus) row.focus({ preventScroll: false });
      onSelect(row._node.path, row._node.value);
    }

    function render(filter) {
      list.textContent = '';
      selected = null;
      var rootItem = makeItem(undefined, value, [], filter);
      list.appendChild(rootItem);
      var rootRow = rootItem.firstChild;
      rootRow.tabIndex = 0;

      if (filter) {
        // Open exactly the branches that lead to a match.
        (function reveal(row) {
          var node = row._node;
          if (!node.filter || !node.filter.kids.size) return;
          open(row);
          childRows(row).forEach(reveal);
        })(rootRow);
        return;
      }

      // Breadth-first, until the screen is reasonably full.
      var queue = [rootRow];
      var used = 1;
      while (queue.length) {
        var row = queue.shift();
        if (!isContainer(row._node.value)) continue;
        var cost = Math.min(childCount(row._node), PAGE);
        if (row !== rootRow && used + cost > AUTO_OPEN_ROWS) continue;
        open(row);
        used += cost;
        queue.push.apply(queue, childRows(row));
      }
    }

    function rowOf(target) {
      return target && target.closest ? target.closest('.tree-row') : null;
    }

    function onClick(event) {
      var more = event.target.closest && event.target.closest('.tree-more button');
      if (more) { showMore(more._owner); return; }
      var row = rowOf(event.target);
      if (!row || !list.contains(row)) return;
      toggle(row);
      select(row);
    }

    function onKey(event) {
      var row = rowOf(event.target);
      if (!row) return;
      var rows = Array.prototype.slice.call(list.querySelectorAll('.tree-row'));
      var index = rows.indexOf(row);
      var node = row._node;
      var target = null;

      switch (event.key) {
        case 'ArrowDown': target = rows[index + 1]; break;
        case 'ArrowUp': target = rows[index - 1]; break;
        case 'Home': target = rows[0]; break;
        case 'End': target = rows[rows.length - 1]; break;
        case 'ArrowRight':
          if (isContainer(node.value) && !node.open) open(row);
          else target = childRows(row)[0];
          break;
        case 'ArrowLeft':
          if (node.open) close(row);
          else {
            var parent = node.li.parentElement.closest('li');
            target = parent && list.contains(parent) ? parent.firstChild : null;
          }
          break;
        case 'Enter':
        case ' ':
          toggle(row);
          break;
        default:
          return;
      }

      event.preventDefault();
      if (target) select(target, true);
    }

    list.addEventListener('click', onClick);
    list.addEventListener('keydown', onKey);
    render(null);

    return {
      filter: function (query) {
        needle = String(query || '').trim().toLowerCase();
        if (!needle) {
          render(null);
          return null;
        }
        var result = search(value, needle);
        if (result.total) render(buildFilter(result.matches));
        else list.textContent = '';
        return result;
      },
      destroy: function () {
        list.removeEventListener('click', onClick);
        list.removeEventListener('keydown', onKey);
        list.textContent = '';
      }
    };
  }

  global.JSONTree = {
    formatPath: formatPath,
    search: search,
    buildFilter: buildFilter,
    mount: mount,
    MATCH_LIMIT: MATCH_LIMIT
  };
})(typeof self !== 'undefined' ? self : globalThis);
