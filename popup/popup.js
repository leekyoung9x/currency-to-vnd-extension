/**
 * popup/popup.js — controls: on/off switch, display mode, rates view/edit,
 * converted-count stats, re-scan. Classic page script (reads globals from
 * shared/currency.js + shared/rates.js loaded via <script> tags above).
 */
var DEFAULT_RATES = ((typeof window !== 'undefined' && window.CurrencyUtils && window.CurrencyUtils.DEFAULT_RATES)
  || ((typeof window !== 'undefined' && window.RateUtils && window.RateUtils.DEFAULT_RATES))
  || {});

var STORAGE_KEYS = ((typeof window !== 'undefined' && window.RateUtils && window.RateUtils.STORAGE_KEYS)
  || {
    RATES: 'vnd_rates',
    CUSTOM_RATES: 'vnd_custom_rates',
    UPDATED_AT: 'vnd_rates_updated_at',
    ENABLED: 'vnd_enabled',
    MODE: 'vnd_display_mode',
    TABLE_SAFE: 'vnd_table_safe',
  });
if (!STORAGE_KEYS.TABLE_SAFE) STORAGE_KEYS.TABLE_SAFE = 'vnd_table_safe';

const $ = (id) => document.getElementById(id);
const MAIN_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'KRW', 'AUD', 'CAD', 'SGD', 'THB'];
const DOLLAR_KEY = 'vnd_dollar_currency';
const YEN_KEY = 'vnd_yen_currency';
let customRates = {};

function fmtRate(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fmtTime(ts) {
  if (!ts) return 'Chưa cập nhật online';
  try {
    return `Cập nhật: ${new Date(Number(ts)).toLocaleString('vi-VN')}`;
  } catch (_) {
    return 'Chưa cập nhật online';
  }
}

async function getState() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      const res = await chrome.runtime.sendMessage({ type: 'vnd:get-state' });
      if (res?.ok) return res;
    }
  } catch (_) { /* fallback */ }
  return { ok: true, enabled: true, mode: 'append', tableSafe: true, rates: { ...DEFAULT_RATES }, updatedAt: 0 };
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch (_) {
    return null;
  }
}

function renderRates(rates) {
  const grid = $('rateGrid');
  grid.innerHTML = '';
  for (const code of MAIN_CODES) {
    const cell = document.createElement('div');
    cell.className = 'rate-cell';
    const name = document.createElement('span');
    name.textContent = `1 ${code}`;
    const val = document.createElement('b');
    val.textContent = `${fmtRate(rates?.[code] ?? DEFAULT_RATES[code])} ₫`;
    cell.append(name, val);
    grid.appendChild(cell);
  }
  const custom = $('customGrid');
  custom.innerHTML = '';
  for (const code of MAIN_CODES) {
    const label = document.createElement('label');
    label.textContent = `1 ${code} = … ₫`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.id = `custom-${code}`;
    // Only real overrides are filled in; the placeholder shows the live rate,
    // so saving never freezes untouched currencies at today's value.
    input.value = customRates?.[code] ?? '';
    input.placeholder = String(Math.round(Number(rates?.[code] ?? DEFAULT_RATES[code])) || '');
    label.appendChild(input);
    custom.appendChild(label);
  }
}

