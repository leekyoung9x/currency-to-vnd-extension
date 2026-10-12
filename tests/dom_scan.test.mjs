/**
 * tests/dom_scan.test.mjs — integration tests on the REAL user fixture
 * (fixtures/Usage_logs_Dashboard_InferHub.html) via JSDOM.
 * Loads the REAL classic extension scripts (shared/currency.js,
 * shared/rates.js, content/content.js) into the global scope via vm,
 * exactly like Chrome MV3 loads them as classic content scripts.
 * Exports `domScanTests()` -> array of { test, expected, actual, pass }.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'Usage_logs_Dashboard_InferHub.html');

function loadClassic(rel) {
  const code = readFileSync(path.join(here, '..', rel), 'utf-8');
  vm.runInThisContext(code, { filename: rel });
  return code;
}

const currencySrc = loadClassic('shared/currency.js');
loadClassic('shared/rates.js');
const contentSrc = loadClassic('content/content.js');

const DEFAULT_RATES = globalThis.CurrencyUtils.DEFAULT_RATES;
const { scanAndConvert, restoreConverted } = globalThis.CurrencyContent;

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

export async function domScanTests() {
  const rows = [];
  const html = await readFile(FIXTURE, 'utf-8');

  // ---- classic-script static assertions (FIX-1): no ESM keywords ----
  rows.push(row(
    'classic: content/content.js has no ESM import',
    'no ^import line',
    /^import\s+/m.test(contentSrc) ? 'HAS import' : 'no ^import line',
  ));
  rows.push(row(
    'classic: content/content.js has no ESM export',
    'no ^export line',
    /^export\s+/m.test(contentSrc) ? 'HAS export' : 'no ^export line',
  ));
  void currencySrc;

  // ---- main fixture scan (append mode) ----
  {
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const before = document.body.innerHTML;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: true });
    rows.push({
      test: 'fixture: converted amounts >= 80',
      expected: '>= 80',
      actual: String(r.count),
      pass: r.count >= 80,
    });
    const bodyText = document.body.textContent || '';
    rows.push(row('fixture: "$3.30" -> "85.800 ₫" present', 'yes', bodyText.includes('85.800 ₫') ? 'yes' : 'no'));
    rows.push(row('fixture: micro "$0.000021" -> "0,55 ₫" present', 'yes', bodyText.includes('0,55 ₫') ? 'yes' : 'no'));
    rows.push({
      test: 'fixture: no "0 ₫" collapse on micro-costs',
      expected: 'no isolated "0 ₫" badge from nonzero input',
      actual: bodyText.includes('(≈ 0 ₫)') ? 'FOUND "(≈ 0 ₫)"' : 'none found',
      pass: !bodyText.includes('(≈ 0 ₫)'),
    });
    rows.push(row(
      'fixture: converted markers use data-vnd-converted',
      'yes',
      document.querySelectorAll('[data-vnd-converted="true"]').length > 0 ? 'yes' : 'no',
    ));

    // ---- restore returns the exact original DOM ----
    const { restored } = restoreConverted(document);
    rows.push({
      test: 'fixture: restore() touches converted nodes',
      expected: `>= 1 (had ${r.nodes} nodes)`,
      actual: String(restored),
      pass: restored >= 1 && restored === r.nodes,
    });
    rows.push(row(
      'fixture: restore() recovers byte-identical body HTML',
      'identical',
      document.body.innerHTML === before ? 'identical' : 'DIFFERS',
    ));
  }

  // ---- replace mode: tooltip keeps the original ----
  {
    const dom = new JSDOM('<html><body><p>Total $3.30 due</p></body></html>');
    const { document } = dom.window;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'replace', enabled: true });
    const el = document.querySelector('.vnd-replace');
    rows.push(row('replace: one amount converted', '1', String(r.count)));
    rows.push(row('replace: VND text shown', '85.800 ₫', el?.textContent ?? '(missing)'));
    rows.push(row('replace: hover keeps original', 'Gốc: $3.30', el?.getAttribute('title') ?? '(missing)'));
  }

  // ---- hover mode: layout untouched, tooltip present ----
  {
    const dom = new JSDOM('<html><body><p>Fee $0.000021 / req</p></body></html>');
    const { document } = dom.window;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'hover', enabled: true });
    const el = document.querySelector('.vnd-hover');
    rows.push(row('hover: one amount wrapped', '1', String(r.count)));
    rows.push(row('hover: original text kept', '$0.000021', el?.textContent ?? '(missing)'));
    const tip = el?.getAttribute('data-vnd-tooltip') ?? '';
    rows.push({
      test: 'hover: tooltip shows VND + rate',
      expected: 'contains "0,55 ₫" and "26.000"',
      actual: tip || '(missing)',
      pass: tip.includes('0,55 ₫') && tip.includes('26.000'),
    });
  }

  // ---- forbidden tags are skipped ----
  {
    const dom = new JSDOM('<html><body><code>$5.00</code><pre>$6.00</pre><p>$5.00</p></body></html>');
    const { document } = dom.window;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: true });
    rows.push(row('skip: CODE/PRE untouched, P converted', '1', String(r.count)));
  }

  // ---- disabled state converts nothing ----
  {
    const dom = new JSDOM('<html><body><p>$3.30</p></body></html>');
    const { document } = dom.window;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: false });
    rows.push(row('disabled: converts nothing', '0', String(r.count)));
  }

  // ---- dual rate cell converts both legs ----
  {
    const dom = new JSDOM('<html><body><table><tr><td>$0.070/$0.350</td></tr></table></body></html>');
    const { document } = dom.window;
    const r = scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: true });
    const text = document.body.textContent || '';
    rows.push(row('dual "$0.070/$0.350": both legs converted', '2', String(r.count)));
    rows.push({
      test: 'dual legs formatted',
      expected: 'contains "1.820 ₫" and "9.100 ₫"',
      actual: text.replace(/\s+/g, ' ').trim(),
      pass: text.includes('1.820 ₫') && text.includes('9.100 ₫'),
    });
  }

  return rows;
}
