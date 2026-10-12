#!/usr/bin/env node
/**
 * tests/run_all.mjs — runs the whole suite, prints a standard measurement
 * table (TEST | EXPECTED | ACTUAL | PASS/FAIL), exits 0 on 100% PASS
 * and 1 on any FAIL. `npm test` maps here.
 */
import { currencyTests } from './currency.test.mjs';
import { domScanTests } from './dom_scan.test.mjs';

const pad = (s, n) => {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
};

function printTable(rows) {
  const W = { test: 52, expected: 34, actual: 34, status: 9 };
  const line = (a, b, c, d) => console.log(`${pad(a, W.test)} | ${pad(b, W.expected)} | ${pad(c, W.actual)} | ${pad(d, W.status)}`);
  console.log('');
  line('TEST', 'EXPECTED', 'ACTUAL', 'PASS/FAIL');
  console.log(`${'-'.repeat(W.test)}-+-${'-'.repeat(W.expected)}-+-${'-'.repeat(W.actual)}-+-${'-'.repeat(W.status)}`);
  for (const r of rows) {
    line(r.test, r.expected, r.actual, r.pass ? 'PASS' : 'FAIL');
  }
}

const all = [];
try {
  all.push(...currencyTests());
} catch (e) {
  all.push({ test: 'currencyTests() threw', expected: 'no throw', actual: String(e?.message || e), pass: false });
}
try {
  all.push(...(await domScanTests()));
} catch (e) {
  all.push({ test: 'domScanTests() threw', expected: 'no throw', actual: String(e?.message || e), pass: false });
}

printTable(all);
const passed = all.filter((r) => r.pass).length;
console.log('');
console.log(`RESULT: ${passed}/${all.length} PASS`);
if (passed === all.length && all.length > 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log('SOME TESTS FAILED');
  process.exit(1);
}
