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
  var inferHints = CurrencyUtils.inferHints;
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
  var INSERTED_ATTR = 'data-vnd-inserted';
  var UNWRAP_ATTR = 'data-vnd-unwrap';
  var CONVERTED_CLASS = 'vnd-converted';

  var DISPLAY_MODES = Object.freeze(['append', 'replace', 'hover']);
  var DEFAULT_STATE = Object.freeze({ enabled: true, mode: 'append', tableSafe: true });

  var currentRates = {};
  var k;
  for (k in DEFAULT_RATES) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_RATES, k)) currentRates[k] = DEFAULT_RATES[k];
  }
  var currentState = { enabled: DEFAULT_STATE.enabled, mode: DEFAULT_STATE.mode, tableSafe: DEFAULT_STATE.tableSafe };
  /** User settings for bare `$` / `¥`: 'auto' or an ISO code. */
  var currencySettings = { dollar: 'auto', yen: 'auto' };
  var DOLLAR_KEY = 'vnd_dollar_currency';
  var YEN_KEY = 'vnd_yen_currency';
  var lastCount = 0;
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

  /**
   * FIX-5: True when an element (and its subtree) is visually hidden, e.g.
   * Tailwind/Bootstrap `sr-only` / `visually-hidden` screen-reader twins or
   * `display: none`. React money components (Surplus Intelligence) render a
   * full `$0.003375` string ONLY inside such a twin while the visible copy
   * is split across sibling text nodes — badges inserted here never show.
   * NOTE: `aria-hidden` deliberately does NOT count as hidden: that same
   * pattern marks the *visible* copy `aria-hidden="true"`.
   */
  function hasHiddenClass(el) {
    var cls = '';
    try { cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal !== undefined ? el.className.baseVal : ''); } catch (_) { cls = ''; }
    if (!cls) return false;
    return /(?:^|\s)(sr-only|visually-hidden|visuallyhidden|screen-reader-only|v-hidden)(?:\s|$)/.test(cls);
  }

  function isVisuallyHiddenEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    if (hasHiddenClass(el)) return true;
    try {
      var style = el.getAttribute ? el.getAttribute('style') : null;
      if (style && /display\s*:\s*none/i.test(style)) return true;
    } catch (_) { /* noop */ }
    return false;
  }

  /**
   * FIX-5: Stricter check used by the split-node joiner: an inline child
   * whose text renders invisibly (Tailwind `invisible` alignment padding
   * such as the comma/indent pads inserted between price digits) must not
   * contribute characters to the joined amount string.
   */
  function isInvisibleForJoin(el) {
    if (isVisuallyHiddenEl(el)) return true;
    var cls = '';
    try { cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal !== undefined ? el.className.baseVal : ''); } catch (_) { cls = ''; }
    if (cls && /(?:^|\s)invisible(?:\s|$)/.test(cls)) return true;
    try {
      var style = el.getAttribute ? el.getAttribute('style') : null;
      if (style && /visibility\s*:\s*hidden/i.test(style)) return true;
    } catch (_) { /* noop */ }
    return false;
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
        if (isVisuallyHiddenEl(p)) return true;
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
      if (isVisuallyHiddenEl(cur)) return true;
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

  /**
   * Work out what a bare `$` / `¥` means on this page from the user
   * settings, price metadata (`itemprop=priceCurrency`, `og:price:currency`),
   * `<html lang>` and the hostname TLD.
   */
  function pageHints(base) {
    var doc = base && base.nodeType === 9 ? base : (base && base.ownerDocument) || null;
    var metas = [];
    var lang = '';
    var hostname = '';
    try {
      if (doc && doc.querySelectorAll) {
        doc.querySelectorAll(
          '[itemprop="priceCurrency"], meta[property="og:price:currency"], meta[property="product:price:currency"]'
        ).forEach(function (el) {
          var v = el.getAttribute('content') || el.textContent;
          if (v) metas.push(v);
        });
      }
      lang = (doc && doc.documentElement && doc.documentElement.getAttribute('lang')) || '';
      var view = viewOf(doc);
      hostname = (view && view.location && view.location.hostname) || '';
    } catch (_) { /* best effort */ }
    if (typeof inferHints !== 'function') return { dollar: 'USD', yen: 'JPY' };
    return inferHints({
      hostname: hostname,
      lang: lang,
      metaCurrencies: metas,
      dollar: currencySettings.dollar,
      yen: currencySettings.yen,
    });
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

  /** `1 CAD = 19.000 ₫` (+ note when the code was guessed from the page). */
  function rateInfo(match, rates) {
    var table = rates || {};
    var rate = table[match.currency] !== undefined && table[match.currency] !== null
      ? table[match.currency]
      : DEFAULT_RATES[match.currency];
    var text = '1 ' + match.currency + ' = ' + (Number(rate) >= 100 ? formatRateBadge(rate) + ' ₫' : formatVND(rate));
    return match.assumed ? text + ' · đoán theo trang, đổi trong popup' : text;
  }

  /**
   * Convert one text node in place. Returns number of converted amounts.
   * Wraps the node in a marked span so restore() + skip-logic work.
   */
  function convertTextNode(textNode, rates, mode, tableSafe, hints) {
    if (rates === undefined) rates = currentRates;
    if (mode === undefined) mode = currentState.mode;
    if (tableSafe === undefined || tableSafe === null) tableSafe = currentState.tableSafe !== false;
    if (!textNode || textNode.nodeType !== 3) return 0;
    var original = textNode.nodeValue;
    if (!original || !original.trim()) return 0;
    if (isSkipped(textNode)) return 0;
    if (!hints) hints = pageHints(textNode.ownerDocument);
    var matches = detectCurrencyAmounts(original, rates, hints);
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
      var info = rateInfo(m, rates);
      if (mode === 'replace') {
        var s = doc.createElement('span');
        s.setAttribute('class', 'vnd-replace');
        s.setAttribute('data-original', m.raw);
        s.setAttribute('title', 'Gốc: ' + m.raw);
        s.setAttribute('data-vnd-rate', info);
        s.textContent = label;
        wrapper.appendChild(s);
      } else if (mode === 'hover' || wantHoverFallback) {
        var h = doc.createElement('span');
        h.setAttribute('class', 'vnd-hover');
        h.setAttribute('data-original', m.raw);
        h.setAttribute('data-vnd-tooltip', '≈ ' + label + ' (' + info + ')');
        h.textContent = m.raw;
        wrapper.appendChild(h);
      } else {
        // append (default): keep original, add badge beside it.
        pushText(m.raw);
        var b = doc.createElement('span');
        b.setAttribute('class', 'vnd-badge');
        b.setAttribute('data-original', m.raw);
        b.setAttribute('title', info);
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
   * FIX-5: Split-node amounts. React money components (Surplus Intelligence
   * `<Money>`, many dashboards) render one visible amount as several
   * sibling text nodes — `"$"` + `"0"` + `"."` + `"003375"` — padded with
   * invisible alignment spans. No single text node matches the currency
   * regex, so join consecutive inline siblings, detect on the joined
   * string, and convert matches that span multiple nodes.
   */
  var CLUSTER_TAGS = Object.freeze(new Set([
    'SPAN', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'SUB', 'SUP',
    'MARK', 'ABBR', 'TIME', 'DATA', 'FONT', 'U', 'S',
  ]));
  var CURRENCY_HINT_RE = /[$€£¥₹₩฿]|USD|EUR|GBP|JPY|CNY|KRW|CAD|AUD|SGD|INR|THB|TWD|HKD/;

  /** Segments of one run: { domNode, text, start, end } over joined text. */
  function buildRuns(parent) {
    var runs = [];
    var segments = [];
    var joined = '';
    function flush() {
      if (segments.length > 0) runs.push({ segments: segments, text: joined });
      segments = [];
      joined = '';
    }
    function push(domNode, text) {
      segments.push({ domNode: domNode, text: text, start: joined.length, end: joined.length + text.length });
      joined += text;
    }
    var kids = parent.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid.nodeType === 8) continue; // React comment separators are transparent
      if (kid.nodeType === 3) {
        push(kid, kid.nodeValue || '');
        continue;
      }
      if (kid.nodeType === 1) {
        var tag = (kid.tagName || '').toUpperCase();
        if (!CLUSTER_TAGS.has(tag) || (kid.children && kid.children.length > 0)) {
          flush();
          continue;
        }
        // Invisible padding (Tailwind `invisible` digit/comma pads) keeps
        // its slot in the run but contributes no characters.
        push(kid, isInvisibleForJoin(kid) ? '' : (kid.textContent || ''));
        continue;
      }
      flush();
    }
    flush();
    return runs;
  }

  function insertAfter(newNode, refNode) {
    if (refNode && refNode.parentNode) refNode.parentNode.insertBefore(newNode, refNode.nextSibling);
  }

  /** Build conversion plans for one run without touching the DOM. */
  function planRun(run, rates) {
    var plans = [];
    if (!run || !run.text || run.text.length > 120) return plans;
    var nonEmpty = 0;
    for (var s = 0; s < run.segments.length; s += 1) {
      if (run.segments[s].text) nonEmpty += 1;
    }
    if (nonEmpty < 2 || !CURRENCY_HINT_RE.test(run.text)) return plans;
    var matches = detectCurrencyAmounts(run.text);
    for (var i = 0; i < matches.length; i += 1) {
      var m = matches[i];
      var mEnd = m.index + m.raw.length;
      var touched = [];
      for (var j = 0; j < run.segments.length; j += 1) {
        var seg = run.segments[j];
        if (seg.text && seg.end > m.index && seg.start < mEnd) touched.push(seg);
      }
      // A match inside a single node is convertTextNode's job (pass 1).
      if (touched.length < 2) continue;
      var vnd = vndFor(m, rates);
      if (vnd == null) continue;
      plans.push({ match: m, vnd: vnd, first: touched[0].domNode, last: touched[touched.length - 1].domNode });
    }
    return plans;
  }

  /**
   * Column-shape alignment for replaced amounts inside tables. Sites like
   * Surplus pad their own prices so every value in a column shares one
   * shape (decimal marks in a straight line, stable column width). A
   * plain replace destroys that: `288 ₫` next to `57,79 ₫` looks ragged.
   * So group converted VND values per table column, take the widest shape
   * (grouped-integer length + fraction digits), and pad each value with
   * an invisible leading span — the same trick the sites themselves use.
   */
  function fracDigitsNeeded(vnd) {
    var a = Math.abs(Number(vnd));
    if (!Number.isFinite(a) || a === 0) return 0;
    if (a >= 100) return 0;
    if (a >= 1) return 2;
    for (var dec = 2; dec <= 6; dec += 1) {
      if (Number(a.toFixed(dec)) !== 0) return dec;
    }
    return 6;
  }

  function groupedParts(vnd, fracDigits) {
    var n = Number(vnd);
    var neg = n < 0;
    var fixed = Math.abs(n).toFixed(fracDigits);
    var parts = fixed.split('.');
    var intStr = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return { neg: neg, intStr: intStr, fracStr: fracDigits > 0 ? (parts[1] || '') : '' };
  }

  function shapeOfValue(vnd) {
    var f = fracDigitsNeeded(vnd);
    var p = groupedParts(vnd, f);
    return { intLen: (p.neg ? 1 : 0) + p.intStr.length, frac: f };
  }

  /** Render a VND value into `container`, padded to the column shape. */
  function appendAlignedVND(doc, container, vnd, shape) {
    if (!shape) {
      container.textContent = formatVND(vnd);
      return;
    }
    var f = Math.max(shape.frac, fracDigitsNeeded(vnd));
    var p = groupedParts(vnd, f);
    var padLen = Math.max(0, shape.intLen - ((p.neg ? 1 : 0) + p.intStr.length));
    if (padLen > 0) {
      var pad = doc.createElement('span');
      pad.setAttribute('class', 'vnd-pad');
      pad.setAttribute('aria-hidden', 'true');
      pad.textContent = '0'.repeat(padLen);
      container.appendChild(pad);
    }
    container.appendChild(doc.createTextNode(
      (p.neg ? '-' : '') + p.intStr + (f > 0 ? ',' + p.fracStr : '') + ' ₫'
    ));
  }

  /** Locate { table, col } for a node inside a table cell, or null. */
  function tableColumnOf(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null);
    var cell = null;
    var table = null;
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var tag = (cur.tagName || '').toUpperCase();
      var role = cur.getAttribute ? String(cur.getAttribute('role') || '').toLowerCase() : '';
      if (!cell && (tag === 'TD' || tag === 'TH' || role === 'cell' || role === 'gridcell')) cell = cur;
      if (tag === 'TABLE' || role === 'table' || role === 'grid' || role === 'treegrid') { table = cur; break; }
      cur = cur.parentNode;
    }
    if (!cell || !table) return null;
    var col = -1;
    try {
      if (typeof cell.cellIndex === 'number' && cell.cellIndex >= 0) col = cell.cellIndex;
    } catch (_) { /* noop */ }
    if (col < 0 && cell.parentNode && cell.parentNode.children) {
      col = Array.prototype.indexOf.call(cell.parentNode.children, cell);
    }
    if (col < 0) return null;
    return { table: table, col: col };
  }

  /** Convert every multi-node match of one run. Returns converted count. */
  function convertRun(parent, run, rates, mode, tableSafe, plans, shape) {
    if (!plans) plans = planRun(run, rates);
    if (plans.length === 0) return 0;
    var doc = parent.ownerDocument;
    if (!doc) return 0;

    var converted = 0;
    selfMutating = true;
    try {
      if (mode === 'append') {
        var wantSubline = tableSafe && isInsideTable(parent);
        if (wantSubline) {
          var legs = [];
          for (var a = 0; a < plans.length; a += 1) legs.push(formatVND(plans[a].vnd));
          var sub = doc.createElement('span');
          sub.setAttribute('class', 'vnd-subline');
          sub.setAttribute(INSERTED_ATTR, '1');
          sub.setAttribute('data-original', plans.map(function (p) { return p.match.raw; }).join(' / '));
          sub.textContent = '≈ ' + legs.join(' / ');
          insertAfter(sub, plans[plans.length - 1].last);
          converted = plans.length;
        } else {
          for (var b = plans.length - 1; b >= 0; b -= 1) {
            var badge = doc.createElement('span');
            badge.setAttribute('class', 'vnd-badge');
            badge.setAttribute(INSERTED_ATTR, '1');
            badge.setAttribute('data-original', plans[b].match.raw);
            badge.textContent = ' (≈ ' + formatVND(plans[b].vnd) + ')';
            insertAfter(badge, plans[b].last);
            converted += 1;
          }
        }
        // Mark the run parent (not a wrapper): page DOM stays untouched,
        // rescans skip it, restore just removes the inserted nodes.
        parent.setAttribute(CONVERTED_ATTR, 'cluster');
        parent.setAttribute(ORIGINAL_ATTR, run.text);
      } else {
        // hover / replace need an anchor element: wrap the exact node
        // range of each match. hover wraps reversibly (unwrap restores
        // the original split nodes verbatim); replace stores the joined
        // visible text like convertTextNode does.
        for (var c = plans.length - 1; c >= 0; c -= 1) {
          var plan = plans[c];
          var rangeNodes = [];
          var curNode = plan.first;
          while (curNode) {
            rangeNodes.push(curNode);
            if (curNode === plan.last) break;
            curNode = curNode.nextSibling;
          }
          var wrap = doc.createElement('span');
          wrap.setAttribute('class', CONVERTED_CLASS);
          wrap.setAttribute(CONVERTED_ATTR, 'true');
          wrap.setAttribute(ORIGINAL_ATTR, plan.match.raw);
          parent.insertBefore(wrap, rangeNodes[0]);
          if (mode === 'hover') {
            wrap.setAttribute(UNWRAP_ATTR, '1');
            var hov = doc.createElement('span');
            hov.setAttribute('class', 'vnd-hover');
            hov.setAttribute('data-original', plan.match.raw);
            var rate = (rates || {})[plan.match.currency] !== undefined && (rates || {})[plan.match.currency] !== null
              ? (rates || {})[plan.match.currency]
              : DEFAULT_RATES[plan.match.currency];
            hov.setAttribute('data-vnd-tooltip', '≈ ' + formatVND(plan.vnd) + ' (Tỷ giá: ' + formatRateBadge(rate) + ')');
            for (var d = 0; d < rangeNodes.length; d += 1) hov.appendChild(rangeNodes[d]);
            wrap.appendChild(hov);
          } else {
            var rep = doc.createElement('span');
            rep.setAttribute('class', 'vnd-replace');
            rep.setAttribute('data-original', plan.match.raw);
            rep.setAttribute('title', 'Gốc: ' + plan.match.raw);
            if (shape && plans.length === 1) {
              appendAlignedVND(doc, rep, plan.vnd, shape);
            } else {
              rep.textContent = formatVND(plan.vnd);
            }
            for (var e = 0; e < rangeNodes.length; e += 1) {
              if (rangeNodes[e].parentNode) rangeNodes[e].parentNode.removeChild(rangeNodes[e]);
            }
            wrap.appendChild(rep);
          }
          converted += 1;
        }
      }
    } finally {
      selfMutating = false;
    }
    return converted;
  }

  /** FIX-5 pass 2: find amounts split across sibling nodes under root. */
  function scanSplitAmounts(scanRoot, rates, mode, tableSafe) {
    var count = 0;
    var nodes = 0;
    if (!scanRoot) return { count: 0, nodes: 0 };
    var scope = scanRoot.nodeType === 9 ? scanRoot.documentElement : scanRoot;
    if (!scope || !scope.querySelectorAll) return { count: 0, nodes: 0 };
    var candidates = [];
    if (scope.nodeType === 1 && scope.childNodes && scope.childNodes.length >= 2) {
      candidates.push(scope);
    }
    var all = scope.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      var tag = (el.tagName || '').toUpperCase();
      if (FORBIDDEN_TAGS.has(tag)) continue;
      if (!el.childNodes || el.childNodes.length < 2 || el.childNodes.length > 24) continue;
      var hasText = false;
      for (var k = 0; k < el.childNodes.length; k += 1) {
        if (el.childNodes[k].nodeType === 3 && (el.childNodes[k].nodeValue || '')) { hasText = true; break; }
      }
      if (hasText) candidates.push(el);
    }
    // Pre-plan every candidate so table columns can be shape-aligned
    // (replace mode) before any DOM mutation happens.
    var items = [];
    for (var c = 0; c < candidates.length; c += 1) {
      var parent = candidates[c];
      try {
        if (!parent.parentNode && parent !== scope) continue;
        if (isSkipped(parent)) continue;
        var runs = buildRuns(parent);
        var planned = [];
        var any = false;
        for (var r = 0; r < runs.length; r += 1) {
          var pl = planRun(runs[r], rates);
          planned.push({ run: runs[r], plans: pl });
          if (pl.length > 0) any = true;
        }
        if (any) items.push({ parent: parent, planned: planned });
      } catch (_) { /* one bad subtree must never break the page scan */ }
    }

    var shapes = new Map(); // planned entry -> column shape (replace only)
    if (mode === 'replace') {
      var byTable = new Map(); // table el -> Map(col -> shape)
      var colOf = new Map(); // planned entry -> { table, col }
      for (var a = 0; a < items.length; a += 1) {
        var it = items[a];
        var tc = null;
        try { tc = tableColumnOf(it.parent); } catch (_) { tc = null; }
        if (!tc) continue;
        for (var b = 0; b < it.planned.length; b += 1) {
          var entry = it.planned[b];
          if (entry.plans.length !== 1) continue;
          colOf.set(entry, tc);
          var cols = byTable.get(tc.table);
          if (!cols) { cols = new Map(); byTable.set(tc.table, cols); }
          var sh = shapeOfValue(entry.plans[0].vnd);
          var cur2 = cols.get(tc.col);
          if (!cur2) {
            cols.set(tc.col, { intLen: sh.intLen, frac: sh.frac, n: 1 });
          } else {
            cur2.intLen = Math.max(cur2.intLen, sh.intLen);
            cur2.frac = Math.max(cur2.frac, sh.frac);
            cur2.n += 1;
          }
        }
      }
      colOf.forEach(function (tc2, entry2) {
        var cols2 = byTable.get(tc2.table);
        var shape2 = cols2 && cols2.get(tc2.col);
        if (shape2 && shape2.n >= 2) shapes.set(entry2, shape2);
      });
    }

    for (var d = 0; d < items.length; d += 1) {
      var item = items[d];
      try {
        var parentConverted = 0;
        for (var e = 0; e < item.planned.length; e += 1) {
          var en = item.planned[e];
          parentConverted += convertRun(item.parent, en.run, rates, mode, tableSafe, en.plans, shapes.get(en) || null);
        }
        if (parentConverted > 0) {
          count += parentConverted;
          nodes += 1;
        }
      } catch (_) { /* one bad subtree must never break the page scan */ }
    }
    return { count: count, nodes: nodes };
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
    var hints = options.hints || pageHints(scanRoot);
    var found = collectTextNodes(scanRoot);
    for (var i = 0; i < found.length; i += 1) {
      var t = found[i];
      // Node may have been detached by an earlier replacement in this pass.
      if (!t.parentNode || (t.ownerDocument && t.ownerDocument.contains && !t.ownerDocument.contains(t))) {
        // contains() may be missing on partial JSDOM nodes; fall back to parent check.
        if (!t.parentNode) continue;
      }
      var c = convertTextNode(t, rates, mode, tableSafe, hints);
      if (c > 0) {
        count += c;
        nodes += 1;
      }
    }
    // FIX-5 pass 2: amounts split across sibling text/element nodes.
    try {
      var sp = scanSplitAmounts(scanRoot, rates, mode, tableSafe);
      count += sp.count;
      nodes += sp.nodes;
    } catch (_) { /* noop */ }
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
        // FIX-5 cluster mark: original DOM was never touched — drop the
        // inserted badge/subline nodes and the mark itself.
        if (el.getAttribute(CONVERTED_ATTR) === 'cluster') {
          var inserted = el.querySelectorAll('[' + INSERTED_ATTR + ']');
          inserted.forEach(function (n) {
            if (n.parentNode) n.parentNode.removeChild(n);
          });
          el.removeAttribute(CONVERTED_ATTR);
          el.removeAttribute(ORIGINAL_ATTR);
          restored += 1;
          return;
        }
        // FIX-5 hover wrap: unwrap (inner .vnd-hover first, then the
        // wrapper) so the original split nodes return byte-for-byte
        // instead of collapsing into one text node.
        if (el.hasAttribute(UNWRAP_ATTR) && el.parentNode) {
          var unwrapNode = function (n) {
            while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
            n.parentNode.removeChild(n);
          };
          var inner = el.firstElementChild;
          if (inner && inner.classList && inner.classList.contains('vnd-hover')) unwrapNode(inner);
          unwrapNode(el);
          restored += 1;
          return;
        }
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
            currencySettings = { dollar: res.dollar || 'auto', yen: res.yen || 'auto' };
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
        return chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.TABLE_SAFE, DOLLAR_KEY, YEN_KEY]).then(function (got) {
          currencySettings = { dollar: (got && got[DOLLAR_KEY]) || 'auto', yen: (got && got[YEN_KEY]) || 'auto' };
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
    lastCount = Number(count) || 0;
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
        if (changes[STORAGE_KEYS.RATES] || changes[STORAGE_KEYS.CUSTOM_RATES] ||
            changes[DOLLAR_KEY] || changes[YEN_KEY]) {
          // Rates or `$` / `¥` settings changed: reload merged state, then redraw.
          loadInitialState().then(function () {
            if (currentState.enabled === false || typeof document === 'undefined') return;
            try {
              restoreConverted(document);
              reportCount(scanAndConvert(document).count);
            } catch (_) { /* noop */ }
          });
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
        if (msg && msg.type === 'vnd:count?') {
          // lastCount only tracks the most recent (incremental) scan, so an
          // SPA rescan converting 0 new amounts would report 0 for a fully
          // converted page. Count live markers in the DOM instead.
          var domCount = 0;
          try {
            domCount = document.querySelectorAll('.vnd-replace, .vnd-badge, .vnd-subline, .vnd-hover').length;
          } catch (_) { /* noop */ }
          sendResponse({ ok: true, count: Math.max(lastCount, domCount), hints: pageHints(typeof document !== 'undefined' ? document : null) });
          return undefined;
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
    isVisuallyHiddenEl: isVisuallyHiddenEl,
    isInsideTable: isInsideTable,
    isTruncatedContext: isTruncatedContext,
    pageHints: pageHints,
    collectTextNodes: collectTextNodes,
    convertTextNode: convertTextNode,
    scanSplitAmounts: scanSplitAmounts,
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
