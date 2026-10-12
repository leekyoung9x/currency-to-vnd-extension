/**
 * verify/verify.js — standalone self-check: runs conversion assertions and
 * renders a TEST | EXPECTED | ACTUAL | PASS/FAIL table into verify.html.
 */
import {
  detectCurrencyAmounts,
  convertToVND,
  formatVND,
  parseCurrencyAmount,
  DEFAULT_RATES,
} from '../shared/currency.js';
import { scanAndConvert, restoreConverted } from '../content/content.js';

const CASES = [
  { input: '$3.30', expected: '85.800 ₫' },
  { input: '$0.0889', expected: '2.311 ₫' },
  { input: '$0.000021', expected: '0,55 ₫' },
  { input: '$0.070/$0.350', expectedCount: 2 },
  { input: '15.50 EUR', expected: '437.100 ₫' },
  { input: '100 JPY', expected: '17.500 ₫' },
  { input: '-$5', expected: '-130.000 ₫' },
  { input: '$1,234.56', expected: '32.098.560 ₫' },
  { input: '€1.234,56', expected: '34.814.592 ₫' },
];

export function runChecks() {
  const rows = [];
  for (const c of CASES) {
    if (c.expectedCount != null) {
      const found = detectCurrencyAmounts(c.input);
      rows.push({
        test: `detect "${c.input}"`,
        expected: `${c.expectedCount} amounts`,
        actual: `${found.length} amounts`,
        pass: found.length === c.expectedCount,
      });
      continue;
    }
    const p = parseCurrencyAmount(c.input);
    const vnd = p ? convertToVND(p.amount, p.currency, DEFAULT_RATES) : null;
    const actual = vnd == null ? '(no match)' : formatVND(vnd);
    rows.push({ test: `convert "${c.input}"`, expected: c.expected, actual, pass: actual === c.expected });
  }
  return rows;
}

function render(rows) {
  const tbody = document.getElementById('rows');
  const summary = document.getElementById('summary');
  tbody.innerHTML = '';
  let pass = 0;
  for (const r of rows) {
    if (r.pass) pass += 1;
    const tr = document.createElement('tr');
    for (const [key, cls] of [['test'], ['expected'], ['actual'], ['pass']]) {
      const td = document.createElement('td');
      if (key === 'pass') {
        td.textContent = r.pass ? 'PASS' : 'FAIL';
        td.className = r.pass ? 'pass' : 'fail';
      } else {
        td.textContent = r[key];
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  summary.textContent = `${pass}/${rows.length} PASS`;
  return pass === rows.length;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('run').addEventListener('click', () => {
    const rows = runChecks();
    // Live DOM demo: convert the sample block in append mode, then keep it.
    try {
      document.querySelectorAll('.samples p').forEach((p) => {
        restoreConverted(p);
        scanAndConvert(p, { rates: DEFAULT_RATES, mode: 'append' });
      });
    } catch (_) { /* table still renders */ }
    render(rows);
  });
});
