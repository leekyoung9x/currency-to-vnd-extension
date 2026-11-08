/**
 * tests/split_nodes.test.mjs — FIX-5: amounts split across sibling nodes.
 * Fixture fixtures/Surplus_Requests.html mirrors the real Surplus
 * Intelligence requests table: the full `$0.003375` string lives only in
 * an `.sr-only` twin while the visible copy is split into sibling text
 * nodes with `invisible` alignment pads. Before FIX-5 the extension
 * converted the invisible twin and left the visible table untouched.
 * Exports `splitNodeTests()` -> array of { test, expected, actual, pass }.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'fixtures', 'Surplus_Requests.html');

function loadClassic(rel) {
  vm.runInThisContext(readFileSync(path.join(here, '..', rel), 'utf-8'), { filename: rel });
}
loadClassic('shared/currency.js');
loadClassic('shared/rates.js');
loadClassic('content/content.js');

const DEFAULT_RATES = globalThis.CurrencyUtils.DEFAULT_RATES;
const { scanAndConvert, restoreConverted, isVisuallyHiddenEl } = globalThis.CurrencyContent;
const OPTS = (mode) => ({ rates: { ...DEFAULT_RATES }, mode, enabled: true });

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

async function freshDoc() {
  const html = await readFile(FIXTURE, 'utf-8');
  return new JSDOM(html).window.document;
}

export async function splitNodeTests() {
  const rows = [];

  // ---- append mode (default, table-safe): the reported bug ----
  {
    const document = await freshDoc();
    const before = document.body.innerHTML;
    const r = scanAndConvert(document, OPTS('append'));
    const priceTds = [...document.querySelectorAll('tbody td')].filter((td) => td.querySelector('.sr-only'));

    rows.push(row('split: all 6 table prices converted (+2 header +1 note)', 9, r.count));
    rows.push(row(
      'split: no badge inside sr-only twins',
      0, document.querySelectorAll('.sr-only .vnd-subline, .sr-only .vnd-badge, .sr-only [data-vnd-converted]').length,
    ));
    rows.push(row(
      'split: subline lands in the VISIBLE span of every price cell',
      priceTds.length,
      priceTds.filter((td) => td.querySelector('span.select-none > .vnd-subline')).length,
    ));
    const firstSub = priceTds[0].querySelector('.vnd-subline');
    rows.push(row('split: $0.003375 -> subline text', '≈ 87,75 ₫', firstSub ? firstSub.textContent : '(missing)'));
    const paddedSub = priceTds[3].querySelector('.vnd-subline');
    rows.push(row(
      'split: invisible comma pad excluded ($234.50 with pad)',
      '≈ 6.097.000 ₫', paddedSub ? paddedSub.textContent : '(missing)',
    ));
    rows.push(row(
      'split: run parent marked cluster, original split nodes preserved',
      'cluster + >=4 child nodes',
      (() => {
        const vis = priceTds[0].querySelector('span.select-none');
        return `${vis.getAttribute('data-vnd-converted')} + ${vis.childNodes.length} child nodes`;
      })(),
      priceTds[0].querySelector('span.select-none').getAttribute('data-vnd-converted') === 'cluster'
        && priceTds[0].querySelector('span.select-none').childNodes.length >= 4,
    ));
    rows.push(row(
      'split: header Credit still converts (single text node)',
      1, document.querySelectorAll('.credit-pill .vnd-badge').length >= 1 ? 1 : 0,
    ));
    rows.push(row(
      'split: symbol in <b> + number sibling converts',
      1, document.querySelectorAll('p.note [data-vnd-inserted]').length,
    ));
    rows.push(row(
      'split: no false join ("$" + " off ... 50 items")',
      0, document.querySelectorAll('p.trap [data-vnd-inserted], p.trap .vnd-badge').length,
    ));

    const again = scanAndConvert(document, OPTS('append'));
    rows.push(row('split: rescan is idempotent (0 new)', 0, again.count));

    const restored = restoreConverted(document);
    rows.push(row('split: restore reports every conversion undone', true, restored.restored >= 7, restored.restored >= 7));
    rows.push(row(
      'split: restore returns the original DOM byte-for-byte',
      'identical', document.body.innerHTML === before ? 'identical' : 'DIFFERS',
    ));
  }

  // ---- hover mode: wrap + exact unwrap restore ----
  {
    const document = await freshDoc();
    const before = document.body.innerHTML;
    scanAndConvert(document, OPTS('hover'));
    const hov = document.querySelector('tbody td .vnd-hover');
    rows.push(row(
      'split hover: visible price wrapped with tooltip',
      'tooltip has ₫',
      hov ? hov.getAttribute('data-vnd-tooltip') : '(missing)',
      !!hov && /₫/.test(hov.getAttribute('data-vnd-tooltip')),
    ));
    rows.push(row('split hover: nothing converted inside sr-only', 0,
      document.querySelectorAll('.sr-only [data-vnd-converted], .sr-only .vnd-hover').length));
    restoreConverted(document);
    rows.push(row(
      'split hover: restore returns the original DOM byte-for-byte',
      'identical', document.body.innerHTML === before ? 'identical' : 'DIFFERS',
    ));
  }

  // ---- replace mode ----
  {
    const document = await freshDoc();
    scanAndConvert(document, OPTS('replace'));
    const rep = document.querySelector('tbody td .vnd-replace');
    rows.push(row('split replace: visible price replaced by VND', '87,75 ₫', rep ? rep.textContent : '(missing)'));
    rows.push(row('split replace: original kept in title', 'Gốc: $0.003375', rep ? rep.getAttribute('title') : '(missing)'));
    restoreConverted(document);
    const cellText = document.querySelector('tbody td:nth-child(2)').textContent;
    rows.push(row(
      'split replace: restore brings back the visible amount text',
      'contains $0.003375', cellText.includes('$0.003375') ? 'contains $0.003375' : cellText,
    ));
    rows.push(row('split replace: no marks left after restore', 0,
      document.querySelectorAll('[data-vnd-converted]').length));
  }

  // ---- hidden-element detection units ----
  {
    const document = await freshDoc();
    rows.push(row('hidden: sr-only detected', true, isVisuallyHiddenEl(document.querySelector('.sr-only'))));
    rows.push(row(
      'hidden: aria-hidden VISIBLE twin is NOT hidden',
      false, isVisuallyHiddenEl(document.querySelector('span.select-none')),
    ));
  }

  return rows;
}
