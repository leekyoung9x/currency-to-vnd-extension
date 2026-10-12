/**
 * content/content.js — DOM scanning, conversion badges, restore & live updates.
 * ESM module (imported by tests via JSDOM; loaded by MV3 as a module script).
 */
import {
  detectCurrencyAmounts,
  convertToVND,
  formatVND,
  DEFAULT_RATES,
} from '../shared/currency.js';
import { STORAGE_KEYS } from '../shared/rates.js';

export const FORBIDDEN_TAGS = Object.freeze(
  new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']),
);
export const CONVERTED_ATTR = 'data-vnd-converted';
export const ORIGINAL_ATTR = 'data-original-text';
export const CONVERTED_CLASS = 'vnd-converted';

export const DISPLAY_MODES = Object.freeze(['append', 'replace', 'hover']);
export const DEFAULT_STATE = Object.freeze({ enabled: true, mode: 'append' });

let currentRates = { ...DEFAULT_RATES };
let currentState = { ...DEFAULT_STATE };
let debounceTimer = 0;
let selfMutating = false;

function viewOf(root) {
  if (root && root.defaultView) return root.defaultView; // Document
  if (root && root.ownerDocument && root.ownerDocument.defaultView) {
    return root.ownerDocument.defaultView;
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
export function isSkipped(node) {
  let el = node && node.nodeType === 1 ? node : node?.parentElement ?? null;
  if (!el && node && node.parentNode) {
    let p = node.parentNode;
    while (p && p.nodeType === 1) {
      const tag = (p.tagName || '').toUpperCase();
      if (FORBIDDEN_TAGS.has(tag)) return true;
      if (p.getAttribute && p.getAttribute('contenteditable') === 'true') return true;
      if (p.isContentEditable) return true;
      if (p.hasAttribute && p.hasAttribute(CONVERTED_ATTR)) return true;
      p = p.parentNode;
    }
    return false;
  }
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = (cur.tagName || '').toUpperCase();
    if (FORBIDDEN_TAGS.has(tag)) return true;
    if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') return true;
    if (cur.isContentEditable) return true;
    if (cur.hasAttribute && cur.hasAttribute(CONVERTED_ATTR)) return true;
    cur = cur.parentNode;
  }
  return false;
}

/** Collect convertible text nodes under root via TreeWalker. */
export function collectTextNodes(root) {
  const doc = root && root.nodeType === 9 ? root : root?.ownerDocument ?? null;
  const view = viewOf(root);
  const scope = root && root.nodeType === 1 ? root : doc?.documentElement ?? root;
  if (!scope || typeof scope.ownerDocument === 'undefined' && scope.nodeType !== 9 && scope.nodeType !== 1) {
    return [];
  }
  const context = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!context || !context.createTreeWalker) return [];
  const walker = context.createTreeWalker(scope, showTextConst(view), {
    acceptNode(node) {
      const NF = view?.NodeFilter ?? (typeof NodeFilter !== 'undefined' ? NodeFilter : null);
      const ACCEPT = NF?.FILTER_ACCEPT ?? 1;
      const REJECT = NF?.FILTER_REJECT ?? 2;
      if (!node.nodeValue || !node.nodeValue.trim()) return REJECT;
      if (isSkipped(node)) return REJECT;
      return ACCEPT;
    },
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

function vndFor(match, rates) {
  const v = convertToVND(match.amount, match.currency, rates);
  return v == null ? null : v;
}

function formatRateBadge(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return '';
  return String(Math.round(r)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * Convert one text node in place. Returns number of converted amounts.
 * Wraps the node in a marked span so restore() + skip-logic work.
 */
export function convertTextNode(textNode, rates = currentRates, mode = currentState.mode) {
  if (!textNode || textNode.nodeType !== 3) return 0;
  const original = textNode.nodeValue;
  if (!original || !original.trim()) return 0;
  if (isSkipped(textNode)) return 0;
  const matches = detectCurrencyAmounts(original);
  if (matches.length === 0) return 0;

  const doc = textNode.ownerDocument;
  if (!doc) return 0;
  const wrapper = doc.createElement('span');
  wrapper.setAttribute('class', CONVERTED_CLASS);
  wrapper.setAttribute(CONVERTED_ATTR, 'true');
  wrapper.setAttribute(ORIGINAL_ATTR, original);

  let cursor = 0;
  let converted = 0;
  const pushText = (s) => {
    if (s) wrapper.appendChild(doc.createTextNode(s));
  };

  for (const m of matches) {
    const vnd = vndFor(m, rates);
    if (vnd == null) continue;
    pushText(original.slice(cursor, m.index));
    const label = formatVND(vnd);
    if (mode === 'replace') {
      const s = doc.createElement('span');
      s.setAttribute('class', 'vnd-replace');
      s.setAttribute('data-original', m.raw);
      s.setAttribute('title', `Gốc: ${m.raw}`);
      s.textContent = label;
      wrapper.appendChild(s);
    } else if (mode === 'hover') {
      const s = doc.createElement('span');
      s.setAttribute('class', 'vnd-hover');
      s.setAttribute('data-original', m.raw);
      const rate = (rates || {})[m.currency] ?? DEFAULT_RATES[m.currency];
      s.setAttribute('data-vnd-tooltip', `≈ ${label} (Tỷ giá: ${formatRateBadge(rate)})`);
      s.textContent = m.raw;
      wrapper.appendChild(s);
    } else {
      // append (default): keep original, add badge beside it.
      pushText(m.raw);
      const s = doc.createElement('span');
      s.setAttribute('class', 'vnd-badge');
      s.setAttribute('data-original', m.raw);
      s.textContent = ` (≈ ${label})`;
      wrapper.appendChild(s);
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
 * @returns {{ count: number, nodes: number }} converted amounts + wrapped nodes.
 */
export function scanAndConvert(root, options = {}) {
  const rates = options.rates ?? currentRates;
  const mode = options.mode ?? currentState.mode;
  const enabled = options.enabled ?? currentState.enabled;
  if (enabled === false) return { count: 0, nodes: 0 };
  if (root == null) {
    try {
      root = typeof document !== 'undefined' ? document : null;
    } catch (_) {
      root = null;
    }
  }
  if (!root) return { count: 0, nodes: 0 };
  let count = 0;
  let nodes = 0;
  for (const t of collectTextNodes(root)) {
    // Node may have been detached by an earlier replacement in this pass.
    if (!t.parentNode || !t.ownerDocument?.contains?.(t)) {
      // contains() may be missing on partial JSDOM nodes; fall back to parent check.
      if (!t.parentNode) continue;
    }
    const c = convertTextNode(t, rates, mode);
    if (c > 0) {
      count += c;
      nodes += 1;
    }
  }
  return { count, nodes };
}

/** Restore every converted node under root to its original text. */
export function restoreConverted(root) {
  if (root == null) {
    try {
      root = typeof document !== 'undefined' ? document : null;
    } catch (_) {
      root = null;
    }
  }
  if (!root) return { restored: 0 };
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const scope = root.nodeType === 9 ? root.documentElement ?? root : root;
  if (!scope || !scope.querySelectorAll) return { restored: 0 };
  const els = scope.querySelectorAll(`[${CONVERTED_ATTR}]`);
  let restored = 0;
  selfMutating = true;
  try {
    els.forEach((el) => {
      const original = el.getAttribute(ORIGINAL_ATTR) ?? el.textContent;
      el.replaceWith(doc.createTextNode(original));
      restored += 1;
    });
  } finally {
    selfMutating = false;
  }
  return { restored };
}

/** Re-run scan from the current state (restore first when switching modes). */
export function rescan(root, options = {}) {
  const nextMode = options.mode ?? currentState.mode;
  const needRestore = options.reset !== false;
  if (needRestore) {
    try {
      restoreConverted(root ?? (typeof document !== 'undefined' ? document : null));
    } catch (_) { /* noop */ }
  }
  return scanAndConvert(root, options);
}

function scheduleRescan(root) {
  if (debounceTimer) {
    try {
      clearTimeout(debounceTimer);
    } catch (_) { /* noop */ }
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = 0;
    if (selfMutating) return;
    if (currentState.enabled === false) return;
    try {
      const r = scanAndConvert(root);
      reportCount(r.count);
    } catch (_) { /* noop */ }
  }, 200);
}

/** Observe SPA/pagination mutations and rescan (debounced ~200ms). */
export function observeDynamic(root) {
  const view = viewOf(root);
  const MO = view?.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  if (!MO || !root) return null;
  const target = root.nodeType === 9 ? (root.body ?? root.documentElement) : root;
  if (!target) return null;
  const obs = new MO(() => {
    if (selfMutating) return;
    scheduleRescan(root);
  });
  obs.observe(target, { childList: true, characterData: true, subtree: true });
  return obs;
}

export function setRates(rates) {
  currentRates = { ...DEFAULT_RATES, ...(rates || {}) };
}

export function setState(patch) {
  currentState = { ...currentState, ...(patch || {}) };
}

export function getState() {
  return { ...currentState, rates: { ...currentRates } };
}

async function loadInitialState() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      const res = await chrome.runtime.sendMessage({ type: 'vnd:get-state' });
      if (res?.ok) {
        if (res.rates) currentRates = { ...DEFAULT_RATES, ...res.rates };
        currentState = {
          enabled: res.enabled ?? true,
          mode: res.mode ?? 'append',
        };
        return;
      }
    }
  } catch (_) { /* fall through to storage/defaults */ }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const got = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE]);
      currentState = {
        enabled: got?.[STORAGE_KEYS.ENABLED] ?? true,
        mode: got?.[STORAGE_KEYS.MODE] ?? 'append',
      };
    }
  } catch (_) { /* defaults */ }
}

