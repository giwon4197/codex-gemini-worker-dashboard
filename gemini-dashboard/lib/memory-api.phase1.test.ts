import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { handleWorkspaceBridgeRequest } from './workspace-node-bridge.ts';

const originalRoot = process.env.CODEX_GEMINI_INSTALL_ROOT;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-api-'));
  process.env.CODEX_GEMINI_INSTALL_ROOT = root;
  fs.writeFileSync(
    path.join(root, 'worker-settings.json'),
    JSON.stringify({ tier: 'normal', model: 'gemini-3.8-flash-medium' })
  );
});

afterEach(() => {
  if (originalRoot === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
  else process.env.CODEX_GEMINI_INSTALL_ROOT = originalRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

type MemoryResponse = {
  memory: { preferences: Record<string, { value: string }> };
};

void test('memory API supports read, explicit mutation, and reset', async () => {
  const initial = await handleWorkspaceBridgeRequest(
    new Request('http://localhost/api/settings/memory')
  );
  assert.equal(initial.status, 200);
  const initialBody = await initial.json() as MemoryResponse;
  assert.deepEqual(initialBody.memory.preferences, {});

  const changed = await handleWorkspaceBridgeRequest(
    new Request('http://localhost/api/settings/memory', {
      method: 'PATCH',
      body: JSON.stringify({
        operation: 'setPreference',
        key: 'responseLanguage',
        value: 'ko',
      }),
    })
  );
  assert.equal(changed.status, 200);
  const changedBody = await changed.json() as MemoryResponse;
  assert.equal(changedBody.memory.preferences.responseLanguage.value, 'ko');

  const reset = await handleWorkspaceBridgeRequest(
    new Request('http://localhost/api/settings/memory', { method: 'DELETE' })
  );
  assert.equal(reset.status, 200);
  const resetBody = await reset.json() as MemoryResponse;
  assert.deepEqual(resetBody.memory.preferences, {});
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'worker-settings.json'), 'utf8')) as { tier: string };
  assert.equal(settings.tier, 'normal');
});

void test('memory API rejects unknown values without echoing them', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const response = await handleWorkspaceBridgeRequest(
    new Request('http://localhost/api/settings/memory', {
      method: 'PATCH',
      body: JSON.stringify({
        operation: 'setPreference',
        key: 'responseLanguage',
        value: secret,
      }),
    })
  );
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), new RegExp(secret));
});
