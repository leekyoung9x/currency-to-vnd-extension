/**
 * shared/rates.js — Offline default rates, custom overrides, live fetching,
 * and chrome.storage persistence.
 * Classic script (IIFE): exposes `RateUtils` on the global scope.
 * Requires shared/currency.js to be loaded FIRST (reads DEFAULT_RATES from
 * `CurrencyUtils`; falls back to an identical frozen copy when loaded alone).
 */
(function (root) {
  'use strict';

  var FALLBACK_RATES = Object.freeze({
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

  var DEFAULT_RATES = (root.CurrencyUtils && root.CurrencyUtils.DEFAULT_RATES) || FALLBACK_RATES;

  var LIVE_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
  var STORAGE_KEYS = Object.freeze({
    RATES: 'vnd_rates',
    CUSTOM_RATES: 'vnd_custom_rates',
    UPDATED_AT: 'vnd_rates_updated_at',
    ENABLED: 'vnd_enabled',
    MODE: 'vnd_display_mode',
  });

  /** Merge base rates with user overrides (override wins when finite & > 0). */
  function mergeRates(base, overrides) {
    if (base === undefined) base = DEFAULT_RATES;
    if (overrides === undefined) overrides = {};
    var out = {};
    var k;
    if (base && typeof base === 'object') {
      for (k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
      }
    }
    if (overrides && typeof overrides === 'object') {
      var entries = Object.entries(overrides);
      for (var i = 0; i < entries.length; i += 1) {
        var code = String(entries[i][0]).toUpperCase();
        var n = Number(entries[i][1]);
        if (Number.isFinite(n) && n > 0) out[code] = n;
      }
    }
    return out;
  }

  /** Effective rate for one ISO code. Returns null when unknown. */
  function getRateFor(currency, rates) {
    if (rates === undefined) rates = DEFAULT_RATES;
    if (currency == null) return null;
    var code = String(currency).trim().toUpperCase();
    var table = rates && typeof rates === 'object' ? rates : DEFAULT_RATES;
    var v = Number(table[code] !== undefined && table[code] !== null ? table[code] : DEFAULT_RATES[code]);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Validate a user-supplied rate table; returns { ok, errors }. */
  function validateRates(table) {
    var errors = [];
    if (!table || typeof table !== 'object') return { ok: false, errors: ['Rate table must be an object'] };
    var entries = Object.entries(table);
    for (var i = 0; i < entries.length; i += 1) {
      var n = Number(entries[i][1]);
      if (!Number.isFinite(n) || n <= 0) errors.push(entries[i][0] + ': must be a positive number');
    }
    return { ok: errors.length === 0, errors: errors };
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
  function loadRates() {
    var area = storageArea();
    if (!area) return Promise.resolve(dictCopy(DEFAULT_RATES));
    return area.get([STORAGE_KEYS.RATES, STORAGE_KEYS.CUSTOM_RATES]).then(function (got) {
      var base = got && got[STORAGE_KEYS.RATES] ? got[STORAGE_KEYS.RATES] : DEFAULT_RATES;
      var custom = (got && got[STORAGE_KEYS.CUSTOM_RATES]) || {};
      return mergeRates(dictCopy(DEFAULT_RATES, base), custom);
    }).catch(function () {
      return dictCopy(DEFAULT_RATES);
    });
  }

  function dictCopy() {
    var out = {};
    for (var i = 0; i < arguments.length; i += 1) {
      var src = arguments[i] || {};
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
      }
    }
    return out;
  }

  /** Persist a full rate table + timestamp. No-op without chrome.storage. */
  function saveRates(rates) {
    var area = storageArea();
    if (!area) return Promise.resolve(false);
    var payload = {};
    payload[STORAGE_KEYS.RATES] = dictCopy(rates);
    payload[STORAGE_KEYS.UPDATED_AT] = Date.now();
    return area.set(payload).then(function () { return true; });
  }

  /** Persist user custom overrides. No-op without chrome.storage. */
  function saveCustomRates(overrides) {
    var area = storageArea();
    if (!area) return Promise.resolve(false);
    var payload = {};
    payload[STORAGE_KEYS.CUSTOM_RATES] = dictCopy(overrides);
    return area.set(payload).then(function () { return true; });
  }

  /** Last live-update timestamp (ms), or 0. */
  function getUpdatedAt() {
    var area = storageArea();
    if (!area) return Promise.resolve(0);
    return area.get([STORAGE_KEYS.UPDATED_AT]).then(function (got) {
      return Number(got && got[STORAGE_KEYS.UPDATED_AT]) || 0;
    }).catch(function () {
      return 0;
    });
  }

  /**
   * Convert open.er-api.com payload (USD-based) to VND-per-unit rates.
   * Needs the VND leg (`rates.VND`) to anchor conversions.
   */
  function ratesFromErApi(payload) {
    if (!payload || payload.result === 'error' || !payload.rates || !payload.rates.VND) {
      return null;
    }
    var perUsd = payload.rates;
    var vndPerUsd = Number(perUsd.VND);
    if (!Number.isFinite(vndPerUsd) || vndPerUsd <= 0) return null;
    var out = {};
    var codes = Object.keys(DEFAULT_RATES);
    for (var i = 0; i < codes.length; i += 1) {
      var code = codes[i];
      if (code === 'USD') {
        out.USD = Math.round(vndPerUsd);
        continue;
      }
      var foreignPerUsd = Number(perUsd[code]);
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
  function fetchLiveRates(fetchImpl) {
    var fn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fn) return Promise.reject(new Error('fetch is not available'));
    return fn(LIVE_RATE_URL).then(function (res) {
      if (!res || !res.ok) throw new Error('Rate API HTTP ' + (res && res.status !== undefined ? res.status : '?'));
      return res.json();
    }).then(function (payload) {
      var live = ratesFromErApi(payload);
      if (!live) throw new Error('Rate API payload missing VND leg');
      var merged = mergeRates(DEFAULT_RATES, live);
      return saveRates(merged).then(function () { return merged; });
    });
  }

  root.RateUtils = {
    DEFAULT_RATES: DEFAULT_RATES,
    LIVE_RATE_URL: LIVE_RATE_URL,
    STORAGE_KEYS: STORAGE_KEYS,
    mergeRates: mergeRates,
    getRateFor: getRateFor,
    validateRates: validateRates,
    loadRates: loadRates,
    saveRates: saveRates,
    saveCustomRates: saveCustomRates,
    getUpdatedAt: getUpdatedAt,
    ratesFromErApi: ratesFromErApi,
    fetchLiveRates: fetchLiveRates,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