async function reportCount(count) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      await chrome.runtime.sendMessage({ type: 'vnd:report-count', count });
    }
  } catch (_) { /* noop */ }
  try {
    if (typeof window !== 'undefined') {
      window.__vndConvertedCount = (window.__vndConvertedCount || 0) + 0; // keep hook alive
    }
  } catch (_) { /* noop */ }
}

export async function initVND(root) {
  const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
  await loadInitialState();
  if (!docRoot) return { count: 0, nodes: 0 };
  const r = scanAndConvert(docRoot);
  await reportCount(r.count);
  observeDynamic(docRoot);
  return r;
}

// Auto-boot in a real page (not under Node/JSDOM tests).
try {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const underNode = typeof process !== 'undefined' && process.versions?.node;
  if (!underNode && !/jsdom/i.test(ua) && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initVND(document));
    } else {
      initVND(document);
    }
  }
} catch (_) { /* noop */ }

try {
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let needRescan = false;
      if (changes[STORAGE_KEYS.MODE]) {
        currentState.mode = changes[STORAGE_KEYS.MODE].newValue ?? 'append';
        needRescan = true;
      }
      if (changes[STORAGE_KEYS.ENABLED]) {
        currentState.enabled = changes[STORAGE_KEYS.ENABLED].newValue ?? true;
        needRescan = true;
      }
      if (needRescan && typeof document !== 'undefined') {
        try {
          restoreConverted(document);
        } catch (_) { /* noop */ }
        if (currentState.enabled) {
          try {
            scanAndConvert(document);
          } catch (_) { /* noop */ }
        }
      }
    });
  }
} catch (_) { /* noop */ }

try {
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'vnd:rescan' && typeof document !== 'undefined') {
        (async () => {
          await loadInitialState();
          restoreConverted(document);
          const r = scanAndConvert(document);
          await reportCount(r.count);
          sendResponse({ ok: true, ...r });
        })();
        return true;
      }
      if (msg?.type === 'vnd:restore' && typeof document !== 'undefined') {
        sendResponse({ ok: true, ...restoreConverted(document) });
        return true;
      }
      return undefined;
    });
  }
} catch (_) { /* noop */ }
