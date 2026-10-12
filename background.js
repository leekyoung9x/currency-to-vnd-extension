/**
 * background.js — MV3 service worker: rate management, live fetch,
 * storage cache, badge, and messaging with content/popup.
 * Classic service worker script (no ESM): shared helpers are loaded via
 * `importScripts` and read from the `CurrencyUtils` / `RateUtils` globals.
 */
try {
  if (typeof importScripts === 'function') {
    importScripts('shared/currency.js', 'shared/rates.js');
  }
} catch (_) { /* tests / non-worker contexts */ }

var CurrencyUtils = (typeof globalThis !== 'undefined' && globalThis.CurrencyUtils) || {};
var RateUtils = (typeof globalThis !== 'undefined' && globalThis.RateUtils) || {};
var DEFAULT_RATES = CurrencyUtils.DEFAULT_RATES || RateUtils.DEFAULT_RATES || {};
var STORAGE_KEYS = RateUtils.STORAGE_KEYS || {
  RATES: 'vnd_rates',
  CUSTOM_RATES: 'vnd_custom_rates',
  UPDATED_AT: 'vnd_rates_updated_at',
  ENABLED: 'vnd_enabled',
  MODE: 'vnd_display_mode',
};
var mergeRates = RateUtils.mergeRates;
var ratesFromErApi = RateUtils.ratesFromErApi;

var LIVE_URL = 'https://open.er-api.com/v6/latest/USD';
var REFRESH_MINUTES = 360; // 6h

function store() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch (_) { /* noop */ }
  return null;
}

function dictCopy() {
  var out = {};
  for (var i = 0; i < arguments.length; i += 1) {
    var src = arguments[i] || {};
    for (var key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
    }
  }
  return out;
}

function getEffectiveRates() {
  var area = store();
  if (!area) return Promise.resolve(dictCopy(DEFAULT_RATES));
  return area.get([STORAGE_KEYS.RATES, STORAGE_KEYS.CUSTOM_RATES]).then(function (got) {
    return mergeRates(
      dictCopy(DEFAULT_RATES, (got && got[STORAGE_KEYS.RATES]) || {}),
      (got && got[STORAGE_KEYS.CUSTOM_RATES]) || {}
    );
  }).catch(function () {
    return dictCopy(DEFAULT_RATES);
  });
}

function refreshLiveRates() {
  return fetch(LIVE_URL).then(function (res) {
    if (!res.ok) throw new Error('Rate API HTTP ' + res.status);
    return res.json();
  }).then(function (payload) {
    var live = ratesFromErApi(payload);
    if (!live) throw new Error('Rate API payload missing VND leg');
    var merged = mergeRates(DEFAULT_RATES, live);
    var area = store();
    if (area) {
      var patch = {};
      patch[STORAGE_KEYS.RATES] = merged;
      patch[STORAGE_KEYS.UPDATED_AT] = Date.now();
      return area.set(patch).then(function () { return merged; });
    }
    return merged;
  });
}

function setBadge(count, tabId) {
  try {
    if (typeof chrome === 'undefined' || !chrome.action) return Promise.resolve();
    var text = count > 0 ? String(Math.min(count, 999)) : '';
    var p = tabId != null
      ? chrome.action.setBadgeText({ text: text, tabId: tabId })
      : chrome.action.setBadgeText({ text: text });
    return Promise.resolve(p).then(function () {
      return chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
    }).catch(function () { /* noop */ });
  } catch (_) { /* noop */ }
  return Promise.resolve();
}

function hasChrome() {
  try {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return false;
  }
}

if (hasChrome()) {
  chrome.runtime.onInstalled.addListener(function () {
    store().then(function (area) {
      if (!area) return;
      return area.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.RATES]).then(function (cur) {
        var patch = {};
        patch[STORAGE_KEYS.ENABLED] = cur && cur[STORAGE_KEYS.ENABLED] !== undefined && cur[STORAGE_KEYS.ENABLED] !== null
          ? cur[STORAGE_KEYS.ENABLED]
          : true;
        patch[STORAGE_KEYS.MODE] = cur && cur[STORAGE_KEYS.MODE] !== undefined && cur[STORAGE_KEYS.MODE] !== null
          ? cur[STORAGE_KEYS.MODE]
          : 'append';
        patch[STORAGE_KEYS.RATES] = dictCopy(DEFAULT_RATES, (cur && cur[STORAGE_KEYS.RATES]) || {});
        return area.set(patch);
      });
    }).catch(function () { /* noop */ });
    try {
      chrome.alarms.create('vnd-rates-refresh', { periodInMinutes: REFRESH_MINUTES });
    } catch (_) { /* alarms optional */ }
  });

  if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(function (alarm) {
      if (alarm && alarm.name === 'vnd-rates-refresh') {
        refreshLiveRates().catch(function () { /* keep offline rates */ });
      }
    });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    store().then(function (area) {
      var type = msg && msg.type;
      if (type === 'vnd:get-state') {
        var got = area
          ? area.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.RATES, STORAGE_KEYS.UPDATED_AT])
          : Promise.resolve({});
        return Promise.resolve(got).then(function (g) {
          sendResponse({
            ok: true,
            enabled: g && g[STORAGE_KEYS.ENABLED] !== undefined && g[STORAGE_KEYS.ENABLED] !== null ? g[STORAGE_KEYS.ENABLED] : true,
            mode: g && g[STORAGE_KEYS.MODE] !== undefined && g[STORAGE_KEYS.MODE] !== null ? g[STORAGE_KEYS.MODE] : 'append',
            rates: dictCopy(DEFAULT_RATES, (g && g[STORAGE_KEYS.RATES]) || {}),
            updatedAt: (g && g[STORAGE_KEYS.UPDATED_AT]) || 0,
          });
        });
      }
      if (type === 'vnd:set-enabled') {
        var p1 = area ? area.set((function () { var o = {}; o[STORAGE_KEYS.ENABLED] = !!(msg && msg.enabled); return o; })()) : Promise.resolve();
        return Promise.resolve(p1).then(function () { sendResponse({ ok: true }); });
      }
      if (type === 'vnd:set-mode') {
        var p2 = area ? area.set((function () { var o = {}; o[STORAGE_KEYS.MODE] = msg && msg.mode; return o; })()) : Promise.resolve();
        return Promise.resolve(p2).then(function () { sendResponse({ ok: true }); });
      }
      if (type === 'vnd:refresh-rates') {
        return refreshLiveRates().then(function (rates) {
          sendResponse({ ok: true, rates: rates, updatedAt: Date.now() });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        });
      }
      if (type === 'vnd:report-count') {
        return setBadge(Number(msg && msg.count) || 0, sender && sender.tab && sender.tab.id).then(function () {
          sendResponse({ ok: true });
        });
      }
      sendResponse({ ok: false, error: 'unknown message' });
      return undefined;
    }).catch(function () {
      try { sendResponse({ ok: false, error: 'internal error' }); } catch (_) { /* noop */ }
    });
    return true; // async response
  });
}

try {
  if (typeof globalThis !== 'undefined') {
    globalThis.VndBackground = {
      getEffectiveRates: getEffectiveRates,
      refreshLiveRates: refreshLiveRates,
    };
  }
} catch (_) { /* noop */ }
