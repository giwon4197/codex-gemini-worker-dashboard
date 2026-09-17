import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type QuotaWindowType = '5h' | 'weekly';

export interface GeminiQuotaPool {
  id: string;
  name: string;
  window: QuotaWindowType;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetTime: string | null;
  remainingDurationMs: number | null;
  remainingDurationText: string | null;
  isAvailable: boolean;
}

export interface GeminiQuotaSnapshot {
  fiveHour: GeminiQuotaPool | null;
  weekly: GeminiQuotaPool | null;
  description: string | null;
}

export interface GeminiQuotaResponse {
  ok: boolean;
  status: 'available' | 'unavailable' | 'error';
  quota: GeminiQuotaSnapshot | null;
  lastSyncedAt: string;
  cached?: boolean;
  message?: string;
}

interface CachedQuotaState {
  response: GeminiQuotaResponse;
  expiresAtMs: number;
}

let memoryCache: CachedQuotaState | null = null;
let inflightPromise: Promise<GeminiQuotaResponse> | null = null;

/**
 * Clears the in-memory cache (primarily for tests).
 */
export function clearGeminiQuotaCache(): void {
  memoryCache = null;
  inflightPromise = null;
}

/**
 * Strips potential secrets, tokens, email addresses, and auth headers from strings.
 */
export function sanitizeSafeString(input: string): string {
  if (!input) return '';
  return input
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/ya29\.[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_KEY]')
    .replace(/(?:cookie|authorization|token|secret|password|passwd|auth)=[^;&\s]+/gi, '$1=[REDACTED]');
}

/**
 * Safely converts remaining milliseconds to Korean duration text (e.g., "48분", "6일 14시간").
 */
