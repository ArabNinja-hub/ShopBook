import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The published GitHub Pages site is a project site served from /ShopBook/, so a
 * root-absolute asset path in the built HTML produces a blank page. These tests
 * exercise the real build guard (`scripts/verify-dist-base.mjs`) against fixture
 * builds, covering both the failing and passing cases.
 */

const scriptPath = path.resolve(process.cwd(), 'scripts/verify-dist-base.mjs');
const tempDirs: string[] = [];

const makeDist = (html: string, assets: string[] = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shopbook-dist-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  for (const asset of assets) {
    const target = path.join(dir, asset.replace(/^\/+/, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '/* asset */', 'utf8');
  }
  return dir;
};

const runGuard = (distDir: string, base: string) =>
  execFileSync(process.execPath, [scriptPath, '--dist', distDir, '--base', base], {
    encoding: 'utf8',
    stdio: 'pipe',
  });

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('built asset paths must fit the deployment base', () => {
  it('passes when every asset is emitted under /ShopBook/', () => {
    const dist = makeDist(
      `<!doctype html><html><head>
        <link rel="icon" href="/ShopBook/brand/shopbook-icon.png" />
        <script type="module" src="/ShopBook/assets/index-abc.js"></script>
        <link rel="stylesheet" href="/ShopBook/assets/index-abc.css" />
      </head><body><div id="root"></div></body></html>`,
      ['brand/shopbook-icon.png', 'assets/index-abc.js', 'assets/index-abc.css']
    );

    expect(() => runGuard(dist, '/ShopBook/')).not.toThrow();
    expect(runGuard(dist, '/ShopBook/')).toContain('OK');
  });

  it('fails when root-absolute assets would 404 on a project site (the original white screen)', () => {
    const dist = makeDist(
      `<!doctype html><html><head>
        <script type="module" src="/assets/index-abc.js"></script>
        <link rel="stylesheet" href="/assets/index-abc.css" />
      </head><body><div id="root"></div></body></html>`,
      ['assets/index-abc.js', 'assets/index-abc.css']
    );

    let failure: { status?: number; stderr?: string } | null = null;
    try {
      runGuard(dist, '/ShopBook/');
    } catch (err) {
      failure = err as { status?: number; stderr?: string };
    }

    expect(failure).not.toBeNull();
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain('/assets/index-abc.js');
    expect(failure?.stderr).toContain('404');
  });

  it('accepts root-absolute assets when the app is served from the domain root (Render)', () => {
    const dist = makeDist(
      `<!doctype html><html><head>
        <script type="module" src="/assets/index-abc.js"></script>
      </head><body><div id="root"></div></body></html>`,
      ['assets/index-abc.js']
    );

    expect(() => runGuard(dist, '/')).not.toThrow();
  });

  it('fails when the HTML references an asset that was not emitted', () => {
    const dist = makeDist(
      `<!doctype html><html><head>
        <script type="module" src="/ShopBook/assets/missing.js"></script>
      </head><body><div id="root"></div></body></html>`
    );

    let failure: { status?: number; stderr?: string } | null = null;
    try {
      runGuard(dist, '/ShopBook/');
    } catch (err) {
      failure = err as { status?: number; stderr?: string };
    }

    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toContain('missing from');
  });
});
