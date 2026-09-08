import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexDailyEntry {
  date: string;
  totalTokens: number;
  cachedInputTokens: number;
  activeTokens: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexRateLimitWindow {
  used_percent: number | null;
  remaining_percent: number | null;
  window_minutes: number | null;
  resets_at: number | string | null;
}

export interface CodexRateLimitCredits {
  balance: string | number | null;
  has_credits: boolean | null;
  unlimited: boolean | null;
}

export interface CodexRateLimitsSnapshot {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexRateLimitCredits | null;
  plan_type: string | null;
}

export interface CodexUsageResponse {
  ok: boolean;
  status: 'active' | 'empty' | 'not_found' | 'error';
  codexDaily: CodexDailyEntry[];
  data: CodexDailyEntry[];
  lastSyncedAt: string;
  sessionCount: number;
  message?: string;
  rate_limits: CodexRateLimitsSnapshot | null;
  rateLimits: CodexRateLimitsSnapshot | null;
}

interface ParsedUsageRecord {
  sessionId: string;
  timestamp: string;
  ordinal: number;
  totalTokens: number;
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  fileMtimeMs: number;
}

interface RateLimitCandidate {
  snapshot: CodexRateLimitsSnapshot;
  effectiveTimeMs: number;
  hasValidTimestamp: boolean;
  timestampStr?: string;
  fileMtimeMs: number;
  filePath: string;
  ordinal: number;
  lineIndex: number;
}

interface FileReadResult {
  usageRecord: ParsedUsageRecord | null;
  rateLimitsCandidate: RateLimitCandidate | null;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: FileReadResult;
}

// In-memory cache based on file mtime and size to avoid re-reading large JSONL files
const fileUsageCache = new Map<string, CacheEntry>();

/**
 * Clears the in-memory usage cache (useful for tests and forced reload).
 */
export function clearCodexUsageCache(): void {
  fileUsageCache.clear();
}

/**
 * Returns the resolved path to the Codex sessions directory.
 */
export function getCodexSessionsDirectory(): string {
  if (process.env.CODEX_SESSIONS_DIR) {
    return process.env.CODEX_SESSIONS_DIR;
  }
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

/**
 * Recursively discovers all .jsonl files under the target directory safely.
 */
function findJsonlFiles(dir: string, fileList: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findJsonlFiles(fullPath, fileList);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        fileList.push(fullPath);
      }
    }
  } catch {
    // Ignore unreadable or locked directories
  }
  return fileList;
}

/**
 * Extracts a date string 'YYYY-MM-DD' from the directory hierarchy or filename.
 */
function extractDateFromPath(filePath: string): string | null {
  // Try matching directory structure: YYYY/MM/DD or YYYY\MM\DD
  const dirMatch = filePath.match(/(\d{4})[/\\](\d{2})[/\\](\d{2})/);
  if (dirMatch) {
    return `${dirMatch[1]}-${dirMatch[2]}-${dirMatch[3]}`;
  }

  // Try matching filename format: rollout-YYYY-MM-DD...
  const fileMatch = filePath.match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
  if (fileMatch) {
    return `${fileMatch[1]}-${fileMatch[2]}-${fileMatch[3]}`;
  }

  return null;
}

/**
 * Extracts fallback session ID from filename (e.g. rollout-2026-09-08T...-<uuid>[_<split>].jsonl).
 */
function extractFallbackSessionId(filePath: string): string {
  const baseName = path.basename(filePath, '.jsonl');
  const match = baseName.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  if (match) {
    return match[1];
  }
  return baseName;
}

/**
 * Parses a rate limit window (primary or secondary).
 * Explicitly returns nullable numbers for used_percent, remaining_percent, window_minutes, resets_at.
 * Normalizes both used_percent and remaining_percent within [0, 100].
 */
function parseRateLimitWindow(raw: unknown): CodexRateLimitWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  let used_percent: number | null = null;
  let remaining_percent: number | null = null;

  if (typeof obj.used_percent === 'number' && Number.isFinite(obj.used_percent)) {
    const clampedUsed = Math.max(0, Math.min(100, obj.used_percent));
    used_percent = Math.round(clampedUsed * 1e6) / 1e6;
    remaining_percent = Math.round((100 - used_percent) * 1e6) / 1e6;
  }

  let window_minutes: number | null = null;
  if (typeof obj.window_minutes === 'number' && Number.isFinite(obj.window_minutes)) {
    window_minutes = obj.window_minutes;
  }

  let resets_at: number | string | null = null;
  if (typeof obj.resets_at === 'number' && Number.isFinite(obj.resets_at)) {
    resets_at = obj.resets_at;
  } else if (typeof obj.resets_at === 'string' && obj.resets_at.trim().length > 0) {
    resets_at = obj.resets_at.trim();
  }

  return {
    used_percent,
    remaining_percent,
    window_minutes,
    resets_at,
  };
}

