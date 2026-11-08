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
    NZD: 15500,
    CHF: 32500,
    MXN: 1400,
    BRL: 4800,
    PHP: 450,
    MYR: 6100,
    IDR: 1.6,
    RUB: 320,
    TRY: 620,
    SEK: 2750,
    NOK: 2600,
    DKK: 4050,
    PLN: 7100,
    ZAR: 1480,
    AED: 7080,
  });

  /**
   * Prefix symbol -> ISO code. Longest match wins (sorted below), so `CA$`
   * is never read as a bare `$`. Letter-based prefixes require a non-letter
   * on their left (see CURRENCY_RE), so `XCA$5` / `FORM 5` never match.
   */
  var SYMBOL_TO_CODE = Object.freeze({
    'US$': 'USD',
    'CA$': 'CAD',
    'AU$': 'AUD',
    'NZ$': 'NZD',
    'MX$': 'MXN',
    'NT$': 'TWD',
    'HK$': 'HKD',
    'SG$': 'SGD',
    'CN¥': 'CNY',
    'JP¥': 'JPY',
    'C$': 'CAD',
    'A$': 'AUD',
    'S$': 'SGD',
    'R$': 'BRL',
    'RM': 'MYR',
    'Rp': 'IDR',
    '$': 'USD',
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '￥': 'JPY',
    '₩': 'KRW',
    '₹': 'INR',
    '฿': 'THB',
    '₱': 'PHP',
    '₽': 'RUB',
    '₺': 'TRY',
  });

  /** Symbols allowed AFTER the number (`29,99 €`, `100円`, `50 zł`). */
  var SUFFIX_TO_CODE = Object.freeze({
    '€': 'EUR',
    '£': 'GBP',
    '¥': 'JPY',
    '￥': 'JPY',
    '円': 'JPY',
    '元': 'CNY',
    '₩': 'KRW',
    '₹': 'INR',
    '฿': 'THB',
    '₱': 'PHP',
    '₽': 'RUB',
    '₺': 'TRY',
    'zł': 'PLN',
    '$': 'USD',
  });

  /**
   * Symbols shared by several currencies. Their code comes from page hints
   * (`{ dollar, yen }`), falling back to the SYMBOL_TO_CODE default.
   */
  var AMBIGUOUS_SYMBOLS = Object.freeze({ '$': 'dollar', '¥': 'yen', '￥': 'yen' });
  var DOLLAR_CODES = Object.freeze(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'TWD', 'MXN']);
  var YEN_CODES = Object.freeze(['JPY', 'CNY']);

  var ISO_CODES = Object.freeze(Object.keys(DEFAULT_RATES));

  /** Non-ISO spellings of a code. */
  var CODE_ALIASES = Object.freeze({ RMB: 'CNY' });

  /** Currencies normally written without decimals (`¥1.234` = 1234). */
  var ZERO_DECIMAL = Object.freeze(['JPY', 'KRW', 'IDR', 'VND']);
  /** Currencies whose locales use `.` as thousands mark (`€1.234` = 1234). */
  var DOT_THOUSANDS = Object.freeze(['EUR', 'BRL', 'TRY', 'DKK', 'NOK', 'PLN', 'RUB', 'IDR']);

  /** `$1.5M`, `€2 bn`, `$10k`, `$3 million` -> multiplier. */
  var MAGNITUDES = Object.freeze({
    k: 1e3, K: 1e3, thousand: 1e3,
    m: 1e6, M: 1e6, mn: 1e6, million: 1e6,
    B: 1e9, bn: 1e9, billion: 1e9,
    trillion: 1e12,
  });

  var ESC = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var byLengthDesc = function (a, b) { return b.length - a.length; };
  var SYMBOL_ALT = Object.keys(SYMBOL_TO_CODE).sort(byLengthDesc).map(ESC).join('|');
  var SUFFIX_ALT = Object.keys(SUFFIX_TO_CODE).sort(byLengthDesc).map(ESC).join('|');
  var CODE_ALT = ISO_CODES.concat(Object.keys(CODE_ALIASES)).join('|');
  var MAG_ALT = Object.keys(MAGNITUDES).sort(byLengthDesc).join('|');

  // A number always starts AND ends with a digit, so trailing punctuation
  // (`$1,500,` / `$5.`) is never swallowed. NBSP-grouped `1 234,56` allowed.
  var NUM = '\\d{1,3}(?:[\\u00A0\\u202F]\\d{3})+(?:[.,]\\d+)?|\\d(?:[\\d.,]*\\d)?';
  var MAG = '\\s?(?:' + MAG_ALT + ')(?![A-Za-z])';

  /**
   * Master currency matcher. Each alternative captures:
   *  - Symbol-first:  SYMBOL number mag? CODE?  (`$3.30`, `C$10`, `$1.5M`, `$10 CAD`)
   *  - Code-first:    CODE SYMBOL? number mag?  (`USD 10`, `USD $10`, `RMB 50`)
   *  - Number-first:  number mag? CODE|SYMBOL   (`10 USD`, `29,99 €`, `100円`)
   * The sign must touch the amount, so the dash in `$10 - $20` is a range,
   * not a negative second leg. A global search finds every leg separately.
   */
  var CURRENCY_RE = new RegExp(
    '(?:(?<![\\w])(?<sign>[-+~\\u2212]))?(?:' +
      '(?<![A-Za-z])(?<sym>' + SYMBOL_ALT + ')\\s*(?<numA>' + NUM + ')(?<magA>' + MAG + ')?' +
        '(?:\\s?(?<codeC>' + CODE_ALT + ')(?![A-Za-z]))?' +
      '|(?<![A-Za-z])(?<codeA>' + CODE_ALT + ')\\s*(?:' + SYMBOL_ALT + ')?\\s*(?<numB>' + NUM + ')(?<magB>' + MAG + ')?' +
      '|(?<![\\w.,])(?<numC>' + NUM + ')(?<magC>' + MAG + ')?\\s?' +
        '(?:(?<codeB>' + CODE_ALT + ')(?![A-Za-z])|(?<symB>' + SUFFIX_ALT + ')(?!\\s?\\d))' +
    ')',
    'g'
  );

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function codeFromText(code) {
    var up = String(code).toUpperCase();
    if (hasOwn(CODE_ALIASES, up)) return CODE_ALIASES[up];
    return hasOwn(DEFAULT_RATES, up) ? up : null;
  }

  /** Normalize a symbol or code string to an ISO code, or null. */
  function normalizeCurrency(symOrCode) {
    if (symOrCode == null) return null;
    var s = String(symOrCode).trim();
    if (hasOwn(SYMBOL_TO_CODE, s)) return SYMBOL_TO_CODE[s];
    if (hasOwn(SUFFIX_TO_CODE, s)) return SUFFIX_TO_CODE[s];
    if (!/^[A-Za-z]{3}$/.test(s)) return null;
    return codeFromText(s);
  }

  /**
   * Clean page hints: `{ dollar, yen }` must name a currency of the right
   * family, otherwise the documented defaults (USD, JPY) apply.
   */
  function normalizeHints(hints) {
    var h = hints || {};
    var dollar = h.dollar ? String(h.dollar).toUpperCase() : '';
    var yen = h.yen ? String(h.yen).toUpperCase() : '';
    return {
      dollar: DOLLAR_CODES.indexOf(dollar) >= 0 ? dollar : 'USD',
      yen: YEN_CODES.indexOf(yen) >= 0 ? yen : 'JPY',
    };
  }

  var TLD_DOLLAR = Object.freeze({
    ca: 'CAD', au: 'AUD', nz: 'NZD', sg: 'SGD', hk: 'HKD', tw: 'TWD', mx: 'MXN',
  });
  var REGION_DOLLAR = Object.freeze({
    CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', TW: 'TWD', MX: 'MXN',
  });

  /**
   * Guess which currency a bare `$` / `¥` means on a page.
   * `info = { hostname, lang, metaCurrencies: [...], dollar, yen }` where
   * `dollar` / `yen` are user settings ('auto' or an ISO code).
   * Priority: user setting > page price metadata > lang region > TLD > default.
   */
  function inferHints(info) {
    var i = info || {};
    var out = { dollar: null, yen: null };
    if (i.dollar && i.dollar !== 'auto') out.dollar = String(i.dollar).toUpperCase();
    if (i.yen && i.yen !== 'auto') out.yen = String(i.yen).toUpperCase();

    var metas = Array.isArray(i.metaCurrencies) ? i.metaCurrencies : [];
    for (var m = 0; m < metas.length; m += 1) {
      var code = String(metas[m] || '').trim().toUpperCase();
      if (!out.dollar && DOLLAR_CODES.indexOf(code) >= 0) out.dollar = code;
      if (!out.yen && YEN_CODES.indexOf(code) >= 0) out.yen = code;
    }

    var lang = String(i.lang || '');
    var region = (lang.split(/[-_]/)[1] || '').toUpperCase();
    if (!out.dollar && hasOwn(REGION_DOLLAR, region)) out.dollar = REGION_DOLLAR[region];
    if (!out.yen && /^zh/i.test(lang)) out.yen = 'CNY';
    if (!out.yen && /^ja/i.test(lang)) out.yen = 'JPY';

    var host = String(i.hostname || '').toLowerCase().replace(/\.$/, '');
    var tld = host.slice(host.lastIndexOf('.') + 1);
    if (!out.dollar && hasOwn(TLD_DOLLAR, tld)) out.dollar = TLD_DOLLAR[tld];
    if (!out.yen && tld === 'cn') out.yen = 'CNY';
    if (!out.yen && tld === 'jp') out.yen = 'JPY';

    return normalizeHints(out);
  }

  /**
   * Parse a localized number string.
   * Supports US `1,234.56` and EU `1.234,56`, plus single-separator forms.
   * `currency` (optional) resolves `1.234`: thousands for JPY/KRW/EUR-style
   * currencies, decimal otherwise (`$1.250` per-token prices stay 1.25).
   * Returns a finite Number, or NaN when unparseable.
   */
  function parseNumber(raw, currency) {
    if (typeof raw !== 'number') {
      if (raw == null) return NaN;
      raw = String(raw).trim().replace(/[\s  ']/g, '');
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
      var dotParts = raw.split('.');
      var code = currency ? String(currency).toUpperCase() : '';
      var thousandsStyle = ZERO_DECIMAL.indexOf(code) >= 0 || DOT_THOUSANDS.indexOf(code) >= 0;
      if (dotParts.length > 2) {
        // `1.234.567` — thousands dots (EU). Single-dot stays a decimal (US).
        norm = raw.replace(/\./g, '');
      } else if (thousandsStyle && /^\d{3}$/.test(dotParts[1]) && !/^[-+]?0*$/.test(dotParts[0])) {
        // `¥1.234` / `€2.500` / `Rp 15.000`: single dot + 3 digits = thousands.
        norm = dotParts.join('');
      }
    }
    var v = Number(norm);
    return Number.isFinite(v) ? v : NaN;
  }

  function resolveSymbol(sym, hints) {
    var family = AMBIGUOUS_SYMBOLS[sym];
    if (family === 'dollar') return { code: hints.dollar, assumed: true };
    if (family === 'yen') return { code: hints.yen, assumed: true };
    return { code: SYMBOL_TO_CODE[sym], assumed: false };
  }

  /** Turn one CURRENCY_RE match into `{ raw, currency, amount, index, assumed }`. */
  function buildMatch(m, hints) {
    var g = m.groups || {};
    var sign = g.sign === '-' || g.sign === '−' ? -1 : 1;
    var currency = null;
    var numStr = null;
    var mag = null;
    var assumed = false;
    if (g.sym) {
      var r = resolveSymbol(g.sym, hints);
      currency = r.code;
      assumed = r.assumed;
      // `$10 CAD`: a trailing code settles an ambiguous symbol.
      if (assumed && g.codeC) {
        currency = codeFromText(g.codeC);
        assumed = false;
      }
      numStr = g.numA;
      mag = g.magA;
    } else if (g.codeA) {
      currency = codeFromText(g.codeA);
      numStr = g.numB;
      mag = g.magB;
    } else if (g.codeB) {
      currency = codeFromText(g.codeB);
      numStr = g.numC;
      mag = g.magC;
    } else if (g.symB) {
      if (hasOwn(AMBIGUOUS_SYMBOLS, g.symB)) {
        var rs = resolveSymbol(g.symB, hints);
        currency = rs.code;
        assumed = rs.assumed;
      } else {
        currency = SUFFIX_TO_CODE[g.symB];
      }
      numStr = g.numC;
      mag = g.magC;
    }
    if (!currency || numStr == null) return null;
    var amount = parseNumber(numStr, currency);
    if (!Number.isFinite(amount)) return null;
    if (mag) amount *= MAGNITUDES[mag.trim()];
    return { raw: m[0], currency: currency, amount: sign * amount, index: m.index, assumed: assumed };
  }

  /**
   * Find every currency amount inside a free-text string.
   * `hints = { dollar, yen }` decides what a bare `$` / `¥` means.
   * Returns array of `{ raw, currency, amount, index, assumed }` in source order;
   * `assumed` is true when the code came from a hint, not the text itself.
   */
  function detectCurrencyAmounts(text, _rates, hints) {
    if (text == null) return [];
    var src = String(text);
    var h = normalizeHints(hints);
    var out = [];
    CURRENCY_RE.lastIndex = 0;
    var m;
    while ((m = CURRENCY_RE.exec(src)) !== null) {
      // Safety against zero-length loops (regex always consumes, but be sure).
      if (m[0].length === 0) {
        CURRENCY_RE.lastIndex += 1;
        continue;
      }
      var found = buildMatch(m, h);
      if (found) out.push(found);
    }
    return out;
  }

  /**
   * Parse one currency amount string (e.g. `$3.30`, `15.50 EUR`, `USD 10`, `-$5`).
   * The whole trimmed string must be a single amount.
   * Returns `{ currency, amount, sign, raw, assumed }` or null.
   */
  function parseCurrencyAmount(raw, hints) {
    if (raw == null) return null;
    var text = String(raw).trim();
    if (!text) return null;
    var found = detectCurrencyAmounts(text, null, hints);
    if (found.length !== 1) return null;
    var f = found[0];
    if (f.index !== 0 || f.raw.length !== text.length) return null;
    return { currency: f.currency, amount: f.amount, sign: f.amount < 0 ? -1 : 1, raw: text, assumed: f.assumed };
  }

  /** True when the text contains at least one currency amount. */
  function containsCurrency(text, hints) {
    return detectCurrencyAmounts(text, null, hints).length > 0;
  }

  /** Count currency amounts inside a text (legs of `a/b` count separately). */
  function countCurrencyAmounts(text, hints) {
    return detectCurrencyAmounts(text, null, hints).length;
  }

  /**
   * Convert a foreign amount to VND.
   * Returns a finite Number (signed), or null for unknown currency / bad input.
   */
  function convertToVND(amount, currency, rates) {
    if (rates === undefined) rates = DEFAULT_RATES;
    var code = normalizeCurrency(currency);
    if (code == null) return null;
    var n = typeof amount === 'number' ? amount : parseNumber(amount, code);
    if (!Number.isFinite(n)) return null;
    var table = rates && typeof rates === 'object' ? rates : DEFAULT_RATES;
    var rate = table[code];
    if (rate == null) rate = DEFAULT_RATES[code];
    if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) return null;
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
  function convertAndFormat(raw, rates, hints) {
    if (rates === undefined) rates = DEFAULT_RATES;
    var p = parseCurrencyAmount(raw, hints);
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
    SUFFIX_TO_CODE: SUFFIX_TO_CODE,
    DOLLAR_CODES: DOLLAR_CODES,
    YEN_CODES: YEN_CODES,
    ISO_CODES: ISO_CODES,
    normalizeCurrency: normalizeCurrency,
    normalizeHints: normalizeHints,
    inferHints: inferHints,
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
