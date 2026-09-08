import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { GET } from './route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { clearGeminiQuotaCache } from '../../../lib/gemini-quota.ts';

void describe('/api/gemini-quota API Route', () => {
  const savedRaw = process.env.GEMINI_QUOTA_RAW_DATA;
  const savedDisable = process.env.GEMINI_QUOTA_DISABLE_CLI;

  beforeEach(() => {
    clearGeminiQuotaCache();
  });

  afterEach(() => {
    clearGeminiQuotaCache();
    if (savedRaw !== undefined) {
      process.env.GEMINI_QUOTA_RAW_DATA = savedRaw;
    } else {
      delete process.env.GEMINI_QUOTA_RAW_DATA;
    }
    if (savedDisable !== undefined) {
      process.env.GEMINI_QUOTA_DISABLE_CLI = savedDisable;
    } else {
      delete process.env.GEMINI_QUOTA_DISABLE_CLI;
    }
  });

  void test('GET returns 200 with sanitized contract for valid quota data', async () => {
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      email: 'sensitive-admin@corp.com',
      authorization: 'Bearer super-secret-token',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit',
                  window: '5h',
                  remaining_fraction: 0.85,
                  reset_time: '2026-09-08T18:00:00Z',
                },
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit',
                  window: 'weekly',
                  remaining_fraction: 0.95,
                  reset_time: '2026-09-15T00:00:00Z',
                },
              ],
            },
          ],
        },
      },
    });

    const req = new Request('http://localhost:3000/api/gemini-quota');
    const response = await GET(req);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');

    const json = (await response.json()) as {
      ok: boolean;
      status: string;
      quota: {
        fiveHour: { remainingPercent: number; usedPercent: number; isAvailable: boolean };
        weekly: { remainingPercent: number; usedPercent: number; isAvailable: boolean };
      };
      lastSyncedAt: string;
    };

    assert.equal(json.ok, true);
    assert.equal(json.status, 'available');
    assert.ok(json.quota);
    assert.equal(json.quota.fiveHour.remainingPercent, 85);
    assert.equal(json.quota.fiveHour.usedPercent, 15);
    assert.equal(json.quota.fiveHour.isAvailable, true);
    assert.equal(json.quota.weekly.remainingPercent, 95);
    assert.equal(json.quota.weekly.usedPercent, 5);
    assert.equal(json.quota.weekly.isAvailable, true);
    assert.ok(json.lastSyncedAt);

    // Verify secrets are strictly absent
    const rawText = JSON.stringify(json);
    assert.equal(rawText.includes('sensitive-admin@corp.com'), false);
    assert.equal(rawText.includes('super-secret-token'), false);
  });

  void test('GET returns 200 with unavailable status when no quota source is present', async () => {
    delete process.env.GEMINI_QUOTA_RAW_DATA;
    process.env.GEMINI_QUOTA_DISABLE_CLI = '1';

    const req = new Request('http://localhost:3000/api/gemini-quota');
    const response = await GET(req);

    assert.equal(response.status, 200);
    const json = (await response.json()) as { ok: boolean; status: string; quota: null; message: string };
    assert.equal(json.ok, false);
    assert.equal(json.status, 'unavailable');
    assert.equal(json.quota, null);
    assert.ok(json.message);
  });

  void test('GET respects ?refresh=true cache bypass query parameter', async () => {
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.5 }],
    });

    const req1 = new Request('http://localhost:3000/api/gemini-quota');
    const res1 = await GET(req1);
    const json1 = (await res1.json()) as { quota: { fiveHour: { remainingPercent: number } } };
    assert.equal(json1.quota.fiveHour.remainingPercent, 50);

    // Change underlying data
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.2 }],
    });

    // Without refresh query param, returns cached 50
    const reqCached = new Request('http://localhost:3000/api/gemini-quota');
    const resCached = await GET(reqCached);
    const jsonCached = (await resCached.json()) as { cached?: boolean; quota: { fiveHour: { remainingPercent: number } } };
    assert.equal(jsonCached.cached, true);
    assert.equal(jsonCached.quota.fiveHour.remainingPercent, 50);

    // With refresh=true, bypasses cache and returns 20
    const reqRefresh = new Request('http://localhost:3000/api/gemini-quota?refresh=true');
    const resRefresh = await GET(reqRefresh);
    const jsonRefresh = (await resRefresh.json()) as { cached?: boolean; quota: { fiveHour: { remainingPercent: number } } };
    assert.equal(jsonRefresh.cached, undefined);
    assert.equal(jsonRefresh.quota.fiveHour.remainingPercent, 20);
  });

  void test('GET handles invocation without Request argument safely', async () => {
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.7 }],
    });

    const response = await GET();
    assert.equal(response.status, 200);
    const json = (await response.json()) as { ok: boolean };
    assert.equal(json.ok, true);
  });
});
