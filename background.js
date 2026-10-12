/**
 * background.js — MV3 service worker: rate management, live fetch,
 * storage cache, badge, and messaging with content/popup.
 */
import { DEFAULT_RATES, STORAGE_KEYS, mergeRates, ratesFromErApi } from './shared/rates.js';

const LIVE_URL = 'https://open.er-api.com/v6/latest/USD';
const REFRESH_MINUTES = 360; // 6h

async function store() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local;
  } catch (_) { /* noop */ }
  return null;
}

export async function getEffectiveRates() {
  const area = await store();
  if (!area) return { ...DEFAULT_RATES };
  try {
    const got = await area.get([STORAGE_KEYS.RATES, STORAGE_KEYS.CUSTOM_RATES]);
    return mergeRates(
      { ...DEFAULT_RATES, ...(got?.[STORAGE_KEYS.RATES] || {}) },
      got?.[STORAGE_KEYS.CUSTOM_RATES] || {},
    );
  } catch (_) {
    return { ...DEFAULT_RATES };
  }
}

export async function refreshLiveRates() {
  const res = await fetch(LIVE_URL);
  if (!res.ok) throw new Error(`Rate API HTTP ${res.status}`);
  const payload = await res.json();
  const live = ratesFromErApi(payload);
  if (!live) throw new Error('Rate API payload missing VND leg');
  const merged = mergeRates(DEFAULT_RATES, live);
  const area = await store();
  if (area) {
    await area.set({ [STORAGE_KEYS.RATES]: merged, [STORAGE_KEYS.UPDATED_AT]: Date.now() });
  }
  return merged;
}

async function setBadge(count, tabId) {
  try {
    if (typeof chrome === 'undefined' || !chrome.action) return;
    const text = count > 0 ? String(Math.min(count, 999)) : '';
    if (tabId != null) await chrome.action.setBadgeText({ text, tabId });
    else await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
  } catch (_) { /* noop */ }
}

function hasChrome() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

if (hasChrome()) {
  chrome.runtime.onInstalled.addListener(async () => {
    const area = await store();
    if (area) {
      const cur = await area.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.RATES]);
      await area.set({
        [STORAGE_KEYS.ENABLED]: cur?.[STORAGE_KEYS.ENABLED] ?? true,
        [STORAGE_KEYS.MODE]: cur?.[STORAGE_KEYS.MODE] ?? 'append',
        [STORAGE_KEYS.RATES]: { ...DEFAULT_RATES, ...(cur?.[STORAGE_KEYS.RATES] || {}) },
      });
    }
    try {
      chrome.alarms.create('vnd-rates-refresh', { periodInMinutes: REFRESH_MINUTES });
    } catch (_) { /* alarms optional */ }
  });

  chrome.alarms?.onAlarm.addListener(async (alarm) => {
    if (alarm?.name === 'vnd-rates-refresh') {
      try {
        await refreshLiveRates();
      } catch (_) { /* keep offline rates */ }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      const area = await store();
      switch (msg?.type) {
        case 'vnd:get-state': {
          const got = area
            ? await area.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.MODE, STORAGE_KEYS.RATES, STORAGE_KEYS.UPDATED_AT])
            : {};
          sendResponse({
            ok: true,
            enabled: got?.[STORAGE_KEYS.ENABLED] ?? true,
            mode: got?.[STORAGE_KEYS.MODE] ?? 'append',
            rates: { ...DEFAULT_RATES, ...(got?.[STORAGE_KEYS.RATES] || {}) },
            updatedAt: got?.[STORAGE_KEYS.UPDATED_AT] ?? 0,
          });
          break;
        }
        case 'vnd:set-enabled': {
          if (area) await area.set({ [STORAGE_KEYS.ENABLED]: !!msg.enabled });
          sendResponse({ ok: true });
          break;
        }
        case 'vnd:set-mode': {
          if (area) await area.set({ [STORAGE_KEYS.MODE]: msg.mode });
          sendResponse({ ok: true });
          break;
        }
        case 'vnd:refresh-rates': {
          try {
            const rates = await refreshLiveRates();
            sendResponse({ ok: true, rates, updatedAt: Date.now() });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }
        case 'vnd:report-count': {
          await setBadge(Number(msg.count) || 0, sender?.tab?.id);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    })();
    return true; // async response
  });
}
