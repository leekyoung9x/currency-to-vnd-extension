/**
 * tests/debug_dump.test.mjs — popup "Get DOM (debug)" collector
 * (shared/debug_dump.js). Proves the dump exposes what an outerHTML copy
 * hides: the exact childNodes tree of split-amount cells (Surplus
 * pattern), conversion counts and extension state.
 * Exports `debugDumpTests()` -> array of { test, expected, actual, pass }.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
const dumpSrc = readFileSync(path.join(here, '..', 'shared', 'debug_dump.js'), 'utf-8');
vm.runInThisContext(dumpSrc, { filename: 'shared/debug_dump.js' });

const DEFAULT_RATES = globalThis.CurrencyUtils.DEFAULT_RATES;
const { scanAndConvert } = globalThis.CurrencyContent;
const { collect } = globalThis.VndDebugDump;

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

export async function debugDumpTests() {
  const rows = [];
  const html = await readFile(FIXTURE, 'utf-8');
  const { document } = new JSDOM(html).window;

  rows.push(row(
    'dump: classic script, no ESM',
    'no ^import/^export',
    (/^import\s+/m.test(dumpSrc) || /^export\s+/m.test(dumpSrc)) ? 'HAS ESM' : 'no ^import/^export',
  ));

  const before = collect(document, { includeHtml: false });
  rows.push(row('dump: kind marker', 'vnd-debug-dump', before.kind));
  rows.push(row(
    'dump: sees split-amount candidates before scan',
    '>=6', before.candidatesTotal, before.candidatesTotal >= 6,
  ));

  const priceCand = before.candidates.find((c) => c.joinedText === '$0.003375' && c.childNodeTexts.length >= 3);
  rows.push(row(
    'dump: price candidate exposes the individual split text nodes',
    '["$","0",".","003375"]',
    priceCand ? JSON.stringify(priceCand.childNodeTexts.filter((n) => n.t === 3).map((n) => n.text)) : '(missing)',
  ));
  rows.push(row(
    'dump: candidate reports the joined match',
    '$0.003375 USD',
    priceCand?.matchesOnJoined?.length === 1
      ? `${priceCand.matchesOnJoined[0].raw} ${priceCand.matchesOnJoined[0].currency}`
      : '(missing)',
  ));
  rows.push(row('dump: extension state captured', true, !!(before.extension.hasCurrencyContent && before.extension.state), !!(before.extension.hasCurrencyContent && before.extension.state)));
  rows.push(row('dump: split scan availability flagged', true, before.extension.hasSplitScan));

  scanAndConvert(document, { rates: { ...DEFAULT_RATES }, mode: 'append', enabled: true });
  const after = collect(document);
  rows.push(row('dump: counts converted after scan', '>=6 cluster/inserted',
    `${after.counts.convertedCluster} cluster / ${after.counts.inserted} inserted`,
    after.counts.convertedCluster >= 6 && after.counts.inserted >= 6));
  rows.push(row('dump: html included by default', true, typeof after.html === 'string' && after.html.includes('select-none'), typeof after.html === 'string' && after.html.includes('select-none')));
  const convCand = after.candidates.find((c) => c.selfConverted === 'cluster');
  rows.push(row('dump: converted candidate flagged cluster', true, !!convCand, !!convCand));
  rows.push(row('dump: dump is JSON-serializable', true, (() => { try { return !!JSON.stringify(after); } catch (_) { return false; } })()));

  return rows;
}
