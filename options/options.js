/**
 * options/options.js — full rate table editor + display settings + probe.
 * Classic page script (reads globals from shared/*.js loaded above).
 */
var CurrencyUtils = (typeof window !== 'undefined' && window.CurrencyUtils)
  || (typeof globalThis !== 'undefined' && globalThis.CurrencyUtils)
  || {};
var DEFAULT_RATES = CurrencyUtils.DEFAULT_RATES || {};
var convertAndFormat = CurrencyUtils.convertAndFormat;

const $ = (id) => document.getElementById(id);
const CODES = Object.keys(DEFAULT_RATES);
let baseRates = { ...DEFAULT_RATES };

async function getState() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      const res = await chrome.runtime.sendMessage({ type: 'vnd:get-state' });
      if (res?.ok) return res;
    }
  } catch (_) { /* fallback */ }
  return { ok: true, enabled: true, mode: 'append', rates: { ...DEFAULT_RATES }, updatedAt: 0 };
}

function renderRates(rates) {
  const grid = $('rateGrid');
  grid.innerHTML = '';
  for (const code of CODES) {
    const label = document.createElement('label');
    label.textContent = `1 ${code} = … ₫`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.dataset.code = code;
    input.value = rates?.[code] ?? DEFAULT_RATES[code] ?? '';
    label.appendChild(input);
    grid.appendChild(label);
  }
}

/** Inputs that differ from the live/default table become custom overrides. */
function readOverrides() {
  const out = {};
  document.querySelectorAll('#rateGrid input').forEach((el) => {
    const n = Number(el.value);
    const code = el.dataset.code;
    if (!code || !Number.isFinite(n) || n <= 0) return;
    if (Math.abs(n - Number(baseRates[code])) > 1e-9) out[code] = n;
  });
  return out;
}

function readRates() {
  const out = { ...DEFAULT_RATES };
  document.querySelectorAll('#rateGrid input').forEach((el) => {
    const n = Number(el.value);
    if (el.dataset.code && Number.isFinite(n) && n > 0) out[el.dataset.code] = n;
  });
  return out;
}

document.addEventListener('DOMContentLoaded', async () => {
  const state = await getState();
  $('enabled').checked = state.enabled !== false;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === (state.mode || 'append');
  });
  baseRates = { ...DEFAULT_RATES, ...(state.baseRates || {}) };
  renderRates(state.rates || DEFAULT_RATES);
  $('updatedAt').textContent = state.updatedAt
    ? `Cập nhật: ${new Date(Number(state.updatedAt)).toLocaleString('vi-VN')}`
    : 'Chưa cập nhật online';

  $('enabled').addEventListener('change', async (e) => {
    try {
      await chrome.runtime.sendMessage({ type: 'vnd:set-enabled', enabled: e.target.checked });
    } catch (_) { /* noop */ }
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', async (e) => {
      try {
        await chrome.runtime.sendMessage({ type: 'vnd:set-mode', mode: e.target.value });
      } catch (_) { /* noop */ }
    });
  });

  $('refresh').addEventListener('click', async () => {
    $('msg').textContent = 'Đang cập nhật…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'vnd:refresh-rates' });
      if (res?.ok) {
        baseRates = { ...DEFAULT_RATES, ...(res.baseRates || {}) };
        renderRates(res.rates);
        $('updatedAt').textContent = `Cập nhật: ${new Date(Number(res.updatedAt)).toLocaleString('vi-VN')}`;
        $('msg').textContent = 'Đã cập nhật xong.';
      } else {
        $('msg').textContent = `Lỗi: ${res?.error || 'không fetch được'}`;
      }
    } catch (_) {
      $('msg').textContent = 'Lỗi: không kết nối được background.';
    }
  });

  $('reset').addEventListener('click', async () => {
    // Drop custom overrides only; keep the live (online) table.
    renderRates(baseRates);
    try {
      await chrome.storage.local.remove(['vnd_custom_rates']);
    } catch (_) { /* noop */ }
    $('msg').textContent = 'Đã khôi phục tỷ giá mặc định.';
  });

  const probe = async () => {
    const rates = readRates();
    const r = convertAndFormat($('probe').value, rates);
    $('probeOut').textContent = r ? `${$('probe').value.trim()}  →  ${r.text}` : 'Không nhận diện được giá tiền.';
  };
  $('probeBtn').addEventListener('click', probe);
  $('probe').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') probe();
  });

  // Auto-save custom rates on edit (debounced).
  let t = 0;
  $('rateGrid').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        await chrome.storage.local.set({ vnd_custom_rates: readOverrides() });
      } catch (_) { /* noop */ }
    }, 400);
  });
});
