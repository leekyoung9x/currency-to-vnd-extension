/**
 * tests/layout_safety.test.mjs — regression tests for FIX-4.
 * The `append` badge used to stretch `whitespace-nowrap` table columns
 * (Budgets_InferHub: `$10 / $50` + 2-4 pill badges = 400-500% width),
 * crushing the `Max discount` column and pushing Save/Clear out of view.
 * Table-safe mode renders ONE block-level `.vnd-subline` per cell text node
 * (compound `$A / $B` clusters collapse into a single grouped label) and
 * falls back to hover tooltips under `truncate` / `overflow: hidden`.
 * Loads the REAL classic extension scripts via vm, like Chrome MV3.
 * Exports `layoutSafetyTests()` -> array of { test, expected, actual, pass }.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync as readSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const FIXTURE = path.join(root, 'fixtures', 'Budgets_InferHub.html');

function loadClassic(rel) {
  const code = readSync(path.join(root, rel), 'utf-8');
  vm.runInThisContext(code, { filename: rel });
  return code;
}

const contentSrc = loadClassic('shared/currency.js');
loadClassic('shared/rates.js');
const contentJs = loadClassic('content/content.js');
const contentCss = readSync(path.join(root, 'content', 'content.css'), 'utf-8');
const popupHtml = readSync(path.join(root, 'popup', 'popup.html'), 'utf-8');
const popupSrc = readSync(path.join(root, 'popup', 'popup.js'), 'utf-8');
const backgroundSrc = readSync(path.join(root, 'background.js'), 'utf-8');
const ratesSrc = readSync(path.join(root, 'shared', 'rates.js'), 'utf-8');
void contentSrc;

const DEFAULT_RATES = globalThis.CurrencyUtils.DEFAULT_RATES;
const CC = () => globalThis.CurrencyContent;

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

function saveClearCounts(document) {
  const btns = Array.from(document.querySelectorAll('button'));
  return {
    save: btns.filter((b) => (b.textContent || '').trim() === 'Save').length,
    clear: btns.filter((b) => (b.textContent || '').trim() === 'Clear').length,
  };
}

export async function layoutSafetyTests() {
  const rows = [];
  const rates = { ...DEFAULT_RATES };

  // ---- FIX-4.0: source-level guards ----
  rows.push(row(
    'tablesafe: content.js detects table context',
    'has isInsideTable',
    contentJs.includes('isInsideTable') ? 'has isInsideTable' : 'missing',
  ));
  rows.push(row(
    'tablesafe: content.js renders block sublines',
    'has vnd-subline',
    contentJs.includes('vnd-subline') ? 'has vnd-subline' : 'missing',
  ));
  rows.push(row(
    'tablesafe: content.js persists vnd_table_safe',
    'has vnd_table_safe',
    contentJs.includes('vnd_table_safe') ? 'has vnd_table_safe' : 'missing',
  ));
  rows.push(row(
    'tablesafe: content.js groups compound legs into one label',
    'has grouped legs.join',
    contentJs.includes("legs.join(' / ')") ? 'has grouped legs.join' : 'missing',
  ));
  rows.push(row(
    'tablesafe: content.css defines block subline',
    'has .vnd-subline { display: block',
    contentCss.includes('.vnd-subline') && contentCss.includes('display: block') ? 'has .vnd-subline { display: block' : 'missing',
  ));
  rows.push(row(
    'tablesafe: badge no longer inflates row height',
    'has line-height: normal',
    contentCss.includes('line-height: normal') ? 'has line-height: normal' : 'missing',
  ));
  rows.push(row(
    'tablesafe: content.css supports dark mode',
    'has dark selectors',
    contentCss.includes('.dark .vnd-badge') && contentCss.includes('prefers-color-scheme') ? 'has dark selectors' : 'missing',
  ));
  rows.push(row(
    'tablesafe: rates.js stores TABLE_SAFE key',
    'has vnd_table_safe',
    ratesSrc.includes("TABLE_SAFE: 'vnd_table_safe'") ? 'has vnd_table_safe' : 'missing',
  ));
  rows.push(row(
    'tablesafe: background answers vnd:set-table-safe',
    'has vnd:set-table-safe',
    backgroundSrc.includes('vnd:set-table-safe') ? 'has vnd:set-table-safe' : 'missing',
  ));
  rows.push(row(
    'tablesafe: popup has table-safe toggle',
    'has #tableSafe + label',
    popupHtml.includes('id="tableSafe"') && popupHtml.includes('Bảo vệ bảng (Table-safe mode)') ? 'has #tableSafe + label' : 'missing',
  ));
  rows.push(row(
    'tablesafe: popup explains append as table-safe',
    'has Kèm theo (Table-safe)',
    popupHtml.includes('Kèm theo (Table-safe)') ? 'has Kèm theo (Table-safe)' : 'missing',
  ));
  rows.push(row(
    'tablesafe: popup marks hover safe for dashboards',
    'has dashboard hint',
    popupHtml.includes('khuyên dùng cho bảng tính, dashboard') ? 'has dashboard hint' : 'missing',
  ));
  rows.push(row(
    'tablesafe: popup.js notifies background + tab',
    'has set-table-safe + rescan',
    popupSrc.includes('vnd:set-table-safe') && popupSrc.includes('vnd:rescan') ? 'has set-table-safe + rescan' : 'missing',
  ));

  // ---- FIX-4.1: unit detectors ----
  {
    const dom = new JSDOM('<html><body><table><tr><td id="c">$1</td><th id="h">$2</th></tr></table><div role="gridcell" id="g">$3</div><div role="row" id="r">$4</div><p id="p">$5</p></body></html>');
    const { document } = dom.window;
    const txt = (id) => document.getElementById(id).firstChild;
    rows.push(row('tablesafe: isInsideTable true in <td>', 'true', String(CC().isInsideTable(txt('c')))));
    rows.push(row('tablesafe: isInsideTable true in <th>', 'true', String(CC().isInsideTable(txt('h')))));
    rows.push(row('tablesafe: isInsideTable true with role=gridcell', 'true', String(CC().isInsideTable(txt('g')))));
    rows.push(row('tablesafe: isInsideTable true with role=row', 'true', String(CC().isInsideTable(txt('r')))));
    rows.push(row('tablesafe: isInsideTable false in <p>', 'false', String(CC().isInsideTable(txt('p')))));
    rows.push(row('tablesafe: default state enables table-safe', 'true', String(CC().getState().tableSafe)));
    // Grouped subline keeps full-precision labels (FIX-4 allows full form).
    const mini = new JSDOM('<html><body><table><tr><td>$10 / $50</td></tr></table></body></html>');
    CC().scanAndConvert(mini.window.document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: true, tableSafe: true });
    const miniSub = mini.window.document.querySelector('.vnd-subline')?.textContent || '';
    rows.push({
      test: 'tablesafe: grouped subline keeps full labels (≈ 260.000 ₫ / 1.300.000 ₫)',
      expected: 'contains "260.000 ₫" and "1.300.000 ₫"',
      actual: miniSub,
      pass: miniSub.includes('260.000 ₫') && miniSub.includes('1.300.000 ₫'),
    });
  }

  // ---- FIX-4.2: Budgets fixture in append mode — no column blowout ----
  {
    const html = await readFile(FIXTURE, 'utf-8');
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const before = document.body.innerHTML;
    const beforeBtns = saveClearCounts(document);
    const compoundCells = Array.from(document.querySelectorAll('td'))
      .filter((td) => (td.textContent || '').trim() === '$10 / $50');

    CC().setState({ enabled: true, mode: 'append', tableSafe: true });
    const r = CC().scanAndConvert(document, { rates, mode: 'append', enabled: true, tableSafe: true });
    rows.push({
      test: 'budgets append: converts the price grid',
      expected: '>= 300',
      actual: String(r.count),
      pass: r.count >= 300,
    });
    rows.push(row(
      'budgets append: zero inline badges inside tables',
      '0',
      String(document.querySelectorAll('table .vnd-badge').length),
    ));
    rows.push({
      test: 'budgets append: every converted node gets a subline',
      expected: `sublines == nodes (${r.nodes})`,
      actual: String(document.querySelectorAll('.vnd-subline').length),
      pass: document.querySelectorAll('.vnd-subline').length === r.nodes,
    });
    let maxSublines = 0;
    document.querySelectorAll('table [data-vnd-converted="true"]').forEach((el) => {
      // Count direct subline children (grouped label); nested wrappers do not occur.
      const direct = Array.from(el.children).filter((c) => c.classList && c.classList.contains('vnd-subline')).length;
      if (direct > maxSublines) maxSublines = direct;
    });
    rows.push({
      test: 'budgets append: at most 1 grouped subline per converted node',
      expected: '<= 1',
      actual: String(maxSublines),
      pass: maxSublines <= 1,
    });
    rows.push(row(
      'budgets append: nowrap cells keep zero inline badges',
      '0',
      String(document.querySelectorAll('.whitespace-nowrap .vnd-badge').length),
    ));
    rows.push({
      test: 'budgets append: compound "$10 / $50" cells collapse to one label',
      expected: '>= 1 cell, each exactly 1 subline, 0 badges',
      actual: `${compoundCells.length} cells; sublines=${compoundCells.map((td) => td.querySelectorAll('.vnd-subline').length).join(',') || 'n/a'}`,
      pass: compoundCells.length >= 1
        && compoundCells.every((td) => td.querySelectorAll('.vnd-subline').length === 1)
        && compoundCells.every((td) => td.querySelectorAll('.vnd-badge').length === 0),
    });
    const firstSub = compoundCells.length > 0
      ? (compoundCells[0].querySelector('.vnd-subline')?.textContent || '')
      : '';
    rows.push({
      test: 'budgets append: grouped label carries both legs (≈ 260.000 ₫ / 1.300.000 ₫)',
      expected: 'contains "260.000 ₫" and "1.300.000 ₫"',
      actual: firstSub || '(missing)',
      pass: firstSub.includes('260.000 ₫') && firstSub.includes('1.300.000 ₫'),
    });
    const afterBtns = saveClearCounts(document);
    rows.push({
      test: 'budgets append: Save buttons all survive',
      expected: String(beforeBtns.save),
      actual: String(afterBtns.save),
      pass: afterBtns.save === beforeBtns.save && afterBtns.save >= 1,
    });
    rows.push({
      test: 'budgets append: Clear buttons all survive',
      expected: String(beforeBtns.clear),
      actual: String(afterBtns.clear),
      pass: afterBtns.clear === beforeBtns.clear && afterBtns.clear >= 1,
    });
    const { restored } = CC().restoreConverted(document);
    rows.push({
      test: 'budgets append: restore() touches converted nodes',
      expected: `>= 1 (had ${r.nodes} nodes)`,
      actual: String(restored),
      pass: restored >= 1 && restored === r.nodes,
    });
    rows.push(row(
      'budgets append: restore() recovers byte-identical body HTML',
      'identical',
      document.body.innerHTML === before ? 'identical' : 'DIFFERS',
    ));
  }

  // ---- FIX-4.3: Budgets fixture in replace + hover modes ----
  {
    const html = await readFile(FIXTURE, 'utf-8');
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const before = document.body.innerHTML;
    CC().setState({ enabled: true, mode: 'replace', tableSafe: true });
    const r = CC().scanAndConvert(document, { rates, mode: 'replace', enabled: true });
    rows.push({
      test: 'budgets replace: converts the price grid',
      expected: '>= 300',
      actual: String(r.count),
      pass: r.count >= 300,
    });
    rows.push(row(
      'budgets replace: VND markers present, originals on hover',
      'yes',
      document.querySelector('.vnd-replace') ? 'yes' : 'no',
    ));
    rows.push({
      test: 'budgets replace: Save/Clear buttons survive',
      expected: 'save>=1 and clear>=1',
      actual: `save=${saveClearCounts(document).save} clear=${saveClearCounts(document).clear}`,
      pass: saveClearCounts(document).save >= 1 && saveClearCounts(document).clear >= 1,
    });
    const { restored } = CC().restoreConverted(document);
    rows.push({
      test: 'budgets replace: restore() recovers byte-identical body HTML',
      expected: 'identical',
      actual: document.body.innerHTML === before && restored === r.nodes ? 'identical' : 'DIFFERS',
      pass: document.body.innerHTML === before && restored === r.nodes,
    });
  }
  {
    const html = await readFile(FIXTURE, 'utf-8');
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const before = document.body.innerHTML;
    CC().setState({ enabled: true, mode: 'hover', tableSafe: true });
    const r = CC().scanAndConvert(document, { rates, mode: 'hover', enabled: true });
    rows.push({
      test: 'budgets hover: converts the price grid',
      expected: '>= 300',
      actual: String(r.count),
      pass: r.count >= 300,
    });
    rows.push(row(
      'budgets hover: layout untouched, tooltips present',
      'yes',
      document.querySelector('.vnd-hover') ? 'yes' : 'no',
    ));
    const { restored } = CC().restoreConverted(document);
    rows.push({
      test: 'budgets hover: restore() recovers byte-identical body HTML',
      expected: 'identical',
      actual: document.body.innerHTML === before && restored === r.nodes ? 'identical' : 'DIFFERS',
      pass: document.body.innerHTML === before && restored === r.nodes,
    });
    CC().setState({ enabled: true, mode: 'append', tableSafe: true });
  }

  // ---- FIX-4.4: truncate protection + tableSafe opt-out ----
  {
    const dom = new JSDOM('<html><body><div class="truncate">top $0.0637 model</div><p>plain $3.30 fee</p></body></html>');
    const { document } = dom.window;
    const r = CC().scanAndConvert(document, { rates, mode: 'append', enabled: true, tableSafe: true });
    rows.push(row('truncate: both amounts still convert', '2', String(r.count)));
    const truncDiv = document.querySelector('.truncate');
    rows.push(row(
      'truncate: clipped context falls back to hover (no badge)',
      '0 badges, 1 hover',
      `${truncDiv.querySelectorAll('.vnd-badge').length} badges, ${truncDiv.querySelectorAll('.vnd-hover').length} hover`,
      truncDiv.querySelectorAll('.vnd-badge').length === 0 && truncDiv.querySelectorAll('.vnd-hover').length === 1,
    ));
    rows.push(row(
      'truncate: plain paragraph keeps the inline badge',
      '1',
      String(document.querySelector('p').querySelectorAll('.vnd-badge').length),
    ));
    CC().restoreConverted(document);
  }
  {
    const dom = new JSDOM('<html><body><table><tr><td>$10 / $50</td></tr></table></body></html>');
    const { document } = dom.window;
    const r = CC().scanAndConvert(document, { rates, mode: 'append', enabled: true, tableSafe: false });
    rows.push(row('tablesafe off: legacy inline badges return in tables', '2', String(r.count)));
    rows.push(row(
      'tablesafe off: badges present, no sublines',
      '2 badges, 0 sublines',
      `${document.querySelectorAll('table .vnd-badge').length} badges, ${document.querySelectorAll('.vnd-subline').length} sublines`,
      document.querySelectorAll('table .vnd-badge').length === 2 && document.querySelectorAll('.vnd-subline').length === 0,
    ));
    CC().restoreConverted(document);
    CC().setState({ enabled: true, mode: 'append', tableSafe: true });
  }

  return rows;
}
