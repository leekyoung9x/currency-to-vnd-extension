/**
 * tests/toggle.test.mjs — regression tests for FIX-3.
 * The popup on/off switch must fully disable the extension on the page:
 * converted DOM is restored byte-identically, and later DOM mutations
 * must NOT be auto-converted while disabled.
 * Loads the REAL classic extension scripts (shared/currency.js,
 * shared/rates.js, content/content.js) into the global scope via vm,
 * exactly like Chrome MV3 loads them as classic content scripts.
 * Exports `toggleTests()` -> array of { test, expected, actual, pass }.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function loadClassic(rel) {
  const code = readFileSync(path.join(here, '..', rel), 'utf-8');
  vm.runInThisContext(code, { filename: rel });
  return code;
}

loadClassic('shared/currency.js');
loadClassic('shared/rates.js');
const contentSrc = loadClassic('content/content.js');
const backgroundSrc = readFileSync(path.join(root, 'background.js'), 'utf-8');
const popupSrc = readFileSync(path.join(root, 'popup', 'popup.js'), 'utf-8');

const DEFAULT_RATES = globalThis.CurrencyUtils.DEFAULT_RATES;

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

export async function toggleTests() {
  const rows = [];
  const CC = () => globalThis.CurrencyContent;
  const rates = { ...DEFAULT_RATES };

  // ---- FIX-3.1: disabling restores 100% of the original DOM ----
  {
    const dom = new JSDOM('<html><body><p>Total $3.30 due, fee $0.000021 / req</p><p>Pay €15.50</p></body></html>');
    const { document } = dom.window;
    const before = document.body.innerHTML;
    CC().setState({ enabled: true, mode: 'append' });
    const r = CC().scanAndConvert(document, { rates, mode: 'append', enabled: true });
    rows.push({
      test: 'toggle: scan converts before disabling',
      expected: '>= 2',
      actual: String(r.count),
      pass: r.count >= 2,
    });
    // Simulate the vnd:restore path: disable state + restore + report 0.
    CC().setState({ enabled: false });
    const { restored } = CC().restoreConverted(document);
    rows.push({
      test: 'toggle: disable restores every converted node',
      expected: `>= 1 (had ${r.nodes} nodes)`,
      actual: String(restored),
      pass: restored >= 1 && restored === r.nodes,
    });
    rows.push(row(
      'toggle: disable recovers byte-identical body HTML',
      'identical',
      document.body.innerHTML === before ? 'identical' : 'DIFFERS',
    ));
    rows.push(row(
      'toggle: state is disabled after restore',
      'false',
      String(CC().getState().enabled),
    ));
  }

  // ---- FIX-3.2: DOM mutations after disable must NOT auto-convert ----
  {
    const dom = new JSDOM('<html><body><p>$3.30</p></body></html>');
    const { document } = dom.window;
    CC().setState({ enabled: true, mode: 'append' });
    CC().scanAndConvert(document, { rates, mode: 'append', enabled: true });
    // vnd:restore path.
    CC().setState({ enabled: false });
    CC().restoreConverted(document);
    // Late SPA-style mutation arrives while disabled.
    const late = document.createElement('p');
    late.id = 'late';
    late.textContent = 'New price $42.00 here';
    document.body.appendChild(late);
    // Observer-driven rescan uses ambient state (no explicit options).
    const r = CC().scanAndConvert(document);
    rows.push(row('toggle: mutation while disabled converts nothing', '0', String(r.count)));
    rows.push(row(
      'toggle: late node keeps raw text while disabled',
      'New price $42.00 here',
      document.getElementById('late')?.textContent ?? '(missing)',
    ));
    rows.push(row(
      'toggle: no converted markers while disabled',
      '0',
      String(document.querySelectorAll('[data-vnd-converted="true"]').length),
    ));
    // Re-enabling converts again (proves the guard was the cause).
    CC().setState({ enabled: true });
    const r2 = CC().scanAndConvert(document);
    rows.push({
      test: 'toggle: re-enable converts again',
      expected: '>= 1',
      actual: String(r2.count),
      pass: r2.count >= 1,
    });
    CC().setState({ enabled: true, mode: 'append' });
    CC().restoreConverted(document);
  }

  // ---- FIX-3.3: rescan helper respects the disabled state ----
  {
    const dom = new JSDOM('<html><body><p>$5.00</p></body></html>');
    const { document } = dom.window;
    CC().setState({ enabled: false, mode: 'append' });
    const r = CC().rescan(document, { rates, mode: 'append' });
    rows.push(row('toggle: rescan() while disabled converts nothing', '0', String(r.count)));
    CC().setState({ enabled: true, mode: 'append' });
    CC().restoreConverted(document);
  }

  // ---- FIX-3.4: source-level regression guards ----
  rows.push(row(
    'toggle: background.js never calls store().then',
    'no store().then',
    backgroundSrc.includes('store().then') ? 'HAS store().then' : 'no store().then',
  ));
  rows.push(row(
    'toggle: background.js broadcasts toggle to tabs',
    'has chrome.tabs.query',
    backgroundSrc.includes('chrome.tabs.query') ? 'has chrome.tabs.query' : 'missing',
  ));
  rows.push(row(
    'toggle: background.js clears badge when disabled',
    'has setBadgeText',
    backgroundSrc.includes('setBadgeText') ? 'has setBadgeText' : 'missing',
  ));
  rows.push(row(
    'toggle: popup saves enabled directly to storage',
    'has storage set ENABLED',
    popupSrc.includes('[STORAGE_KEYS.ENABLED]') ? 'has storage set ENABLED' : 'missing',
  ));
  rows.push(row(
    'toggle: popup shows disabled status text',
    'has status text',
    popupSrc.includes('Đã tắt extension trên trang') ? 'has status text' : 'missing',
  ));
  rows.push(row(
    'toggle: content restore path disables state',
    'has currentState.enabled = false',
    contentSrc.includes('currentState.enabled = false') ? 'has currentState.enabled = false' : 'missing',
  ));
  rows.push(row(
    'toggle: content rescan path reads msg.enabled',
    'has msg.enabled !== false',
    contentSrc.includes('msg.enabled !== false') ? 'has msg.enabled !== false' : 'missing',
  ));
  rows.push(row(
    'toggle: observer rescan exits when disabled',
    'has enabled guard',
    contentSrc.includes('if (currentState.enabled === false) return;') ? 'has enabled guard' : 'missing',
  ));

  return rows;
}
