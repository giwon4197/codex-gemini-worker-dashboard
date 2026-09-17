/**
 * Daily Token Stats Calculation Module
 * Pure calculation helper for dashboard daily token comparison (local 00:00 through now).
 */

export interface DailyJobStatsInput {
  cached?: number | null;
  prompt?: number | null;
  candidates?: number | null;
  thoughts?: number | null;
  requests?: number | null;
  latency?: number | null;
}

export interface DailyJobInput {
  name?: string;
  model?: string;
  status?: string;
  tokens?: string | number | null;
  duration?: string;
  time?: string;
  timestamp?: string | null;
  snippet?: string;
  stats?: DailyJobStatsInput | null;
}

export interface DailyCodexEntryInput {
  date: string;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  activeTokens?: number | null;
  tokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
}

export interface CalculateDailyTokenStatsParams {
  codexDaily?: DailyCodexEntryInput[] | null;
  jobs?: DailyJobInput[] | null;
  referenceDate?: Date | string | number;
}

export interface DailyTokenStatsResult {
  localDateKey: string;
  codexTotals: {
    totalTokens: number;
    cachedInputTokens: number;
    activeTokens: number;
  };
  codexActiveTokens: number;
  geminiActiveTokens: number;
  geminiCachedTokens: number;
  geminiTotalTokens: number;
  geminiMatchingJobsCount: number;
  totalActiveTokens: number;
  codexActiveRatio: number;
  geminiActiveRatio: number;
  estimatedCodexSavedTokens: number;
  estimatedCodexSavingsRatio: number;
  totalCachedTokens: number;
  grandTotalTokens: number;
}

/**
 * Derives a local YYYY-MM-DD key from the current local clock or provided reference date.
 * Does not use UTC date slicing (e.g. toISOString).
 */
export function getLocalDateKey(dateInput: Date | string | number = new Date()): string {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return dateInput;
  }
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    return '';
  }
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Defensively parses and clamps a token count to a non-negative integer.
 */
export function parseTokenCount(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || isNaN(value)) return 0;
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return 0;
    const match = cleaned.match(/-?\d+/);
    if (!match) return 0;
    const parsed = parseInt(match[0], 10);
    if (!Number.isFinite(parsed) || isNaN(parsed)) return 0;
    return Math.max(0, parsed);
  }
  return 0;
}

/**
 * Pure calculation function that calculates daily token stats for Codex and Gemini
 * for the given local day (local 00:00 to now).
 */
export function calculateDailyTokenStats(params: CalculateDailyTokenStatsParams): DailyTokenStatsResult {
  const localDateKey = getLocalDateKey(params.referenceDate ?? new Date());

  // 1. Codex: only entries whose date equals localDateKey.
  // Must NOT reduce all historical codexDaily entries.
  const matchingCodexEntries = (params.codexDaily ?? []).filter(
    entry => Boolean(entry && typeof entry.date === 'string' && entry.date === localDateKey)
  );

  let codexTotalTokens = 0;
  let codexCachedInputTokens = 0;
  let codexActiveTokens = 0;

  for (const entry of matchingCodexEntries) {
    const total = parseTokenCount(entry.totalTokens ?? entry.tokens ?? 0);
    const cached = parseTokenCount(entry.cachedInputTokens ?? 0);
    const active = (entry.activeTokens !== undefined && entry.activeTokens !== null)
      ? parseTokenCount(entry.activeTokens)
      : Math.max(0, total - cached);

    codexTotalTokens += total;
    codexCachedInputTokens += cached;
    codexActiveTokens += active;
  }

  // 2. Gemini: calculated ONLY from data.jobs entries whose valid timestamp falls on that same local day.
  // Sum the job-level confirmed usage: active from job.tokens, cached from job.stats.cached.
  let geminiActiveTokens = 0;
  let geminiCachedTokens = 0;
  let geminiMatchingJobsCount = 0;

  for (const job of params.jobs ?? []) {
    if (!job || !job.timestamp || typeof job.timestamp !== 'string') {
      continue;
    }
    const jobDate = new Date(job.timestamp);
    if (isNaN(jobDate.getTime())) {
      continue;
    }
    const jobDateKey = getLocalDateKey(jobDate);
    if (!jobDateKey || jobDateKey !== localDateKey) {
      continue;
    }

    const active = parseTokenCount(job.tokens);
    const cached = parseTokenCount(job.stats?.cached);

    geminiActiveTokens += active;
    geminiCachedTokens += cached;
    geminiMatchingJobsCount += 1;
  }

  const geminiTotalTokens = geminiActiveTokens + geminiCachedTokens;

  // 3. Proportions & Ratios
  const totalActiveTokens = codexActiveTokens + geminiActiveTokens;
  const codexActiveRatio = totalActiveTokens > 0 ? (codexActiveTokens / totalActiveTokens) * 100 : 0;
  const geminiActiveRatio = totalActiveTokens > 0 ? (geminiActiveTokens / totalActiveTokens) * 100 : 0;

  // 4. Estimated Codex Savings (1:1 Proxy from Gemini active tokens)
  const estimatedCodexSavedTokens = geminiActiveTokens;
  const estimatedTotalWork = codexActiveTokens + estimatedCodexSavedTokens;
  const estimatedCodexSavingsRatio = estimatedTotalWork > 0
    ? (estimatedCodexSavedTokens / estimatedTotalWork) * 100
    : 0;

  const totalCachedTokens = codexCachedInputTokens + geminiCachedTokens;
  const grandTotalTokens = codexTotalTokens + geminiTotalTokens;

  return {
    localDateKey,
    codexTotals: {
      totalTokens: codexTotalTokens,
      cachedInputTokens: codexCachedInputTokens,
      activeTokens: codexActiveTokens,
    },
    codexActiveTokens,
    geminiActiveTokens,
    geminiCachedTokens,
    geminiTotalTokens,
    geminiMatchingJobsCount,
    totalActiveTokens,
    codexActiveRatio,
    geminiActiveRatio,
    estimatedCodexSavedTokens,
    estimatedCodexSavingsRatio,
    totalCachedTokens,
    grandTotalTokens,
  };
}


