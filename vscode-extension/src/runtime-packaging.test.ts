import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ASSETS = [
  'codex-router.ps1',
  'run-parallel-workers.ps1',
  'run-gemini-worker.ps1',
  'orchestration-common.ps1',
  'filesystem-policy.ps1',
  'bounded-process-runner.ps1',
  'dashboard-dependency-bootstrap.ps1',
  'toolchain.ps1',
  'router-plan.schema.json',
  'model-tiers.json',
  'gemini-dashboard/scripts/router-bootstrap.ps1',
] as const;

void test('prepare-runtime stages only the canonical orchestration assets', () => {
  const extensionRoot = process.cwd();
  const repositoryRoot = path.resolve(extensionRoot, '..');
  const result = spawnSync(process.execPath, ['prepare-runtime.mjs'], {
    cwd: extensionRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const relativePath of ASSETS) {
    const canonical = path.join(repositoryRoot, relativePath);
    const staged = path.join(extensionRoot, 'runtime', relativePath);
    assert.equal(fs.existsSync(staged), true, relativePath);
    assert.deepEqual(fs.readFileSync(staged), fs.readFileSync(canonical), relativePath);
  }
  assert.equal(fs.existsSync(path.join(extensionRoot, 'runtime', 'gemini-dashboard', 'package.json')), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, 'runtime', 'node_modules')), false);
});

void test('approval and retry both pass the extension runtime root', () => {
  const conversation = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'conversation-view.ts'), 'utf8');
  const graph = fs.readFileSync(path.join(process.cwd(), 'src', 'task-graph-view.ts'), 'utf8');
  for (const source of [conversation, graph]) {
    assert.match(source, /runtimeRoot:\s*vscode\.Uri\.joinPath\(this\.context\.extensionUri, 'runtime'\)\.fsPath/);
  }
});
