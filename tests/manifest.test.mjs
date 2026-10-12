/**
 * tests/manifest.test.mjs — regression tests for FIX-2.
 * Chrome MV3 refuses to load an extension that declares "default_locale"
 * without a matching `_locales/<locale>/messages.json` subtree:
 *   "Default locale was specified, but _locales subtree is missing."
 * This extension uses no i18n (`__MSG_...__`), so the manifest must stay
 * loadable: either no "default_locale", or the _locales subtree exists.
 * Exports `manifestTests()` -> array of { test, expected, actual, pass }.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function row(test, expected, actual, pass = String(expected) === String(actual)) {
  return { test, expected: String(expected), actual: String(actual), pass: !!pass };
}

export function manifestTests() {
  const rows = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf-8'));
  } catch (e) {
    return [row('manifest: manifest.json is valid JSON', 'valid JSON', `INVALID: ${e?.message || e}`, false)];
  }

  rows.push(row('manifest: manifest_version is 3', '3', String(manifest.manifest_version)));

  const locale = manifest.default_locale;
  const hasLocalesDir = existsSync(path.join(root, '_locales', String(locale || ''), 'messages.json'));
  if (locale) {
    rows.push(row(
      'manifest: default_locale has matching _locales subtree',
      `no default_locale without _locales (got "${locale}")`,
      hasLocalesDir ? `_locales/${locale}/messages.json present` : '_locales subtree is missing',
      hasLocalesDir,
    ));
  } else {
    rows.push(row(
      'manifest: default_locale has matching _locales subtree',
      'loadable by Chrome (no dangling default_locale)',
      'loadable by Chrome (no dangling default_locale)',
    ));
  }

  return rows;
}
