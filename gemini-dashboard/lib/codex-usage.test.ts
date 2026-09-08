import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error TS5097 allowed for test runner
import { getCodexDailyUsage, clearCodexUsageCache } from './codex-usage.ts';

void describe('Codex Usage and Rate Limits', () => {
  const tempDirs: string[] = [];
  const originalEnv = process.env.CODEX_SESSIONS_DIR;

  function createTempSessionsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-sessions-'));
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
        // Ignore cleanup error
      }
    }
    tempDirs.length = 0;
    if (originalEnv !== undefined) {
      process.env.CODEX_SESSIONS_DIR = originalEnv;
    } else {
      delete process.env.CODEX_SESSIONS_DIR;
    }
  });

  void test('primary and secondary window calculation with normalized remaining_percent', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const content = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T12:00:00.000Z',
      ordinal: 1,
      payload: {
        session_id: 'session-rate-limit-1',
        thread_token_usage: { total_tokens: 1000 },
        rate_limits: {
          primary: {
            used_percent: 75.0,
            window_minutes: 300,
            resets_at: 1789451000,
          },
          secondary: {
            used_percent: 28.5,
            window_minutes: 10080,
            resets_at: 1789500000,
          },
          credits: null,
          plan_type: 'plus',
        },
      },
    }) + '\n';

    fs.writeFileSync(path.join(dayDir, 'rollout-2026-09-08T12-00-00-11111111-1111-1111-1111-111111111111.jsonl'), content);

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'active');
    assert.ok(result.rate_limits !== null);
    assert.strictEqual(result.rate_limits, result.rateLimits);

    const primary = result.rate_limits.primary;
    assert.ok(primary !== null);
    assert.strictEqual(primary.used_percent, 75.0);
    assert.strictEqual(primary.remaining_percent, 25.0);
    assert.strictEqual(primary.window_minutes, 300);
    assert.strictEqual(primary.resets_at, 1789451000);

    const secondary = result.rate_limits.secondary;
    assert.ok(secondary !== null);
    assert.strictEqual(secondary.used_percent, 28.5);
    assert.strictEqual(secondary.remaining_percent, 71.5);
    assert.strictEqual(secondary.window_minutes, 10080);
    assert.strictEqual(secondary.resets_at, 1789500000);

    assert.strictEqual(result.rate_limits.credits, null);
    assert.strictEqual(result.rate_limits.plan_type, 'plus');
  });

  void test('clamping remaining_percent when used_percent exceeds 100 or is negative', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const content = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T12:00:00.000Z',
      payload: {
        rate_limits: {
          primary: {
            used_percent: 120.0,
            window_minutes: 300,
          },
          secondary: {
            used_percent: -5.0,
            window_minutes: 10080,
          },
        },
      },
    }) + '\n';

    fs.writeFileSync(path.join(dayDir, 'rollout-2026-09-08T12-00-00-clamp.jsonl'), content);

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);
    assert.strictEqual(result.rate_limits.primary?.used_percent, 120.0);
    assert.strictEqual(result.rate_limits.primary?.remaining_percent, 0);
    assert.strictEqual(result.rate_limits.secondary?.used_percent, -5.0);
    assert.strictEqual(result.rate_limits.secondary?.remaining_percent, 100);
  });

  void test('credits and plan_type normalization for valid and missing/mistyped fields', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const content = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T15:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 10.0 },
          secondary: null,
          credits: {
            balance: '482.0227350000',
            has_credits: true,
            unlimited: false,
          },
          plan_type: 'team',
        },
      },
    }) + '\n';

    fs.writeFileSync(path.join(dayDir, 'rollout-2026-09-08T15-00-00-credits.jsonl'), content);

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);
    assert.strictEqual(result.rate_limits.secondary, null);
    assert.strictEqual(result.rate_limits.plan_type, 'team');

    const credits = result.rate_limits.credits;
    assert.ok(credits !== null);
    assert.strictEqual(credits.balance, '482.0227350000');
    assert.strictEqual(credits.has_credits, true);
    assert.strictEqual(credits.unlimited, false);
  });

  void test('normalizes mistyped fields in credits and windows to null without throwing', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const content = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T16:00:00.000Z',
      payload: {
        rate_limits: {
          primary: {
            used_percent: 'not-a-number',
            window_minutes: [100],
            resets_at: true,
          },
          secondary: {},
          credits: {
            balance: { invalid: 'object' },
            has_credits: 'yes',
            unlimited: 1,
          },
          plan_type: 12345,
        },
      },
    }) + '\n';

    fs.writeFileSync(path.join(dayDir, 'rollout-2026-09-08T16-00-00-mistyped.jsonl'), content);

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);

    const primary = result.rate_limits.primary;
    assert.ok(primary !== null);
    assert.strictEqual(primary.used_percent, null);
    assert.strictEqual(primary.remaining_percent, null);
    assert.strictEqual(primary.window_minutes, null);
    assert.strictEqual(primary.resets_at, null);

    const secondary = result.rate_limits.secondary;
    assert.ok(secondary !== null);
    assert.strictEqual(secondary.used_percent, null);
    assert.strictEqual(secondary.remaining_percent, null);

    const credits = result.rate_limits.credits;
    assert.ok(credits !== null);
    assert.strictEqual(credits.balance, null);
    assert.strictEqual(credits.has_credits, null);
    assert.strictEqual(credits.unlimited, null);

    assert.strictEqual(result.rate_limits.plan_type, null);
  });

  void test('selects latest snapshot across multiple sessions and split files', () => {
    const sessionsDir = createTempSessionsDir();
    const dir1 = path.join(sessionsDir, '2026', '09', '07');
    const dir2 = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    // Older session file
    fs.writeFileSync(
      path.join(dir1, 'rollout-2026-09-07T10-00-00.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-07T10:00:00.000Z',
        payload: {
          rate_limits: {
            primary: { used_percent: 10.0 },
            plan_type: 'old-plan',
          },
        },
      }) + '\n'
    );

    // Newer session file
    fs.writeFileSync(
      path.join(dir2, 'rollout-2026-09-08T18-00-00.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T18:00:00.000Z',
        payload: {
          rate_limits: {
            primary: { used_percent: 85.0 },
            plan_type: 'new-plan',
          },
        },
      }) + '\n'
    );

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);
    assert.strictEqual(result.rate_limits.primary?.used_percent, 85.0);
    assert.strictEqual(result.rate_limits.plan_type, 'new-plan');
  });

  void test('prioritizes valid event timestamp over file mtime', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const fileA = path.join(dayDir, 'rollout-fileA.jsonl');
    const fileB = path.join(dayDir, 'rollout-fileB.jsonl');

    // File A: has newer event timestamp (15:00), but older file mtime (10:00)
    fs.writeFileSync(
      fileA,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T15:00:00.000Z',
        payload: {
          rate_limits: {
            primary: { used_percent: 50.0 },
            plan_type: 'from-file-A',
          },
        },
      }) + '\n'
    );
    const time10 = new Date('2026-09-08T10:00:00.000Z');
    fs.utimesSync(fileA, time10, time10);

    // File B: has older event timestamp (12:00), but newer file mtime (16:00)
    fs.writeFileSync(
      fileB,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T12:00:00.000Z',
        payload: {
          rate_limits: {
            primary: { used_percent: 90.0 },
            plan_type: 'from-file-B',
          },
        },
      }) + '\n'
    );
    const time16 = new Date('2026-09-08T16:00:00.000Z');
    fs.utimesSync(fileB, time16, time16);

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);
    // File A must be chosen because its event timestamp 15:00 > File B's 12:00
    assert.strictEqual(result.rate_limits.plan_type, 'from-file-A');
    assert.strictEqual(result.rate_limits.primary?.used_percent, 50.0);
  });

  void test('falls back to file mtime when event timestamp is absent or invalid', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const fileA = path.join(dayDir, 'rollout-no-timestamp.jsonl');
    const fileB = path.join(dayDir, 'rollout-invalid-timestamp.jsonl');

    // File A: no timestamp, mtime 14:00
    fs.writeFileSync(
      fileA,
      JSON.stringify({
        type: 'token_usage_record',
        payload: {
          rate_limits: {
            primary: { used_percent: 40.0 },
            plan_type: 'mtime-1400',
          },
        },
      }) + '\n'
    );
    const time14 = new Date('2026-09-08T14:00:00.000Z');
    fs.utimesSync(fileA, time14, time14);

    // File B: invalid timestamp, mtime 11:00
    fs.writeFileSync(
      fileB,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: 'not-a-valid-date-string',
        payload: {
          rate_limits: {
            primary: { used_percent: 20.0 },
            plan_type: 'mtime-1100',
          },
        },
      }) + '\n'
    );
    const time11 = new Date('2026-09-08T11:00:00.000Z');
    fs.utimesSync(fileB, time11, time11);

    const result = getCodexDailyUsage();
    assert.ok(result.rate_limits !== null);
    // File A must be chosen because mtime 14:00 > 11:00
    assert.strictEqual(result.rate_limits.plan_type, 'mtime-1400');
    assert.strictEqual(result.rate_limits.primary?.used_percent, 40.0);
  });

  void test('deterministic tie-breaking when two events share identical timestamps', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const fileA = path.join(dayDir, 'rollout-alpha.jsonl');
    const fileB = path.join(dayDir, 'rollout-beta.jsonl');

    const contentA = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T12:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 11.0 },
          plan_type: 'plan-alpha',
        },
      },
    }) + '\n';

    const contentB = JSON.stringify({
      type: 'token_usage_record',
      timestamp: '2026-09-08T12:00:00.000Z',
      payload: {
        rate_limits: {
          primary: { used_percent: 22.0 },
          plan_type: 'plan-beta',
        },
      },
    }) + '\n';

    fs.writeFileSync(fileA, contentA);
    fs.writeFileSync(fileB, contentB);

    // Run multiple times to verify determinism
    const result1 = getCodexDailyUsage();
    clearCodexUsageCache();
    const result2 = getCodexDailyUsage();

    assert.strictEqual(result1.rate_limits?.plan_type, result2.rate_limits?.plan_type);
    assert.strictEqual(result1.rate_limits?.primary?.used_percent, result2.rate_limits?.primary?.used_percent);
  });

  void test('edge cases: missing directory returns not_found and null rate_limits', () => {
    const nonExistent = path.join(os.tmpdir(), 'codex-non-existent-' + Date.now());
    process.env.CODEX_SESSIONS_DIR = nonExistent;

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'not_found');
    assert.strictEqual(result.rate_limits, null);
    assert.strictEqual(result.rateLimits, null);
    assert.strictEqual(result.sessionCount, 0);
    assert.deepStrictEqual(result.codexDaily, []);
  });

  void test('edge cases: empty directory returns empty status and null rate_limits', () => {
    createTempSessionsDir();

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'empty');
    assert.strictEqual(result.rate_limits, null);
    assert.strictEqual(result.rateLimits, null);
    assert.strictEqual(result.sessionCount, 0);
    assert.deepStrictEqual(result.codexDaily, []);
  });

  void test('edge cases: corrupt JSONL and partial lines handled gracefully', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const file = path.join(dayDir, 'rollout-corrupt.jsonl');
    const content = [
      '{ "malformed json...',
      'not json at all',
      '{"type":"token_usage_record"}',
      '{"type":"token_usage_record","payload":{}}',
      '{"type":"token_usage_record","payload":{"rate_limits":{}}}',
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T12:00:00.000Z',
        payload: {
          rate_limits: {
            primary: { used_percent: 33.0 },
            plan_type: 'plus',
          },
        },
      }),
      '{"another": "truncated',
    ].join('\n') + '\n';

    fs.writeFileSync(file, content);

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.ok(result.rate_limits !== null);
    assert.strictEqual(result.rate_limits.primary?.used_percent, 33.0);
    assert.strictEqual(result.rate_limits.plan_type, 'plus');
  });

  void test('sensitive fields and non-candidate events are never logged or exposed in response', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    const sensitiveToken = 'SECRET_BEARER_TOKEN_XYZ_12345';
    const sensitivePrompt = 'CLASSIFIED_SYSTEM_PROMPT_VERY_CONFIDENTIAL';
    const sensitiveConversation = 'USER: What is the launch code? ASSISTANT: 9999';

    const lines = [
      JSON.stringify({
        type: 'prompt_record',
        prompt: sensitivePrompt,
        auth_token: sensitiveToken,
      }),
      JSON.stringify({
        type: 'event_msg',
        content: sensitiveConversation,
      }),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T19:00:00.000Z',
        secret_key: 'DO_NOT_EXPOSE_ME',
        payload: {
          session_id: 'clean-session-id',
          auth_token: sensitiveToken,
          conversation_history: sensitiveConversation,
          prompt_text: sensitivePrompt,
          thread_token_usage: {
            total_tokens: 500,
            cached_input_tokens: 100,
            input_tokens: 400,
            output_tokens: 100,
            reasoning_output_tokens: 0,
          },
          rate_limits: {
            secret_metadata: 'SHOULD_NOT_LEAK',
            primary: {
              used_percent: 50.0,
              window_minutes: 300,
              resets_at: 1789450000,
              extra_sensitive_field: 'LEAK_CHECK',
            },
            credits: {
              balance: '100.0',
              has_credits: true,
              unlimited: false,
              user_bank_account: 'SECRET_BANK_ACCOUNT',
            },
            plan_type: 'plus',
          },
        },
      }),
    ];

    fs.writeFileSync(path.join(dayDir, 'rollout-sensitive.jsonl'), lines.join('\n') + '\n');

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.ok(result.rate_limits !== null);

    // Deep string inspection: ensure sensitive strings NEVER appear in serialized response
    const serialized = JSON.stringify(result);
    assert.strictEqual(serialized.includes(sensitiveToken), false);
    assert.strictEqual(serialized.includes(sensitivePrompt), false);
    assert.strictEqual(serialized.includes(sensitiveConversation), false);
    assert.strictEqual(serialized.includes('DO_NOT_EXPOSE_ME'), false);
    assert.strictEqual(serialized.includes('SHOULD_NOT_LEAK'), false);
    assert.strictEqual(serialized.includes('LEAK_CHECK'), false);
    assert.strictEqual(serialized.includes('SECRET_BANK_ACCOUNT'), false);

    // Ensure only explicitly allowed keys exist in rate_limits
    assert.deepStrictEqual(Object.keys(result.rate_limits).sort(), ['credits', 'plan_type', 'primary', 'secondary']);
    if (result.rate_limits.primary) {
      assert.deepStrictEqual(Object.keys(result.rate_limits.primary).sort(), ['remaining_percent', 'resets_at', 'used_percent', 'window_minutes']);
    }
    if (result.rate_limits.credits) {
      assert.deepStrictEqual(Object.keys(result.rate_limits.credits).sort(), ['balance', 'has_credits', 'unlimited']);
    }
  });

  void test('existing cumulative token usage regression verification', () => {
    const sessionsDir = createTempSessionsDir();
    const dayDir = path.join(sessionsDir, '2026', '09', '08');
    fs.mkdirSync(dayDir, { recursive: true });

    // Session 1, part 1
    fs.writeFileSync(
      path.join(dayDir, 'rollout-2026-09-08T01-00-00-aaaa-1.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T01:00:00.000Z',
        ordinal: 1,
        payload: {
          session_id: 'session-alpha',
          thread_token_usage: {
            total_tokens: 100,
            cached_input_tokens: 20,
            input_tokens: 80,
            output_tokens: 20,
            reasoning_output_tokens: 0,
          },
        },
      }) + '\n'
    );

    // Session 1, part 2 (higher cumulative tokens for same session: should replace part 1)
    fs.writeFileSync(
      path.join(dayDir, 'rollout-2026-09-08T01-30-00-aaaa-2.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T01:30:00.000Z',
        ordinal: 2,
        payload: {
          session_id: 'session-alpha',
          thread_token_usage: {
            total_tokens: 250,
            cached_input_tokens: 50,
            input_tokens: 200,
            output_tokens: 50,
            reasoning_output_tokens: 10,
          },
        },
      }) + '\n'
    );

    // Session 2 on same day (distinct session: should sum with session 1)
    fs.writeFileSync(
      path.join(dayDir, 'rollout-2026-09-08T02-00-00-bbbb-1.jsonl'),
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: '2026-09-08T02:00:00.000Z',
        ordinal: 1,
        payload: {
          session_id: 'session-beta',
          thread_token_usage: {
            total_tokens: 300,
            cached_input_tokens: 100,
            input_tokens: 200,
            output_tokens: 100,
            reasoning_output_tokens: 5,
          },
        },
      }) + '\n'
    );

    const result = getCodexDailyUsage();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.sessionCount, 1); // 1 date in map
    assert.strictEqual(result.codexDaily.length, 1);

    const day = result.codexDaily[0];
    assert.strictEqual(day.date, '2026-09-08');
    // Total tokens: session-alpha (250) + session-beta (300) = 550
    assert.strictEqual(day.totalTokens, 550);
    // Cached tokens: 50 + 100 = 150
    assert.strictEqual(day.cachedInputTokens, 150);
    // Active tokens: 550 - 150 = 400
    assert.strictEqual(day.activeTokens, 400);
    // Output tokens: 50 + 100 = 150
    assert.strictEqual(day.outputTokens, 150);
    // Reasoning output tokens: 10 + 5 = 15
    assert.strictEqual(day.reasoningOutputTokens, 15);
  });
});