/**
 * Parses credits information if provided, normalizing missing/mistyped fields to null.
 */
function parseCredits(raw: unknown): CodexRateLimitCredits | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  let balance: string | number | null = null;
  if (typeof obj.balance === 'string' && obj.balance.trim().length > 0) {
    balance = obj.balance.trim();
  } else if (typeof obj.balance === 'number' && Number.isFinite(obj.balance)) {
    balance = obj.balance;
  }

  const has_credits = typeof obj.has_credits === 'boolean' ? obj.has_credits : null;
  const unlimited = typeof obj.unlimited === 'boolean' ? obj.unlimited : null;

  return {
    balance,
    has_credits,
    unlimited,
  };
}

/**
 * Parses plan_type string, normalizing missing/mistyped values to null.
 */
function parsePlanType(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

/**
 * Parses rate_limits payload from a token_usage_record event into a candidate snapshot.
 * Candidate is considered valid if at least one recognizable section/field is present.
 */
function parseRateLimitsSnapshot(
  rawRateLimits: unknown,
  timestampStr: string | undefined,
  fileMtimeMs: number,
  filePath: string,
  ordinal: number,
  lineIndex: number
): RateLimitCandidate | null {
  if (!rawRateLimits || typeof rawRateLimits !== 'object' || Array.isArray(rawRateLimits)) {
    return null;
  }
  const raw = rawRateLimits as Record<string, unknown>;

  const primary = parseRateLimitWindow(raw.primary);
  const secondary = parseRateLimitWindow(raw.secondary);
  const credits = parseCredits(raw.credits);
  const plan_type = parsePlanType(raw.plan_type);

  // Must contain at least one valid section
  if (!primary && !secondary && !credits && !plan_type) {
    return null;
  }

  let effectiveTimeMs = fileMtimeMs;
  let hasValidTimestamp = false;
  if (typeof timestampStr === 'string' && timestampStr.trim().length > 0) {
    const parsedTime = Date.parse(timestampStr);
    if (!Number.isNaN(parsedTime) && Number.isFinite(parsedTime)) {
      effectiveTimeMs = parsedTime;
      hasValidTimestamp = true;
    }
  }

  return {
    snapshot: {
      primary,
      secondary,
      credits,
      plan_type,
    },
    effectiveTimeMs,
    hasValidTimestamp,
    timestampStr,
    fileMtimeMs,
    filePath,
    ordinal,
    lineIndex,
  };
}

/**
 * Determines whether candidate is newer than current snapshot.
 * Prioritizes valid event timestamp; falls back to file mtime when timestamp is absent/invalid.
 * Same-time choices are strictly deterministic.
 */
function isCandidateNewer(candidate: RateLimitCandidate, current: RateLimitCandidate): boolean {
  // 1. Compare effective time (event timestamp if valid, else file mtime)
  if (candidate.effectiveTimeMs > current.effectiveTimeMs) {
    return true;
  }
  if (candidate.effectiveTimeMs < current.effectiveTimeMs) {
    return false;
  }

  // 2. Same effective time: prefer candidate with valid event timestamp over mtime fallback
  if (candidate.hasValidTimestamp && !current.hasValidTimestamp) {
    return true;
  }
  if (!candidate.hasValidTimestamp && current.hasValidTimestamp) {
    return false;
  }

  // 3. Compare ordinal
  if (candidate.ordinal > current.ordinal) {
    return true;
  }
  if (candidate.ordinal < current.ordinal) {
    return false;
  }

  // 4. Same file tie-breaker: later line in file wins
  if (candidate.filePath === current.filePath) {
    return candidate.lineIndex > current.lineIndex;
  }

  // 5. Cross-file deterministic tie-breaker
  return candidate.filePath.localeCompare(current.filePath) > 0;
}

/**
 * Reads the latest token_usage_record from the tail of a JSONL file.
 * Checks ONLY token_usage_record candidates and extracts thread_token_usage and rate_limits.
 * Never loads full file into memory and never logs/preserves sensitive conversation/auth fields.
 */
function readLatestFromFile(filePath: string): FileReadResult | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  if (stat.size === 0) {
    return null;
  }

  // Check cache
  const cached = fileUsageCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  let foundRecord: ParsedUsageRecord | null = null;
  let foundRateLimits: RateLimitCandidate | null = null;

  try {
    const chunkSizes = [64 * 1024, 256 * 1024, 1024 * 1024, 2 * 1024 * 1024];
    for (const chunkSize of chunkSizes) {
      const readSize = Math.min(stat.size, chunkSize);
      const buffer = Buffer.alloc(readSize);
      const position = stat.size - readSize;

      fs.readSync(fd, buffer, 0, readSize, position);
      const text = buffer.toString('utf-8');
      const lines = text.split('\n');

      const startIndex = position === 0 ? 0 : 1;

      for (let i = lines.length - 1; i >= startIndex; i--) {
        const line = lines[i].trim();
        // Accept the legacy normalized record and Codex CLI's actual event_msg/token_count shape.
        if (!line || (!line.includes('token_usage_record') && !line.includes('token_count'))) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as {
            type?: unknown;
            timestamp?: unknown;
            ordinal?: unknown;
            payload?: {
              type?: unknown;
              session_id?: unknown;
              thread_id?: unknown;
              thread_token_usage?: {
                total_tokens?: unknown;
                cached_input_tokens?: unknown;
                input_tokens?: unknown;
                output_tokens?: unknown;
                reasoning_output_tokens?: unknown;
              };
              info?: {
                total_token_usage?: {
                  total_tokens?: unknown;
                  cached_input_tokens?: unknown;
                  input_tokens?: unknown;
                  output_tokens?: unknown;
                  reasoning_output_tokens?: unknown;
                };
              };
              rate_limits?: unknown;
            };
          };

          if (!parsed.payload || typeof parsed.payload !== 'object') {
            continue;
          }
          const isLegacyRecord = parsed.type === 'token_usage_record';
          const isCodexTokenEvent = parsed.type === 'event_msg' && parsed.payload.type === 'token_count';
          if (!isLegacyRecord && !isCodexTokenEvent) continue;

          const ordinal = typeof parsed.ordinal === 'number' && Number.isFinite(parsed.ordinal) ? parsed.ordinal : 0;
          const timestampStr = typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined;

          // 1. Thread token usage for daily aggregation
          const tokenUsage = isLegacyRecord
            ? parsed.payload.thread_token_usage
            : parsed.payload.info?.total_token_usage;
          if (!foundRecord && tokenUsage && typeof tokenUsage === 'object') {
            const usage = tokenUsage;
            const sessionId =
              (typeof parsed.payload.session_id === 'string' && parsed.payload.session_id) ||
              (typeof parsed.payload.thread_id === 'string' && parsed.payload.thread_id) ||
              extractFallbackSessionId(filePath);

            const totalTokens = typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens) ? Math.max(0, usage.total_tokens) : 0;
            const cachedInputTokens = typeof usage.cached_input_tokens === 'number' && Number.isFinite(usage.cached_input_tokens) ? Math.max(0, usage.cached_input_tokens) : 0;
            const inputTokens = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? Math.max(0, usage.input_tokens) : 0;
            const outputTokens = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? Math.max(0, usage.output_tokens) : 0;
            const reasoningOutputTokens = typeof usage.reasoning_output_tokens === 'number' && Number.isFinite(usage.reasoning_output_tokens) ? Math.max(0, usage.reasoning_output_tokens) : 0;

            foundRecord = {
              sessionId,
              timestamp: timestampStr || new Date(stat.mtimeMs).toISOString(),
              ordinal,
              totalTokens,
              cachedInputTokens,
              inputTokens,
              outputTokens,
              reasoningOutputTokens,
              fileMtimeMs: stat.mtimeMs,
            };
          }

          // 2. Rate limits snapshot
          if (parsed.payload.rate_limits && typeof parsed.payload.rate_limits === 'object' && !Array.isArray(parsed.payload.rate_limits)) {
            const candidate = parseRateLimitsSnapshot(
              parsed.payload.rate_limits,
              timestampStr,
              stat.mtimeMs,
              filePath,
              ordinal,
              i
            );
            if (candidate) {
              if (!foundRateLimits || isCandidateNewer(candidate, foundRateLimits)) {
                foundRateLimits = candidate;
              }
            }
          }
        } catch {
          // Skip corrupt or actively written JSON lines without exposing contents
        }
      }

      if ((foundRecord && foundRateLimits) || position === 0) {
        break;
      }
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }

  const result: FileReadResult = {
    usageRecord: foundRecord,
    rateLimitsCandidate: foundRateLimits,
  };

  fileUsageCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    result,
  });

  return result;
}

