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

export interface CodexUsageResponse {
  ok: boolean;
  status: 'active' | 'empty' | 'not_found' | 'error';
  codexDaily: CodexDailyEntry[];
  data: CodexDailyEntry[];
  lastSyncedAt: string;
  sessionCount: number;
  message?: string;
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

interface CacheEntry {
  mtimeMs: number;
  size: number;
  record: ParsedUsageRecord | null;
}

// In-memory cache based on file mtime and size to avoid re-reading large JSONL files
const fileUsageCache = new Map<string, CacheEntry>();

/**
 * Returns the resolved path to the Codex sessions directory.
 */
export function getCodexSessionsDirectory(): string {
  const envDir = process.env.CODEX_SESSIONS_DIR;
  if (envDir && fs.existsSync(envDir)) {
    return envDir;
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
 * Reads the latest token_usage_record from the tail of a JSONL file.
 * Uses stepped chunk scanning (64KB -> 256KB -> 1MB -> 2MB) and in-memory mtime/size caching.
 * NEVER loads the full 10MB+ file or accesses authentication/conversation fields.
 */
function readLatestUsageFromFile(filePath: string): ParsedUsageRecord | null {
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
    return cached.record;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    // If file is locked or being written, skip gracefully
    return null;
  }

  let foundRecord: ParsedUsageRecord | null = null;

  try {
    const chunkSizes = [64 * 1024, 256 * 1024, 1024 * 1024, 2 * 1024 * 1024];
    for (const chunkSize of chunkSizes) {
      const readSize = Math.min(stat.size, chunkSize);
      const buffer = Buffer.alloc(readSize);
      const position = stat.size - readSize;

      fs.readSync(fd, buffer, 0, readSize, position);
      const text = buffer.toString('utf-8');
      const lines = text.split('\n');

      // If we didn't start at position 0, lines[0] is likely a partially read line
      const startIndex = position === 0 ? 0 : 1;

      for (let i = lines.length - 1; i >= startIndex; i--) {
        const line = lines[i].trim();
        if (!line || !line.includes('token_usage_record')) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            ordinal?: number;
            payload?: {
              session_id?: string;
              thread_id?: string;
              thread_token_usage?: {
                total_tokens?: number;
                cached_input_tokens?: number;
                input_tokens?: number;
                output_tokens?: number;
                reasoning_output_tokens?: number;
              };
            };
          };

          if (parsed.type === 'token_usage_record' && parsed.payload?.thread_token_usage) {
            const usage = parsed.payload.thread_token_usage;
            const sessionId =
              parsed.payload.session_id ||
              parsed.payload.thread_id ||
              extractFallbackSessionId(filePath);

            foundRecord = {
              sessionId,
              timestamp: parsed.timestamp || new Date(stat.mtimeMs).toISOString(),
              ordinal: parsed.ordinal ?? 0,
              totalTokens: Math.max(0, usage.total_tokens || 0),
              cachedInputTokens: Math.max(0, usage.cached_input_tokens || 0),
              inputTokens: Math.max(0, usage.input_tokens || 0),
              outputTokens: Math.max(0, usage.output_tokens || 0),
              reasoningOutputTokens: Math.max(0, usage.reasoning_output_tokens || 0),
              fileMtimeMs: stat.mtimeMs,
            };
            break;
          }
        } catch {
          // Skip corrupt or actively written JSON lines
        }
      }

      if (foundRecord || position === 0) {
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

  // Update memory cache
  fileUsageCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    record: foundRecord,
  });

  return foundRecord;
}

/**
 * Gathers and computes Codex daily usage from ~/.codex/sessions.
 * Strictly guarantees:
 * 1. Exactly 1 latest cumulative thread_token_usage record per session (never double counts same session).
 * 2. Sums across multiple distinct sessions on each date.
 * 3. activeTokens = Math.max(0, totalTokens - cachedInputTokens).
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
      };
    }

    // Map: date -> Map<sessionId, ParsedUsageRecord>
    const sessionsByDate = new Map<string, Map<string, ParsedUsageRecord>>();
    let totalUniqueSessions = 0;

    for (const filePath of files) {
      const date = extractDateFromPath(filePath);
      if (!date) {
        continue;
      }

      const record = readLatestUsageFromFile(filePath);
      if (!record) {
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
        totalUniqueSessions++;
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

    return {
      ok: true,
      status: codexDaily.length > 0 ? 'active' : 'empty',
      codexDaily,
      data: codexDaily,
      lastSyncedAt: new Date().toISOString(),
      sessionCount: sessionsByDate.size,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 'error',
      message: `Failed to read Codex usage: ${errorMsg}`,
      codexDaily: [],
      data: [],
      lastSyncedAt: new Date().toISOString(),
      sessionCount: 0,
    };
  }
}
