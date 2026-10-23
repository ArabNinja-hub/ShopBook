#!/usr/bin/env node
/**
 * Cross-platform production build for the GitHub Pages project site.
 *
 * Kept as a Node script (instead of an inline `VAR=value vite build` npm script)
 * so it behaves identically in PowerShell, CI and bash.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyBuiltHtml } from './verify-dist-base.mjs';

const PAGES_BASE = '/ShopBook/';
const distDir = path.resolve(process.cwd(), 'dist');

const npmBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npmBin, ['vite', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE_PATH: PAGES_BASE },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
const verification = verifyBuiltHtml(html, PAGES_BASE, { distDir });

if (!verification.ok) {
  console.error(`[build-pages] Built HTML is not safe for base "${PAGES_BASE}":`);
  for (const problem of verification.problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  `[build-pages] OK — ${verification.checkedPaths.length} asset path(s) resolved under ${PAGES_BASE}`
);
