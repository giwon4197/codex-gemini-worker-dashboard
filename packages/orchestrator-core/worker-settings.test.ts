import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  GET,
  POST,
  deleteWorkerPreference,
  readWorkerMemory,
  resetWorkerPreferences,
  setWorkerMemoryEnabled,
  setWorkerPreference,
} from './worker-settings.ts';

const originalRoot = process.env.CODEX_GEMINI_INSTALL_ROOT;
let root: string;
let settingsPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-worker-settings-'));
  settingsPath = path.join(root, 'worker-settings.json');
  process.env.CODEX_GEMINI_INSTALL_ROOT = root;
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
  else process.env.CODEX_GEMINI_INSTALL_ROOT = originalRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

test('normalizes missing memory without writing the legacy file', () => {
  const legacy = {
    tier: 'normal',
    model: 'gemini-3.8-flash-medium',
    codexModel: 'gpt-5.6-terra',
  };
  fs.writeFileSync(settingsPath, JSON.stringify(legacy));

  assert.deepEqual(readWorkerMemory(), {
    schemaVersion: 1,
    enabled: true,
    preferences: {},
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), legacy);
});

test('memory mutations preserve worker model settings and assign metadata', () => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      tier: 'reasoning',
      model: 'gemini-3.1-pro-high',
      codexModel: 'gpt-5.6-terra',
    })
  );

  const memory = setWorkerPreference('responseLanguage', 'ko');
  assert.equal(memory.preferences.responseLanguage?.value, 'ko');
  assert.equal(
    memory.preferences.responseLanguage?.provenance,
    'explicit_user'
  );
  assert.equal(memory.preferences.responseLanguage?.confidence, 'confirmed');

  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    tier: string;
    model: string;
    codexModel: string;
  };
  assert.equal(saved.tier, 'reasoning');
  assert.equal(saved.model, 'gemini-3.1-pro-high');
  assert.equal(saved.codexModel, 'gpt-5.6-terra');
});

test('legacy worker settings save preserves valid memory', async () => {
  setWorkerPreference('explanationDetail', 'detailed');
  const response = await POST(
    new Request('http://localhost/api/settings', {
      method: 'POST',
      body: JSON.stringify({ tier: 'fast', codexModel: 'gpt-5.6-terra' }),
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    memory: ReturnType<typeof readWorkerMemory>;
  };
  assert.equal(body.memory.preferences.explanationDetail?.value, 'detailed');
});

test('supports enable, delete, and reset without changing enabled state', () => {
  setWorkerPreference('preferTargetedTests', true);
  setWorkerPreference('completionNotifications', false);
  assert.equal(setWorkerMemoryEnabled(false).enabled, false);
  assert.equal(
    deleteWorkerPreference('preferTargetedTests').preferences
      .preferTargetedTests,
    undefined
  );
  const reset = resetWorkerPreferences();
  assert.equal(reset.enabled, false);
  assert.deepEqual(reset.preferences, {});
});

test('rejects unknown, unsafe, and incorrectly typed preferences', () => {
  assert.throws(
    () => setWorkerPreference('responseLanguage', 'C:\\Users\\lee' as 'ko'),
    /INVALID_MEMORY_MUTATION/
  );
  assert.throws(
    () => setWorkerPreference('preferTargetedTests', 'true' as never),
    /INVALID_MEMORY_MUTATION/
  );
  assert.throws(
    () => setWorkerPreference('unknown' as never, true as never),
    /INVALID_MEMORY_MUTATION/
  );
});

test('GET returns normalized memory while preserving valid settings', async () => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ tier: 'normal', model: 'ignored' })
  );
  const response = await GET();
  const body = (await response.json()) as {
    tier: string;
    model: string;
    memory: ReturnType<typeof readWorkerMemory>;
  };
  assert.equal(body.tier, 'normal');
  assert.equal(body.model, 'gemini-3.8-flash-medium');
  assert.deepEqual(body.memory, {
    schemaVersion: 1,
    enabled: true,
    preferences: {},
  });
});
