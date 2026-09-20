import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bootstrap-'));
  const runtimeRoot = path.join(root, 'runtime');
  const repoRoot = path.join(root, 'repo');
  const outsideRoot = path.join(root, 'outside');
  const scriptsDir = path.join(runtimeRoot, 'gemini-dashboard', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.agent'), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.copyFileSync(
    path.resolve(process.cwd(), '..', '..', 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1'),
    path.join(scriptsDir, 'router-bootstrap.ps1')
  );
  return { root, runtimeRoot, repoRoot, outsideRoot, bootstrap: path.join(scriptsDir, 'router-bootstrap.ps1') };
}

function runBootstrap(input: string, bootstrap: string) {
  return spawnSync('pwsh', ['-NoProfile', '-File', bootstrap, '-InputFile', input], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

void test('bootstrap rejects a router outside its own runtime root', () => {
  const f = fixture();
  try {
    const externalRouter = path.join(f.outsideRoot, 'codex-router.ps1');
    fs.writeFileSync(externalRouter, 'throw "must not execute"\n');
    const input = path.join(f.repoRoot, '.agent', 'outside.json');
    fs.writeFileSync(input, JSON.stringify({
      dashboardRunId: 'outside-router',
      repoRoot: f.repoRoot,
      prompt: 'test',
      routerScript: externalRouter,
    }));
    const result = runBootstrap(input, f.bootstrap);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /runtime/iu);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

void test('bootstrap executes only its fixed router while keeping writes in repoRoot', () => {
  const f = fixture();
  try {
    const router = path.join(f.runtimeRoot, 'codex-router.ps1');
    fs.writeFileSync(router, [
      'param([string]$Request, [string]$Repository)',
      "$marker = Join-Path $Repository '.agent\\router-seen.txt'",
      '[IO.File]::WriteAllText($marker, $Repository, [Text.Encoding]::UTF8)',
    ].join('\n'));
    const input = path.join(f.repoRoot, '.agent', 'valid.json');
    fs.writeFileSync(input, JSON.stringify({
      dashboardRunId: 'valid-router',
      repoRoot: f.repoRoot,
      prompt: 'test',
      routerScript: router,
    }));
    const result = runBootstrap(input, f.bootstrap);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(
      fs.readFileSync(path.join(f.repoRoot, '.agent', 'router-seen.txt'), 'utf8').replace(/^\uFEFF/, ''),
      f.repoRoot
    );
    assert.equal(fs.existsSync(path.join(f.runtimeRoot, '.agent')), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
