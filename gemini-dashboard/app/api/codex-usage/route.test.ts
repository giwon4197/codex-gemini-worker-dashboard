import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error TS5097 allowed for test runner
import { GET } from './route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { clearCodexUsageCache } from '../../../lib/codex-usage.ts';

void describe('/api/codex-usage API Route Handlers', () => {
  const tempDirs: string[] = [];
  const originalEnv = process.env.CODEX_SESSIONS_DIR;

  function createTempSessionsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-api-test-sessions-'));
    tempDirs.push(dir);
    process.env.CODEX_SESSIONS_DIR = dir;
    return dir;
  }

  beforeEach(() => {
    clearCodexUsageCache();
  });

  afterEach(() => {
    clearCodexUsageCache();
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
    tempDirs.length = 0;
    if (originalEnv !== undefined) {
      process.env.CODEX_SESSIONS_DIR = originalEnv;
    } else {
      delete process.env.CODEX_SESSIONS_DIR;
    }
  });

  void test('GET returns 200 with Codex rate limit and token usage data', async () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '09');
    fs.mkdirSync(dayDir, { recursive: true });

    fs.writeFileSync(
      path.join(dayDir, 'rollout-2026-09-09T10-00-00-1111.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-09T10:00:00.000Z',
        ordinal: 1,
        payload: {
          session_id: 'api-test-session-1',
          thread_token_usage: { total_tokens: 500 },
          rate_limits: {
            primary: {
              used_percent: 41.0,
              window_minutes: 300,
              resets_at: 1789455000,
            },
            secondary: {
              used_percent: 15.0,
              window_minutes: 10080,
              resets_at: 1789510000,
            },
            plan_type: 'plus',
          },
        },
      }) + '\n'
    );

    const req = new Request('http://localhost:3000/api/codex-usage');
    const res = await GET(req);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

    const json = await res.json() as {
      ok: boolean;
      status: string;
      rate_limits: {
        primary: { remaining_percent: number; used_percent: number };
        secondary: { remaining_percent: number; used_percent: number };
      };
    };

    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.status, 'active');
    assert.ok(json.rate_limits);
    assert.strictEqual(json.rate_limits.primary.remaining_percent, 59.0);
    assert.strictEqual(json.rate_limits.primary.used_percent, 41.0);
  });

  void test('GET with ?refresh=true bypasses cache and reflects updated data immediately', async () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '09');
    fs.mkdirSync(dayDir, { recursive: true });

    const file = path.join(dayDir, 'rollout-2026-09-09T10-00-00-cache.jsonl');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-09T10:00:00.000Z',
        ordinal: 1,
        payload: {
          session_id: 'cache-sess',
          rate_limits: {
            primary: {
              used_percent: 30.0,
              window_minutes: 300,
              resets_at: 1789455000,
            },
          },
        },
      }) + '\n'
    );

    // Initial query
    const req1 = new Request('http://localhost:3000/api/codex-usage');
    const res1 = await GET(req1);
    const json1 = await res1.json() as { rate_limits: { primary: { remaining_percent: number } } };
    assert.strictEqual(json1.rate_limits.primary.remaining_percent, 70.0);

    // Update file on disk
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-09T10:05:00.000Z',
        ordinal: 2,
        payload: {
          session_id: 'cache-sess',
          rate_limits: {
            primary: {
              used_percent: 45.0,
              window_minutes: 300,
              resets_at: 1789455000,
            },
          },
        },
      }) + '\n'
    );

    // Normal query without refresh would use cache; but with ?refresh=true cache must be bypassed:
    const req2 = new Request('http://localhost:3000/api/codex-usage?refresh=true');
    const res2 = await GET(req2);
    const json2 = await res2.json() as { rate_limits: { primary: { remaining_percent: number } } };
    assert.strictEqual(json2.rate_limits.primary.remaining_percent, 55.0);
  });
});