export function formatRemainingDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  if (ms <= 0) return '0분';

  const totalSeconds = Math.floor(ms / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}시간 ${minutes}분` : `${hours}시간`;
  }
  return `${Math.max(1, minutes)}분`;
}

/**
 * Parses a reset timestamp into ISO 8601 string and calculates remaining duration.
 */
function parseResetTimestamp(
  rawReset: unknown,
  referenceTimeMs: number
): { resetTime: string | null; remainingDurationMs: number | null; remainingDurationText: string | null } {
  if (rawReset === null || rawReset === undefined || rawReset === '') {
    return { resetTime: null, remainingDurationMs: null, remainingDurationText: null };
  }

  let resetDate: Date | null = null;
  if (typeof rawReset === 'number' && Number.isFinite(rawReset)) {
    // Epoch seconds vs milliseconds heuristic
    const ms = rawReset < 10000000000 ? rawReset * 1000 : rawReset;
    resetDate = new Date(ms);
  } else if (typeof rawReset === 'string') {
    const trimmed = rawReset.trim();
    if (trimmed.length > 0) {
      const parsed = new Date(trimmed);
      if (!isNaN(parsed.getTime())) {
        resetDate = parsed;
      }
    }
  }

  if (!resetDate || isNaN(resetDate.getTime())) {
    return { resetTime: null, remainingDurationMs: null, remainingDurationText: null };
  }

  const resetTime = resetDate.toISOString();
  const remainingDurationMs = Math.max(0, resetDate.getTime() - referenceTimeMs);
  const remainingDurationText = formatRemainingDuration(remainingDurationMs);

  return { resetTime, remainingDurationMs, remainingDurationText };
}

/**
 * Normalizes percentage values strictly from confirmed backend fields.
 */
function parsePercentages(rawObj: Record<string, unknown>): {
  usedPercent: number | null;
  remainingPercent: number | null;
  isAvailable: boolean;
} {
  // Case 1: remaining_fraction / remainingFraction in [0.0, 1.0]
  const fraction = rawObj.remaining_fraction ?? rawObj.remainingFraction;
  if (typeof fraction === 'number' && Number.isFinite(fraction)) {
    const clampedFraction = Math.max(0, Math.min(1, fraction));
    const remainingPercent = Math.round(clampedFraction * 100 * 1e4) / 1e4;
    const usedPercent = Math.round((100 - remainingPercent) * 1e4) / 1e4;
    return { usedPercent, remainingPercent, isAvailable: true };
  }

  // Case 2: explicit remaining_percent / remainingPercent
  const rawRemaining = rawObj.remaining_percent ?? rawObj.remainingPercent;
  if (typeof rawRemaining === 'number' && Number.isFinite(rawRemaining)) {
    const clampedRemaining = Math.max(0, Math.min(100, rawRemaining));
    const remainingPercent = Math.round(clampedRemaining * 1e4) / 1e4;
    const usedPercent = Math.round((100 - remainingPercent) * 1e4) / 1e4;
    return { usedPercent, remainingPercent, isAvailable: true };
  }

  // Case 3: explicit used_percent / usedPercent
  const rawUsed = rawObj.used_percent ?? rawObj.usedPercent;
  if (typeof rawUsed === 'number' && Number.isFinite(rawUsed)) {
    const clampedUsed = Math.max(0, Math.min(100, rawUsed));
    const usedPercent = Math.round(clampedUsed * 1e4) / 1e4;
    const remainingPercent = Math.round((100 - usedPercent) * 1e4) / 1e4;
    return { usedPercent, remainingPercent, isAvailable: true };
  }

  // Unconfirmed or absent
  return { usedPercent: null, remainingPercent: null, isAvailable: false };
}

/**
 * Parses TSV text output from Antigravity CLI /usage or /quota flow.
 */
export function parseQuotaTsv(tsvText: string, referenceTimeMs: number = Date.now()): GeminiQuotaSnapshot | null {
  if (!tsvText || typeof tsvText !== 'string') return null;

  const lines = tsvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let fiveHour: GeminiQuotaPool | null = null;
  let weekly: GeminiQuotaPool | null = null;

  for (const line of lines) {
    const parts = line.split('\t').map(p => p.trim());
    if (parts.length < 3) continue;

    const [groupName, bucketName, percentStr, resetStr] = parts;
    if (!/gemini/i.test(groupName)) continue;

    const percentMatch = percentStr.match(/^(\d+(?:\.\d+)?)%?$/);
    if (!percentMatch) continue;

    const rawRemPercent = parseFloat(percentMatch[1]);
    if (!Number.isFinite(rawRemPercent)) continue;

    const clampedRemaining = Math.max(0, Math.min(100, rawRemPercent));
    const remainingPercent = Math.round(clampedRemaining * 1e4) / 1e4;
    const usedPercent = Math.round((100 - remainingPercent) * 1e4) / 1e4;

    const { resetTime, remainingDurationMs, remainingDurationText } = parseResetTimestamp(resetStr, referenceTimeMs);

    const isFiveHour = /5\s*h|five\s*hour/i.test(bucketName);
    const isWeekly = /week(ly)?/i.test(bucketName);

    if (isFiveHour && !fiveHour) {
      fiveHour = {
        id: 'gemini-5h',
        name: bucketName,
        window: '5h',
        usedPercent,
        remainingPercent,
        resetTime,
        remainingDurationMs,
        remainingDurationText,
        isAvailable: true,
      };
    } else if (isWeekly && !weekly) {
      weekly = {
        id: 'gemini-weekly',
        name: bucketName,
        window: 'weekly',
        usedPercent,
        remainingPercent,
        resetTime,
        remainingDurationMs,
        remainingDurationText,
        isAvailable: true,
      };
    }
  }

  if (!fiveHour && !weekly) return null;

  return {
    fiveHour,
    weekly,
    description: null,
  };
}

/**
 * Normalizes raw upstream quota response into sanitized GeminiQuotaSnapshot.
 * Only confirmed backend values are kept; all estimations, secrets, and extra metadata are dropped.
 */
export function normalizeQuotaData(raw: unknown, referenceTimeMs: number = Date.now()): GeminiQuotaSnapshot | null {
  if (!raw) return null;

  // Handle string input (JSON or TSV)
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return normalizeQuotaData(parsed, referenceTimeMs);
      } catch {
        // Fall back to TSV parser
        return parseQuotaTsv(trimmed, referenceTimeMs);
      }
    }
    return parseQuotaTsv(trimmed, referenceTimeMs);
  }

  if (typeof raw !== 'object') return null;

  const rawRecord = raw as Record<string, unknown>;

  // Extract nested data if wrapped (e.g., CLI response shape: command.data)
  let dataObj = rawRecord;
  if (rawRecord.command && typeof rawRecord.command === 'object') {
    const cmd = rawRecord.command as Record<string, unknown>;
    if (cmd.data && typeof cmd.data === 'object') {
      dataObj = cmd.data as Record<string, unknown>;
    }
  } else if (rawRecord.data && typeof rawRecord.data === 'object') {
    dataObj = rawRecord.data as Record<string, unknown>;
  }

  // Extract description if present and sanitize
  let description: string | null = null;
  if (typeof dataObj.description === 'string' && dataObj.description.trim().length > 0) {
    description = sanitizeSafeString(dataObj.description.trim());
  }

  // Helper to convert unknown primitive values safely to string without invoking Object's toString
  const toSafeString = (val: unknown): string => {
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    return '';
  };

  // Find candidate buckets
  let candidateBuckets: Array<Record<string, unknown>> = [];

  // Structure A: groups array containing buckets
  const rawGroups = dataObj.groups ?? rawRecord.groups;
  if (Array.isArray(rawGroups) && rawGroups.length > 0) {
    // Find Gemini-specific group
    let geminiGroup: Record<string, unknown> | null = null;
    for (const g of rawGroups) {
      if (!g || typeof g !== 'object') continue;
      const grp = g as Record<string, unknown>;
      const name = toSafeString(grp.name ?? grp.displayName ?? grp.title);
      const desc = toSafeString(grp.description);
      if (/gemini/i.test(name) || /gemini/i.test(desc)) {
        geminiGroup = grp;
        break;
      }
    }

    if (geminiGroup && Array.isArray(geminiGroup.buckets)) {
      candidateBuckets = geminiGroup.buckets.filter((b): b is Record<string, unknown> => Boolean(b && typeof b === 'object'));
    } else {
      // If no explicit Gemini group found, collect all buckets not belonging to other known providers
      for (const g of rawGroups) {
        if (!g || typeof g !== 'object') continue;
        const grp = g as Record<string, unknown>;
        const name = toSafeString(grp.name ?? grp.displayName);
        if (/claude|gpt|anthropic|openai|3p/i.test(name)) continue;
        if (Array.isArray(grp.buckets)) {
          for (const b of grp.buckets) {
            if (b && typeof b === 'object') {
              candidateBuckets.push(b as Record<string, unknown>);
            }
          }
        }
      }
    }
  }

  // Structure B: top-level buckets array
  if (candidateBuckets.length === 0) {
    const rawBuckets = dataObj.buckets ?? rawRecord.buckets;
    if (Array.isArray(rawBuckets)) {
      candidateBuckets = rawBuckets.filter((b): b is Record<string, unknown> => {
        if (!b || typeof b !== 'object') return false;
        const id = toSafeString((b as Record<string, unknown>).id ?? (b as Record<string, unknown>).bucketId);
        return !id.startsWith('3p-');
      });
    }
  }

  // If still no buckets found and raw response has a text string, try TSV parser
  if (candidateBuckets.length === 0 && typeof rawRecord.response === 'string') {
    return parseQuotaTsv(rawRecord.response, referenceTimeMs);
  }

  if (candidateBuckets.length === 0) {
    return null;
  }

  let fiveHourBucket: Record<string, unknown> | null = null;
  let weeklyBucket: Record<string, unknown> | null = null;

  for (const b of candidateBuckets) {
    const windowStr = toSafeString(b.window).toLowerCase();
    const idStr = toSafeString(b.id ?? b.bucketId).toLowerCase();
    const nameStr = toSafeString(b.name ?? b.displayName).toLowerCase();

    const is5h =
      windowStr === '5h' ||
      windowStr === 'five_hours' ||
      /5\s*h(our)?/i.test(windowStr) ||
      /5h|five[_-]?hour/i.test(idStr) ||
      /5\s*h(our)?|5시간/i.test(nameStr);

    const isWeekly =
      windowStr === 'weekly' ||
      windowStr === 'week' ||
      /week(ly)?/i.test(windowStr) ||
      /weekly|week/i.test(idStr) ||
      /week(ly)?|주간/i.test(nameStr);

    if (is5h && !fiveHourBucket) {
      fiveHourBucket = b;
    } else if (isWeekly && !weeklyBucket) {
      weeklyBucket = b;
    }
  }

  const buildPool = (
    b: Record<string, unknown> | null,
    targetWindow: QuotaWindowType,
    defaultName: string
  ): GeminiQuotaPool | null => {
    if (!b) return null;

    const id = sanitizeSafeString(toSafeString(b.id ?? b.bucketId) || `gemini-${targetWindow}`);
    const name = sanitizeSafeString(toSafeString(b.name ?? b.displayName) || defaultName);
    const { usedPercent, remainingPercent, isAvailable } = parsePercentages(b);

    const rawReset = b.reset_time ?? b.resetTime ?? b.resets_at ?? b.resetsAt;
    const { resetTime, remainingDurationMs, remainingDurationText } = parseResetTimestamp(rawReset, referenceTimeMs);

    return {
      id,
      name,
      window: targetWindow,
      usedPercent,
      remainingPercent,
      resetTime,
      remainingDurationMs,
      remainingDurationText,
      isAvailable,
    };
  };

  const fiveHour = buildPool(fiveHourBucket, '5h', '5-Hour Limit Remaining');
  const weekly = buildPool(weeklyBucket, 'weekly', 'Weekly Limit Remaining');

  if (!fiveHour && !weekly) {
    return null;
  }

  return {
    fiveHour,
    weekly,
    description,
  };
}

/**
 * Searches for the Antigravity CLI executable (agy/agy.exe).
 * Safely handles Windows paths with Korean characters.
 */
export function findAntigravityCliExecutable(): string | null {
  if (process.env.GEMINI_QUOTA_DISABLE_CLI === '1') {
    return null;
  }

  // 1. Explicit environment overrides
  const envCandidates = [
    process.env.ANTIGRAVITY_BIN,
    process.env.AGY_BIN,
    process.env.GEMINI_CLI_BIN,
  ].filter((p): p is string => Boolean(p && typeof p === 'string' && p.trim().length > 0));

  for (const envPath of envCandidates) {
    try {
      if (fs.existsSync(envPath)) return envPath;
    } catch {
      // Ignore filesystem permission or path resolution errors
    }
  }

  // 2. Windows LocalAppData
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    try {
      const candidate = path.join(localAppData, 'agy', 'bin', 'agy.exe');
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore
    }
  }

  // 3. Server runtimes such as vinext may not forward USERPROFILE or
  // LOCALAPPDATA. Recover the Windows profile directory from the dashboard's
  // working directory without assuming an ASCII-only user name.
  if (process.platform === 'win32') {
    try {
      const cwd = process.cwd();
      const profileMatch = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/i);
      if (profileMatch) {
        const candidate = path.join(profileMatch[1], 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore runtimes that do not expose a native working directory
    }
  }

  // 4. User Home Directory (supports Korean characters e.g. C:\Users\김기원)
  try {
    const home = os.homedir();
    const homeCandidates = [
      path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
      path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy.exe'),
      path.join(home, 'bin', 'agy.exe'),
    ];
    for (const c of homeCandidates) {
      if (fs.existsSync(c)) return c;
    }
  } catch {
    // Ignore
  }

  // 5. System PATH search
  try {
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter);
    const exeNames = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];

    for (const dir of pathDirs) {
      if (!dir) continue;
      for (const name of exeNames) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) return full;
      }
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Discovers a local quota state file if one exists.
 */
export function getLocalQuotaFilePath(): string | null {
  const envFiles = [
    process.env.GEMINI_QUOTA_FILE,
    process.env.ANTIGRAVITY_QUOTA_FILE,
  ].filter((f): f is string => Boolean(f && typeof f === 'string' && f.trim().length > 0));

  for (const f of envFiles) {
    try {
      if (fs.existsSync(f)) return f;
    } catch {
      // Ignore
    }
  }

  try {
    const home = os.homedir();
    const candidateFiles = [
      path.join(home, '.gemini', 'antigravity-cli', 'cache', 'quota.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'cache', 'quota_summary.json'),
      path.join(home, '.gemini', 'antigravity-cli', 'cache', 'user_quota_summary.json'),
    ];

    for (const c of candidateFiles) {
      if (fs.existsSync(c)) return c;
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Spawns the CLI process with strict timeout and read-only execution.
 */
function executeCliQuota(
  cliPath: string,
  timeoutMs: number
): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        cliPath,
        ['--output-format', 'json', '--print', '/quota'],
        {
          timeout: timeoutMs,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
        (err, stdout) => {
          if (err) {
            const isTimeout = (err as { code?: string; killed?: boolean }).killed || err.message?.includes('timed out');
            resolve({
              stdout: stdout || '',
              error: isTimeout ? '요청 시간이 초과되었습니다.' : 'CLI 실행 실패',
            });
            return;
          }
          resolve({ stdout: stdout || '' });
        }
      );
    } catch {
      resolve({ stdout: '', error: 'CLI 프로세스를 시작할 수 없습니다.' });
    }
  });
}

export interface GetGeminiQuotaOptions {
  bypassCache?: boolean;
  referenceTimeMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

/**
 * Primary server-only entry point to read and normalize Gemini quota.
 * Guarantees bounded cache, strict timeout, and sanitized failure safety.
 */
export async function getGeminiQuota(options: GetGeminiQuotaOptions = {}): Promise<GeminiQuotaResponse> {
  const now = options.referenceTimeMs ?? Date.now();
  const cacheTtlMs = Math.max(5000, Math.min(60000, options.cacheTtlMs ?? (process.env.GEMINI_QUOTA_CACHE_TTL_MS ? parseInt(process.env.GEMINI_QUOTA_CACHE_TTL_MS, 10) : 20000)));
  const timeoutMs = Math.max(1000, Math.min(30000, options.timeoutMs ?? (process.env.GEMINI_QUOTA_TIMEOUT_MS ? parseInt(process.env.GEMINI_QUOTA_TIMEOUT_MS, 10) : 10000)));

  if (options.bypassCache) {
    memoryCache = null;
    inflightPromise = null;
  }

  // Return cached result if fresh and not bypassed
  if (!options.bypassCache && memoryCache && now < memoryCache.expiresAtMs) {
    return {
      ...memoryCache.response,
      cached: true,
    };
  }

  // Coalesce concurrent in-flight requests (Singleflight pattern)
  if (inflightPromise) {
    return inflightPromise;
  }

  const executeFetch = async (): Promise<GeminiQuotaResponse> => {
    try {
      let rawData: unknown = null;

      // 1. Direct environment mock / raw injection (for deterministic tests)
      if (process.env.GEMINI_QUOTA_RAW_DATA) {
        rawData = process.env.GEMINI_QUOTA_RAW_DATA;
      }

      // 2. Local quota file read
      if (!rawData) {
        const filePath = getLocalQuotaFilePath();
        if (filePath) {
          try {
            rawData = await fs.promises.readFile(filePath, 'utf8');
          } catch {
            // Ignore file read collision or missing file
          }
        }
      }

      // 3. Official CLI execution
      if (!rawData) {
        const cliPath = findAntigravityCliExecutable();
        if (cliPath) {
          const cliResult = await executeCliQuota(cliPath, timeoutMs);
          if (cliResult.stdout) {
            rawData = cliResult.stdout;
          } else if (cliResult.error) {
            const errResponse: GeminiQuotaResponse = {
              ok: false,
              status: 'unavailable',
              quota: null,
              lastSyncedAt: new Date(now).toISOString(),
              message: cliResult.error,
            };
            memoryCache = { response: errResponse, expiresAtMs: now + 5000 };
            return errResponse;
          }
        }
      }

      if (!rawData) {
        const unavailableResponse: GeminiQuotaResponse = {
          ok: false,
          status: 'unavailable',
          quota: null,
          lastSyncedAt: new Date(now).toISOString(),
          message: 'Gemini 쿼터 상태를 확인할 수 없습니다.',
        };
        memoryCache = { response: unavailableResponse, expiresAtMs: now + 5000 };
        return unavailableResponse;
      }

      const snapshot = normalizeQuotaData(rawData, now);
      if (!snapshot || (!snapshot.fiveHour && !snapshot.weekly)) {
        const unavailableResponse: GeminiQuotaResponse = {
          ok: false,
          status: 'unavailable',
          quota: null,
          lastSyncedAt: new Date(now).toISOString(),
          message: '확인 가능한 쿼터 풀이 없습니다.',
        };
        memoryCache = { response: unavailableResponse, expiresAtMs: now + 5000 };
        return unavailableResponse;
      }

      const hasAvailablePool = Boolean(
        (snapshot.fiveHour && snapshot.fiveHour.isAvailable) ||
        (snapshot.weekly && snapshot.weekly.isAvailable)
      );

      const successResponse: GeminiQuotaResponse = {
        ok: true,
        status: hasAvailablePool ? 'available' : 'unavailable',
        quota: snapshot,
        lastSyncedAt: new Date(now).toISOString(),
      };

      memoryCache = { response: successResponse, expiresAtMs: now + cacheTtlMs };
      return successResponse;
    } catch {
      const fallbackResponse: GeminiQuotaResponse = {
        ok: false,
        status: 'error',
        quota: null,
        lastSyncedAt: new Date(now).toISOString(),
        message: 'Gemini 쿼터 정보를 불러오는 중 오류가 발생했습니다.',
      };
      memoryCache = { response: fallbackResponse, expiresAtMs: now + 5000 };
      return fallbackResponse;
    } finally {
      inflightPromise = null;
    }
  };

  const currentPromise = executeFetch();
  inflightPromise = currentPromise;
  return currentPromise;
}

