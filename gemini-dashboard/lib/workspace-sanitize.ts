import type {
  LiveWorkerData,
  LiveWorkerLog,
  LiveWorkerVerificationCommand,
} from './workspace-contract.ts';

// Regex patterns for detecting and redacting sensitive data
const API_KEY_REGEX = /AIza[0-9A-Za-z-_]{35}/g;
const OPENAI_KEY_REGEX = /sk-[0-9A-Za-z-_]{20,}/g;
const BEARER_TOKEN_REGEX = /Bearer\s+([A-Za-z0-9._~+/-]+=*)/gi;
const CLI_FLAG_KEY_REGEX = /--(api-key|key|token|password|auth-token)(?:=|\s+)([^\s"']+)/gi;
const ENV_SECRET_REGEX = /\b[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*([^\s"']+)/gi;
const USER_DIR_REGEX = /(?:[A-Za-z]:)?[/\\]Users[/\\][^/\\\s"']+[/\\]/gi;
const HOME_DIR_REGEX = /\/(?:home|Users)\/[^/\s"']+\//g;

/**
 * Normalizes Windows and POSIX separators to forward slash.
 */
function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Converts absolute repository paths into clean, safe relative paths.
 * Also neutralizes path traversal characters and redacts absolute home directories.
 */
export function sanitizePath(filePath?: string | null, repoRoot?: string): string {
  if (!filePath) return '';
  let normalized = normalizeSlashes(filePath.trim());

  if (repoRoot) {
    const normRoot = normalizeSlashes(repoRoot).replace(/\/+$/, '');
    if (normalized.toLowerCase().startsWith(normRoot.toLowerCase())) {
      normalized = normalized.slice(normRoot.length);
    }
  }

  // Redact home directories
  normalized = normalized.replace(USER_DIR_REGEX, '~/');
  normalized = normalized.replace(HOME_DIR_REGEX, '~/');

  // Strip drive letters if remaining (e.g. C:/)
  normalized = normalized.replace(/^[A-Za-z]:\/+/, '');

  // Strip leading slashes
  normalized = normalized.replace(/^\/+/, '');

  // Neutralize path traversal
  normalized = normalized.replace(/\.\.\//g, '');
  normalized = normalized.replace(/\/\.\./g, '');

  return normalized;
}

/**
 * Redacts secrets, sensitive environment flags, and raw paths from CLI commands.
 */
export function sanitizeCommand(cmd?: string | null, repoRoot?: string): string {
  if (!cmd) return '';
  let sanitized = normalizeSlashes(cmd.trim());

  // Redact flags like --api-key <secret>
  sanitized = sanitized.replace(CLI_FLAG_KEY_REGEX, '--$1 [REDACTED]');

  // Redact environment variable secrets like KEY=...
  sanitized = sanitized.replace(ENV_SECRET_REGEX, '$1=[REDACTED]');

  // Redact bearer tokens
  sanitized = sanitized.replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]');

  // Redact specific key patterns
  sanitized = sanitized.replace(API_KEY_REGEX, '[API_KEY_REDACTED]');
  sanitized = sanitized.replace(OPENAI_KEY_REGEX, '[TOKEN_REDACTED]');

  // Normalize absolute paths to executables (e.g. C:/Program Files/nodejs/npm.cmd -> npm)
  sanitized = sanitized.replace(/(?:[A-Za-z]:)?\/[^"'\n\r]+\/(npm|node|git|powershell|pwsh)(?:\.(?:cmd|exe))?(?=\s|$)/gi, '$1');

  // Strip repo root from arguments if present
  if (repoRoot) {
    const normRoot = normalizeSlashes(repoRoot).replace(/\/+$/, '');
    sanitized = sanitized.split(normRoot).join('.');
  }

  // Redact home directories
  sanitized = sanitized.replace(USER_DIR_REGEX, '~/');
  sanitized = sanitized.replace(HOME_DIR_REGEX, '~/');

  return sanitized;
}

/**
 * Sanitizes arbitrary text (logs, errors, markdown) removing secrets and absolute paths.
 */
export function sanitizeText(text?: string | null, repoRoot?: string): string {
  if (!text) return '';
  let sanitized = normalizeSlashes(text);

  // Redact secrets
  sanitized = sanitized.replace(API_KEY_REGEX, '[API_KEY_REDACTED]');
  sanitized = sanitized.replace(OPENAI_KEY_REGEX, '[TOKEN_REDACTED]');
  sanitized = sanitized.replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(CLI_FLAG_KEY_REGEX, '--$1 [REDACTED]');
  sanitized = sanitized.replace(ENV_SECRET_REGEX, '$1=[REDACTED]');

  // Strip repoRoot paths
  if (repoRoot) {
    const normRoot = normalizeSlashes(repoRoot).replace(/\/+$/, '');
    sanitized = sanitized.split(normRoot).join('.');
  }

  // Redact home/user paths
  sanitized = sanitized.replace(USER_DIR_REGEX, '~/');
  sanitized = sanitized.replace(HOME_DIR_REGEX, '~/');

  return sanitized;
}

/**
 * Sanitizes a single worker log event.
 */
export function sanitizeWorkerLog(
  log: LiveWorkerLog | string,
  repoRoot?: string
): LiveWorkerLog {
  if (typeof log === 'string') {
    return {
      timestamp: new Date().toLocaleTimeString('ko-KR', { hour12: false }),
      message: sanitizeText(log, repoRoot),
      type: 'log',
    };
  }

  return {
    timestamp: log.timestamp || '',
    message: sanitizeText(log.message, repoRoot),
    type: log.type || 'step',
  };
}

/**
 * Sanitizes an entire LiveWorkerData structure.
 * Ensures no secrets, absolute paths, or raw shell lines escape into API responses or UI.
 */
export function sanitizeWorkerData(
  worker: LiveWorkerData,
  repoRoot?: string
): LiveWorkerData {
  const sanitizedLogs = (worker.recentLogs || []).map(log =>
    sanitizeWorkerLog(log, repoRoot)
  );

  const sanitizedChangedFiles = (worker.changedFiles || []).map(f =>
    sanitizePath(f, repoRoot)
  );

  let sanitizedVerification = worker.verification;
  if (worker.verification?.commands) {
    sanitizedVerification = {
      ...worker.verification,
      commands: worker.verification.commands.map(
        (cmd): LiveWorkerVerificationCommand => ({
          ...cmd,
          command: sanitizeCommand(cmd.command, repoRoot),
          output: cmd.output ? sanitizeText(cmd.output, repoRoot) : undefined,
        })
      ),
    };
  }

  let sanitizedPolicy = worker.policy;
  if (worker.policy) {
    sanitizedPolicy = {
      ...worker.policy,
      allowedFiles: worker.policy.allowedFiles?.map(f => sanitizePath(f, repoRoot)),
      violations: worker.policy.violations?.map(f => sanitizePath(f, repoRoot)),
    };
  }

  return {
    ...worker,
    task: sanitizeText(worker.task, repoRoot),
    recentLogs: sanitizedLogs,
    changedFiles: sanitizedChangedFiles,
    verification: sanitizedVerification,
    policy: sanitizedPolicy,
    finalResponse: worker.finalResponse
      ? sanitizeText(worker.finalResponse, repoRoot)
      : null,
    error: worker.error ? sanitizeText(worker.error, repoRoot) : null,
  };
}