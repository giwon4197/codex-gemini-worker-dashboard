import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { getLocalDateKey, parseTokenCount, calculateDailyTokenStats } from './daily-token-stats.ts';

void describe('Daily Token Stats Helper and Calculations', () => {
  void describe('getLocalDateKey', () => {
    void test('derives local YYYY-MM-DD from Date using local calendar', () => {
      const d = new Date(2026, 8, 9, 14, 30, 0); // Local Month 8 is September
      assert.strictEqual(getLocalDateKey(d), '2026-09-09');
    });

    void test('preserves already formatted YYYY-MM-DD date string', () => {
      assert.strictEqual(getLocalDateKey('2026-09-09'), '2026-09-09');
      assert.strictEqual(getLocalDateKey('2025-12-31'), '2025-12-31');
    });

    void test('returns empty string for invalid dates', () => {
      assert.strictEqual(getLocalDateKey('invalid-date'), '');
      assert.strictEqual(getLocalDateKey(NaN), '');
    });
  });

  void describe('parseTokenCount', () => {
    void test('handles valid numbers and rounds to non-negative integer', () => {
      assert.strictEqual(parseTokenCount(1234), 1234);
      assert.strictEqual(parseTokenCount(1234.8), 1234);
      assert.strictEqual(parseTokenCount(0), 0);
    });

    void test('clamps negative numbers, NaN, and Infinity to zero', () => {
      assert.strictEqual(parseTokenCount(-500), 0);
      assert.strictEqual(parseTokenCount(NaN), 0);
      assert.strictEqual(parseTokenCount(Infinity), 0);
      assert.strictEqual(parseTokenCount(-Infinity), 0);
    });

    void test('parses numeric strings with commas and labels', () => {
      assert.strictEqual(parseTokenCount('11,092'), 11092);
      assert.strictEqual(parseTokenCount('9,283 토큰'), 9283);
      assert.strictEqual(parseTokenCount('  500  '), 500);
    });

    void test('defensively handles non-numeric and malformed string values', () => {
      assert.strictEqual(parseTokenCount('기록 전'), 0);
      assert.strictEqual(parseTokenCount(''), 0);
      assert.strictEqual(parseTokenCount('abc'), 0);
      assert.strictEqual(parseTokenCount('-100'), 0);
      assert.strictEqual(parseTokenCount(null), 0);
      assert.strictEqual(parseTokenCount(undefined), 0);
      assert.strictEqual(parseTokenCount({}), 0);
      assert.strictEqual(parseTokenCount([]), 0);
    });
  });

  void describe('calculateDailyTokenStats', () => {
    const referenceDate = new Date(2026, 8, 9, 12, 0, 0); // 2026-09-09 local
    const todayKey = '2026-09-09';
    const yesterdayKey = '2026-09-08';

    void test('yesterday/today filtering for both Codex and Gemini providers', () => {
      // Codex: historical entries for yesterday and today
      const codexDaily = [
        {
          date: yesterdayKey,
          totalTokens: 100000,
          cachedInputTokens: 30000,
          activeTokens: 70000,
        },
        {
          date: todayKey,
          totalTokens: 25000,
          cachedInputTokens: 5000,
          activeTokens: 20000,
        },
      ];

      // Gemini: jobs from yesterday and today
      const yesterdayJobTime = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - 1, 15, 0, 0);
      const todayJobTime = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 10, 0, 0);

      const jobs = [
        {
          name: 'Yesterday Job',
          tokens: '15,000',
          timestamp: yesterdayJobTime.toISOString(),
          stats: { cached: 5000 },
        },
        {
          name: 'Today Job',
          tokens: '10,000',
          timestamp: todayJobTime.toISOString(),
          stats: { cached: 2000 },
        },
      ];

      const stats = calculateDailyTokenStats({
        codexDaily,
        jobs,
        referenceDate,
      });

      // Codex donut metrics must use ONLY today's entry and not reduce yesterday
      assert.strictEqual(stats.localDateKey, todayKey);
      assert.strictEqual(stats.codexActiveTokens, 20000);
      assert.strictEqual(stats.codexTotals.totalTokens, 25000);
      assert.strictEqual(stats.codexTotals.cachedInputTokens, 5000);

      // Gemini donut metrics must use ONLY today's job
      assert.strictEqual(stats.geminiMatchingJobsCount, 1);
      assert.strictEqual(stats.geminiActiveTokens, 10000);
      assert.strictEqual(stats.geminiCachedTokens, 2000);
      assert.strictEqual(stats.geminiTotalTokens, 12000);

      // Total active = 20000 (Codex) + 10000 (Gemini) = 30000
      assert.strictEqual(stats.totalActiveTokens, 30000);
      assert.strictEqual(Math.round(stats.codexActiveRatio), 67); // 20000/30000 = 66.67%
      assert.strictEqual(Math.round(stats.geminiActiveRatio), 33); // 10000/30000 = 33.33%

      // Savings proxy: Gemini active = 10000, Total work = 30000, ratio = 33.33%
      assert.strictEqual(stats.estimatedCodexSavedTokens, 10000);
      assert.strictEqual(Math.round(stats.estimatedCodexSavingsRatio), 33);
    });

    void test('local-date boundary behavior including timestamps with offsets', () => {
      // Local start of day: 00:00:01
      const startOfToday = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 0, 0, 1);
      // Local end of day: 23:59:59
      const endOfToday = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 23, 59, 59);
      // Local 1 second before midnight (yesterday 23:59:59)
      const endOfYesterday = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() - 1, 23, 59, 59);
      // Local 1 second after midnight (tomorrow 00:00:01)
      const startOfTomorrow = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + 1, 0, 0, 1);

      const jobs = [
        {
          name: 'Start of Today',
          tokens: '1,000',
          timestamp: startOfToday.toISOString(),
          stats: { cached: 100 },
        },
        {
          name: 'End of Today',
          tokens: '2,000',
          timestamp: endOfToday.toISOString(),
          stats: { cached: 200 },
        },
        {
          name: 'End of Yesterday (Excluded)',
          tokens: '9,999',
          timestamp: endOfYesterday.toISOString(),
          stats: { cached: 999 },
        },
        {
          name: 'Start of Tomorrow (Excluded)',
          tokens: '8,888',
          timestamp: startOfTomorrow.toISOString(),
          stats: { cached: 888 },
        },
      ];

      const stats = calculateDailyTokenStats({
        jobs,
        referenceDate,
      });

      assert.strictEqual(stats.geminiMatchingJobsCount, 2);
      assert.strictEqual(stats.geminiActiveTokens, 3000);
      assert.strictEqual(stats.geminiCachedTokens, 300);
      assert.strictEqual(stats.geminiTotalTokens, 3300);
    });

    void test('timestamps with explicit ISO offsets match local calendar day correctly', () => {
      // Construct an ISO string with the current local timezone offset
      const localTzOffsetMinutes = -referenceDate.getTimezoneOffset();
      const sign = localTzOffsetMinutes >= 0 ? '+' : '-';
      const absOffset = Math.abs(localTzOffsetMinutes);
      const hoursOffset = String(Math.floor(absOffset / 60)).padStart(2, '0');
      const minsOffset = String(absOffset % 60).padStart(2, '0');
      const tzString = `${sign}${hoursOffset}:${minsOffset}`;

      const explicitOffsetToday = `2026-09-09T08:15:30.000${tzString}`;
      const explicitOffsetYesterday = `2026-09-08T23:45:00.000${tzString}`;

      const jobs = [
        {
          name: 'Explicit Offset Today',
          tokens: '4,500',
          timestamp: explicitOffsetToday,
          stats: { cached: 500 },
        },
        {
          name: 'Explicit Offset Yesterday',
          tokens: '10,000',
          timestamp: explicitOffsetYesterday,
          stats: { cached: 1000 },
        },
      ];

      const stats = calculateDailyTokenStats({
        jobs,
        referenceDate,
      });

      assert.strictEqual(stats.geminiMatchingJobsCount, 1);
      assert.strictEqual(stats.geminiActiveTokens, 4500);
      assert.strictEqual(stats.geminiCachedTokens, 500);
    });

    void test('malformed or missing timestamps and token fields handled gracefully', () => {
      const validToday = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 11, 0, 0).toISOString();

      const jobs = [
        {
          name: 'Missing Timestamp',
          tokens: '1,000',
          timestamp: undefined,
        },
        {
          name: 'Null Timestamp',
          tokens: '1,000',
          timestamp: null,
        },
        {
          name: 'Empty Timestamp',
          tokens: '1,000',
          timestamp: '',
        },
        {
          name: 'Invalid Timestamp',
          tokens: '1,000',
          timestamp: 'not-a-valid-date',
        },
        {
          name: 'Malformed Tokens String ("기록 전")',
          tokens: '기록 전',
          timestamp: validToday,
          stats: { cached: 100 },
        },
        {
          name: 'Negative Tokens & Cached',
          tokens: -500,
          timestamp: validToday,
          stats: { cached: -200 },
        },
        {
          name: 'NaN and Infinity Fields',
          tokens: NaN,
          timestamp: validToday,
          stats: { cached: Infinity },
        },
        {
          name: 'Null stats and missing tokens',
          tokens: null,
          timestamp: validToday,
          stats: null,
        },
        {
          name: 'Valid Job along with malformed ones',
          tokens: '5,000',
          timestamp: validToday,
          stats: { cached: 1000 },
        },
      ];

      const codexDaily = [
        {
          date: todayKey,
          totalTokens: NaN,
          cachedInputTokens: -100,
          activeTokens: undefined,
        },
      ];

      const stats = calculateDailyTokenStats({
        codexDaily,
        jobs,
        referenceDate,
      });

      // Valid job contributes 5000 active and 1000 cached.
      // Malformed string '기록 전' contributes 0 active and 100 cached.
      // Negative / NaN / Infinity / Null contribute 0.
      assert.strictEqual(stats.geminiActiveTokens, 5000);
      assert.strictEqual(stats.geminiCachedTokens, 1100);
      assert.strictEqual(stats.codexActiveTokens, 0);
      assert.strictEqual(stats.codexTotals.cachedInputTokens, 0);
      assert.strictEqual(stats.codexTotals.totalTokens, 0);
      assert.strictEqual(Number.isFinite(stats.geminiActiveRatio), true);
    });

    void test('zero totals and ratios handled deterministically without NaN or Infinity', () => {
      const stats = calculateDailyTokenStats({
        codexDaily: [],
        jobs: [],
        referenceDate,
      });

      assert.strictEqual(stats.totalActiveTokens, 0);
      assert.strictEqual(stats.codexActiveTokens, 0);
      assert.strictEqual(stats.geminiActiveTokens, 0);
      assert.strictEqual(stats.codexActiveRatio, 0);
      assert.strictEqual(stats.geminiActiveRatio, 0);
      assert.strictEqual(stats.estimatedCodexSavedTokens, 0);
      assert.strictEqual(stats.estimatedCodexSavingsRatio, 0);
      assert.strictEqual(stats.totalCachedTokens, 0);
      assert.strictEqual(stats.grandTotalTokens, 0);

      // Only Codex active tokens present
      const codexOnly = calculateDailyTokenStats({
        codexDaily: [{ date: todayKey, totalTokens: 1000, cachedInputTokens: 200, activeTokens: 800 }],
        jobs: [],
        referenceDate,
      });
      assert.strictEqual(codexOnly.codexActiveRatio, 100);
      assert.strictEqual(codexOnly.geminiActiveRatio, 0);
      assert.strictEqual(codexOnly.estimatedCodexSavingsRatio, 0);

      // Only Gemini active tokens present
      const todayTime = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 10, 0, 0).toISOString();
      const geminiOnly = calculateDailyTokenStats({
        codexDaily: [],
        jobs: [{ name: 'Job', tokens: '1000', timestamp: todayTime }],
        referenceDate,
      });
      assert.strictEqual(geminiOnly.codexActiveRatio, 0);
      assert.strictEqual(geminiOnly.geminiActiveRatio, 100);
      assert.strictEqual(geminiOnly.estimatedCodexSavingsRatio, 100);
    });

    void test('cached-token handling correctly accounts for cache in totals without double-counting active tokens', () => {
      const todayTime = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 10, 0, 0).toISOString();

      const codexDaily = [
        {
          date: todayKey,
          totalTokens: 10000,
          cachedInputTokens: 3000,
          activeTokens: 7000,
        },
      ];

      const jobs = [
        {
          name: 'Job With Cache',
          tokens: '5,000', // active tokens
          timestamp: todayTime,
          stats: { cached: 2000 },
        },
      ];

      const stats = calculateDailyTokenStats({
        codexDaily,
        jobs,
        referenceDate,
      });

      assert.strictEqual(stats.codexActiveTokens, 7000);
      assert.strictEqual(stats.codexTotals.cachedInputTokens, 3000);
      assert.strictEqual(stats.codexTotals.totalTokens, 10000);

      assert.strictEqual(stats.geminiActiveTokens, 5000);
      assert.strictEqual(stats.geminiCachedTokens, 2000);
      assert.strictEqual(stats.geminiTotalTokens, 7000); // 5000 + 2000

      assert.strictEqual(stats.totalActiveTokens, 12000); // 7000 + 5000
      assert.strictEqual(stats.totalCachedTokens, 5000); // 3000 + 2000
      assert.strictEqual(stats.grandTotalTokens, 17000); // 10000 + 7000
    });

    void test('multiple already-materialized job records are summed without relying on summary totals', () => {
      const todayTime = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 14, 0, 0).toISOString();

      const jobs = [
        {
          name: 'Job 1',
          tokens: '1,000',
          timestamp: todayTime,
          stats: { cached: 100 },
        },
        {
          name: 'Job 2',
          tokens: '2,500',
          timestamp: todayTime,
          stats: { cached: 250 },
        },
        {
          name: 'Job 3',
          tokens: '3,500',
          timestamp: todayTime,
          stats: { cached: 350 },
        },
      ];

      // Note: calculateDailyTokenStats does not receive summary totals at all, proving it is independent of data.summary.tokens
      const stats = calculateDailyTokenStats({
        jobs,
        referenceDate,
      });

      assert.strictEqual(stats.geminiMatchingJobsCount, 3);
      assert.strictEqual(stats.geminiActiveTokens, 7000); // 1000 + 2500 + 3500
      assert.strictEqual(stats.geminiCachedTokens, 700); // 100 + 250 + 350
      assert.strictEqual(stats.geminiTotalTokens, 7700);
    });
  });
});



