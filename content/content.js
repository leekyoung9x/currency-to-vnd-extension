/**
 * content/content.js — DOM scanning, conversion badges, restore & live updates.
 * Classic script (IIFE): reads helpers from `CurrencyUtils` / `RateUtils`
 * globals (shared/currency.js + shared/rates.js must load FIRST) and exposes
 * the scan/restore API on `CurrencyContent` for the test suite and pages.
 * No static `import` / `export` so Chrome MV3 can run it as a classic
 * content script.
 */
(function (root) {
  'use strict';

  var CurrencyUtils = root.CurrencyUtils || {};
  var RateUtils = root.RateUtils || {};
  var detectCurrencyAmounts = CurrencyUtils.detectCurrencyAmounts;
  var convertToVND = CurrencyUtils.convertToVND;
  var formatVND = CurrencyUtils.formatVND;
  var DEFAULT_RATES = CurrencyUtils.DEFAULT_RATES || {};
  var STORAGE_KEYS = RateUtils.STORAGE_KEYS || {
    RATES: 'vnd_rates',
    CUSTOM_RATES: 'vnd_custom_rates',
    UPDATED_AT: 'vnd_rates_updated_at',
    ENABLED: 'vnd_enabled',
    MODE: 'vnd_display_mode',
    TABLE_SAFE: 'vnd_table_safe',
  };
  if (!STORAGE_KEYS.TABLE_SAFE) {
    // RateUtils.STORAGE_KEYS is frozen: copy instead of mutating.
    var _keys = {};
    for (var _k in STORAGE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(STORAGE_KEYS, _k)) _keys[_k] = STORAGE_KEYS[_k];
    }
    _keys.TABLE_SAFE = 'vnd_table_safe';
    STORAGE_KEYS = _keys;
  }

  var FORBIDDEN_TAGS = Object.freeze(
    new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE'])
  );
  var CONVERTED_ATTR = 'data-vnd-converted';
  var ORIGINAL_ATTR = 'data-original-text';
  var CONVERTED_CLASS = 'vnd-converted';

  var DISPLAY_MODES = Object.freeze(['append', 'replace', 'hover']);
  var DEFAULT_STATE = Object.freeze({ enabled: true, mode: 'append', tableSafe: true });

  var currentRates = {};
  var k;
  for (k in DEFAULT_RATES) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_RATES, k)) currentRates[k] = DEFAULT_RATES[k];
  }
  var currentState = { enabled: DEFAULT_STATE.enabled, mode: DEFAULT_STATE.mode, tableSafe: DEFAULT_STATE.tableSafe };
  var debounceTimer = 0;
  var selfMutating = false;

  function viewOf(subroot) {
    if (subroot && subroot.defaultView) return subroot.defaultView; // Document
    if (subroot && subroot.ownerDocument && subroot.ownerDocument.defaultView) {
      return subroot.ownerDocument.defaultView;
    }
    try {
      if (typeof window !== 'undefined') return window;
    } catch (_) { /* noop */ }
    return null;
  }

  function showTextConst(view) {
    try {
      if (view && view.NodeFilter) return view.NodeFilter.SHOW_TEXT;
      if (typeof NodeFilter !== 'undefined') return NodeFilter.SHOW_TEXT;
    } catch (_) { /* noop */ }
    return 4; // NodeFilter.SHOW_TEXT
  }

  /** True when the node lives inside a tag we must never touch. */
  function isSkipped(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement !== undefined && node.parentElement !== null ? node.parentElement : null);
    if (!el && node && node.parentNode) {
      var p = node.parentNode;
      while (p && p.nodeType === 1) {
        var tag = (p.tagName || '').toUpperCase();
        if (FORBIDDEN_TAGS.has(tag)) return true;
        if (p.getAttribute && p.getAttribute('contenteditable') === 'true') return true;
        if (p.isContentEditable) return true;
        if (p.hasAttribute && p.hasAttribute(CONVERTED_ATTR)) return true;
        p = p.parentNode;
      }
      return false;
    }
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var tag2 = (cur.tagName || '').toUpperCase();
      if (FORBIDDEN_TAGS.has(tag2)) return true;
      if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') return true;
      if (cur.isContentEditable) return true;
      if (cur.hasAttribute && cur.hasAttribute(CONVERTED_ATTR)) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  /**
   * FIX-4: True when the node lives inside a table context (`<td>`, `<th>`,
   * `<tr>`, `<table>` family, or `[role="cell|gridcell|row|..."]`).
   * Appending wide inline badges there stretches `whitespace-nowrap`
   * columns and pushes action buttons (Save/Clear) out of view.
   */
  function isInsideTable(node) {
    var el = null;
    if (node && node.nodeType === 1) {
      el = node;
    } else if (node && node.parentElement) {
      el = node.parentElement;
    } else if (node && node.parentNode && node.parentNode.nodeType === 1) {
      el = node.parentNode;
    }
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var tag = (cur.tagName || '').toUpperCase();
      if (tag === 'TD' || tag === 'TH' || tag === 'TR' || tag === 'TABLE' ||
          tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' ||
          tag === 'CAPTION' || tag === 'COLGROUP' || tag === 'COL') {
        return true;
      }
      if (cur.getAttribute) {
        var role = cur.getAttribute('role');
        if (role) {
          var rl = String(role).toLowerCase();
          if (rl === 'cell' || rl === 'gridcell' || rl === 'row' ||
              rl === 'rowheader' || rl === 'columnheader' ||
              rl === 'table' || rl === 'grid' || rl === 'treegrid') {
            return true;
          }
        }
      }
      cur = cur.parentNode;
    }
    return false;
  }

  /**
   * FIX-4: True when the node sits under a `truncate` / `overflow: hidden`
   * context. Inline badges there get clipped to `...`, so table-safe mode
   * falls back to a zero-width-growth hover tooltip instead.
   */
  function isTruncatedContext(node) {
    var el = null;
    if (node && node.nodeType === 1) {
      el = node;
    } else if (node && node.parentElement) {
      el = node.parentElement;
    } else if (node && node.parentNode && node.parentNode.nodeType === 1) {
      el = node.parentNode;
    }
    var cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.classList && cur.classList.contains('truncate')) return true;
      if (cur.getAttribute) {
        var style = cur.getAttribute('style');
        if (style && /overflow\s*:\s*hidden/i.test(style)) return true;
      }
      cur = cur.parentNode;
    }
    return false;
  }

  /** Collect convertible text nodes under root via TreeWalker. */
  function collectTextNodes(base) {
    var doc = base && base.nodeType === 9 ? base : (base && base.ownerDocument !== undefined && base.ownerDocument !== null ? base.ownerDocument : null);
    var view = viewOf(base);
    var scope = base && base.nodeType === 1 ? base : (doc && doc.documentElement ? doc.documentElement : base);
    if (!scope || (typeof scope.ownerDocument === 'undefined' && scope.nodeType !== 9 && scope.nodeType !== 1)) {
      return [];
    }
    var context = doc || (typeof document !== 'undefined' ? document : null);
    if (!context || !context.createTreeWalker) return [];
    var walker = context.createTreeWalker(scope, showTextConst(view), {
      acceptNode: function (node) {
        var NF = (view && view.NodeFilter) || (typeof NodeFilter !== 'undefined' ? NodeFilter : null);
        var ACCEPT = (NF && NF.FILTER_ACCEPT) || 1;
        var REJECT = (NF && NF.FILTER_REJECT) || 2;
        if (!node.nodeValue || !node.nodeValue.trim()) return REJECT;
        if (isSkipped(node)) return REJECT;
        return ACCEPT;
      },
    });
    var out = [];
    var n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function vndFor(match, rates) {
    var v = convertToVND(match.amount, match.currency, rates);
    return v == null ? null : v;
  }

  function formatRateBadge(rate) {
    var r = Number(rate);
    if (!Number.isFinite(r)) return '';
    return String(Math.round(r)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /**
   * Convert one text node in place. Returns number of converted amounts.
   * Wraps the node in a marked span so restore() + skip-logic work.
   */
  function convertTextNode(textNode, rates, mode, tableSafe) {
    if (rates === undefined) rates = currentRates;
    if (mode === undefined) mode = currentState.mode;
    if (tableSafe === undefined || tableSafe === null) tableSafe = currentState.tableSafe !== false;
    if (!textNode || textNode.nodeType !== 3) return 0;
    var original = textNode.nodeValue;
    if (!original || !original.trim()) return 0;
    if (isSkipped(textNode)) return 0;
    var matches = detectCurrencyAmounts(original);
    if (matches.length === 0) return 0;

    var doc = textNode.ownerDocument;
    if (!doc) return 0;
    var wrapper = doc.createElement('span');
    wrapper.setAttribute('class', CONVERTED_CLASS);
    wrapper.setAttribute(CONVERTED_ATTR, 'true');
    wrapper.setAttribute(ORIGINAL_ATTR, original);

    var cursor = 0;
    var converted = 0;
    var pushText = function (s) {
      if (s) wrapper.appendChild(doc.createTextNode(s));
    };

    // FIX-4 Table-safe: inside tables, `append` must not emit wide inline
    // badges (they stretch nowrap columns and push Save/Clear out of view).
    // One block-level subline per text node keeps 100% of column width, and
    // compound `$A / $B` / `$A–$B` clusters collapse into a single label.
    // `truncate` / `overflow: hidden` contexts fall back to hover tooltips
    // (zero width growth, never clipped to `...`).
    var wantTableSafe = tableSafe && mode === 'append' && isInsideTable(textNode);
    var wantHoverFallback = tableSafe && mode === 'append' && !wantTableSafe && isTruncatedContext(textNode);

    if (wantTableSafe) {
      pushText(original);
      var legs = [];
      for (var li = 0; li < matches.length; li += 1) {
        var lv = vndFor(matches[li], rates);
        if (lv == null) continue;
        legs.push(formatVND(lv));
        converted += 1;
      }
      if (converted === 0) return 0;
      var sub = doc.createElement('span');
      sub.setAttribute('class', 'vnd-subline');
      sub.setAttribute('data-original', original);
      sub.textContent = '≈ ' + legs.join(' / ');
      wrapper.appendChild(sub);
      cursor = original.length;
    } else for (var i = 0; i < matches.length; i += 1) {
      var m = matches[i];
      var vnd = vndFor(m, rates);
      if (vnd == null) continue;
      pushText(original.slice(cursor, m.index));
      var label = formatVND(vnd);
      if (mode === 'replace') {
        var s = doc.createElement('span');
        s.setAttribute('class', 'vnd-replace');
        s.setAttribute('data-original', m.raw);
        s.setAttribute('title', 'Gốc: ' + m.raw);
        s.textContent = label;
        wrapper.appendChild(s);
      } else if (mode === 'hover' || wantHoverFallback) {
        var h = doc.createElement('span');
        h.setAttribute('class', 'vnd-hover');
        h.setAttribute('data-original', m.raw);
        var rate = (rates || {})[m.currency] !== undefined && (rates || {})[m.currency] !== null
          ? (rates || {})[m.currency]
          : DEFAULT_RATES[m.currency];
        h.setAttribute('data-vnd-tooltip', '≈ ' + label + ' (Tỷ giá: ' + formatRateBadge(rate) + ')');
        h.textContent = m.raw;
        wrapper.appendChild(h);
      } else {
        // append (default): keep original, add badge beside it.
        pushText(m.raw);
        var b = doc.createElement('span');
        b.setAttribute('class', 'vnd-badge');
        b.setAttribute('data-original', m.raw);
        b.textContent = ' (≈ ' + label + ')';
        wrapper.appendChild(b);
      }
      cursor = m.index + m.raw.length;
      converted += 1;
    }
    if (converted === 0) return 0;
    pushText(original.slice(cursor));

    selfMutating = true;
    try {
      textNode.parentNode.replaceChild(wrapper, textNode);
    } finally {
      selfMutating = false;
    }
    return converted;
  }

  /**
   * Scan a document/subtree and convert every currency amount.
   * Returns `{ count, nodes }`: converted amounts + wrapped nodes.
   */
  function scanAndConvert(scanRoot, options) {
    if (options === undefined) options = {};
    var rates = options.rates !== undefined && options.rates !== null ? options.rates : currentRates;
    var mode = options.mode !== undefined && options.mode !== null ? options.mode : currentState.mode;
    var enabled = options.enabled !== undefined && options.enabled !== null ? options.enabled : currentState.enabled;
    var tableSafe = options.tableSafe !== undefined && options.tableSafe !== null ? options.tableSafe : currentState.tableSafe !== false;
    if (enabled === false) return { count: 0, nodes: 0 };
    if (scanRoot == null) {
      try {
        scanRoot = typeof document !== 'undefined' ? document : null;
      } catch (_) {
        scanRoot = null;
      }
    }
    if (!scanRoot) return { count: 0, nodes: 0 };
    var count = 0;
    var nodes = 0;
    var found = collectTextNodes(scanRoot);
    for (var i = 0; i < found.length; i += 1) {
      var t = found[i];
      // Node may have been detached by an earlier replacement in this pass.
      if (!t.parentNode || (t.ownerDocument && t.ownerDocument.contains && !t.ownerDocument.contains(t))) {
        // contains() may be missing on partial JSDOM nodes; fall back to parent check.
        if (!t.parentNode) continue;
      }
      var c = convertTextNode(t, rates, mode, tableSafe);
      if (c > 0) {
        count += c;
        nodes += 1;
      }
    }
    return { count: count, nodes: nodes };
  }

  /** Restore every converted node under root to its original text. */
  function restoreConverted(restoreRoot) {
    if (restoreRoot == null) {
      try {
        restoreRoot = typeof document !== 'undefined' ? document : null;
      } catch (_) {
        restoreRoot = null;
      }
    }
    if (!restoreRoot) return { restored: 0 };
    var doc = restoreRoot.nodeType === 9 ? restoreRoot : restoreRoot.ownerDocument;
    var scope = restoreRoot.nodeType === 9 ? (restoreRoot.documentElement || restoreRoot) : restoreRoot;
    if (!scope || !scope.querySelectorAll) return { restored: 0 };
    var els = scope.querySelectorAll('[' + CONVERTED_ATTR + ']');
    var restored = 0;
    selfMutating = true;
    try {
      els.forEach(function (el) {
        var original = el.getAttribute(ORIGINAL_ATTR);
        if (original == null) original = el.textContent;
        el.replaceWith(doc.createTextNode(original));
        restored += 1;
      });
    } finally {
      selfMutating = false;
    }
    return { restored: restored };
  }

  /** Re-run scan from the current state (restore first when switching modes). */
  function rescan(rescanRoot, options) {
    if (options === undefined) options = {};
    var nextMode = options.mode !== undefined && options.mode !== null ? options.mode : currentState.mode;
    void nextMode;
    var needRestore = options.reset !== false;
    if (needRestore) {
      try {
        restoreConverted(rescanRoot !== undefined && rescanRoot !== null
          ? rescanRoot
          : (typeof document !== 'undefined' ? document : null));
      } catch (_) { /* noop */ }
    }
    return scanAndConvert(rescanRoot, options);
  }

  function scheduleRescan(schedRoot) {
    if (debounceTimer) {
      try {
        clearTimeout(debounceTimer);
      } catch (_) { /* noop */ }
    }
    debounceTimer = setTimeout(function () {
      debounceTimer = 0;
      if (selfMutating) return;
      if (currentState.enabled === false) return;
      try {
        var r = scanAndConvert(schedRoot);
        reportCount(r.count);
      } catch (_) { /* noop */ }
    }, 200);
  }

  /** Observe SPA/pagination mutations and rescan (debounced ~200ms). */
  function observeDynamic(obsRoot) {
    var view = viewOf(obsRoot);
    var MO = (view && view.MutationObserver) || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (!MO || !obsRoot) return null;
    var target = obsRoot.nodeType === 9 ? (obsRoot.body || obsRoot.documentElement) : obsRoot;
    if (!target) return null;
    var obs = new MO(function () {
      if (selfMutating) return;
      scheduleRescan(obsRoot);
    });
    obs.observe(target, { childList: true, characterData: true, subtree: true });
    return obs;
  }

  function setRates(rates) {
    currentRates = {};
    var k2;
    for (k2 in DEFAULT_RATES) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_RATES, k2)) currentRates[k2] = DEFAULT_RATES[k2];
    }
    var src = rates || {};
    for (k2 in src) {
      if (Object.prototype.hasOwnProperty.call(src, k2)) currentRates[k2] = src[k2];
    }
  }

  function setState(patch) {
    var src = patch || {};
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) currentState[key] = src[key];
    }
  }

  function getState() {
    var ratesCopy = {};
    for (var key in currentRates) {
      if (Object.prototype.hasOwnProperty.call(currentRates, key)) ratesCopy[key] = currentRates[key];
    }
    return { enabled: currentState.enabled, mode: currentState.mode, tableSafe: currentState.tableSafe !== false, rates: ratesCopy };
  }

  function loadInitialState() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        return chrome.runtime.sendMessage({ type: 'vnd:get-state' }).then(function (res) {
          if (res && res.ok) {
            if (res.rates) {
              setRates(res.rates);
            }
            currentState = {
              enabled: res.enabled !== undefined && res.enabled !== null ? res.enabled : true,
              mode: res.mode !== undefined && res.mode !== null ? res.mode : 'append',
              tableSafe: res.tableSafe !== undefined && res.tableSafe !== null ? res.tableSafe : true,
            };
            return;
          }
          return loadFromStorage();
        }).catch(function () { return loadFromStorage(); });
      }
    } catch (_) { /* fall through to storage/defaults */ }
    return loadFromStorage();
  }

  function loadFromStorage() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.TABLE_SAFE]).then(function (got) {
          currentState = {
            enabled: got && got[STORAGE_KEYS.ENABLED] !== undefined && got[STORAGE_KEYS.ENABLED] !== null
              ? got[STORAGE_KEYS.ENABLED]
              : true,
            mode: got && got[STORAGE_KEYS.MODE] !== undefined && got[STORAGE_KEYS.MODE] !== null
              ? got[STORAGE_KEYS.MODE]
              : 'append',
            tableSafe: got && got[STORAGE_KEYS.TABLE_SAFE] !== undefined && got[STORAGE_KEYS.TABLE_SAFE] !== null
              ? got[STORAGE_KEYS.TABLE_SAFE]
              : true,
          };
        }).catch(function () { /* defaults */ });
      }
    } catch (_) { /* defaults */ }
    return Promise.resolve();
  }

  function reportCount(count) {
    void count;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
        var p = chrome.runtime.sendMessage({ type: 'vnd:report-count', count: count });
        if (p && typeof p.catch === 'function') p.catch(function () { /* noop */ });
      }
    } catch (_) { /* noop */ }
    try {
      if (typeof window !== 'undefined') {
        window.__vndConvertedCount = (window.__vndConvertedCount || 0) + 0; // keep hook alive
      }
    } catch (_) { /* noop */ }
    return Promise.resolve();
  }

  function initVND(initRoot) {
    var docRoot = initRoot !== undefined && initRoot !== null
      ? initRoot
      : (typeof document !== 'undefined' ? document : null);
    return loadInitialState().then(function () {
      if (!docRoot) return { count: 0, nodes: 0 };
      var r = scanAndConvert(docRoot);
      return reportCount(r.count).then(function () {
        observeDynamic(docRoot);
        return r;
      });
    });
  }

  // Auto-boot in a real page (not under Node/JSDOM tests).
  try {
    var ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    var underNode = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (!underNode && !/jsdom/i.test(ua) && typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { initVND(document); });
      } else {
        initVND(document);
      }
    }
  } catch (_) { /* noop */ }

  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        var needRescan = false;
        if (changes[STORAGE_KEYS.MODE]) {
          currentState.mode = changes[STORAGE_KEYS.MODE].newValue !== undefined && changes[STORAGE_KEYS.MODE].newValue !== null
            ? changes[STORAGE_KEYS.MODE].newValue
            : 'append';
          needRescan = true;
        }
        if (changes[STORAGE_KEYS.ENABLED]) {
          currentState.enabled = changes[STORAGE_KEYS.ENABLED].newValue !== undefined && changes[STORAGE_KEYS.ENABLED].newValue !== null
            ? changes[STORAGE_KEYS.ENABLED].newValue
            : true;
          needRescan = true;
        }
        if (changes[STORAGE_KEYS.TABLE_SAFE]) {
          currentState.tableSafe = changes[STORAGE_KEYS.TABLE_SAFE].newValue !== undefined && changes[STORAGE_KEYS.TABLE_SAFE].newValue !== null
            ? changes[STORAGE_KEYS.TABLE_SAFE].newValue
            : true;
          needRescan = true;
        }
        if (needRescan && typeof document !== 'undefined') {
          try {
            restoreConverted(document);
          } catch (_) { /* noop */ }
          if (currentState.enabled === false) {
            try {
              reportCount(0);
            } catch (_) { /* noop */ }
          } else if (currentState.enabled) {
            try {
              var r = scanAndConvert(document);
              reportCount(r.count);
            } catch (_) { /* noop */ }
          }
        }
      });
    }
  } catch (_) { /* noop */ }

  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (msg && msg.type === 'vnd:rescan' && typeof document !== 'undefined') {
          currentState.enabled = msg.enabled !== false;
          if (msg && msg.tableSafe !== undefined && msg.tableSafe !== null) {
            currentState.tableSafe = msg.tableSafe;
          }
          if (currentState.enabled === false) {
            restoreConverted(document);
            reportCount(0).then(function () {
              sendResponse({ ok: true, count: 0, nodes: 0 });
            });
          } else {
            restoreConverted(document);
            var r = scanAndConvert(document);
            reportCount(r.count).then(function () {
              sendResponse({ ok: true, count: r.count, nodes: r.nodes });
            });
          }
          return true;
        }
        if (msg && msg.type === 'vnd:restore' && typeof document !== 'undefined') {
          currentState.enabled = false;
          var out = restoreConverted(document);
          reportCount(0).then(function () {
            sendResponse({ ok: true, restored: out.restored });
          });
          return true;
        }
        return undefined;
      });
    }
  } catch (_) { /* noop */ }

  root.CurrencyContent = {
    FORBIDDEN_TAGS: FORBIDDEN_TAGS,
    CONVERTED_ATTR: CONVERTED_ATTR,
    ORIGINAL_ATTR: ORIGINAL_ATTR,
    CONVERTED_CLASS: CONVERTED_CLASS,
    DISPLAY_MODES: DISPLAY_MODES,
    DEFAULT_STATE: DEFAULT_STATE,
    isSkipped: isSkipped,
    isInsideTable: isInsideTable,
    isTruncatedContext: isTruncatedContext,
    collectTextNodes: collectTextNodes,
    convertTextNode: convertTextNode,
    scanAndConvert: scanAndConvert,
    restoreConverted: restoreConverted,
    rescan: rescan,
    observeDynamic: observeDynamic,
    setRates: setRates,
    setState: setState,
    getState: getState,
    initVND: initVND,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
