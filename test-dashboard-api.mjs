import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./', import.meta.url));
const dashboard = path.join(root, 'gemini-dashboard');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ver3-api-'));
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['updatedAt', 'lastSyncedAt', 'remainingDurationMs', 'remainingDurationText'].includes(key))
    .map(([key, item]) => [key, normalize(item)]));
  return value;
}
try {
  for (const mode of ['dev', 'start']) {
    const state = path.join(temporary, mode);
    fs.mkdirSync(path.join(state, 'sessions', '2026', '09', '14'), { recursive: true });
    const sessionFile = path.join(state, 'sessions', '2026', '09', '14', 'rollout-fixture.jsonl');
    const writeUsage = used => fs.writeFileSync(sessionFile, JSON.stringify({ type: 'token_usage_record', timestamp: '2026-09-14T01:00:00Z', ordinal: 1, payload: { session_id: 'parity-fixture', thread_token_usage: { total_tokens: 500 }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 4070908800 } } } }) + '\n');
    writeUsage(42);
    const port = await freePort();
    const args = mode === 'dev'
      ? [path.join(dashboard, 'node_modules/vinext/dist/cli.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort']
      : ['--experimental-strip-types', path.join(dashboard, 'scripts/start-local.mjs'), '--port', String(port)];
    const log = fs.openSync(path.join(state, 'server.log'), 'w');
    const child = spawn(process.execPath, args, { cwd: dashboard, windowsHide: true, stdio: ['ignore', log, log], env: {
      ...process.env, CODEX_GEMINI_INSTALL_ROOT: state, CODEX_SESSIONS_DIR: path.join(state, 'sessions'),
      GEMINI_QUOTA_DISABLE_CLI: '1', GEMINI_QUOTA_RAW_DATA: JSON.stringify({ groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.75, reset_time: '2099-01-01T00:00:00Z' }] }] }),
    } });
    fs.closeSync(log);
    console.log(`${mode} PID=${child.pid} port=${port}`);
    const responses = [];
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (child.exitCode !== null) throw new Error(`${mode} exited ${child.exitCode}`);
        const probe = spawnSync('curl.exe', ['-s', '--max-time', '2', '-o', 'NUL', '-w', '%{http_code}', `http://localhost:${port}/`], { encoding: 'utf8', windowsHide: true });
        if (probe.status === 0 && probe.stdout === '200') { ready = true; break; }
        await delay(500);
      }
      assert.ok(ready, `${mode} readiness`);
      console.log(`${mode} readiness=200`);
      function request(method, endpoint, body, expected = 200) {
        const headers = path.join(state, 'headers.txt');
        const output = path.join(state, 'response.json');
        const curlArgs = ['-sS', '--max-time', '15', '-X', method, '-D', headers, '-o', output, '-w', '%{http_code}'];
        if (body !== undefined) curlArgs.push('-H', 'Content-Type: application/json', '--data-binary', body);
        curlArgs.push(`http://localhost:${port}${endpoint}`);
        const curl = spawnSync('curl.exe', curlArgs, { encoding: 'utf8', windowsHide: true });
        assert.equal(curl.status, 0, curl.stderr);
        assert.equal(Number(curl.stdout), expected);
        const json = JSON.parse(fs.readFileSync(output, 'utf8'));
        const headerText = fs.readFileSync(headers, 'utf8');
        const cacheControl = headerText.match(/^cache-control:\s*(.*)$/im)?.[1].trim() ?? null;
        assert.match(headerText, /content-type:\s*application\/json/i);
        responses.push({ method, endpoint, status: expected, cacheControl, body: normalize(json) });
        console.log(`${mode} ${method} ${endpoint} status=${expected} keys=${Object.keys(json).sort().join(',')} cache=${cacheControl}`);
        return json;
      }
      assert.equal(request('GET', '/api/settings').tier, 'normal');
      assert.equal(request('POST', '/api/settings', '{"tier":"fast"}').model, 'gemini-3.8-flash-low');
      assert.equal(request('GET', '/api/settings').tier, 'fast');
      assert.equal(request('PUT', '/api/settings', '{"tier":"normal"}').tier, 'normal');
      request('POST', '/api/settings', '{"tier":"invalid"}', 400);
      request('POST', '/api/settings', '{', 500);
      assert.equal(request('GET', '/api/codex-usage').rate_limits.primary.used_percent, 42);
      writeUsage(45);
      assert.equal(request('GET', '/api/codex-usage?refresh=true').rate_limits.primary.used_percent, 45);
      assert.equal(request('GET', '/api/gemini-quota').status, 'available');
      results.push({ mode, pid: child.pid, port, ready, responses });
    } finally {
      if (child.exitCode === null) {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
        assert.equal(killed.status, 0, killed.stderr);
      }
      await delay(500);
      const closed = spawnSync('curl.exe', ['-s', '--max-time', '2', `http://localhost:${port}/`], { windowsHide: true });
      assert.notEqual(closed.status, 0, `${mode} port must close`);
      console.log(`${mode} terminated=true portClosed=true`);
      console.log(fs.readFileSync(path.join(state, 'server.log'), 'utf8').split('\n').filter(line => line.includes('Local start PID=')).join('\n'));
    }
  }
  assert.deepEqual(results[0].responses, results[1].responses);
  console.log(`API parity PASS: ${results[0].responses.length} responses, dev/start; exit=0`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
