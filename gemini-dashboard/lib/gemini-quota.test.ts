import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error TS5097 allowed for test runner
import { normalizeQuotaData, parseQuotaTsv, sanitizeSafeString, getGeminiQuota, clearGeminiQuotaCache } from './gemini-quota.ts';

void describe('Gemini Quota Reader and Normalizer', () => {
  const referenceTime = new Date('2026-09-08T16:30:00.000Z').getTime();
  const tempDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function backupEnv(keys: string[]) {
    for (const k of keys) {
      savedEnv[k] = process.env[k];
    }
  }

  function restoreEnv() {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  beforeEach(() => {
    clearGeminiQuotaCache();
    backupEnv([
      'GEMINI_QUOTA_RAW_DATA',
      'GEMINI_QUOTA_FILE',
      'ANTIGRAVITY_QUOTA_FILE',
      'ANTIGRAVITY_BIN',
      'AGY_BIN',
      'GEMINI_CLI_BIN',
      'GEMINI_QUOTA_CACHE_TTL_MS',
      'GEMINI_QUOTA_TIMEOUT_MS',
      'GEMINI_QUOTA_DISABLE_CLI',
    ]);
  });

  afterEach(() => {
    clearGeminiQuotaCache();
    restoreEnv();
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
    tempDirs.length = 0;
  });

  void test('1. Normalization of official CLI JSON response variant', () => {
    const cliOutput = JSON.stringify({
      conversation_id: '',
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          description: 'Within each group, models share a weekly limit and a 5-hour limit.',
          groups: [
            {
              name: 'Gemini Models',
              description: 'Models within this group: Gemini Flash, Gemini Pro',
              buckets: [
                {
                  id: 'gemini-weekly',
                  name: 'Weekly Limit Remaining',
                  description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 14 hours.',
                  window: 'weekly',
                  remaining_fraction: 0.7592,
                  reset_time: '2026-09-15T07:25:51Z',
                },
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit Remaining',
                  description: 'You have used some of your 5-hour limit, it will fully refresh in 48 minutes.',
                  window: '5h',
                  remaining_fraction: 0.148,
                  reset_time: '2026-09-08T17:18:00Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
              buckets: [
                {
                  id: '3p-weekly',
                  name: 'Weekly Limit Remaining',
                  window: 'weekly',
                  remaining_fraction: 1.0,
                  reset_time: '2026-09-15T16:30:00Z',
                },
              ],
            },
          ],
        },
      },
    });

    const snapshot = normalizeQuotaData(cliOutput, referenceTime);
    assert.ok(snapshot, 'Snapshot should be returned');

    // Verify 5-hour pool
    assert.ok(snapshot.fiveHour, '5-hour pool must be extracted');
    assert.equal(snapshot.fiveHour.id, 'gemini-5h');
    assert.equal(snapshot.fiveHour.window, '5h');
    assert.equal(snapshot.fiveHour.remainingPercent, 14.8);
    assert.equal(snapshot.fiveHour.usedPercent, 85.2);
    assert.equal(snapshot.fiveHour.resetTime, '2026-09-08T17:18:00.000Z');
    assert.equal(snapshot.fiveHour.remainingDurationMs, 48 * 60 * 1000);
    assert.equal(snapshot.fiveHour.remainingDurationText, '48분');
    assert.equal(snapshot.fiveHour.isAvailable, true);

    // Verify weekly pool
    assert.ok(snapshot.weekly, 'Weekly pool must be extracted');
    assert.equal(snapshot.weekly.id, 'gemini-weekly');
    assert.equal(snapshot.weekly.window, 'weekly');
    assert.equal(snapshot.weekly.remainingPercent, 75.92);
    assert.equal(snapshot.weekly.usedPercent, 24.08);
    assert.equal(snapshot.weekly.resetTime, '2026-09-15T07:25:51.000Z');
    assert.equal(snapshot.weekly.isAvailable, true);
    assert.ok(snapshot.weekly.remainingDurationText?.includes('일'), 'Weekly remaining duration formatted in days');
  });

  void test('2. Normalization of protobuf / RPC retrieveUserQuotaSummary response (camelCase)', () => {
    const rpcPayload = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h-pool',
              displayName: '5-Hour Limit',
              window: 'FIVE_HOURS',
              remainingFraction: 0.825,
              resetTime: '2026-09-08T21:30:00Z',
            },
            {
              bucketId: 'gemini-weekly-pool',
              displayName: 'Weekly Limit',
              window: 'WEEKLY',
              remainingFraction: 0.95,
              resetTime: '2026-09-15T16:30:00Z',
            },
          ],
        },
      ],
    };

    const snapshot = normalizeQuotaData(rpcPayload, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.isAvailable, true);
    assert.equal(snapshot.fiveHour?.remainingPercent, 82.5);
    assert.equal(snapshot.fiveHour?.usedPercent, 17.5);
    assert.equal(snapshot.fiveHour?.window, '5h');
    assert.equal(snapshot.fiveHour?.remainingDurationText, '5시간');

    assert.equal(snapshot.weekly?.isAvailable, true);
    assert.equal(snapshot.weekly?.remainingPercent, 95.0);
    assert.equal(snapshot.weekly?.usedPercent, 5.0);
    assert.equal(snapshot.weekly?.window, 'weekly');
    assert.equal(snapshot.weekly?.remainingDurationText, '7일');
  });

  void test('3. Normalization of flat buckets array variant', () => {
    const flatPayload = {
      buckets: [
        {
          id: 'gemini-5h',
          window: '5h',
          remaining_percent: 45.5,
          reset_time: '2026-09-08T18:00:00Z',
        },
        {
          id: 'gemini-weekly',
          window: 'weekly',
          remaining_percent: 88.0,
          reset_time: '2026-09-15T00:00:00Z',
        },
        {
          id: '3p-weekly',
          window: 'weekly',
          remaining_percent: 100.0,
        },
      ],
    };

    const snapshot = normalizeQuotaData(flatPayload, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.remainingPercent, 45.5);
    assert.equal(snapshot.fiveHour?.usedPercent, 54.5);
    assert.equal(snapshot.weekly?.remainingPercent, 88.0);
    assert.equal(snapshot.weekly?.usedPercent, 12.0);
  });

  void test('4. Normalization of TSV text output from CLI /usage fallback', () => {
    const tsvText = `
Gemini Models\tWeekly Limit Remaining\t76%\t2026-09-15T07:25:51Z
Gemini Models\tFive Hour Limit Remaining\t15%\t2026-09-08T17:25:51Z
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-09-15T16:36:34Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-08T21:36:34Z
`;

    const snapshot = parseQuotaTsv(tsvText, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.remainingPercent, 15);
    assert.equal(snapshot.fiveHour?.usedPercent, 85);
    assert.equal(snapshot.weekly?.remainingPercent, 76);
    assert.equal(snapshot.weekly?.usedPercent, 24);
  });

  void test('5. 5-hour and weekly pool selection distinguishes Gemini from 3rd-party models', () => {
    const mixedGroups = {
      groups: [
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-5h', window: '5h', remaining_fraction: 1.0 },
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1.0 },
          ],
        },
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.35 },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.65 },
          ],
        },
      ],
    };

    const snapshot = normalizeQuotaData(mixedGroups, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.id, 'gemini-5h');
    assert.equal(snapshot.fiveHour?.remainingPercent, 35);
    assert.equal(snapshot.weekly?.id, 'gemini-weekly');
    assert.equal(snapshot.weekly?.remainingPercent, 65);
  });

  void test('6. Handles partial confirmation: only 5-hour pool confirmed, weekly unconfirmed', () => {
    const partialData = {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.5 },
          ],
        },
      ],
    };

    const snapshot = normalizeQuotaData(partialData, referenceTime);
    assert.ok(snapshot);
    assert.ok(snapshot.fiveHour, '5-hour pool exists');
    assert.equal(snapshot.fiveHour.isAvailable, true);
    assert.equal(snapshot.fiveHour.remainingPercent, 50);
    assert.equal(snapshot.weekly, null, 'Unconfirmed weekly pool must be null without fabricated defaults');
  });

  void test('7. Percentage clamping and validation for boundary/malformed values', () => {
    // Fraction > 1.0 clamped to 100%, negative fraction clamped to 0%
    const overflowData = {
      buckets: [
        { id: 'gemini-5h', window: '5h', remaining_fraction: 1.5 },
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: -0.2 },
      ],
    };

    const snapshot = normalizeQuotaData(overflowData, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.remainingPercent, 100);
    assert.equal(snapshot.fiveHour?.usedPercent, 0);
    assert.equal(snapshot.weekly?.remainingPercent, 0);
    assert.equal(snapshot.weekly?.usedPercent, 100);

    // Non-numeric or NaN percentages result in unconfirmed (isAvailable: false, null percent)
    const malformedData = {
      buckets: [
        { id: 'gemini-5h', window: '5h', remaining_fraction: 'NaN' },
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: undefined },
      ],
    };

    const malformedSnapshot = normalizeQuotaData(malformedData, referenceTime);
    assert.ok(malformedSnapshot);
    assert.equal(malformedSnapshot.fiveHour?.isAvailable, false);
    assert.equal(malformedSnapshot.fiveHour?.remainingPercent, null);
    assert.equal(malformedSnapshot.fiveHour?.usedPercent, null);
    assert.equal(malformedSnapshot.weekly?.isAvailable, false);
    assert.equal(malformedSnapshot.weekly?.remainingPercent, null);
  });

  void test('8. Reset handling with numeric epoch timestamps and past timestamps', () => {
    const epochSec = Math.floor(referenceTime / 1000) + 7200; // 2 hours in the future
    const pastSec = Math.floor(referenceTime / 1000) - 300; // 5 minutes in the past

    const payload = {
      buckets: [
        { id: 'gemini-5h', window: '5h', remaining_fraction: 0.5, reset_time: epochSec },
        { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: pastSec },
      ],
    };

    const snapshot = normalizeQuotaData(payload, referenceTime);
    assert.ok(snapshot);
    assert.equal(snapshot.fiveHour?.remainingDurationMs, 7200 * 1000);
    assert.equal(snapshot.fiveHour?.remainingDurationText, '2시간');

    // Past reset time clamps remaining duration to 0ms
    assert.equal(snapshot.weekly?.remainingDurationMs, 0);
    assert.equal(snapshot.weekly?.remainingDurationText, '0분');
  });

  void test('9. Bounded in-memory cache and cache bypass behavior', async () => {
    process.env.GEMINI_QUOTA_CACHE_TTL_MS = '30000';
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.6 }],
    });

    const first = await getGeminiQuota({ referenceTimeMs: referenceTime });
    assert.equal(first.ok, true);
    assert.equal(first.cached, undefined);
    assert.equal(first.quota?.fiveHour?.remainingPercent, 60);

    // Second call with different env data should return cached value
    process.env.GEMINI_QUOTA_RAW_DATA = JSON.stringify({
      buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.1 }],
    });

    const cached = await getGeminiQuota({ referenceTimeMs: referenceTime + 1000 });
    assert.equal(cached.ok, true);
    assert.equal(cached.cached, true);
    assert.equal(cached.quota?.fiveHour?.remainingPercent, 60);

    // Call with bypassCache should update value
    const fresh = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime + 2000 });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.quota?.fiveHour?.remainingPercent, 10);
  });

  void test('10. Windows Unicode and Korean character path handling', async () => {
    // Create temporary directory with Korean characters in path
    const koreanTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-테스트-쿼터-'));
    tempDirs.push(koreanTempDir);

    const quotaFilePath = path.join(koreanTempDir, '사용자_quota_summary.json');
    const mockQuotaContent = JSON.stringify({
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.77 },
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88 },
          ],
        },
      ],
    });

    fs.writeFileSync(quotaFilePath, mockQuotaContent, 'utf8');
    process.env.GEMINI_QUOTA_FILE = quotaFilePath;

    const res = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'available');
    assert.equal(res.quota?.fiveHour?.remainingPercent, 77);
    assert.equal(res.quota?.weekly?.remainingPercent, 88);
  });

  void test('11. Unavailable and error responses are safe and non-crashing', async () => {
    // Empty / corrupt payload
    process.env.GEMINI_QUOTA_RAW_DATA = '{ corrupt json ... ';
    const resCorrupt = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime });
    assert.equal(resCorrupt.ok, false);
    assert.equal(resCorrupt.status, 'unavailable');
    assert.equal(resCorrupt.quota, null);
    assert.ok(resCorrupt.message);

    // Missing state entirely when CLI is not available
    delete process.env.GEMINI_QUOTA_RAW_DATA;
    process.env.GEMINI_QUOTA_DISABLE_CLI = '1';
    const resMissing = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.status, 'unavailable');
    assert.equal(resMissing.quota, null);

    // CLI execution failure (e.g. process exits with non-zero code)
    delete process.env.GEMINI_QUOTA_DISABLE_CLI;
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-fail-test-'));
    tempDirs.push(testDir);
    const failBat = path.join(testDir, 'fail-cli.cmd');
    fs.writeFileSync(failBat, '@echo off\r\nexit /b 1\r\n', 'utf8');
    process.env.ANTIGRAVITY_BIN = failBat;
    const resCliFail = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime });
    assert.equal(resCliFail.ok, false);
    assert.equal(resCliFail.status, 'unavailable');
    assert.equal(resCliFail.quota, null);
  });

  void test('12. Redaction and non-disclosure: secrets, tokens, emails never leaked', async () => {
    const rawWithSecrets = JSON.stringify({
      email: 'giwon6599@gmail.com',
      token: 'ya29.a0ARrdaM_secret_token_12345',
      authorization: 'Bearer secret_access_token_xyz',
      cookie: 'SID=secret_cookie_value; HSID=another_secret',
      account_id: '9876543210',
      apiKey: 'AIzaSyD-secret-google-api-key-12345',
      user_profile: {
        email: 'giwon6599@gmail.com',
      },
      command: {
        name: 'usage',
        data: {
          description: 'Auth for giwon6599@gmail.com with Bearer ya29.secret',
          groups: [
            {
              name: 'Gemini Models for giwon6599@gmail.com',
              buckets: [
                {
                  id: 'gemini-5h',
                  name: 'Five Hour Limit (email: giwon6599@gmail.com)',
                  window: '5h',
                  remaining_fraction: 0.42,
                  secret_internal_meta: 'classified_header_ya29',
                },
              ],
            },
          ],
        },
      },
    });

    process.env.GEMINI_QUOTA_RAW_DATA = rawWithSecrets;
    const res = await getGeminiQuota({ bypassCache: true, referenceTimeMs: referenceTime });

    assert.equal(res.ok, true);
    assert.ok(res.quota);

    // Serialize entire response to JSON string to inspect for leaks
    const serialized = JSON.stringify(res);

    assert.equal(serialized.includes('giwon6599@gmail.com'), false, 'Email address must not appear in response');
    assert.equal(serialized.includes('ya29.a0ARrdaM_secret_token_12345'), false, 'OAuth token must not appear');
    assert.equal(serialized.includes('secret_access_token_xyz'), false, 'Bearer token must not appear');
    assert.equal(serialized.includes('secret_cookie_value'), false, 'Cookie must not appear');
    assert.equal(serialized.includes('AIzaSyD-secret-google-api-key-12345'), false, 'API key must not appear');
    assert.equal(serialized.includes('classified_header_ya29'), false, 'Internal secrets must not appear');
    assert.equal(serialized.includes('9876543210'), false, 'Account ID must not appear');

    // Test safe sanitization utility
    const dirty = 'User: test@example.com, Token: ya29.abcdef123456, Auth: Bearer token123';
    const clean = sanitizeSafeString(dirty);
    assert.ok(!clean.includes('test@example.com'));
    assert.ok(!clean.includes('ya29.abcdef123456'));
    assert.ok(!clean.includes('token123'));
  });
});
