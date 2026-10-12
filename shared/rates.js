/**
 * shared/rates.js — Offline default rates, custom overrides, live fetching,
 * and chrome.storage persistence. Works in ESM (tests) and MV3 workers/pages.
 */
import { DEFAULT_RATES } from './currency.js';

export { DEFAULT_RATES };

export const LIVE_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
export const STORAGE_KEYS = Object.freeze({
  RATES: 'vnd_rates',
  CUSTOM_RATES: 'vnd_custom_rates',
  UPDATED_AT: 'vnd_rates_updated_at',
  ENABLED: 'vnd_enabled',
  MODE: 'vnd_display_mode',
});

/** Merge base rates with user overrides (override wins when finite & > 0). */
export function mergeRates(base = DEFAULT_RATES, overrides = {}) {
  const out = { ...(base || {}) };
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      const code = String(k).toUpperCase();
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[code] = n;
    }
  }
  return out;
}

/** Effective rate for one ISO code. Returns null when unknown. */
export function getRateFor(currency, rates = DEFAULT_RATES) {
  if (currency == null) return null;
  const code = String(currency).trim().toUpperCase();
  const table = rates && typeof rates === 'object' ? rates : DEFAULT_RATES;
  const v = Number(table[code] ?? DEFAULT_RATES[code]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Validate a user-supplied rate table; returns { ok, errors }. */
export function validateRates(table) {
  const errors = [];
  if (!table || typeof table !== 'object') return { ok: false, errors: ['Rate table must be an object'] };
  for (const [k, v] of Object.entries(table)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) errors.push(`${k}: must be a positive number`);
  }
  return { ok: errors.length === 0, errors };
}

function storageArea() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
  } catch (_) {
    // ignore
  }
  return null;
}

/** Load effective rates (defaults + stored customs). Never rejects. */
export async function loadRates() {
  const area = storageArea();
  if (!area) return { ...DEFAULT_RATES };
  try {
    const got = await area.get([STORAGE_KEYS.RATES, STORAGE_KEYS.CUSTOM_RATES]);
    const base = got && got[STORAGE_KEYS.RATES] ? got[STORAGE_KEYS.RATES] : DEFAULT_RATES;
    const custom = (got && got[STORAGE_KEYS.CUSTOM_RATES]) || {};
    return mergeRates({ ...DEFAULT_RATES, ...base }, custom);
  } catch (_) {
    return { ...DEFAULT_RATES };
  }
}

/** Persist a full rate table + timestamp. No-op without chrome.storage. */
export async function saveRates(rates) {
  const area = storageArea();
  if (!area) return false;
  await area.set({
    [STORAGE_KEYS.RATES]: { ...rates },
    [STORAGE_KEYS.UPDATED_AT]: Date.now(),
  });
  return true;
}

/** Persist user custom overrides. No-op without chrome.storage. */
export async function saveCustomRates(overrides) {
  const area = storageArea();
  if (!area) return false;
  await area.set({ [STORAGE_KEYS.CUSTOM_RATES]: { ...overrides } });
  return true;
}

/** Last live-update timestamp (ms), or 0. */
export async function getUpdatedAt() {
  const area = storageArea();
  if (!area) return 0;
  try {
    const got = await area.get([STORAGE_KEYS.UPDATED_AT]);
    return Number(got?.[STORAGE_KEYS.UPDATED_AT]) || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Convert open.er-api.com payload (USD-based) to VND-per-unit rates.
 * Needs the VND leg (`rates.VND`) to anchor conversions.
 */
export function ratesFromErApi(payload) {
  if (!payload || payload.result === 'error' || !payload.rates || !payload.rates.VND) {
    return null;
  }
  const perUsd = payload.rates;
  const vndPerUsd = Number(perUsd.VND);
  if (!Number.isFinite(vndPerUsd) || vndPerUsd <= 0) return null;
  const out = {};
  for (const code of Object.keys(DEFAULT_RATES)) {
    if (code === 'USD') {
      out.USD = Math.round(vndPerUsd);
      continue;
    }
    const foreignPerUsd = Number(perUsd[code]);
    if (Number.isFinite(foreignPerUsd) && foreignPerUsd > 0) {
      out[code] = vndPerUsd / foreignPerUsd;
    }
  }
  return out;
}

/**
 * Fetch live rates online, persist them, and return the merged table.
 * `fetchImpl` is injectable for tests. Throws on network/API failure.
 */
export async function fetchLiveRates(fetchImpl) {
  const fn = fetchImpl
    || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fn) throw new Error('fetch is not available');
  const res = await fn(LIVE_RATE_URL);
  if (!res || !res.ok) throw new Error(`Rate API HTTP ${res?.status ?? '?'}`);
  const payload = await res.json();
  const live = ratesFromErApi(payload);
  if (!live) throw new Error('Rate API payload missing VND leg');
  const merged = mergeRates(DEFAULT_RATES, live);
  await saveRates(merged);
  return merged;
}

try {
  if (typeof globalThis !== 'undefined') {
    globalThis.RateUtils = {
      DEFAULT_RATES,
      LIVE_RATE_URL,
      STORAGE_KEYS,
      mergeRates,
      getRateFor,
      validateRates,
      loadRates,
      saveRates,
      saveCustomRates,
      getUpdatedAt,
      ratesFromErApi,
      fetchLiveRates,
    };
  }
} catch (_) {
  // ignore
}