/**
 * Gathers and computes Codex daily usage and latest rate limits from ~/.codex/sessions.
 * Strictly guarantees:
 * 1. Exactly 1 latest cumulative thread_token_usage record per session.
 * 2. Sums across multiple distinct sessions on each date.
 * 3. Exactly 1 latest valid payload.rate_limits snapshot chosen deterministically.
 */
export function getCodexDailyUsage(): CodexUsageResponse {
  try {
    const sessionsDir = getCodexSessionsDirectory();

    if (!fs.existsSync(sessionsDir)) {
      return {
        ok: true,
        status: 'not_found',
        message: 'Codex sessions directory not found',
        codexDaily: [],
        data: [],
        lastSyncedAt: new Date().toISOString(),
        sessionCount: 0,
        rate_limits: null,
        rateLimits: null,
      };
    }

    const files = findJsonlFiles(sessionsDir);
    if (files.length === 0) {
      return {
        ok: true,
        status: 'empty',
        message: 'No Codex session files found',
        codexDaily: [],
        data: [],
        lastSyncedAt: new Date().toISOString(),
        sessionCount: 0,
        rate_limits: null,
        rateLimits: null,
      };
    }

    // Sort files deterministically
    const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));

    // Map: date -> Map<sessionId, ParsedUsageRecord>
    const sessionsByDate = new Map<string, Map<string, ParsedUsageRecord>>();
    let bestRateLimitCandidate: RateLimitCandidate | null = null;

    for (const filePath of sortedFiles) {
      const fileResult = readLatestFromFile(filePath);
      if (!fileResult) {
        continue;
      }

      // Check for latest rate limits candidate
      if (fileResult.rateLimitsCandidate) {
        if (!bestRateLimitCandidate || isCandidateNewer(fileResult.rateLimitsCandidate, bestRateLimitCandidate)) {
          bestRateLimitCandidate = fileResult.rateLimitsCandidate;
        }
      }

      // Check for daily token usage record
      const record = fileResult.usageRecord;
      if (!record) {
        continue;
      }

      const date = extractDateFromPath(filePath) || (record.timestamp ? record.timestamp.slice(0, 10) : null);
      if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
        continue;
      }

      if (!sessionsByDate.has(date)) {
        sessionsByDate.set(date, new Map());
      }
      const dateSessions = sessionsByDate.get(date)!;

      const existing = dateSessions.get(record.sessionId);
      if (!existing) {
        dateSessions.set(record.sessionId, record);
      } else {
        // Same session across multiple split rollout files: pick the later cumulative record
        const isNewer =
          record.ordinal > existing.ordinal ||
          record.totalTokens > existing.totalTokens ||
          record.timestamp > existing.timestamp ||
          record.fileMtimeMs > existing.fileMtimeMs;

        if (isNewer) {
          dateSessions.set(record.sessionId, record);
        }
      }
    }

    const codexDaily: CodexDailyEntry[] = [];

    for (const [date, sessionsMap] of sessionsByDate.entries()) {
      let dateTotalTokens = 0;
      let dateCachedInputTokens = 0;
      let dateInputTokens = 0;
      let dateOutputTokens = 0;
      let dateReasoningOutputTokens = 0;

      for (const usage of sessionsMap.values()) {
        dateTotalTokens += usage.totalTokens;
        dateCachedInputTokens += usage.cachedInputTokens;
        dateInputTokens += usage.inputTokens;
        dateOutputTokens += usage.outputTokens;
        dateReasoningOutputTokens += usage.reasoningOutputTokens;
      }

      const activeTokens = Math.max(0, dateTotalTokens - dateCachedInputTokens);

      codexDaily.push({
        date,
        totalTokens: dateTotalTokens,
        cachedInputTokens: dateCachedInputTokens,
        activeTokens,
        tokens: dateTotalTokens,
        inputTokens: dateInputTokens,
        outputTokens: dateOutputTokens,
        reasoningOutputTokens: dateReasoningOutputTokens,
      });
    }

    // Sort by date ascending
    codexDaily.sort((a, b) => a.date.localeCompare(b.date));

    const rateLimits = bestRateLimitCandidate ? bestRateLimitCandidate.snapshot : null;
    const sessionCount = [...sessionsByDate.values()].reduce((count, sessions) => count + sessions.size, 0);

    return {
      ok: true,
      status: codexDaily.length > 0 ? 'active' : 'empty',
      codexDaily,
      data: codexDaily,
      lastSyncedAt: new Date().toISOString(),
      sessionCount,
      rate_limits: rateLimits,
      rateLimits,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      ok: false,
      status: 'error',
      message: `Failed to read Codex usage: ${errorMsg}`,
      codexDaily: [],
      data: [],
      lastSyncedAt: new Date().toISOString(),
      sessionCount: 0,
      rate_limits: null,
      rateLimits: null,
    };
  }
}
