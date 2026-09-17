import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GET, POST, PUT } from '../app/api/settings/route.ts';
import { handleWorkspaceBridgeRequest } from './workspace-node-bridge.ts';

const originalRoot = process.env.CODEX_GEMINI_INSTALL_ROOT;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-settings-test-'));
  process.env.CODEX_GEMINI_INSTALL_ROOT = root;
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
  else process.env.CODEX_GEMINI_INSTALL_ROOT = originalRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
void test('settings recovers malformed installed state and derives model', async () => {
  fs.writeFileSync(path.join(root, 'worker-settings.json'), '{');
  const result = await GET();
  assert.equal(result.status, 200);
  const body = await result.json() as { tier: string; model: string };
  assert.equal(body.tier, 'normal');
  assert.equal(body.model, 'gemini-3.8-flash-medium');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'worker-settings.json'), 'utf8')).tier, 'normal');
});
for (const [method, handler] of [['POST', POST], ['PUT', PUT]] as const) {
  void test(`settings ${method} persists tier with derived model`, async () => {
    const response = await handler(new Request('http://localhost/api/settings', { method, body: JSON.stringify({ tier: 'reasoning', model: 'untrusted' }) }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, 'gemini-3.1-pro-high');
    assert.equal((await (await GET()).json() as { tier: string }).tier, 'reasoning');
  });
}
void test('settings app route and bridge share invalid-tier error contract', async () => {
  for (const tier of ['missing', 'toString']) {
    const makeRequest = () => new Request('http://localhost/api/settings', { method: 'POST', body: JSON.stringify({ tier }) });
    const app = await POST(makeRequest());
    const bridge = await handleWorkspaceBridgeRequest(makeRequest());
    assert.equal(app.status, 400);
    assert.equal(bridge.status, app.status);
    assert.deepEqual(await bridge.json(), await app.json());
  }
});
void test('settings malformed body retains JSON 500 contract', async () => {
  const result = await POST(new Request('http://localhost/api/settings', { method: 'POST', body: '{' }));
  assert.equal(result.status, 500);
  assert.equal(typeof (await result.json() as { error: string }).error, 'string');
});
