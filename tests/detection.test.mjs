/**
 * tests/detection.test.mjs — regression tests for currency identification
 * (`CA$` / `R$` / `CN¥` / suffix `€` / page hints) and conversion accuracy
 * (magnitudes, trailing punctuation, range dashes, zero-decimal currencies).
 * Loads the REAL classic shared/currency.js via vm.
 * Exports `detectionTests()` -> array of { test, expected, actual, pass }.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => vm.runInThisContext(readFileSync(path.join(here, '..', rel), 'utf-8'), { filename: rel });
load('shared/currency.js');
load('shared/rates.js');
load('content/content.js');

const { detectCurrencyAmounts, parseCurrencyAmount, inferHints } = globalThis.CurrencyUtils;

function row(test, expected, actual) {
  return { test, expected: String(expected), actual: String(actual), pass: String(expected) === String(actual) };
}

const legs = (text, hints) => detectCurrencyAmounts(text, null, hints)
  .map((d) => `${d.currency} ${d.amount}`).join(' | ') || '(none)';

export async function detectionTests() {
  const rows = [];

  // ---- currency identification ----
  rows.push(row('detect "CA$10" is CAD', 'CAD 10', legs('Price CA$10')));
  rows.push(row('detect "NZ$20" is NZD', 'NZD 20', legs('NZ$20')));
  rows.push(row('detect "R$ 50,00" is BRL', 'BRL 50', legs('R$ 50,00')));
  rows.push(row('detect "US$5" is USD', 'USD 5', legs('US$5')));
  rows.push(row('detect "CN¥100" is CNY', 'CNY 100', legs('CN¥100')));
  rows.push(row('detect "100元" is CNY', 'CNY 100', legs('100元')));
  rows.push(row('detect "1.500円" is JPY 1500', 'JPY 1500', legs('1.500円')));
  rows.push(row('detect "RMB 50" is CNY', 'CNY 50', legs('RMB 50')));
  rows.push(row('detect "$10 CAD" trailing code wins', 'CAD 10', legs('$10 CAD')));
  rows.push(row('detect "USD $10" single leg', 'USD 10', legs('USD $10')));
  rows.push(row('detect unknown "XY$5" not USD', '(none)', legs('XY$5')));
  rows.push(row('detect "USDC 10" not USD', '(none)', legs('USDC 10')));

  // ---- suffix symbols (EU style) ----
  rows.push(row('detect "29,99 €"', 'EUR 29.99', legs('29,99 €')));
  rows.push(row('detect "1.234,56 €"', 'EUR 1234.56', legs('1.234,56 €')));
  rows.push(row('detect "€2.500" EU thousands', 'EUR 2500', legs('€2.500')));
  rows.push(row('detect "50 zł"', 'PLN 50', legs('50 zł')));
  rows.push(row('detect "5 $10" no suffix steal', 'USD 10', legs('5 $10')));

  // ---- page hints for bare $ / ¥ ----
  rows.push(row('hint dollar=CAD: "$10"', 'CAD 10', legs('$10', { dollar: 'CAD' })));
  rows.push(row('hint yen=CNY: "¥100"', 'CNY 100', legs('¥100', { yen: 'CNY' })));
  rows.push(row('hint ignored for explicit "US$5"', 'USD 5', legs('US$5', { dollar: 'CAD' })));
  rows.push(row('hint bogus dollar falls back USD', 'USD 1', legs('$1', { dollar: 'EUR' })));
  rows.push(row('inferHints amazon.ca', 'CAD', inferHints({ hostname: 'www.amazon.ca' }).dollar));
  rows.push(row('inferHints lang en-AU', 'AUD', inferHints({ hostname: 'x.com', lang: 'en-AU' }).dollar));
  rows.push(row('inferHints zh-CN yen', 'CNY', inferHints({ lang: 'zh-CN' }).yen));
  rows.push(row('inferHints meta beats TLD', 'USD', inferHints({ hostname: 'shop.ca', metaCurrencies: ['USD'] }).dollar));
  rows.push(row('inferHints user setting wins', 'SGD', inferHints({ hostname: 'shop.ca', dollar: 'SGD' }).dollar));
  rows.push(row('inferHints default', 'USD/JPY', `${inferHints({}).dollar}/${inferHints({}).yen}`));

  // ---- conversion accuracy ----
  rows.push(row('detect "$1.5M" magnitude', 'USD 1500000', legs('$1.5M')));
  rows.push(row('detect "$10k"', 'USD 10000', legs('$10k')));
  rows.push(row('detect "$2 billion"', 'USD 2000000000', legs('$2 billion')));
  rows.push(row('detect "$5 Monthly" no magnitude', 'USD 5', legs('$5 Monthly')));
  rows.push(row('detect "$1,500, then" trailing comma', 'USD 1500', legs('costs $1,500, then')));
  rows.push(row('detect "$10 - $20" range not negative', 'USD 10 | USD 20', legs('$10 - $20')));
  rows.push(row('detect "$10-$20" range not negative', 'USD 10 | USD 20', legs('$10-$20')));
  rows.push(row('detect "-$5" still negative', 'USD -5', legs('-$5')));
  rows.push(row('detect "¥1.234" zero-decimal', 'JPY 1234', legs('¥1.234')));
  rows.push(row('detect "Rp 15.000"', 'IDR 15000', legs('Rp 15.000')));
  rows.push(row('detect "$1.250" per-token stays decimal', 'USD 1.25', legs('$1.250')));
  rows.push(row('parse "€0.125" stays decimal', 'EUR 0.125', `${parseCurrencyAmount('€0.125')?.currency} ${parseCurrencyAmount('€0.125')?.amount}`));

  // ---- DOM: page hints reach the content script ----
  const { scanAndConvert, pageHints } = globalThis.CurrencyContent;
  const ca = new JSDOM('<html lang="en-CA"><body><p>Only $10 today</p><p>US$10 too</p></body></html>');
  rows.push(row('dom: pageHints lang en-CA', 'CAD', pageHints(ca.window.document).dollar));
  scanAndConvert(ca.window.document, { enabled: true, mode: 'append', rates: globalThis.CurrencyUtils.DEFAULT_RATES });
  const badges = [...ca.window.document.querySelectorAll('.vnd-badge')];
  rows.push(row('dom: "$10" on en-CA page uses CAD rate', ' (≈ 190.000 ₫)', badges[0]?.textContent));
  rows.push(row('dom: badge title names currency', 'true', String(/^1 CAD = 19\.000 ₫/.test(badges[0]?.getAttribute('title') || ''))));
  rows.push(row('dom: explicit "US$10" stays USD', ' (≈ 260.000 ₫)', badges[1]?.textContent));
  const meta = new JSDOM('<html><head><meta property="og:price:currency" content="AUD"></head><body><p>$2</p></body></html>');
  rows.push(row('dom: og:price:currency AUD hint', 'AUD', pageHints(meta.window.document).dollar));

  return rows;
}
