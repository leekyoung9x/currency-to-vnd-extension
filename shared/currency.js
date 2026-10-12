/**
 * shared/currency.js — Pure functions for currency detection, parsing,
 * conversion and VND formatting. No DOM / chrome.* dependencies.
 * ESM module (used by tests, content script, popup, options, verify).
 */

export const DEFAULT_USD_VND = 26000;

/** Canonical per-unit rates: 1 unit of foreign currency = X VND. */
export const DEFAULT_RATES = Object.freeze({
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
export const SYMBOL_TO_CODE = Object.freeze({
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

export const ISO_CODES = Object.freeze([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW',
  'CAD', 'AUD', 'SGD', 'INR', 'THB', 'TWD', 'HKD',
]);

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SYMBOLS_SORTED = Object.keys(SYMBOL_TO_CODE).sort((a, b) => b.length - a.length);
const SYMBOL_ALT = SYMBOLS_SORTED.map(ESC).join('|');
const CODE_ALT = ISO_CODES.join('|');

/**
 * Master currency matcher. Each alternative captures:
 *  - Symbol-first:  sign? SYMBOL number      (e.g. $3.30, -$5, ~$5.00, C$10)
 *  - Code-first:    sign? CODE number        (e.g. USD 10, -$5 USD not matched; sign inside)
 *  - Code-last:     sign? number CODE        (e.g. 10 USD, 15.5 EUR, 100 JPY)
 * A global search finds every leg of `$0.070/$0.350` and `$10 - $20` separately.
 */
const CURRENCY_RE = new RegExp(
  `(?:(?<sign>[-+~])\\s*)?(?:` +
    `(?<sym>${SYMBOL_ALT})\\s*(?<numA>\\d[\\d.,]*)` +
    `|(?<codeA>${CODE_ALT})\\s+(?<numB>\\d[\\d.,]*)` +
    `|(?<numC>\\d[\\d.,]*)\\s*(?<codeB>${CODE_ALT})` +
  `)`,
  'g',
);

const CODE_ONLY_RE = new RegExp(`^(?:${CODE_ALT})$`, 'i');

/** Normalize a symbol or code string to an ISO code, or null. */
export function normalizeCurrency(symOrCode) {
  if (symOrCode == null) return null;
  const s = String(symOrCode).trim();
  if (Object.prototype.hasOwnProperty.call(SYMBOL_TO_CODE, s)) return SYMBOL_TO_CODE[s];
  const up = s.toUpperCase();
  if (CODE_ONLY_RE.test(up) && Object.prototype.hasOwnProperty.call(DEFAULT_RATES, up)) return up;
  // Bare '¥' ambiguity: JPY vs CNY — default JPY (documented).
  return null;
}

/**
 * Parse a localized number string.
 * Supports US `1,234.56` and EU `1.234,56`, plus single-separator forms.
 * Returns a finite Number, or NaN when unparseable.
 */
export function parseNumber(raw) {
  if (typeof raw !== 'number') {
    if (raw == null) return NaN;
    raw = String(raw).trim().replace(/[\s\u00A0\u202F']/g, '');
  } else {
    return raw;
  }
  if (!/^[-+]?[\d.,]+$/.test(raw)) return NaN;
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  let norm = raw;
  if (hasDot && hasComma) {
    // Last separator wins as the decimal mark.
    if (raw.lastIndexOf('.') > raw.lastIndexOf(',')) {
      norm = raw.replace(/,/g, '');
    } else {
      norm = raw.replace(/\./g, '').replace(/,/g, '.');
    }
  } else if (hasComma) {
    const parts = raw.split(',');
    const tail = parts[parts.length - 1];
    const allThousands = parts.length > 1 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
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
    const dots = (raw.match(/\./g) || []).length;
    if (dots > 1) {
      // `1.234.567` — thousands dots (EU). Single-dot stays a decimal (US).
      norm = raw.replace(/\./g, '');
    }
  }
  const v = Number(norm);
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Parse one currency amount string (e.g. `$3.30`, `15.50 EUR`, `USD 10`, `-$5`).
 * Returns `{ currency, amount, sign, raw }` or null.
 */
export function parseCurrencyAmount(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  CURRENCY_RE.lastIndex = 0;
  const m = CURRENCY_RE.exec(text);
  if (!m || m.index !== 0) {
    // Allow leading whitespace only; otherwise no match at start => null.
    // Fall back: try a full anchored re-test for embedded leading junk.
    CURRENCY_RE.lastIndex = 0;
    const m2 = CURRENCY_RE.exec(text);
    if (!m2) return null;
    // Accept only if match covers the whole trimmed string.
    if (m2.index !== 0 || m2[0].length !== text.length) return null;
    return buildParsed(m2, text);
  }
  if (m[0].length !== text.length) return null;
  return buildParsed(m, text);
}

function buildParsed(m, text) {
  const g = m.groups || {};
  const sign = g.sign === '-' ? -1 : 1;
  let currency = null;
  let numStr = null;
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
  const amount = parseNumber(numStr);
  if (!Number.isFinite(amount)) return null;
  return { currency, amount: sign * amount, sign, raw: text };
}

/**
 * Find every currency amount inside a free-text string.
 * Returns array of `{ raw, currency, amount, index }` in source order.
 */
export function detectCurrencyAmounts(text, _rates) {
  if (text == null) return [];
  const src = String(text);
  const out = [];
  CURRENCY_RE.lastIndex = 0;
  let m;
  while ((m = CURRENCY_RE.exec(src)) !== null) {
    const g = m.groups || {};
    const sign = g.sign === '-' ? -1 : 1;
    let currency = null;
    let numStr = null;
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
    const after = src[m.index + m[0].length];
    if ((g.codeA || g.codeB) && after && /[A-Za-z]/.test(after)) continue;
    const amount = parseNumber(numStr);
    if (!Number.isFinite(amount)) continue;
    out.push({ raw: m[0], currency, amount: sign * amount, index: m.index });
    // Safety against zero-length loops (regex always consumes, but be sure).
    if (m[0].length === 0) CURRENCY_RE.lastIndex += 1;
  }
  return out;
}

/** True when the text contains at least one currency amount. */
export function containsCurrency(text) {
  return detectCurrencyAmounts(text).length > 0;
}

/** Count currency amounts inside a text (legs of `a/b` count separately). */
export function countCurrencyAmounts(text) {
  return detectCurrencyAmounts(text).length;
}

/**
 * Convert a foreign amount to VND.
 * Returns a finite Number (signed), or null for unknown currency / bad input.
 */
export function convertToVND(amount, currency, rates = DEFAULT_RATES) {
  const code = normalizeCurrency(currency);
  if (code == null) return null;
  const n = typeof amount === 'number' ? amount : parseNumber(amount);
  if (!Number.isFinite(n)) return null;
  const table = rates && typeof rates === 'object' ? rates : DEFAULT_RATES;
  let rate = table[code];
  if (rate == null) rate = DEFAULT_RATES[code];
  if (!Number.isFinite(Number(rate))) return null;
  return n * Number(rate);
}

const groupThousands = (intStr) => intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Format a VND value per spec (AI-log safe):
 *  - |vnd| >= 100 : rounded integer, dot thousands, suffixed ` ₫`
 *  - 1 <= |vnd| < 100 : 2 decimals, comma decimal sep (`14,50 ₫`)
 *  - 0 < |vnd| < 1 : micro-cents, min 2 decimals, widening to 3-4 decimals
 *    so a nonzero value NEVER collapses to `0 ₫` (`0,55 ₫`, `0,001 ₫`).
 */
export function formatVND(vnd) {
  const n = Number(vnd);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return '0 ₫';
  const neg = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 100) {
    return `${neg}${groupThousands(String(Math.round(a)))} ₫`;
  }
  if (a >= 1) {
    const fixed = a.toFixed(2);
    const [i, d] = fixed.split('.');
    return `${neg}${groupThousands(i)},${d} ₫`;
  }
  // Micro range: find the smallest decimals in [2..6] that stays nonzero.
  for (let dec = 2; dec <= 6; dec += 1) {
    const fixed = a.toFixed(dec);
    if (Number(fixed) !== 0) {
      const [i, d] = fixed.split('.');
      return `${neg}${groupThousands(i)},${d} ₫`;
    }
  }
  return `${neg}0,000001 ₫`;
}

/**
 * Parse + convert + format in one step.
 * Returns `{ currency, amount, vnd, text }` or null.
 */
export function convertAndFormat(raw, rates = DEFAULT_RATES) {
  const p = parseCurrencyAmount(raw);
  if (!p) return null;
  const vnd = convertToVND(p.amount, p.currency, rates);
  if (vnd == null) return null;
  return { currency: p.currency, amount: p.amount, vnd, text: formatVND(vnd) };
}

/** Badge text used by the append display mode: `≈ 85.800 ₫`. */
export function badgeText(vnd) {
  return `≈ ${formatVND(vnd)}`;
}

// UMD-ish global for classic-script consumers (harmless under ESM).
try {
  if (typeof globalThis !== 'undefined') {
    globalThis.CurrencyUtils = {
      DEFAULT_RATES,
      DEFAULT_USD_VND,
      SYMBOL_TO_CODE,
      ISO_CODES,
      normalizeCurrency,
      parseNumber,
      parseCurrencyAmount,
      detectCurrencyAmounts,
      containsCurrency,
      countCurrencyAmounts,
      convertToVND,
      formatVND,
      convertAndFormat,
      badgeText,
    };
  }
} catch (_) {
  // ignore — module exports below are the source of truth.
}