function readCustom() {
  const out = {};
  for (const code of MAIN_CODES) {
    const el = document.getElementById(`custom-${code}`);
    if (!el) continue;
    const raw = String(el.value ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[code] = n;
  }
  return out;
}

async function refreshStats() {
  try {
    const tab = await activeTab();
    if (!tab?.id) {
      $('statCount').textContent = 'Mở một tab web để xem thống kê';
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'vnd:count?' }).catch(() => null);
    const n = Number(res?.count);
    if (res?.hints && $('hintNow')) {
      $('hintNow').textContent = `Trang này: $ = ${res.hints.dollar}, ¥ = ${res.hints.yen}. Ký hiệu rõ ràng như CA$, US$, CN¥ luôn được nhận đúng.`;
    }
    $('statCount').textContent = Number.isFinite(n) && n > 0
      ? `Đã quy đổi ${n} giá tiền trên trang này`
      : 'Chưa phát hiện giá tiền nào (bấm Quét lại trang)';
  } catch (_) {
    $('statCount').textContent = 'Chưa quét trang này';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const state = await getState();
  customRates = state.customRates || {};
  $('enabled').checked = state.enabled !== false;
  if ($('dollarSel')) $('dollarSel').value = state.dollar || 'auto';
  if ($('yenSel')) $('yenSel').value = state.yen || 'auto';
  if ($('tableSafe')) $('tableSafe').checked = state.tableSafe !== false;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === (state.mode || 'append');
  });
  renderRates(state.rates || DEFAULT_RATES);
  $('updatedAt').textContent = fmtTime(state.updatedAt);
  await refreshStats();

  $('enabled').addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: isEnabled }).catch(() => null);
    } catch (_) { /* direct storage save is best-effort */ }
    try {
      chrome.runtime.sendMessage({ type: 'vnd:set-enabled', enabled: isEnabled }).catch(() => null);
    } catch (_) { /* background notify is best-effort */ }
    try {
      const tab = await activeTab();
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: isEnabled ? 'vnd:rescan' : 'vnd:restore', enabled: isEnabled }).catch(() => null);
    } catch (_) { /* tab notify is best-effort */ }
    if (!isEnabled) {
      $('statCount').textContent = 'Đã tắt extension trên trang';
    } else {
      await refreshStats();
    }
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async (e) => {
      try {
        await chrome.runtime.sendMessage({ type: 'vnd:set-mode', mode: e.target.value });
        const tab = await activeTab();
        if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'vnd:rescan' }).catch(() => null);
      } catch (_) { /* noop */ }
    });
  });

  if ($('tableSafe')) {
    $('tableSafe').addEventListener('change', async (e) => {
      const tableSafe = e.target.checked;
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.TABLE_SAFE]: tableSafe }).catch(() => null);
      } catch (_) { /* direct storage save is best-effort */ }
      try {
        chrome.runtime.sendMessage({ type: 'vnd:set-table-safe', tableSafe }).catch(() => null);
      } catch (_) { /* background notify is best-effort */ }
      try {
        const tab = await activeTab();
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'vnd:rescan', tableSafe }).catch(() => null);
      } catch (_) { /* tab notify is best-effort */ }
    });
  }

  // Content scripts listen to these keys and redraw on change.
  for (const [id, key] of [['dollarSel', DOLLAR_KEY], ['yenSel', YEN_KEY]]) {
    $(id)?.addEventListener('change', async (e) => {
      try {
        await chrome.storage.local.set({ [key]: e.target.value });
        setTimeout(refreshStats, 400);
      } catch (_) { /* noop */ }
    });
  }

  $('rescan').addEventListener('click', async () => {
    try {
      const tab = await activeTab();
      if (tab?.id) {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'vnd:rescan' }).catch(() => null);
        const n = Number(res?.count);
        $('statCount').textContent = Number.isFinite(n)
          ? `Đã quy đổi ${n} giá tiền trên trang này`
          : 'Đã gửi lệnh quét lại';
      }
    } catch (_) { /* noop */ }
  });

  $('refresh').addEventListener('click', async () => {
    $('refreshMsg').textContent = 'Đang cập nhật…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'vnd:refresh-rates' });
      if (res?.ok) {
        renderRates(res.rates);
        $('updatedAt').textContent = fmtTime(res.updatedAt);
        $('refreshMsg').textContent = 'Đã cập nhật xong.';
      } else {
        $('refreshMsg').textContent = `Lỗi: ${res?.error || 'không fetch được'}`;
      }
    } catch (e) {
      $('refreshMsg').textContent = 'Lỗi: không kết nối được background.';
    }
  });

  $('saveCustom').addEventListener('click', async () => {
    const overrides = readCustom();
    try {
      await chrome.storage.local.set({ vnd_custom_rates: overrides });
      customRates = overrides;
      const tab = await activeTab();
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'vnd:rescan' }).catch(() => null);
      $('refreshMsg').textContent = `Đã lưu ${Object.keys(overrides).length} tỷ giá tùy chỉnh.`;
    } catch (_) {
      $('refreshMsg').textContent = 'Không lưu được (thiếu quyền storage).';
    }
  });

  $('resetCustom').addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove(['vnd_custom_rates']);
      customRates = {};
      const fresh = await getState();
      renderRates(fresh.rates || DEFAULT_RATES);
      $('refreshMsg').textContent = 'Đã khôi phục tỷ giá mặc định.';
    } catch (_) { /* noop */ }
  });

  try {
    const v = chrome.runtime?.getManifest?.().version;
    if (v && $('extVersion')) $('extVersion').textContent = `v${v}`;
    if (v && $('extVersionHead')) $('extVersionHead').textContent = `v${v}`;
  } catch (_) { /* noop */ }

  // Get DOM (debug): inject shared/debug_dump.js into the active tab, run
  // VndDebugDump.collect(document) there, download the result as JSON.
  // The dump records exact childNodes trees of split-amount candidates —
  // information a plain outerHTML copy loses (nodes get merged).
  $('getDom')?.addEventListener('click', async () => {
    const msg = $('getDomMsg');
    msg.textContent = 'Đang lấy DOM…';
    try {
      const tab = await activeTab();
      if (!tab?.id) throw new Error('không có tab đang mở');
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/debug_dump.js'],
      });
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (window.VndDebugDump ? window.VndDebugDump.collect(document) : null),
      });
      const dump = res?.result;
      if (!dump) throw new Error('không lấy được dump (trang bị chặn inject?)');
      const host = (() => { try { return new URL(dump.url || tab.url || '').hostname || 'page'; } catch (_) { return 'page'; } })();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vnd-dom-${host}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      msg.textContent = `Đã tải dump (${dump.candidatesTotal ?? 0} ứng viên, gửi file này để debug).`;
    } catch (e) {
      msg.textContent = `Lỗi Get DOM: ${e?.message || e}`;
    }
  });
});
