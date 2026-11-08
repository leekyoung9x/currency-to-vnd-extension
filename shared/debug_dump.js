/**
 * shared/debug_dump.js — DOM diagnostic dump for the popup "Get DOM" button.
 * Classic script (IIFE): exposes `VndDebugDump` so the popup can inject this
 * file into the active tab via chrome.scripting and call
 * `VndDebugDump.collect(document)`. The dump is built to answer "why didn't
 * this price convert?": unlike a raw outerHTML copy (which MERGES adjacent
 * text nodes during serialization), it records the exact childNodes tree —
 * node types and per-node text — of every element that looks like a split
 * currency amount, plus extension version/state and conversion counts.
 */
(function (root) {
  'use strict';

  var HINT_RE = /[$€£¥₹₩฿]|USD|EUR|GBP|JPY|CNY|KRW|CAD|AUD|SGD|INR|THB|TWD|HKD/;
  var MAX_TEXT = 120;

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function classOf(el) {
    try {
      if (typeof el.className === 'string') return el.className;
      if (el.className && el.className.baseVal !== undefined) return el.className.baseVal;
    } catch (_) { /* noop */ }
    return '';
  }

  /** Recursive node-type tree: the part outerHTML cannot show. */
  function nodeTree(node, depth) {
    if (!node) return null;
    if (node.nodeType === 3) return { t: 3, text: truncate(node.nodeValue, 80) };
    if (node.nodeType === 8) return { t: 8, comment: truncate(node.nodeValue, 40) };
    if (node.nodeType !== 1) return { t: node.nodeType };
    var out = { t: 1, tag: (node.tagName || '').toLowerCase(), cls: truncate(classOf(node), 120) };
    try {
      if (node.getAttribute) {
        var keep = ['data-vnd-converted', 'data-vnd-inserted', 'data-vnd-unwrap', 'aria-hidden', 'hidden', 'style', 'role'];
        for (var i = 0; i < keep.length; i += 1) {
          var v = node.getAttribute(keep[i]);
          if (v != null) out[keep[i]] = truncate(v, 120);
        }
      }
    } catch (_) { /* noop */ }
    if (depth > 0 && node.childNodes && node.childNodes.length > 0) {
      out.kids = [];
      for (var k = 0; k < node.childNodes.length; k += 1) {
        out.kids.push(nodeTree(node.childNodes[k], depth - 1));
      }
    } else if (node.childNodes && node.childNodes.length > 0) {
      out.kids = '(+' + node.childNodes.length + ' nodes)';
    }
    return out;
  }

  function cssPath(el) {
    var parts = [];
    var cur = el;
    var guard = 0;
    while (cur && cur.nodeType === 1 && guard < 7) {
      var seg = (cur.tagName || '').toLowerCase();
      try {
        var parent = cur.parentElement;
        if (parent) {
          var sibs = [];
          for (var i = 0; i < parent.children.length; i += 1) {
            if (parent.children[i].tagName === cur.tagName) sibs.push(parent.children[i]);
          }
          if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        }
      } catch (_) { /* noop */ }
      parts.unshift(seg);
      cur = cur.parentElement;
      guard += 1;
    }
    return parts.join(' > ');
  }

  /** Direct-child joined text, mirroring the split-node scan criteria. */
  function directJoined(el) {
    var parts = [];
    for (var i = 0; i < el.childNodes.length; i += 1) {
      var kid = el.childNodes[i];
      if (kid.nodeType === 3) parts.push(kid.nodeValue || '');
      else if (kid.nodeType === 1 && (!kid.children || kid.children.length === 0)) parts.push(kid.textContent || '');
    }
    return parts.join('');
  }

  function queryCount(doc, sel) {
    try { return doc.querySelectorAll(sel).length; } catch (_) { return -1; }
  }

  function collect(doc, opts) {
    opts = opts || {};
    var maxCandidates = opts.maxCandidates != null ? opts.maxCandidates : 120;
    var view = doc.defaultView || (typeof window !== 'undefined' ? window : null);

    var dump = {
      kind: 'vnd-debug-dump',
      dumpVersion: 1,
      capturedAt: new Date().toISOString(),
      url: '',
      title: '',
      extension: {
        manifestVersion: null,
        hasCurrencyContent: false,
        hasSplitScan: false,
        state: null,
      },
      counts: {},
      candidates: [],
      candidatesTotal: 0,
      html: null,
    };
    try { dump.url = String(doc.location && doc.location.href || ''); } catch (_) { /* noop */ }
    try { dump.title = String(doc.title || ''); } catch (_) { /* noop */ }

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        dump.extension.manifestVersion = chrome.runtime.getManifest().version || null;
      }
    } catch (_) { /* noop */ }
    try {
      var cc = (view && view.CurrencyContent) || root.CurrencyContent || null;
      dump.extension.hasCurrencyContent = !!cc;
      dump.extension.hasSplitScan = !!(cc && typeof cc.scanSplitAmounts === 'function');
      if (cc && typeof cc.getState === 'function') dump.extension.state = cc.getState();
    } catch (_) { /* noop */ }

    dump.counts = {
      convertedTrue: queryCount(doc, '[data-vnd-converted="true"]'),
      convertedCluster: queryCount(doc, '[data-vnd-converted="cluster"]'),
      inserted: queryCount(doc, '[data-vnd-inserted]'),
      badges: queryCount(doc, '.vnd-badge'),
      sublines: queryCount(doc, '.vnd-subline'),
      replaces: queryCount(doc, '.vnd-replace'),
      hovers: queryCount(doc, '.vnd-hover'),
    };

    var scope = doc.documentElement;
    if (scope && scope.querySelectorAll) {
      var detect = null;
      try {
        var cu = (view && view.CurrencyUtils) || root.CurrencyUtils || null;
        if (cu && typeof cu.detectCurrencyAmounts === 'function') detect = cu.detectCurrencyAmounts;
      } catch (_) { /* noop */ }

      var all = scope.querySelectorAll('*');
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i];
        if (!el.childNodes || el.childNodes.length < 2 || el.childNodes.length > 24) continue;
        var hasText = false;
        for (var k = 0; k < el.childNodes.length; k += 1) {
          if (el.childNodes[k].nodeType === 3 && (el.childNodes[k].nodeValue || '')) { hasText = true; break; }
        }
        if (!hasText) continue;
        var joined = directJoined(el);
        if (!joined || joined.length > MAX_TEXT || !HINT_RE.test(joined)) continue;
        dump.candidatesTotal += 1;
        if (dump.candidates.length >= maxCandidates) continue;

        var entry = {
          path: cssPath(el),
          tag: (el.tagName || '').toLowerCase(),
          cls: truncate(classOf(el), 160),
          joinedText: truncate(joined, 160),
          childNodeTexts: [],
          tree: nodeTree(el, 4),
          convertedInside: false,
          selfConverted: null,
          display: null,
          visibility: null,
        };
        for (var c = 0; c < el.childNodes.length; c += 1) {
          var kid2 = el.childNodes[c];
          if (kid2.nodeType === 3) entry.childNodeTexts.push({ t: 3, text: truncate(kid2.nodeValue, 80) });
          else if (kid2.nodeType === 1) entry.childNodeTexts.push({ t: 1, tag: (kid2.tagName || '').toLowerCase(), cls: truncate(classOf(kid2), 80), text: truncate(kid2.textContent, 80) });
          else entry.childNodeTexts.push({ t: kid2.nodeType });
        }
        try {
          entry.convertedInside = !!el.querySelector('[data-vnd-converted]');
          entry.selfConverted = el.getAttribute && el.getAttribute('data-vnd-converted');
        } catch (_) { /* noop */ }
        if (detect) {
          try {
            entry.matchesOnJoined = detect(joined).map(function (m) {
              return { raw: m.raw, currency: m.currency, amount: m.amount, index: m.index };
            });
          } catch (_) { /* noop */ }
        }
        try {
          if (view && view.getComputedStyle) {
            var cs = view.getComputedStyle(el);
            entry.display = cs.display;
            entry.visibility = cs.visibility;
          }
        } catch (_) { /* noop */ }
        dump.candidates.push(entry);
      }
    }

    if (opts.includeHtml !== false) {
      try { dump.html = doc.documentElement ? doc.documentElement.outerHTML : null; } catch (_) { dump.html = null; }
    }
    return dump;
  }

  root.VndDebugDump = { collect: collect, nodeTree: nodeTree };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
