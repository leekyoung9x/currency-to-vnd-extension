/**
 * tests/rates_flow.test.mjs — background rate pipeline with a mocked
 * `chrome` API: custom overrides must reach content scripts, and live rates
 * must be fetched on install/startup instead of waiting for the 6h alarm.
 * Loads the REAL background.js (+ shared/*.js via importScripts) in a vm
 * sandbox. Exports `ratesFlowTests()` -> array of { test, expected, actual, pass }.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf-8');

function row(test, expected, actual) {
  return { test, expected: String(expected), actual: String(actual), pass: String(expected) === String(actual) };
}

function event() {
  const fns = [];
  return { addListener: (fn) => fns.push(fn), fire: (...a) => fns.map((fn) => fn(...a)) };
}

function bootBackground(initialStore) {
  const data = { ...initialStore };
  const fetchCalls = [];
  const chrome = {
    runtime: { id: 'test', onInstalled: event(), onStartup: event(), onMessage: event() },
    alarms: { create() {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: (_q, cb) => cb([]), sendMessage: async () => {} },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries((keys || []).filter((k) => k in data).map((k) => [k, data[k]])),
        set: async (patch) => { Object.assign(data, patch); },
        remove: async (keys) => { [].concat(keys).forEach((k) => delete data[k]); },
      },
    },
  };
  const sandbox = {
    chrome,
    console,
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, json: async () => ({ result: 'success', rates: { USD: 1, VND: 26500, EUR: 0.9 } }) };
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(read(f), sandbox, { filename: f }));
  vm.createContext(sandbox);
  vm.runInContext(read('background.js'), sandbox, { filename: 'background.js' });
  const send = (msg) => new Promise((resolve) => {
    chrome.runtime.onMessage.fire(msg, {}, resolve);
  });
  return { chrome, data, fetchCalls, send };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function ratesFlowTests() {
  const rows = [];

  // Custom overrides saved by popup/options must be part of get-state rates.
  const a = bootBackground({ vnd_custom_rates: { USD: 25000 } });
  const st = await a.send({ type: 'vnd:get-state' });
  rows.push(row('rates: get-state applies custom USD override', '25000', st?.rates?.USD));
  rows.push(row('rates: get-state exposes customRates', '25000', st?.customRates?.USD));

  // Fresh install: fetch live rates right away (not after 6h).
  const b = bootBackground({});
  b.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await tick(); await tick(); await tick();
  rows.push(row('rates: onInstalled fetches live rates', '1', b.fetchCalls.length));
  rows.push(row('rates: live USD stored after install', '26500', b.data.vnd_rates?.USD));

  // Browser startup with stale rates: refresh.
  const c = bootBackground({ vnd_rates_updated_at: Date.now() - 24 * 3600 * 1000 });
  c.chrome.runtime.onStartup.fire();
  await tick(); await tick(); await tick();
  rows.push(row('rates: onStartup refreshes stale rates', '1', c.fetchCalls.length));

  // Startup with fresh rates: no network call.
  const d = bootBackground({ vnd_rates_updated_at: Date.now() - 60 * 1000 });
  d.chrome.runtime.onStartup.fire();
  await tick(); await tick(); await tick();
  rows.push(row('rates: onStartup skips fresh rates', '0', d.fetchCalls.length));

  // Page-hint settings travel with state.
  const e = bootBackground({ vnd_dollar_currency: 'CAD' });
  const st2 = await e.send({ type: 'vnd:get-state' });
  rows.push(row('rates: get-state exposes dollar setting', 'CAD/auto', `${st2?.dollar}/${st2?.yen}`));

  return rows;
}
