/**
 * shared/currency.js — Pure functions for currency detection, parsing,
 * conversion and VND formatting. No DOM / chrome.* dependencies.
 * Classic script (IIFE): exposes `CurrencyUtils` on the global scope so
 * Chrome MV3 content scripts, service worker (via importScripts) and
 * extension pages (via plain <script> tags) can use it without ESM.
 * Load order: currency.js FIRST, then rates.js, then content.js.
 */
(function (root) {
  'use strict';

  var DEFAULT_USD_VND = 26000;

  /** Canonical per-unit rates: 1 unit of foreign currency = X VND. */
  var DEFAULT_RATES = Object.freeze({
    USD: 26000,
    EUR: 28200,
    GBP: 33000,
    JPY: 175,
    CNY: 3600,
    KRW: 19,
    AUD: 17200,
    CAD: 19000,
    SGD: 19800,
    THB: 750,
    INR: 310,
    TWD: 850,
    HKD: 3350,
  });

  /** Symbol (or multi-char prefix) -> ISO code. Order matters: longest first. */
  var SYMBOL_TO_CODE = Object.freeze({
    'AU$': 'AUD',
    'NT$': 'TWD',
    'HK$': 'HKD',
    'C$': 'CAD',
    'A$': 'AUD',
    'S$': 'SGD',
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '₩': 'KRW',
    '₹': 'INR',
    '฿': 'THB',
  });

  var ISO_CODES = Object.freeze([
    'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW',
    'CAD', 'AUD', 'SGD', 'INR', 'THB', 'TWD', 'HKD',
  ]);

  var ESC = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var SYMBOLS_SORTED = Object.keys(SYMBOL_TO_CODE).sort(function (a, b) { return b.length - a.length; });
  var SYMBOL_ALT = SYMBOLS_SORTED.map(ESC).join('|');
  var CODE_ALT = ISO_CODES.join('|');

  /**
   * Master currency matcher. Each alternative captures:
   *  - Symbol-first:  sign? SYMBOL number      (e.g. $3.30, -$5, ~$5.00, C$10)
   *  - Code-first:    sign? CODE number        (e.g. USD 10, -$5 USD not matched; sign inside)
   *  - Code-last:     sign? number CODE        (e.g. 10 USD, 15.5 EUR, 100 JPY)
   * A global search finds every leg of `$0.070/$0.350` and `$10 - $20` separately.
   */
  var CURRENCY_RE = new RegExp(
    '(?:(?<sign>[-+~])\\s*)?(?:' +
      '(?<sym>' + SYMBOL_ALT + ')\\s*(?<numA>\\d[\\d.,]*)' +
      '|(?<codeA>' + CODE_ALT + ')\\s+(?<numB>\\d[\\d.,]*)' +
      '|(?<numC>\\d[\\d.,]*)\\s*(?<codeB>' + CODE_ALT + ')' +
    ')',
    'g'
  );

  var CODE_ONLY_RE = new RegExp('^(?:' + CODE_ALT + ')$', 'i');

  /** Normalize a symbol or code string to an ISO code, or null. */
  function normalizeCurrency(symOrCode) {
    if (symOrCode == null) return null;
    var s = String(symOrCode).trim();
    if (Object.prototype.hasOwnProperty.call(SYMBOL_TO_CODE, s)) return SYMBOL_TO_CODE[s];
    var up = s.toUpperCase();
    if (CODE_ONLY_RE.test(up) && Object.prototype.hasOwnProperty.call(DEFAULT_RATES, up)) return up;
    // Bare '¥' ambiguity: JPY vs CNY — default JPY (documented).
    return null;
  }

  /**
   * Parse a localized number string.
   * Supports US `1,234.56` and EU `1.234,56`, plus single-separator forms.
   * Returns a finite Number, or NaN when unparseable.
   */
  function parseNumber(raw) {
    if (typeof raw !== 'number') {
      if (raw == null) return NaN;
      raw = String(raw).trim().replace(/[\s\u00A0\u202F']/g, '');
    } else {
      return raw;
    }
    if (!/^[-+]?[\d.,]+$/.test(raw)) return NaN;
    var hasDot = raw.includes('.');
    var hasComma = raw.includes(',');
    var norm = raw;
    if (hasDot && hasComma) {
      // Last separator wins as the decimal mark.
      if (raw.lastIndexOf('.') > raw.lastIndexOf(',')) {
        norm = raw.replace(/,/g, '');
      } else {
        norm = raw.replace(/\./g, '').replace(/,/g, '.');
      }
    } else if (hasComma) {
      var parts = raw.split(',');
      var tail = parts[parts.length - 1];
      var allThousands = parts.length > 1 && parts.slice(1).every(function (p) { return /^\d{3}$/.test(p); });
      if (allThousands) {
        norm = parts.join('');
      } else if (parts.length > 1 && /^\d{1,2}$/.test(tail)) {
        // Decimal comma: keep last comma as '.', drop the rest.
        norm = parts.slice(0, -1).join('') + '.' + tail;
      } else if (parts.length === 2 && /^\d{3}$/.test(tail)) {
        // Ambiguous single `1,234`: treat as US thousands.
        norm = parts.join('');
      } else {
        norm = raw.replace(/,/g, '.');
      }
    } else if (hasDot) {
      var dots = (raw.match(/\./g) || []).length;
      if (dots > 1) {
        // `1.234.567` — thousands dots (EU). Single-dot stays a decimal (US).
        norm = raw.replace(/\./g, '');
      }
    }
    var v = Number(norm);
    return Number.isFinite(v) ? v : NaN;
  }

  /**
   * Parse one currency amount string (e.g. `$3.30`, `15.50 EUR`, `USD 10`, `-$5`).
   * Returns `{ currency, amount, sign, raw }` or null.
   */
  function parseCurrencyAmount(raw) {
    if (raw == null) return null;
    var text = String(raw).trim();
    if (!text) return null;
    CURRENCY_RE.lastIndex = 0;
    var m = CURRENCY_RE.exec(text);
    if (!m || m.index !== 0) {
      // Allow leading whitespace only; otherwise no match at start => null.
      // Fall back: try a full anchored re-test for embedded leading junk.
      CURRENCY_RE.lastIndex = 0;
      var m2 = CURRENCY_RE.exec(text);
      if (!m2) return null;
      // Accept only if match covers the whole trimmed string.
      if (m2.index !== 0 || m2[0].length !== text.length) return null;
      return buildParsed(m2, text);
    }
    if (m[0].length !== text.length) return null;
    return buildParsed(m, text);
  }

  function buildParsed(m, text) {
    var g = m.groups || {};
    var sign = g.sign === '-' ? -1 : 1;
    var currency = null;
    var numStr = null;
    if (g.sym) {
      currency = SYMBOL_TO_CODE[g.sym];
      numStr = g.numA;
    } else if (g.codeA) {
      currency = g.codeA.toUpperCase();
      numStr = g.numB;
    } else if (g.codeB) {
      currency = g.codeB.toUpperCase();
      numStr = g.numC;
    }
    if (!currency || numStr == null) return null;
    var amount = parseNumber(numStr);
    if (!Number.isFinite(amount)) return null;
    return { currency: currency, amount: sign * amount, sign: sign, raw: text };
  }

  /**
   * Find every currency amount inside a free-text string.
   * Returns array of `{ raw, currency, amount, index }` in source order.
   */
  function detectCurrencyAmounts(text, _rates) {
    if (text == null) return [];
    var src = String(text);
    var out = [];
    CURRENCY_RE.lastIndex = 0;
    var m;
    while ((m = CURRENCY_RE.exec(src)) !== null) {
      var g = m.groups || {};
      var sign = g.sign === '-' ? -1 : 1;
      var currency = null;
      var numStr = null;
      if (g.sym) {
        currency = SYMBOL_TO_CODE[g.sym];
        numStr = g.numA;
      } else if (g.codeA) {
        currency = g.codeA.toUpperCase();
        numStr = g.numB;
      } else if (g.codeB) {
        currency = g.codeB.toUpperCase();
        numStr = g.numC;
      }
      if (!currency || numStr == null) continue;
      // Guard: code-first needs the code boundary (regex already word-safe for
      // symbol forms; e.g. avoid matching 'USDC' as 'USD' + junk).
      var after = src[m.index + m[0].length];
      if ((g.codeA || g.codeB) && after && /[A-Za-z]/.test(after)) continue;
      var amount = parseNumber(numStr);
      if (!Number.isFinite(amount)) continue;
      out.push({ raw: m[0], currency: currency, amount: sign * amount, index: m.index });
      // Safety against zero-length loops (regex always consumes, but be sure).
      if (m[0].length === 0) CURRENCY_RE.lastIndex += 1;
    }
    return out;
  }

  /** True when the text contains at least one currency amount. */
  function containsCurrency(text) {
    return detectCurrencyAmounts(text).length > 0;
  }

  /** Count currency amounts inside a text (legs of `a/b` count separately). */
  function countCurrencyAmounts(text) {
    return detectCurrencyAmounts(text).length;
  }

  /**
   * Convert a foreign amount to VND.
   * Returns a finite Number (signed), or null for unknown currency / bad input.
   */
  function convertToVND(amount, currency, rates) {
    if (rates === undefined) rates = DEFAULT_RATES;
    var code = normalizeCurrency(currency);
    if (code == null) return null;
    var n = typeof amount === 'number' ? amount : parseNumber(amount);
    if (!Number.isFinite(n)) return null;
    var table = rates && typeof rates === 'object' ? rates : DEFAULT_RATES;
    var rate = table[code];
    if (rate == null) rate = DEFAULT_RATES[code];
    if (!Number.isFinite(Number(rate))) return null;
    return n * Number(rate);
  }

  var groupThousands = function (intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };

  /**
   * Format a VND value per spec (AI-log safe):
   *  - |vnd| >= 100 : rounded integer, dot thousands, suffixed ` ₫`
   *  - 1 <= |vnd| < 100 : 2 decimals, comma decimal sep (`14,50 ₫`)
   *  - 0 < |vnd| < 1 : micro-cents, min 2 decimals, widening to 3-4 decimals
   *    so a nonzero value NEVER collapses to `0 ₫` (`0,55 ₫`, `0,001 ₫`).
   */
  function formatVND(vnd) {
    var n = Number(vnd);
    if (!Number.isFinite(n)) return '';
    if (n === 0) return '0 ₫';
    var neg = n < 0 ? '-' : '';
    var a = Math.abs(n);
    if (a >= 100) {
      return neg + groupThousands(String(Math.round(a))) + ' ₫';
    }
    if (a >= 1) {
      var fixed = a.toFixed(2);
      var parts = fixed.split('.');
      return neg + groupThousands(parts[0]) + ',' + parts[1] + ' ₫';
    }
    // Micro range: find the smallest decimals in [2..6] that stays nonzero.
    for (var dec = 2; dec <= 6; dec += 1) {
      var f = a.toFixed(dec);
      if (Number(f) !== 0) {
        var sp = f.split('.');
        return neg + groupThousands(sp[0]) + ',' + sp[1] + ' ₫';
      }
    }
    return neg + '0,000001 ₫';
  }

  /**
   * Parse + convert + format in one step.
   * Returns `{ currency, amount, vnd, text }` or null.
   */
  function convertAndFormat(raw, rates) {
    if (rates === undefined) rates = DEFAULT_RATES;
    var p = parseCurrencyAmount(raw);
    if (!p) return null;
    var vnd = convertToVND(p.amount, p.currency, rates);
    if (vnd == null) return null;
    return { currency: p.currency, amount: p.amount, vnd: vnd, text: formatVND(vnd) };
  }

  /** Badge text used by the append display mode: `≈ 85.800 ₫`. */
  function badgeText(vnd) {
    return '≈ ' + formatVND(vnd);
  }

  root.CurrencyUtils = {
    DEFAULT_RATES: DEFAULT_RATES,
    DEFAULT_USD_VND: DEFAULT_USD_VND,
    SYMBOL_TO_CODE: SYMBOL_TO_CODE,
    ISO_CODES: ISO_CODES,
    normalizeCurrency: normalizeCurrency,
    parseNumber: parseNumber,
    parseCurrencyAmount: parseCurrencyAmount,
    detectCurrencyAmounts: detectCurrencyAmounts,
    containsCurrency: containsCurrency,
    countCurrencyAmounts: countCurrencyAmounts,
    convertToVND: convertToVND,
    formatVND: formatVND,
    convertAndFormat: convertAndFormat,
    badgeText: badgeText,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
