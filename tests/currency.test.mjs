/**
 * tests/currency.test.mjs — unit tests for parse / regex / convert / format.
 * Exports `currencyTests()` -> array of { test, expected, actual, pass }.
 */
import {
  detectCurrencyAmounts,
  parseCurrencyAmount,
  parseNumber,
  convertToVND,
  formatVND,
  convertAndFormat,
  DEFAULT_RATES,
} from '../shared/currency.js';

const RATE_USD = DEFAULT_RATES.USD; // 26000

function row(test, expected, actual) {
  return { test, expected: String(expected), actual: String(actual), pass: String(expected) === String(actual) };
}

function fmtAmount(p) {
  if (!p) return '(null)';
  return `${p.currency} ${p.amount}`;
}

export function currencyTests() {
  const rows = [];

  // ---- parse: basic symbol forms ----
  rows.push(row('parse "$3.30"', 'USD 3.3', fmtAmount(parseCurrencyAmount('$3.30'))));
  rows.push(row('parse "$0.0889"', 'USD 0.0889', fmtAmount(parseCurrencyAmount('$0.0889'))));
  rows.push(row('parse micro "$0.000021"', 'USD 0.000021', fmtAmount(parseCurrencyAmount('$0.000021'))));
  rows.push(row('parse "15.50 EUR"', 'EUR 15.5', fmtAmount(parseCurrencyAmount('15.50 EUR'))));
  rows.push(row('parse "100 JPY"', 'JPY 100', fmtAmount(parseCurrencyAmount('100 JPY'))));
  rows.push(row('parse negative "-$5"', 'USD -5', fmtAmount(parseCurrencyAmount('-$5'))));
  rows.push(row('parse "+$10.00"', 'USD 10', fmtAmount(parseCurrencyAmount('+$10.00'))));
  rows.push(row('parse "~$5.00"', 'USD 5', fmtAmount(parseCurrencyAmount('~$5.00'))));
  rows.push(row('parse "USD 10"', 'USD 10', fmtAmount(parseCurrencyAmount('USD 10'))));
  rows.push(row('parse "10 USD"', 'USD 10', fmtAmount(parseCurrencyAmount('10 USD'))));
  rows.push(row('parse "€15.5"', 'EUR 15.5', fmtAmount(parseCurrencyAmount('€15.5'))));
  rows.push(row('parse "C$25"', 'CAD 25', fmtAmount(parseCurrencyAmount('C$25'))));
  rows.push(row('parse "₩22,000"', 'KRW 22000', fmtAmount(parseCurrencyAmount('₩22,000'))));

  // ---- parse: thousand / decimal separators ----
  rows.push(row('parseNumber "1,234.56" (US)', '1234.56', String(parseNumber('1,234.56'))));
  rows.push(row('parseNumber "1.234,56" (EU)', '1234.56', String(parseNumber('1.234,56'))));
  rows.push(row('parse "$1,234.56"', 'USD 1234.56', fmtAmount(parseCurrencyAmount('$1,234.56'))));
  rows.push(row('parse "€1.234,56"', '1234.56', String(parseCurrencyAmount('€1.234,56')?.amount ?? '(null)')));

  // ---- detect: dual / range forms find every leg ----
  const dual = detectCurrencyAmounts('$0.070/$0.350');
  rows.push(row('detect "$0.070/$0.350" legs', '2', String(dual.length)));
  rows.push(row('detect "$0.070/$0.350" raws', '$0.070 | $0.350', dual.map((d) => d.raw).join(' | ')));
  const spaced = detectCurrencyAmounts('$0.020 / $0.100');
  rows.push(row('detect "$0.020 / $0.100" legs', '2', String(spaced.length)));
  const range = detectCurrencyAmounts('$10 - $20');
  rows.push(row('detect "$10 - $20" legs', '2', String(range.length)));
  const rangeTilde = detectCurrencyAmounts('$10 ~ $20');
  rows.push(row('detect "$10 ~ $20" legs', '2', String(rangeTilde.length)));

  // ---- convert ----
  rows.push(row('convert $3.30 @26000', String(3.3 * RATE_USD), String(convertToVND(3.3, 'USD'))));
  rows.push(row('convert 100 JPY @175', '17500', String(convertToVND(100, 'JPY'))));
  rows.push(row('convert unknown currency', '(null)', String(convertToVND(10, 'XXX') ?? '(null)')));

  // ---- format VND ----
  rows.push(row('format "$3.30" -> VND', '85.800 ₫', formatVND(convertToVND(3.3, 'USD'))));
  rows.push(row('format micro "$0.000021"', '0,55 ₫', formatVND(convertToVND(0.000021, 'USD'))));
  const microText = formatVND(0.546);
  rows.push({
    test: 'micro <1đ never collapses to "0 ₫"',
    expected: 'not "0 ₫"',
    actual: microText,
    pass: microText !== '0 ₫' && microText.includes('₫'),
  });
  const tinyText = formatVND(0.001);
  rows.push({
    test: 'tiny 0.001đ never collapses to "0 ₫"',
    expected: 'not "0 ₫"',
    actual: tinyText,
    pass: tinyText !== '0 ₫' && tinyText.includes('₫'),
  });
  rows.push(row('format 14.5đ keeps decimals', '14,50 ₫', formatVND(14.5)));
  rows.push(row('format 2311.4đ rounds to integer', '2.311 ₫', formatVND(2311.4)));

  // ---- end-to-end helper ----
  rows.push(row('convertAndFormat "$3.30"', '85.800 ₫', convertAndFormat('$3.30')?.text ?? '(null)'));
  rows.push(row('convertAndFormat "$0.000021"', '0,55 ₫', convertAndFormat('$0.000021')?.text ?? '(null)'));

  return rows;
}
