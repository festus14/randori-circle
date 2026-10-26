#!/usr/bin/env node
// Byte-budget check (issue #400, baseline from the #412 inventory).
//
// The #412 baseline is file bytes on disk — uncompressed UTF-8 bytes —
// not network bytes: deterministic, reviewable in CI, and independent of
// compression, headers, and caching. tests/e2e/page-weight.spec.ts stays
// the separate network-view guard; it asserts no byte budget at all.
// Thresholds are the #412 proposals, adopted as-is (about 3% headroom
// over the Wave 10 baseline: index.html 973,059; CSS initial 124,195 /
// total 130,384; JS initial 964,418 / total 1,408,918).
//
// Slices:
// - index.html: the whole file.
// - CSS initial: inline <style> content + the stylesheets index.html
//   <link rel="stylesheet">s (circle-history.css; legal.css is used by
//   privacy.html/terms.html only, so it counts toward the total, not the
//   initial slice). CSS total: inline + all of assets/*.css.
// - JS initial: inline <script> content (no src=) + the assets/*.js files
//   index.html loads via <script src>. JS total: inline + all of
//   assets/*.js (including lazy/on-demand assets such as crdt-editor.js).
// External <script src> / <link href> URLs are never counted — the
// budget covers first-party file bytes only — and a referenced local
// asset that does not exist fails closed.
//
// Known limitations (documented, not silently assumed):
// - Parsing is regex over index.html, not a DOM parse: a <style> or
//   <script> tag inside an HTML comment or a JS string literal would be
//   counted. The current tree has no such shape.
// - Duplicate <script src> references to the same asset count once;
//   duplicate <link> references would likewise count once.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const GATE = 'byte-budget';

export const BYTE_BUDGET_THRESHOLDS = Object.freeze({
  indexHtml: 1_000_000,
  cssInitial: 130_000,
  cssTotal: 135_000,
  jsInitial: 1_000_000,
  jsTotal: 1_450_000,
});

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function isLocalReference(href) {
  if (!href) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return false;
  return true;
}

// A local href (/assets/x.js, assets/x.js, ./assets/x.js) as a repo path.
function localPath(href) {
  return href.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/)[0];
}

function readBytes(root, relative, errors) {
  try {
    return statSync(join(root, relative)).size;
  } catch {
    errors.push(`referenced file is missing: ${relative}`);
    return 0;
  }
}

export function measureByteBudget(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const errors = [];
  let html = '';
  try {
    html = readFileSync(join(root, 'index.html'), 'utf8');
  } catch {
    errors.push('index.html is missing');
    return { errors, measurement: null };
  }
  const indexHtml = byteLength(html);

  let inlineCss = 0;
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    inlineCss += byteLength(match[1]);
  }
  let inlineJs = 0;
  const scriptSrcs = new Set();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
    if (src) {
      if (isLocalReference(src)) scriptSrcs.add(localPath(src));
    } else {
      inlineJs += byteLength(match[2]);
    }
  }
  const linkedStylesheets = new Set();
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && isLocalReference(href)) linkedStylesheets.add(localPath(href));
  }

  const assets = (extension) => {
    try {
      return readdirSync(join(root, 'assets'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
        .map((entry) => `assets/${entry.name}`);
    } catch {
      errors.push('assets/ directory is missing');
      return [];
    }
  };
  const jsAssets = assets('.js');
  const cssAssets = assets('.css');
  const assetBytes = (relative) => readBytes(root, relative, errors);
  const jsTotalAssets = jsAssets.reduce((sum, file) => sum + assetBytes(file), 0);
  const cssTotalAssets = cssAssets.reduce((sum, file) => sum + assetBytes(file), 0);
  const jsInitialAssets = [...scriptSrcs].reduce((sum, file) => sum + assetBytes(file), 0);
  const cssInitialAssets = [...linkedStylesheets].reduce((sum, file) => sum + assetBytes(file), 0);

  const measurement = Object.freeze({
    indexHtml,
    cssInitial: inlineCss + cssInitialAssets,
    cssTotal: inlineCss + cssTotalAssets,
    jsInitial: inlineJs + jsInitialAssets,
    jsTotal: inlineJs + jsTotalAssets,
    inlineCss,
    inlineJs,
    linkedStylesheets: [...linkedStylesheets].sort(),
    scriptSrcs: [...scriptSrcs].sort(),
    assetJsFiles: jsAssets.length,
    assetCssFiles: cssAssets.length,
  });
  return { errors, measurement };
}

export function inspectByteBudget(rootDirectory = process.cwd()) {
  const { errors, measurement } = measureByteBudget(rootDirectory);
  if (!measurement) return Object.freeze(errors);
  const violations = [...errors];
  const checks = [
    ['index.html', measurement.indexHtml, BYTE_BUDGET_THRESHOLDS.indexHtml],
    ['CSS initial-load', measurement.cssInitial, BYTE_BUDGET_THRESHOLDS.cssInitial],
    ['CSS total', measurement.cssTotal, BYTE_BUDGET_THRESHOLDS.cssTotal],
    ['JS initial-load', measurement.jsInitial, BYTE_BUDGET_THRESHOLDS.jsInitial],
    ['JS total', measurement.jsTotal, BYTE_BUDGET_THRESHOLDS.jsTotal],
  ];
  for (const [label, actual, limit] of checks) {
    if (actual > limit) violations.push(`${label} byte budget exceeded: ${actual} > ${limit}`);
  }
  return Object.freeze(violations);
}

function main() {
  const errors = inspectByteBudget(process.cwd());
  if (errors.length > 0) {
    process.stderr.write(`${JSON.stringify({
      ok: false, gate: GATE, providerNetworkRequired: false, externalMutation: false, errors,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const { measurement } = measureByteBudget(process.cwd());
  process.stdout.write(`${JSON.stringify({
    ok: true, gate: GATE, providerNetworkRequired: false, externalMutation: false, measurement,
  }, null, 2)}\n`);
}

function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '')).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
