#!/usr/bin/env node
/**
 * ShopBook build guard — fails the build when the emitted HTML is not safe to
 * serve from the configured public path.
 *
 * Why this exists:
 *   GitHub Pages project sites are served from `/ShopBook/`, not `/`. If the built
 *   `index.html` references a root-absolute asset such as `/assets/index-abc.js`,
 *   the browser requests `https://<user>.github.io/assets/index-abc.js` instead of
 *   `https://<user>.github.io/ShopBook/assets/index-abc.js` and the page renders a
 *   blank white screen with 404s. This exact defect shipped once; the guard makes
 *   sure it cannot ship again.
 *
 * Usage:
 *   node scripts/verify-dist-base.mjs                  # base from VITE_BASE_PATH, default "/"
 *   node scripts/verify-dist-base.mjs --base /ShopBook/
 *   node scripts/verify-dist-base.mjs --dist dist --base /ShopBook/
 */

import fs from 'node:fs';
import path from 'node:path';

/** Normalizes a public path so it always starts and ends with exactly one slash. */
export function normalizeBase(rawBase) {
  const trimmed = String(rawBase ?? '').trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * Extracts every root-absolute URL used by an asset-bearing HTML attribute.
 * Returns unique, sorted values such as ['/assets/index-abc.js'].
 */
export function findRootAbsoluteAssetPaths(html) {
  const attributePattern = /\b(?:src|href)\s*=\s*"([^"]*)"/gi;
  const found = new Set();
  let match;
  while ((match = attributePattern.exec(html)) !== null) {
    const value = match[1].trim();
    if (value.startsWith('/') && !value.startsWith('//')) {
      found.add(value);
    }
  }
  return [...found].sort();
}

/**
 * Returns the root-absolute asset paths that do NOT live under `base`.
 * Root base ('/') accepts every root-absolute path by definition.
 */
export function findUnsafeAssetPaths(html, base) {
  const normalizedBase = normalizeBase(base);
  const absolutePaths = findRootAbsoluteAssetPaths(html);
  if (normalizedBase === '/') return {};
  return Object.fromEntries(
    absolutePaths
      .filter((assetPath) => !assetPath.startsWith(normalizedBase))
      .map((assetPath) => [assetPath, normalizedBase])
  );
}

/**
 * Validates a built HTML string plus its on-disk asset targets.
 *
 * @returns {{ ok: boolean, problems: string[], checkedPaths: string[] }}
 */
export function verifyBuiltHtml(html, base, options = {}) {
  const normalizedBase = normalizeBase(base);
  const distDir = options.distDir ?? null;
  const problems = [];
  const checkedPaths = findRootAbsoluteAssetPaths(html);

  const unsafe = findUnsafeAssetPaths(html, normalizedBase);
  for (const assetPath of Object.keys(unsafe)) {
    problems.push(
      `Asset "${assetPath}" is served from the domain root but the app is deployed under "${normalizedBase}". ` +
        'The browser would request it outside the deployed folder and receive a 404.'
    );
  }

  if (!/<div\s+id="root"\s*>/i.test(html)) {
    problems.push('Built HTML has no <div id="root"> mount point.');
  }
  if (!/<script[^>]+type="module"[^>]+src=/i.test(html)) {
    problems.push('Built HTML has no module script entry point.');
  }

  if (distDir) {
    for (const assetPath of checkedPaths) {
      const relative = assetPath.startsWith(normalizedBase)
        ? assetPath.slice(normalizedBase.length)
        : assetPath.replace(/^\/+/, '');
      const onDisk = path.join(distDir, relative);
      if (!fs.existsSync(onDisk)) {
        problems.push(`Referenced asset "${assetPath}" is missing from ${distDir}.`);
      }
    }
  }

  return { ok: problems.length === 0, problems, checkedPaths };
}

function parseArgs(argv) {
  const args = { dist: 'dist', base: process.env.VITE_BASE_PATH ?? '/' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.dist = argv[i + 1];
    if (argv[i] === '--base') args.base = argv[i + 1];
  }
  return args;
}

function main() {
  const { dist, base } = parseArgs(process.argv.slice(2));
  const indexPath = path.join(dist, 'index.html');

  if (!fs.existsSync(indexPath)) {
    console.error(`[verify-dist-base] Missing ${indexPath}. Run the build first.`);
    process.exit(1);
  }

  const html = fs.readFileSync(indexPath, 'utf8');
  const result = verifyBuiltHtml(html, base, { distDir: dist });

  if (!result.ok) {
    console.error(`[verify-dist-base] FAILED for base "${normalizeBase(base)}"`);
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log(
    `[verify-dist-base] OK — base "${normalizeBase(base)}", ${result.checkedPaths.length} asset path(s) verified:`
  );
  for (const assetPath of result.checkedPaths) {
    console.log(`  - ${assetPath}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
