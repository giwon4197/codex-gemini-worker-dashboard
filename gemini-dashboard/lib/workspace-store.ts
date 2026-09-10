import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import crypto from 'node:crypto';
import type {
  CompactRunState,
  RunDetail,
  LiveWorkerData,
  TaskProgressSummary,
  RunAliasRecord,
  ConversationSession,
  ConversationApproval,
  LaunchMetadata,
  ProjectWorkGraphData,
  LiveWorkerVerificationCommand,
  DeliveryInfo,
  DeliveryStage,
  DeliveryFailureCategory,
  RunStatus,
} from './workspace-contract.ts';
import {
  normalizeRunStatus,
  normalizeWorkerStatus,
  isWorkerActive,
  isRunActive,
  requiresUserAction,
  getUserActionReason,
  extractTimelineEvents,
  validateSessionId,
  isLauncherError,
  evaluateRunRetrySafety,
  classifyDeliveryFailureCategory,
  getDeliveryActionGuidance,
  getDeliveryFailureDisplayName,
// @ts-expect-error TS5097 allowed for test runner
} from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { buildProjectWorkGraph } from './project-event-graph.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeText, sanitizePath, sanitizeWorkerData, sanitizeGraphData } from './workspace-sanitize.ts';
// @ts-expect-error TS5097 allowed for test runner
import { evaluateRunLiveness, isProcessAlive, STALE_PROCESS_MISMATCH_REASON } from './process-liveness.ts';
import type { LivenessOptions } from './process-liveness.ts';

export { STALE_PROCESS_MISMATCH_REASON };
export type { LivenessOptions, LaunchMetadata };

export interface IdempotencyRecord {
  idempotencyKey: string;
  runId: string;
  prompt: string;
  createdAt: string;
  status: string;
}

export type SpawnerFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => { unref?: () => void; pid?: number };

export interface ResolvedTools {
  pwsh: string;
  codex: string;
  rg: string;
  agy: string;
  augmentedPath: string;
}

export interface ToolResolutionResult {
  ok: boolean;
  tools?: ResolvedTools;
  missing?: string[];
  error?: string;
}

export interface ToolResolutionOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  overrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
}

/**
 * Safely discovers PowerShell 7 (pwsh) and essential tools (codex.exe, rg.exe, agy.exe).
 * Enforces safe exploration:
 * - Never executes shell strings or arbitrary child processes during exploration.
 * - Searches caller overrides, environment variables, PATH, and known installation/cache locations.
 * - Resolves PowerShell 7 (pwsh) to avoid Windows PowerShell legacy encoding issues (mojibake) with Korean paths.
 * - Prepares augmented PATH containing discovered tool directories.
 */
export function resolveRequiredTools(options?: ToolResolutionOptions): ToolResolutionResult {
  const currentPlatform = options?.platform || process.platform;
  const isWin = currentPlatform === 'win32';
  const env = options?.env || process.env;
  const overrides = options?.overrides || {};

  const localAppData = env.LOCALAPPDATA || '';
  const userProfile = env.USERPROFILE || env.HOME || '';

  const testFile = (filePath: string | undefined): boolean => {
    if (!filePath) return false;
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  };

  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);

  const searchInPath = (names: string[]): string | null => {
    for (const dir of pathDirs) {
      for (const name of names) {
        const full = path.join(dir, name);
        if (testFile(full)) return full;
      }
    }
    return null;
  };

  const findPwsh = (): string | null => {
    if (testFile(overrides.pwsh)) return overrides.pwsh!;
    const envVar = env.PWSH_PATH || env.POWERSHELL_PATH;
    if (testFile(envVar)) return envVar!;

    const pathFound = searchInPath(isWin ? ['pwsh.exe', 'pwsh'] : ['pwsh']);
    if (pathFound) return pathFound;

    if (isWin) {
      const candidates = [
        path.join(localAppData, 'Microsoft', 'PowerShell', 'pwsh.exe'),
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
        'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
        path.join(userProfile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
      ];
      for (const c of candidates) {
        if (testFile(c)) return c;
      }
      const runtimesDir = path.join(userProfile, '.cache', 'codex-runtimes');
      if (fs.existsSync(runtimesDir)) {
        try {
          const checkSub = path.join(runtimesDir, 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
          if (testFile(checkSub)) return checkSub;
        } catch {
          // Ignore
        }
      }
    } else {
      for (const u of ['/usr/local/bin/pwsh', '/usr/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']) {
        if (testFile(u)) return u;
      }
    }
    return null;
  };

  const findCodex = (): string | null => {
    if (testFile(overrides.codex)) return overrides.codex!;
    const envVar = env.CODEX_PATH;
    if (testFile(envVar)) return envVar!;

    const pathFound = searchInPath(isWin ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']);
    if (pathFound) return pathFound;

    if (isWin) {
      const codexBinDir = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
      if (fs.existsSync(codexBinDir)) {
        try {
          for (const sub of fs.readdirSync(codexBinDir)) {
            const p = path.join(codexBinDir, sub, 'codex.exe');
            if (testFile(p)) return p;
          }
        } catch {
          // Ignore
        }
      }
      const p2 = path.join(localAppData, 'Programs', 'Codex', 'codex.exe');
      if (testFile(p2)) return p2;
    } else {
      const u = path.join(userProfile, '.local', 'bin', 'codex');
      if (testFile(u)) return u;
      for (const p of ['/usr/local/bin/codex', '/usr/bin/codex']) {
        if (testFile(p)) return p;
      }
    }
    return null;
  };

  const findRg = (): string | null => {
    if (testFile(overrides.rg)) return overrides.rg!;
    const envVar = env.RG_PATH || env.RIPGREP_PATH;
    if (testFile(envVar)) return envVar!;

    const pathFound = searchInPath(isWin ? ['rg.exe', 'rg'] : ['rg']);
    if (pathFound) return pathFound;

    if (isWin) {
      const codexBinDir = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
      if (fs.existsSync(codexBinDir)) {
        try {
          for (const sub of fs.readdirSync(codexBinDir)) {
            const p = path.join(codexBinDir, sub, 'rg.exe');
            if (testFile(p)) return p;
          }
        } catch {
          // Ignore
        }
      }
      const p2 = 'C:\\Program Files\\ripgrep\\rg.exe';
      if (testFile(p2)) return p2;
    } else {
      for (const p of ['/usr/local/bin/rg', '/usr/bin/rg']) {
        if (testFile(p)) return p;
      }
    }
    return null;
  };

  const findAgy = (): string | null => {
    if (testFile(overrides.agy)) return overrides.agy!;
    const envVar = env.AGY_PATH;
    if (testFile(envVar)) return envVar!;

    const pathFound = searchInPath(isWin ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy']);
    if (pathFound) return pathFound;

    if (isWin) {
      const candidates = [
        path.join(localAppData, 'agy', 'bin', 'agy.exe'),
        path.join(localAppData, 'Programs', 'agy', 'agy.exe'),
        path.join(userProfile, '.gemini', 'antigravity-cli', 'bin', 'agy.exe'),
      ];
      for (const c of candidates) {
        if (testFile(c)) return c;
      }
    } else {
      const u = path.join(userProfile, '.local', 'bin', 'agy');
      if (testFile(u)) return u;
      for (const p of ['/usr/local/bin/agy', '/usr/bin/agy']) {
        if (testFile(p)) return p;
      }
    }
    return null;
  };

  const pwsh = findPwsh();
  const codex = findCodex();
  const rg = findRg();
  const agy = findAgy();

  const missing: string[] = [];
  if (!pwsh) missing.push('pwsh (PowerShell 7)');
  if (!codex) missing.push('codex.exe');
  if (!rg) missing.push('rg.exe');
  if (!agy) missing.push('agy.exe');

  if (missing.length > 0 || !pwsh || !codex || !rg || !agy) {
    return {
      ok: false,
      missing,
      error: `필수 실행 도구를 찾을 수 없습니다: ${missing.join(', ')}`,
    };
  }

  const toolDirs = Array.from(new Set([
    path.dirname(pwsh),
    path.dirname(codex),
    path.dirname(rg),
    path.dirname(agy),
  ]));

  const seen = new Set<string>();
  const finalDirs: string[] = [];
  for (const d of [...toolDirs, ...pathDirs]) {
    const key = isWin ? d.toLowerCase() : d;
    if (!seen.has(key)) {
      seen.add(key);
      finalDirs.push(d);
    }
  }

  return {
    ok: true,
    tools: {
      pwsh,
      codex,
      rg,
      agy,
      augmentedPath: finalDirs.join(path.delimiter),
    },
  };
}

/**
 * Resolves the currently allowed repository root.
 * Defaults to process.env.ALLOWED_REPO_ROOT if set.
 * Otherwise walks up from process.cwd() or looks for .agent/.git directory.
 */
export function getAllowedRepoRoot(preferredRoot?: string): string {
  if (preferredRoot) {
    return path.resolve(preferredRoot);
  }
  if (process.env.ALLOWED_REPO_ROOT) {
    return path.resolve(process.env.ALLOWED_REPO_ROOT);
  }

  let current = process.cwd();
  // Check if we are inside gemini-dashboard
  if (path.basename(current) === 'gemini-dashboard') {
    const parent = path.dirname(current);
    if (fs.existsSync(path.join(parent, '.agent')) || fs.existsSync(path.join(parent, '.git'))) {
      return path.resolve(parent);
    }
  }

  // Walk upwards up to 5 levels to find .agent or .git
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(current, '.agent')) || fs.existsSync(path.join(current, '.git'))) {
      return path.resolve(current);
    }
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }

  return path.resolve(process.cwd());
}

/**
 * Validates runId format strictly.
 * Allows only alphanumeric characters, hyphens, and underscores (max 64 chars).
 * Prevents any directory traversal or path manipulation.
 */
export function validateRunId(runId: unknown): boolean {
  if (typeof runId !== 'string') return false;
  const trimmed = runId.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return false;
  }
  return /^[0-9a-zA-Z_-]+$/.test(trimmed);
}

/**
 * Validates that any repository path passed in strictly matches the allowed repository root.
 * Rejects path traversals, foreign repositories, and arbitrary inputs.
 */
export function validateRepository(
  inputRepo?: unknown,
  allowedRoot?: string
): { ok: boolean; repoRoot: string; error?: string } {
  const allowed = path.resolve(allowedRoot || getAllowedRepoRoot());

  if (inputRepo === undefined || inputRepo === null || inputRepo === '' || inputRepo === '.') {
    return { ok: true, repoRoot: allowed };
  }

  if (typeof inputRepo !== 'string') {
    return { ok: false, repoRoot: allowed, error: '유효하지 않은 저장소 경로 형식입니다.' };
  }

  if (inputRepo.includes('\0') || inputRepo.includes('..')) {
    return { ok: false, repoRoot: allowed, error: '저장소 경로에 안전하지 않은 문자가 포함되어 있습니다.' };
  }

  const resolved = path.resolve(inputRepo);
  // Compare normalized paths case-insensitively on Windows
  const isMatch =
    process.platform === 'win32'
      ? resolved.toLowerCase() === allowed.toLowerCase()
      : resolved === allowed;

  if (!isMatch) {
    return { ok: false, repoRoot: allowed, error: '지정된 저장소는 허용되지 않은 외부 경로입니다.' };
  }

  return { ok: true, repoRoot: allowed };
}

/**
 * Validates prompt text.
 */
export function validatePrompt(prompt: unknown): { ok: boolean; prompt: string; error?: string } {
  if (typeof prompt !== 'string') {
    return { ok: false, prompt: '', error: '작업 요청 내용(prompt)은 문자열이어야 합니다.' };
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { ok: false, prompt: '', error: '작업 요청 내용을 입력해주세요.' };
  }
  if (trimmed.length > 10000) {
    return { ok: false, prompt: '', error: '작업 요청 내용이 제한 길이(10,000자)를 초과했습니다.' };
  }
  return { ok: true, prompt: trimmed };
}

/**
 * Generates a stable, chronological run ID.
 * Format: YYYYMMDD-HHmmss-xxxxxxxx
 */
export function generateRunId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

/**
 * Atomic write helper using tmp file and rename.
 */
async function atomicWriteJson(targetPath: string, data: unknown): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpDir = path.join(dir, 'tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tmpFile = path.join(tmpDir, `${path.basename(targetPath)}.${process.pid}.${randSuffix}.tmp`);

  await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmpFile, targetPath);
}

function getDashboardStateDir(repoRoot: string): string {
  return path.join(repoRoot, '.agent', 'dashboard-state');
}

function parseJsonFileText<T>(raw: string): T {
  return JSON.parse(raw.replace(/^\uFEFF/, '')) as T;
}

/**
 * Loads and sanitizes delivery artifact or manifest delivery block if present.
 * Ensures all paths, URLs, and failure guidance are sanitized without exposing credentials.
 */
export async function loadDeliveryInfo(
  runDir: string,
  manifest?: Record<string, unknown> | null,
  compact?: CompactRunState | null,
  repoRoot?: string
): Promise<DeliveryInfo | undefined> {
  const root = repoRoot || getAllowedRepoRoot();

  // 1. Check direct delivery.json or delivery-state.json in runDir
  const deliveryCandidates = [
    path.join(runDir, 'delivery.json'),
    path.join(runDir, 'delivery-state.json'),
  ];

  let rawDel: Record<string, unknown> | null = null;
  let artifactFileUsed: string | undefined;

  for (const delPath of deliveryCandidates) {
    try {
      if (fs.existsSync(delPath)) {
        const raw = await fs.promises.readFile(delPath, 'utf8');
        rawDel = parseJsonFileText<Record<string, unknown>>(raw);
        artifactFileUsed = delPath;
        break;
      }
    } catch {
      // Ignore
    }
  }

  // 2. Fallback to manifest.delivery or compact.delivery
  if (!rawDel && manifest && typeof manifest.delivery === 'object' && manifest.delivery !== null) {
    rawDel = manifest.delivery as Record<string, unknown>;
  }

  if (!rawDel && compact?.delivery) {
    return compact.delivery;
  }

  if (!rawDel) {
    // If manifest status is explicitly 'delivered', synthesize minimal DeliveryInfo
    if (manifest?.status === 'delivered') {
      return {
        status: 'delivered',
        stage: 'delivered',
        targetBranch: (manifest.targetBranch as string) || 'main',
        remote: 'origin',
        deliveredCommit: (manifest.deliveredCommit as string) || (manifest.baseCommit as string),
        deliveredAt: (manifest.updatedAt as string) || (manifest.createdAt as string),
      };
    }
    return undefined;
  }

  const rawStatus = (rawDel.status as string) || (rawDel.stage as string) || 'delivering';
  const normStatus: DeliveryInfo['status'] =
    rawStatus === 'delivered' ? 'delivered' :
    rawStatus === 'failed' ? 'failed' :
    rawStatus === 'awaiting_review' ? 'awaiting_review' :
    rawStatus === 'skipped' ? 'skipped' :
    rawStatus === 'in_progress' ? 'in_progress' : 'delivering';

  const failureCat = (rawDel.failureCategory as string) || (rawDel.category as string);
  const rawFailureReason = (rawDel.failureReason as string) || (rawDel.reason as string) || (rawDel.error as string);
  const sanitizedReason = rawFailureReason ? sanitizeText(rawFailureReason, root) : undefined;
  const classifiedCat = failureCat ? classifyDeliveryFailureCategory(failureCat, sanitizedReason) : undefined;

  const rawArtifactPath = (rawDel.diagnosticArtifactPath as string) || (rawDel.diagnosticArtifact as string) || (rawDel.artifactPath as string) || artifactFileUsed;
  const safeArtifactPath = rawArtifactPath ? sanitizePath(rawArtifactPath, root) : undefined;

  // Mask tokens/passwords in remote URL if present
  let safeRemote = (rawDel.remote as string) || 'origin';
  if (safeRemote.includes('://') || safeRemote.includes('@')) {
    safeRemote = safeRemote.replace(/:\/\/[^@]+@/, '://***@');
  }

  const effectiveGuidance = (rawDel.actionGuidance as string) || (rawDel.guidance as string) || (classifiedCat
    ? getDeliveryActionGuidance(classifiedCat, sanitizedReason, safeArtifactPath)
    : undefined);

  return {
    status: normStatus,
    stage: (rawDel.stage as DeliveryStage) || undefined,
    stageName: (rawDel.stageName as string) || undefined,
    currentStage: (rawDel.currentStage as string) || (rawDel.stage as string) || undefined,
    targetBranch: (rawDel.targetBranch as string) || 'main',
    remote: safeRemote,
    candidateCommit: (rawDel.candidateCommit as string) || undefined,
    deliveredCommit: (rawDel.deliveredCommit as string) || undefined,
    deliveredAt: (rawDel.deliveredAt as string) || (normStatus === 'delivered' ? (rawDel.updatedAt as string) : undefined),
    failureCategory: (classifiedCat || failureCat || undefined) as DeliveryFailureCategory | undefined,
    failureReason: sanitizedReason,
    diagnosticArtifactPath: safeArtifactPath,
    diagnosticArtifact: safeArtifactPath,
    guidance: effectiveGuidance,
    actionGuidance: effectiveGuidance,
    verificationCommands: Array.isArray(rawDel.tests) ? (rawDel.tests as LiveWorkerVerificationCommand[]) : undefined,
  };
}

/**
 * Fetches an existing idempotency record if present.
 */
export async function getIdempotencyRecord(
  key: string,
  repoRoot?: string
): Promise<IdempotencyRecord | null> {
  if (!key || typeof key !== 'string') return null;
  const root = repoRoot || getAllowedRepoRoot();
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const filePath = path.join(getDashboardStateDir(root), 'idempotency', `${safeKey}.json`);

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return parseJsonFileText<IdempotencyRecord>(raw);
  } catch {
    return null;
  }
}

/**
 * Atomically saves an idempotency record.
 */
export async function saveIdempotencyRecord(
  record: IdempotencyRecord,
  repoRoot?: string
): Promise<void> {
  const root = repoRoot || getAllowedRepoRoot();
  const safeKey = record.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const filePath = path.join(getDashboardStateDir(root), 'idempotency', `${safeKey}.json`);
  await atomicWriteJson(filePath, record);
}

/**
 * Atomically saves a compact run state for restart recovery.
 */
export async function saveCompactRunState(
  state: CompactRunState,
  repoRoot?: string
): Promise<void> {
  const root = repoRoot || getAllowedRepoRoot();
  if (!validateRunId(state.runId)) {
    throw new Error(`Invalid runId: ${state.runId}`);
  }
  const filePath = path.join(getDashboardStateDir(root), 'compact', `${state.runId}.json`);
  await atomicWriteJson(filePath, state);
}

/**
 * Reads a compact run state.
 */
export async function getCompactRunState(
  runId: string,
  repoRoot?: string
): Promise<CompactRunState | null> {
  if (!validateRunId(runId)) return null;
  const root = repoRoot || getAllowedRepoRoot();
  const filePath = path.join(getDashboardStateDir(root), 'compact', `${runId}.json`);

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return parseJsonFileText<CompactRunState>(raw);
  } catch {
    return null;
  }
}

export const DEFAULT_MANIFEST_TIMEOUT_MS = 30_000;

/**
 * Resolves the persistent log path for a dashboardRunId.
 */
export function getRunLogPath(runId: string, repoRoot?: string): string {
  const root = repoRoot || getAllowedRepoRoot();
  return path.join(getDashboardStateDir(root), 'logs', `${runId}.log`);
}

/**
 * Reads the persistent log file for a run if present.
 */
export async function getRunLogContent(runId: string, repoRoot?: string): Promise<string | null> {
  const root = repoRoot || getAllowedRepoRoot();
  const logFile = getRunLogPath(runId, root);
  try {
    return await fs.promises.readFile(logFile, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Retrieves launch metadata from disk.
 * Supports both .agent/dashboard-state/meta/<runId>.json (Criterion 2)
 * and .agent/dashboard-state/launches/<runId>.meta.json.
 */
export async function getLaunchMetadata(
  runId: string,
  repoRoot?: string
): Promise<LaunchMetadata | null> {
  if (!validateRunId(runId)) return null;
  const root = repoRoot || getAllowedRepoRoot();
  const metaPath = path.join(getDashboardStateDir(root), 'meta', `${runId}.json`);
  const launchesPath = path.join(getDashboardStateDir(root), 'launches', `${runId}.meta.json`);

  for (const candidate of [metaPath, launchesPath]) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = await fs.promises.readFile(candidate, 'utf8');
        return parseJsonFileText<LaunchMetadata>(raw);
      }
    } catch {
      // Try next
    }
  }
  return null;
}

/**
 * Atomically saves launch metadata to disk.
 */
export async function saveLaunchMetadata(
  meta: LaunchMetadata,
  repoRoot?: string
): Promise<void> {
  if (!validateRunId(meta.dashboardRunId)) return;
  const root = repoRoot || getAllowedRepoRoot();
  const metaPath = path.join(getDashboardStateDir(root), 'meta', `${meta.dashboardRunId}.json`);
  const launchesPath = path.join(getDashboardStateDir(root), 'launches', `${meta.dashboardRunId}.meta.json`);
  await atomicWriteJson(metaPath, meta);
  try {
    await atomicWriteJson(launchesPath, meta);
  } catch {}
}

/**
 * Sanitizes raw stderr and process termination details, stripping secrets,
 * user home directories, absolute repository paths, command statement syntax,
 * and PowerShell internal stack/position message dumps (Criterion 3, 7).
 */
export function extractSanitizedFailureReason(
  logText?: string | null,
  metaError?: string | null,
  repoRoot?: string,
  exitCode?: number | null
): string {
  const root = repoRoot || getAllowedRepoRoot();
  const rawCandidate = ((metaError || '') + '\n' + (logText || '')).trim();

  if (rawCandidate) {
    const lines = rawCandidate.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const cleanedLines: string[] = [];

    for (const line of lines) {
      if (/^\[?BOOTSTRAP_(?:START|EXIT)\]?/i.test(line)) continue;
      if (/^(?:At |위치 |\+|PositionMessage|CategoryInfo|FullyQualifiedErrorId)/i.test(line)) continue;
      if (/^(?:NativeCommandError|RemoteException)/i.test(line)) continue;

      let msg = line
        .replace(/^\[?BOOTSTRAP_ERROR\]?:\s*/i, '')
        .replace(/^Error:\s*/i, '')
        .replace(/^throw\s*['"]?/i, '')
        .replace(/['"]?$/i, '')
        .trim();

      if (msg) {
        msg = sanitizeText(msg, root);
        cleanedLines.push(msg);
      }
    }

    if (cleanedLines.length > 0) {
      const unique = Array.from(new Set(cleanedLines));
      const summary = unique.slice(0, 2).join('; ');
      if (summary.trim().length > 0) {
        return summary.trim().slice(0, 500);
      }
    }
  }

  if (typeof exitCode === 'number' && exitCode !== 0) {
    return `실행기 프로세스가 비정상 종료되었습니다 (종료 코드: ${exitCode}).`;
  }

  return '오케스트레이터 실행 제한 시간 내에 작업 매니페스트가 생성되지 않았습니다.';
}

/**
 * Settles and watches the state of a run against disk launch metadata,
 * stdout log stream, and .agent/runs manifest (Criterion 3, 4).
 * Race-safe and recoverable across server restarts.
 */
export async function settleRunState(
  runId: string,
  repoRoot?: string,
  options?: LivenessOptions & { manifestTimeoutMs?: number }
): Promise<{ compact: CompactRunState; actualRunId?: string | null; settled: boolean } | null> {
  const root = repoRoot || getAllowedRepoRoot();
  if (!validateRunId(runId)) return null;

  const compact = await getCompactRunState(runId, root);
  if (!compact) return null;

  const logPath = getRunLogPath(runId, root);
  const relativeLogPath = sanitizePath(logPath, root);

  // 1. Check if linked to actualRunId
  let actualRunId: string | null | undefined = compact.actualRunId;
  if (!actualRunId) {
    actualRunId = await findAndLinkActualRun(runId, root);
  }

  if (actualRunId && validateRunId(actualRunId)) {
    const manifestPath = path.join(root, '.agent', 'runs', actualRunId, 'run.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const manifest = parseJsonFileText<{
          status?: string;
          baseCommit?: string;
          integrationBranch?: string;
          tasks?: string[];
        }>(raw);

        const normStatus = normalizeRunStatus(manifest.status);
        let changed = false;
        if (compact.status !== normStatus) {
          compact.status = normStatus;
          changed = true;
        }
        if (manifest.integrationBranch && compact.integrationBranch !== manifest.integrationBranch) {
          compact.integrationBranch = manifest.integrationBranch;
          changed = true;
        }
        if (manifest.baseCommit && compact.baseCommit !== manifest.baseCommit) {
          compact.baseCommit = manifest.baseCommit;
          changed = true;
        }
        const taskCount = Array.isArray(manifest.tasks) ? manifest.tasks.length : 1;
        if (compact.tasksCount !== taskCount) {
          compact.tasksCount = taskCount;
          changed = true;
        }
        const userAction = requiresUserAction(normStatus, null, compact.errorCategory, compact.failureReason);
        if (compact.requiresUserAction !== userAction) {
          compact.requiresUserAction = userAction;
          compact.userActionReason = getUserActionReason(normStatus, null, compact.errorCategory, compact.failureReason);
          changed = true;
        }
        if (compact.actualRunId !== actualRunId) {
          compact.actualRunId = actualRunId;
          changed = true;
        }
        if (changed) {
          compact.updatedAt = new Date().toISOString();
          await saveCompactRunState(compact, root);
        }
        return { compact, actualRunId, settled: true };
      } catch {
        // Fall through
      }
    }
  }

  // If status is already terminal failed/completed/cancelled, no further settlement needed
  if (compact.status === 'failed' || compact.status === 'completed' || compact.status === 'cancelled') {
    return { compact, actualRunId: compact.actualRunId, settled: true };
  }

  // 2. Check launch metadata and process liveness
  const meta = await getLaunchMetadata(runId, root);
  const logExists = fs.existsSync(logPath);

  // If there is NO launch metadata and NO log file, this run was NOT started by the dashboard launcher
  // (e.g. it's a legacy or test-mocked compact run). Do NOT prematurely fail it here;
  // let evaluateRunLiveness handle process liveness / stale PID detection.
  if (!meta && !logExists) {
    return { compact, actualRunId: compact.actualRunId, settled: false };
  }

  const pid = compact.orchestratorProcessId ?? meta?.orchestratorProcessId;
  let isAlive = false;
  if (typeof pid === 'number' && pid > 0) {
    if (options?.processInfoResolver) {
      const pInfo = await options.processInfoResolver(pid, options.platform);
      isAlive = Boolean(pInfo.alive);
    } else if (options?.isAlive) {
      isAlive = Boolean(options.isAlive(pid));
    } else {
      isAlive = isProcessAlive(pid);
    }
  }

  const hasMetaExited = meta?.exitCode !== null && meta?.exitCode !== undefined;

  const nowMs =
    options?.now instanceof Date
      ? options.now.getTime()
      : typeof options?.now === 'number'
      ? options.now
      : Date.now();
  const createdAtMs = compact.createdAt ? new Date(compact.createdAt).getTime() : 0;
  const ageMs = nowMs - createdAtMs;
  const timeoutMs = options?.manifestTimeoutMs ?? DEFAULT_MANIFEST_TIMEOUT_MS;
  const gracePeriodMs = options?.gracePeriodMs ?? 5000;
  const isTimedOut = ageMs >= timeoutMs;

  const isProcessTerminated = hasMetaExited || (!isAlive && (hasMetaExited || ageMs > gracePeriodMs));
  const hasManifestEvidence = Boolean(actualRunId && fs.existsSync(path.join(root, '.agent', 'runs', actualRunId, 'run.json')));

  if (!hasManifestEvidence && (isProcessTerminated || isTimedOut)) {
    let logText: string | null = null;
    try {
      if (fs.existsSync(logPath)) {
        logText = await fs.promises.readFile(logPath, 'utf8');
      }
    } catch {}

    const exitCode = meta?.exitCode ?? (isAlive ? null : 1);
    const sanitizedReason = extractSanitizedFailureReason(logText, meta?.error, root, exitCode);

    compact.status = 'failed';
    compact.error = sanitizedReason;
    compact.failureReason = sanitizedReason;
    compact.errorCategory = 'launcher_error';
    compact.errorDisplayName = '실행기 오류';
    compact.retryable = true;
    compact.requiresUserAction = false;
    compact.userActionReason = undefined;
    compact.exitCode = exitCode;
    compact.failureLogPath = relativeLogPath;
    compact.activeWorkersCount = 0;
    compact.tasksCount = 0;
    compact.updatedAt = new Date(nowMs).toISOString();

    await saveCompactRunState(compact, root);

    // Update launch metadata atomically
    if (meta) {
      meta.status = 'failed';
      meta.exitCode = exitCode;
      meta.endedAt = meta.endedAt || new Date(nowMs).toISOString();
      meta.error = sanitizedReason;
      await saveLaunchMetadata(meta, root);
    }

    return { compact, actualRunId: null, settled: true };
  }

  return { compact, actualRunId: null, settled: false };
}

/**
 * Atomically saves a conversation session.
 */
export async function saveConversationSession(
  session: ConversationSession,
  repoRoot?: string
): Promise<void> {
  const root = repoRoot || getAllowedRepoRoot();
  if (!validateSessionId(session.sessionId)) {
    throw new Error(`Invalid sessionId: ${session.sessionId}`);
  }
  const filePath = path.join(getDashboardStateDir(root), 'conversations', `${session.sessionId}.json`);
  await atomicWriteJson(filePath, session);
}

/**
 * Reads a conversation session by ID.
 */
export async function getConversationSession(
  sessionId: string,
  repoRoot?: string
): Promise<ConversationSession | null> {
  if (!validateSessionId(sessionId)) return null;
  const root = repoRoot || getAllowedRepoRoot();
  const filePath = path.join(getDashboardStateDir(root), 'conversations', `${sessionId}.json`);

  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return parseJsonFileText<ConversationSession>(raw);
  } catch {
    return null;
  }
}

/**
 * Lists all conversation sessions sorted by updatedAt descending.
 */
export async function listConversationSessions(
  repoRoot?: string
): Promise<ConversationSession[]> {
  const root = repoRoot || getAllowedRepoRoot();
  const convDir = path.join(getDashboardStateDir(root), 'conversations');
  const sessions: ConversationSession[] = [];

  try {
    const files = await fs.promises.readdir(convDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.slice(0, -5);
      if (!validateSessionId(sessionId)) continue;
      try {
        const raw = await fs.promises.readFile(path.join(convDir, file), 'utf8');
        sessions.push(parseJsonFileText<ConversationSession>(raw));
      } catch {
        // Skip unreadable session
      }
    }
  } catch {
    // Directory might not exist yet
  }

  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

/**
 * Approves a pending plan in a conversation session and executes the router run exactly once.
 * Enforces persistent idempotency across repeated clicks or retries.
 */
export async function approveConversationPlan(options: {
  sessionId: string;
  approvalId?: string;
  idempotencyKey?: string;
  repoRoot?: string;
  spawner?: SpawnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
}): Promise<{
  ok: boolean;
  runId?: string;
  isDuplicate?: boolean;
  approval?: ConversationApproval;
  session?: ConversationSession;
  error?: string;
}> {
  const repoValidation = validateRepository(options.repoRoot);
  if (!repoValidation.ok) {
    return { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' };
  }
  const root = repoValidation.repoRoot;

  if (!validateSessionId(options.sessionId)) {
    return { ok: false, error: '유효하지 않은 대화 세션 식별자입니다.' };
  }

  const session = await getConversationSession(options.sessionId, root);
  if (!session) {
    return { ok: false, error: '대화 세션을 찾을 수 없습니다.' };
  }

  // Locate the approval to process
  let targetApproval: ConversationApproval | undefined;
  if (session.pendingApproval && (!options.approvalId || session.pendingApproval.approvalId === options.approvalId)) {
    targetApproval = session.pendingApproval;
  } else if (options.approvalId) {
    targetApproval = session.messages.find(m => m.approval?.approvalId === options.approvalId)?.approval;
    if (!targetApproval && session.lastApproval?.approvalId === options.approvalId) {
      targetApproval = session.lastApproval;
    }
  }

  if (!targetApproval) {
    return { ok: false, error: '승인 대기 중인 작업 계획을 찾을 수 없습니다.' };
  }

  // If already approved, return idempotent success without calling spawnRouterRun
  if (targetApproval.status === 'approved' && targetApproval.runId) {
    return {
      ok: true,
      runId: targetApproval.runId,
      isDuplicate: true,
      approval: targetApproval,
      session,
    };
  }

  const key = options.idempotencyKey || targetApproval.idempotencyKey;
  if (key) {
    const existing = await getIdempotencyRecord(key, root);
    if (existing) {
      targetApproval.status = 'approved';
      targetApproval.runId = existing.runId;
      targetApproval.approvedAt = targetApproval.approvedAt || new Date().toISOString();
      session.pendingApproval = undefined;
      session.lastApproval = targetApproval;
      if (!session.linkedRunIds.includes(existing.runId)) {
        session.linkedRunIds.push(existing.runId);
      }
      await saveConversationSession(session, root);
      return {
        ok: true,
        runId: existing.runId,
        isDuplicate: true,
        approval: targetApproval,
        session,
      };
    }
  }

  try {
    const result = await spawnRouterRun({
      prompt: targetApproval.prompt,
      idempotencyKey: key,
      repoRoot: root,
      spawner: options.spawner,
      env: options.env,
      toolOverrides: options.toolOverrides,
    });

    targetApproval.status = 'approved';
    targetApproval.runId = result.runId;
    targetApproval.approvedAt = new Date().toISOString();
    session.pendingApproval = undefined;
    session.lastApproval = targetApproval;
    if (!session.linkedRunIds.includes(result.runId)) {
      session.linkedRunIds.push(result.runId);
    }

    session.messages.push({
      id: `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      sender: 'codex',
      text: `작업 실행이 승인되었습니다. 백그라운드 라우터에서 Run (${result.runId})을 시작했습니다.`,
      timestamp: new Date().toISOString(),
      approval: targetApproval,
    });
    session.updatedAt = new Date().toISOString();

    await saveConversationSession(session, root);

    return {
      ok: true,
      runId: result.runId,
      isDuplicate: result.isDuplicate,
      approval: targetApproval,
      session,
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = sanitizeText(rawMsg, root);
    targetApproval.status = 'failed';
    targetApproval.error = sanitized;
    session.updatedAt = new Date().toISOString();
    await saveConversationSession(session, root);
    return {
      ok: false,
      error: sanitized,
      approval: targetApproval,
      session,
    };
  }
}

/**
 * Saves an alias record atomically linking a dashboardRunId with an actualRunId or child process PID.
 */
export async function saveAliasRecord(
  record: RunAliasRecord,
  repoRoot?: string,
  keyOverride?: string
): Promise<void> {
  const root = repoRoot || getAllowedRepoRoot();
  const key = keyOverride || record.dashboardRunId;
  if (!validateRunId(key)) return;
  const aliasPath = path.join(getDashboardStateDir(root), 'aliases', `${key}.json`);
  await atomicWriteJson(aliasPath, record);
}

/**
 * Retrieves an alias record for a given run ID.
 */
export async function getAliasRecord(
  runId: string,
  repoRoot?: string
): Promise<RunAliasRecord | null> {
  if (!validateRunId(runId)) return null;
  const root = repoRoot || getAllowedRepoRoot();
  const aliasPath = path.join(getDashboardStateDir(root), 'aliases', `${runId}.json`);
  try {
    const raw = await fs.promises.readFile(aliasPath, 'utf8');
    return parseJsonFileText<RunAliasRecord>(raw);
  } catch {
    return null;
  }
}

/**
 * Atomically links a dashboard run ID to its actual worker run ID in .agent/runs/.
 * Returns the actual run ID if linked/found, or null if not yet created.
 */
export async function findAndLinkActualRun(
  runId: string,
  repoRoot?: string
): Promise<string | null> {
  if (!validateRunId(runId)) return null;
  const root = repoRoot || getAllowedRepoRoot();

  // 1. If runId already exists directly in .agent/runs/<runId>, it IS the actual run
  const directManifestPath = path.join(root, '.agent', 'runs', runId, 'run.json');
  if (fs.existsSync(directManifestPath)) {
    return runId;
  }

  // 2. Check if an alias record already exists with an existing actualRunId
  const existingAlias = await getAliasRecord(runId, root);
  if (existingAlias?.actualRunId && validateRunId(existingAlias.actualRunId)) {
    const candManifest = path.join(root, '.agent', 'runs', existingAlias.actualRunId, 'run.json');
    if (fs.existsSync(candManifest)) {
      return existingAlias.actualRunId;
    }
  }

  // 3. Read dashboard compact state
  const compact = await getCompactRunState(runId, root);
  if (!compact) return null;

  if (compact.actualRunId && validateRunId(compact.actualRunId)) {
    const candManifest = path.join(root, '.agent', 'runs', compact.actualRunId, 'run.json');
    if (fs.existsSync(candManifest)) {
      return compact.actualRunId;
    }
  }

  // 4. Check stdout protocol in log file (Criterion 3)
  const logPath = getRunLogPath(runId, root);
  try {
    if (fs.existsSync(logPath)) {
      const logContent = await fs.promises.readFile(logPath, 'utf8');
      const stdoutMatch = logContent.match(/^Run:\s+([0-9a-zA-Z_-]+)/m) ||
        logContent.match(/(?:ROUTER_ACTUAL_RUN_ID|actualRunId)[:=\s]+([0-9a-zA-Z_-]+)/i);
      if (stdoutMatch && stdoutMatch[1]) {
        const candidateId = stdoutMatch[1].trim();
        if (validateRunId(candidateId)) {
          const candManifest = path.join(root, '.agent', 'runs', candidateId, 'run.json');
          if (fs.existsSync(candManifest)) {
            const aliasRecord: RunAliasRecord = {
              dashboardRunId: runId,
              actualRunId: candidateId,
              orchestratorProcessId: compact.orchestratorProcessId,
              createdAt: compact.createdAt,
              linkedAt: new Date().toISOString(),
              prompt: compact.prompt,
            };
            await saveAliasRecord(aliasRecord, root, runId);
            await saveAliasRecord(aliasRecord, root, candidateId);

            compact.actualRunId = candidateId;
            compact.updatedAt = new Date().toISOString();
            await saveCompactRunState(compact, root);
            return candidateId;
          }
        }
      }
    }
  } catch {}

  // 5. Check launch metadata
  const meta = await getLaunchMetadata(runId, root);
  if (meta?.actualRunId && validateRunId(meta.actualRunId)) {
    const candManifest = path.join(root, '.agent', 'runs', meta.actualRunId, 'run.json');
    if (fs.existsSync(candManifest)) {
      const aliasRecord: RunAliasRecord = {
        dashboardRunId: runId,
        actualRunId: meta.actualRunId,
        orchestratorProcessId: compact.orchestratorProcessId ?? meta.orchestratorProcessId ?? undefined,
        createdAt: compact.createdAt,
        linkedAt: new Date().toISOString(),
        prompt: compact.prompt,
      };
      await saveAliasRecord(aliasRecord, root, runId);
      await saveAliasRecord(aliasRecord, root, meta.actualRunId);

      compact.actualRunId = meta.actualRunId;
      compact.updatedAt = new Date().toISOString();
      await saveCompactRunState(compact, root);
      return meta.actualRunId;
    }
  }

  // 6. Scan .agent/runs/ for candidate runs matching process ID or time window
  const runsDir = path.join(root, '.agent', 'runs');
  try {
    const entries = await fs.promises.readdir(runsDir);
    let matchedId: string | null = null;

    for (const folder of entries) {
      if (!validateRunId(folder) || folder === runId) continue;
      const manifestPath = path.join(runsDir, folder, 'run.json');
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const manifest = parseJsonFileText<{
          runId?: string;
          orchestratorProcessId?: number;
          createdAt?: string;
          repository?: string;
        }>(raw);

        // Match primarily on orchestratorProcessId (child.pid)
        if (
          compact.orchestratorProcessId !== undefined &&
          manifest.orchestratorProcessId !== undefined &&
          manifest.orchestratorProcessId === compact.orchestratorProcessId
        ) {
          matchedId = folder;
          break;
        }

        // Secondary fallback match: createdAt timestamp within time window (up to 3 minutes)
        if (!matchedId && compact.createdAt && manifest.createdAt) {
          const cTime = new Date(compact.createdAt).getTime();
          const mTime = new Date(manifest.createdAt).getTime();
          if (mTime >= cTime - 5000 && mTime <= cTime + 180000) {
            matchedId = folder;
          }
        }
      } catch {
        // Skip unreadable manifest
      }
    }

    if (matchedId) {
      const aliasRecord: RunAliasRecord = {
        dashboardRunId: runId,
        actualRunId: matchedId,
        orchestratorProcessId: compact.orchestratorProcessId,
        createdAt: compact.createdAt,
        linkedAt: new Date().toISOString(),
        prompt: compact.prompt,
      };

      // Atomically write both forward and reverse alias
      await saveAliasRecord(aliasRecord, root, runId);
      await saveAliasRecord(aliasRecord, root, matchedId);

      // Atomically update compact state
      compact.actualRunId = matchedId;
      compact.updatedAt = new Date().toISOString();
      await saveCompactRunState(compact, root);

      return matchedId;
    }
  } catch {
    // Directory might not exist
  }

  return null;
}

/**
 * Lists all compact runs, combining saved dashboard-state and existing .agent/runs directories
 * so that state is seamlessly recovered across server restarts and page reloads.
 * Merges linked dashboard runs and actual worker runs without duplicates.
 */
export async function listCompactRuns(
  repoRoot?: string,
  livenessOptions?: LivenessOptions
): Promise<CompactRunState[]> {
  const root = repoRoot || getAllowedRepoRoot();
  const runsMap = new Map<string, CompactRunState>();
  const handledActualRuns = new Set<string>();

  // 1. Read compact runs stored in dashboard-state/compact
  const compactDir = path.join(getDashboardStateDir(root), 'compact');
  try {
    const files = await fs.promises.readdir(compactDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const runId = file.slice(0, -5);
      if (!validateRunId(runId)) continue;
      try {
        const raw = await fs.promises.readFile(path.join(compactDir, file), 'utf8');
        let parsed = parseJsonFileText<CompactRunState>(raw);

        // Try to settle/link run if in running or planning state
        if (parsed.status === 'running' || parsed.status === 'planning') {
          const settled = await settleRunState(runId, root, livenessOptions);
          if (settled?.compact) {
            parsed = settled.compact;
          }
        }

        // Try to link to actual run if not linked yet
        const actualRunId = parsed.actualRunId || (await findAndLinkActualRun(runId, root));
        if (actualRunId) {
          handledActualRuns.add(actualRunId);
          parsed.actualRunId = actualRunId;

          // Merge live status from actual run manifest if available
          const actualRunDir = path.join(root, '.agent', 'runs', actualRunId);
          const actualManifestPath = path.join(actualRunDir, 'run.json');
          try {
            const mRaw = await fs.promises.readFile(actualManifestPath, 'utf8');
            const m = parseJsonFileText<{
              status?: string;
              updatedAt?: string;
              tasks?: string[];
              baseCommit?: string;
              orchestratorProcessId?: number;
              delivery?: unknown;
            }>(mRaw);
            const delivery = await loadDeliveryInfo(actualRunDir, m, parsed, root);
            if (delivery) {
              parsed.delivery = delivery;
            }
            const rawStatus = delivery?.status === 'delivered' ? 'delivered' : delivery?.status === 'failed' ? 'failed' : (m.status || parsed.status);
            const norm = normalizeRunStatus<RunStatus>(rawStatus);
            parsed.status = norm;
            parsed.requiresUserAction = requiresUserAction(norm, null, parsed.errorCategory || delivery?.failureCategory, parsed.failureReason || delivery?.failureReason, delivery);
            parsed.userActionReason = getUserActionReason(norm, null, parsed.errorCategory || delivery?.failureCategory, parsed.failureReason || delivery?.failureReason, delivery);
            if (m.updatedAt) parsed.updatedAt = m.updatedAt;
            if (Array.isArray(m.tasks)) parsed.tasksCount = m.tasks.length;
            if (m.baseCommit) parsed.baseCommit = m.baseCommit;
            if (m.orchestratorProcessId) parsed.orchestratorProcessId = m.orchestratorProcessId;
          } catch {
            // Ignore unreadable manifest
          }
        }

        // Evaluate liveness for active compact run
        const evalResult = await evaluateRunLiveness(parsed, root, actualRunId, livenessOptions);
        if (evalResult.wasCorrected && evalResult.updatedCompact) {
          await saveCompactRunState(evalResult.updatedCompact, root);
          runsMap.set(runId, evalResult.updatedCompact);
        } else {
          runsMap.set(runId, parsed);
        }
      } catch {
        // Ignore corrupted file
      }
    }
  } catch {
    // Directory might not exist yet
  }

  // 2. Read runs from .agent/runs to recover external or unaliased runs
  const runsDir = path.join(root, '.agent', 'runs');
  try {
    const runFolders = await fs.promises.readdir(runsDir);
    for (const folder of runFolders) {
      if (!validateRunId(folder)) continue;
      if (handledActualRuns.has(folder)) continue;

      const alias = await getAliasRecord(folder, root);
      if (alias?.dashboardRunId && runsMap.has(alias.dashboardRunId)) {
        continue;
      }

      const runFolderDir = path.join(runsDir, folder);
      const manifestPath = path.join(runFolderDir, 'run.json');
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const manifest = parseJsonFileText<{
          runId?: string;
          status?: string;
          createdAt?: string;
          updatedAt?: string;
          tasks?: string[];
          baseCommit?: string;
          orchestratorProcessId?: number;
          delivery?: unknown;
        }>(raw);

        const existing = runsMap.get(folder);
        const delivery = await loadDeliveryInfo(runFolderDir, manifest, existing, root);
        const rawStatus = delivery?.status === 'delivered' ? 'delivered' : delivery?.status === 'failed' ? 'failed' : (manifest.status || 'running');
        const normStatus = normalizeRunStatus<RunStatus>(rawStatus);
        const actionRequired = requiresUserAction(normStatus, null, delivery?.failureCategory, delivery?.failureReason, delivery);

        const isDeliveryStage =
          normStatus === 'delivering' ||
          normStatus === 'review_validation' ||
          normStatus === 'divergence_check' ||
          normStatus === 'conflict_check' ||
          normStatus === 'candidate_verification' ||
          normStatus === 'main_integration' ||
          normStatus === 'post_integration_verification' ||
          normStatus === 'push';

        const recovered: CompactRunState = {
          runId: folder,
          actualRunId: folder,
          prompt: alias?.prompt || existing?.prompt || `작업 실행 (${folder})`,
          createdAt: manifest.createdAt || existing?.createdAt || new Date().toISOString(),
          updatedAt: manifest.updatedAt || existing?.updatedAt || new Date().toISOString(),
          status: normStatus,
          requiresUserAction: actionRequired,
          userActionReason: getUserActionReason(normStatus, null, delivery?.failureCategory, delivery?.failureReason, delivery),
          tasksCount: Array.isArray(manifest.tasks) ? manifest.tasks.length : existing?.tasksCount || 1,
          activeWorkersCount: normStatus === 'running' ? 1 : 0,
          completedTasksCount: (normStatus === 'completed' || normStatus === 'delivered' || isDeliveryStage) ? 1 : existing?.completedTasksCount || 0,
          baseCommit: manifest.baseCommit || existing?.baseCommit,
          orchestratorProcessId: manifest.orchestratorProcessId || existing?.orchestratorProcessId,
          delivery,
        };

        // Evaluate liveness for recovered unaliased active run
        const evalResult = await evaluateRunLiveness(recovered, root, folder, livenessOptions);
        if (evalResult.wasCorrected && evalResult.updatedCompact) {
          await saveCompactRunState(evalResult.updatedCompact, root);
          runsMap.set(folder, evalResult.updatedCompact);
        } else {
          runsMap.set(folder, recovered);
        }
      } catch {
        // Not a valid run folder or unreadable
      }
    }
  } catch {
    // Directory might not exist yet
  }

  const list = Array.from(runsMap.values());
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list;
}

/**
 * Safely executes the fixed router entrypoint with an argument array.
 * Enforces:
 * 1. Safe argument array (NO shell string concatenation, NO arbitrary commands)
 * 2. Fixed router entrypoint (codex-router.ps1 inside allowed repository)
 * 3. Idempotency checking to prevent duplicate execution of same run
 * 4. Safe tool discovery: resolves PowerShell 7 and essential tools (codex, rg, agy)
 *    Transitions immediately to a sanitized failed state if tools are missing
 * 5. Passes augmented PATH and UTF-8 environment variables to child process
 * 6. Captures child process ID and establishes atomic alias linking to actual worker run
 */
export async function spawnRouterRun(options: {
  prompt: string;
  idempotencyKey?: string;
  repoRoot?: string;
  spawner?: SpawnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
  routerScript?: string;
  manifestTimeoutMs?: number;
}): Promise<{ runId: string; isDuplicate: boolean; status: string; actualRunId?: string }> {
  const root = options.repoRoot || getAllowedRepoRoot();

  // Validate prompt
  const validatedPrompt = validatePrompt(options.prompt);
  if (!validatedPrompt.ok) {
    throw new Error(validatedPrompt.error);
  }

  // Idempotency check
  if (options.idempotencyKey) {
    const existing = await getIdempotencyRecord(options.idempotencyKey, root);
    if (existing) {
      return {
        runId: existing.runId,
        isDuplicate: true,
        status: existing.status,
      };
    }
  }

  const runId = generateRunId();
  const now = new Date().toISOString();

  // 1. Tool Resolution: Safely search for PowerShell 7 and essential tools (codex, rg, agy)
  const toolResult = resolveRequiredTools({
    env: options.env,
    overrides: options.toolOverrides,
  });

  const stateDir = getDashboardStateDir(root);
  const launchesDir = path.join(stateDir, 'launches');
  const logsDir = path.join(stateDir, 'logs');
  const metaDir = path.join(stateDir, 'meta');
  await fs.promises.mkdir(launchesDir, { recursive: true });
  await fs.promises.mkdir(logsDir, { recursive: true });
  await fs.promises.mkdir(metaDir, { recursive: true });

  const inputPath = path.join(launchesDir, `${runId}.input.json`);
  const logPath = path.join(logsDir, `${runId}.log`);
  const metaPath = path.join(metaDir, `${runId}.json`);
  const relativeLogPath = sanitizePath(logPath, root);

  if (!toolResult.ok || !toolResult.tools) {
    const sanitizedReason = sanitizeText(
      `필수 실행 도구 또는 PowerShell 7을 찾을 수 없습니다: ${toolResult.missing?.join(', ')}`,
      root
    );
    // Criterion 6: 실행기 오류는 requiresUserAction=false, 표시명 실행기 오류, 재시도 가능으로 분류
    const failedCompact: CompactRunState = {
      runId,
      prompt: validatedPrompt.prompt,
      createdAt: now,
      updatedAt: now,
      status: 'failed',
      requiresUserAction: false,
      userActionReason: undefined,
      errorCategory: 'launcher_error',
      errorDisplayName: '실행기 오류',
      retryable: true,
      tasksCount: 0,
      activeWorkersCount: 0,
      completedTasksCount: 0,
      error: sanitizedReason,
      failureReason: sanitizedReason,
      failureLogPath: relativeLogPath,
    };
    await saveCompactRunState(failedCompact, root);
    if (options.idempotencyKey) {
      await saveIdempotencyRecord(
        {
          idempotencyKey: options.idempotencyKey,
          runId,
          prompt: validatedPrompt.prompt,
          createdAt: now,
          status: 'failed',
        },
        root
      );
    }
    const err = new Error(sanitizedReason) as Error & { runId?: string };
    err.runId = runId;
    throw err;
  }

  const tools = toolResult.tools;

  // Fixed router script path inside repository root
  const routerScript = options.routerScript
    ? path.resolve(root, options.routerScript)
    : path.join(root, 'codex-router.ps1');

  // Fixed bootstrap script path inside repository root (Criterion 1)
  const bootstrapScript = path.join(root, 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1');

  // Self-seed bootstrap script if running in temporary test repository
  if (!fs.existsSync(bootstrapScript)) {
    const candidateSource = path.join(getAllowedRepoRoot(), 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1');
    if (fs.existsSync(candidateSource) && candidateSource.toLowerCase() !== bootstrapScript.toLowerCase()) {
      await fs.promises.mkdir(path.dirname(bootstrapScript), { recursive: true });
      await fs.promises.copyFile(candidateSource, bootstrapScript);
    }
  }

  // Write safe JSON input file (Criterion 1: data passing, no shell string interpolation)
  await atomicWriteJson(inputPath, {
    dashboardRunId: runId,
    prompt: validatedPrompt.prompt,
    repoRoot: root,
    routerScript,
    logPath,
    metaPath,
    createdAt: now,
  });

  // Write initial launch metadata
  const initialMeta: LaunchMetadata = {
    dashboardRunId: runId,
    orchestratorProcessId: null,
    startedAt: now,
    status: 'running',
    exitCode: null,
    endedAt: null,
    actualRunId: null,
    error: null,
    logPath: relativeLogPath,
  };
  await saveLaunchMetadata(initialMeta, root);

  // Atomically save initial compact state (Criterion 5: no fake tasksCount before manifest)
  const initialCompact: CompactRunState = {
    runId,
    prompt: validatedPrompt.prompt,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    requiresUserAction: false,
    tasksCount: 0,
    activeWorkersCount: 1,
    completedTasksCount: 0,
    failureLogPath: relativeLogPath,
  };
  await saveCompactRunState(initialCompact, root);

  // Atomically save idempotency record
  if (options.idempotencyKey) {
    await saveIdempotencyRecord(
      {
        idempotencyKey: options.idempotencyKey,
        runId,
        prompt: validatedPrompt.prompt,
        createdAt: now,
        status: 'running',
      },
      root
    );
  }

  // Use injected spawner or default spawn
  const spawnFn: SpawnerFn = options.spawner || ((cmd, args, opts) => spawn(cmd, args, opts));

  // Use resolved PowerShell 7 executable
  const executable = tools.pwsh;

  // Strict argument array using bootstrap script and input file (Criterion 1)
  const safeArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    bootstrapScript,
    '-InputFile',
    inputPath,
  ];

  // Pass augmented PATH and UTF-8 environment variables safely
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PATH: tools.augmentedPath,
    PYTHONIOENCODING: 'utf-8',
    POWERSHELL_CLI_CONSOLE_ENCODING: 'utf-8',
    LANG: 'ko_KR.UTF-8',
    LC_ALL: 'ko_KR.UTF-8',
  };

  // Open persistent log file descriptor for direct stdout/stderr redirection (Criterion 2)
  const stdoutFd = fs.openSync(logPath, 'a');
  const stderrFd = fs.openSync(logPath, 'a');
  let childPid: number | undefined;
  try {
    const child = spawnFn(executable, safeArgs, {
      // On Windows, detached console creation can terminate pwsh before the
      // script starts when stdout/stderr are redirected to inherited handles.
      // `unref()` is sufficient for the long-lived dashboard server.
      detached: process.platform !== 'win32',
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      cwd: root,
      env: childEnv,
    });
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
    if (child && typeof child.pid === 'number') {
      childPid = child.pid;
    }
  } catch (spawnErr: unknown) {
    initialCompact.status = 'failed';
    initialCompact.updatedAt = new Date().toISOString();
    initialCompact.errorCategory = 'launcher_error';
    initialCompact.errorDisplayName = '실행기 오류';
    initialCompact.retryable = true;
    initialCompact.requiresUserAction = false;
    const rawMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
    const sanitized = extractSanitizedFailureReason(rawMsg, rawMsg, root, 1);
    initialCompact.error = sanitized;
    initialCompact.failureReason = sanitized;
    initialCompact.activeWorkersCount = 0;
    await saveCompactRunState(initialCompact, root);
    throw new Error(sanitized);
  } finally {
    try {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
    } catch {}
  }

  // Save child PID and initial alias record
  if (childPid !== undefined) {
    initialCompact.orchestratorProcessId = childPid;
    await saveCompactRunState(initialCompact, root);

    initialMeta.orchestratorProcessId = childPid;
    await saveLaunchMetadata(initialMeta, root);

    await saveAliasRecord(
      {
        dashboardRunId: runId,
        orchestratorProcessId: childPid,
        createdAt: now,
        prompt: validatedPrompt.prompt,
      },
      root
    );
  }

  return { runId, isDuplicate: false, status: 'running' };
}

/**
 * Retries a failed run using server authority.
 * Acceptance criteria 1, 2, 3:
 * - Does NOT create a Codex conversation.
 * - Reads original stored prompt and failure reason from disk.
 * - Enforces safety checks: blocks policy violations, secrets, destructive actions,
 *   Codex escalations, or user action required states.
 * - Uses stable derived or provided idempotency key to guarantee exactly one new run
 *   per logical retry attempt despite duplicate clicks or network retries.
 * - Atomically links original run and new run in durable compact states.
 */
export async function retryRun(options: {
  runId: string;
  idempotencyKey?: string;
  repoRoot?: string;
  spawner?: SpawnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
}): Promise<{
  runId: string;
  originalRunId: string;
  retryCount: number;
  isDuplicate: boolean;
  status: string;
}> {
  const root = options.repoRoot || getAllowedRepoRoot();

  if (!validateRunId(options.runId)) {
    throw new Error('유효하지 않은 원본 run ID 형식입니다.');
  }

  // 1. Retrieve original compact state
  const settled = await settleRunState(options.runId, root);
  let originalCompact = settled?.compact || (await getCompactRunState(options.runId, root));
  if (!originalCompact) {
    const actualId = await findAndLinkActualRun(options.runId, root);
    if (actualId) {
      originalCompact = await getCompactRunState(actualId, root);
    }
  }

  if (!originalCompact) {
    const err = new Error('재시도할 원본 작업을 찾을 수 없습니다.');
    (err as unknown as { code: string }).code = 'RUN_NOT_FOUND';
    throw err;
  }

  // 2. Check if already retried (idempotent duplicate return)
  if (originalCompact.retriedByRunId) {
    const existingRetry = await getCompactRunState(originalCompact.retriedByRunId, root);
    if (existingRetry) {
      return {
        runId: originalCompact.retriedByRunId,
        originalRunId: options.runId,
        retryCount: originalCompact.retryCount || 1,
        isDuplicate: true,
        status: existingRetry.status,
      };
    }
  }

  // 3. Validate safe retryability on server
  const decision = evaluateRunRetrySafety(originalCompact);
  if (!decision.canRetry) {
    const err = new Error(decision.reason || '안전 정책에 의해 재시도가 제한되었습니다.');
    (err as unknown as { code: string }).code = 'RETRY_NOT_PERMITTED';
    throw err;
  }

  // 4. Derive stable idempotency key
  const nextRetryCount = (originalCompact.retryCount || 0) + 1;
  const stableIdempotencyKey =
    options.idempotencyKey?.trim() || `retry-${options.runId}-${nextRetryCount}`;

  // 5. Check existing idempotency record
  const existing = await getIdempotencyRecord(stableIdempotencyKey, root);
  if (existing) {
    return {
      runId: existing.runId,
      originalRunId: options.runId,
      retryCount: originalCompact.retryCount || nextRetryCount,
      isDuplicate: true,
      status: existing.status,
    };
  }

  // 5. Spawn new run using stored original prompt (server authority, client cannot spoof prompt)
  const result = await spawnRouterRun({
    prompt: originalCompact.prompt,
    idempotencyKey: stableIdempotencyKey,
    repoRoot: root,
    spawner: options.spawner,
    env: options.env,
    toolOverrides: options.toolOverrides,
  });

  // 6. Atomically persist retry relationship on original run and new run
  originalCompact.retriedByRunId = result.runId;
  originalCompact.retryCount = nextRetryCount;
  originalCompact.updatedAt = new Date().toISOString();
  await saveCompactRunState(originalCompact, root);

  const newCompact = await getCompactRunState(result.runId, root);
  if (newCompact) {
    newCompact.retryOf = options.runId;
    newCompact.retryCount = nextRetryCount;
    newCompact.updatedAt = new Date().toISOString();
    await saveCompactRunState(newCompact, root);
  }

  return {
    runId: result.runId,
    originalRunId: options.runId,
    retryCount: nextRetryCount,
    isDuplicate: result.isDuplicate,
    status: result.status,
  };
}

/**
 * Reads detailed state for a specific run, building sanitized worker and timeline data.
 * Seamlessly resolves dashboard run IDs to actual worker run directories in .agent/runs/.
 */
export async function getRunDetails(
  runId: string,
  repoRoot?: string,
  livenessOptions?: LivenessOptions & { manifestTimeoutMs?: number }
): Promise<RunDetail | null> {
  if (!validateRunId(runId)) {
    return null;
  }

  const root = repoRoot || getAllowedRepoRoot();

  // 1. Settle run state against disk metadata and log protocol (Criterion 3, 4)
  const settledResult = await settleRunState(runId, root, livenessOptions);
  let compact =
    settledResult?.compact ||
    (await getCompactRunState(runId, root));

  // Resolve actual worker run ID if linked or newly created
  let actualRunId: string | null | undefined = settledResult?.actualRunId || compact?.actualRunId;
  if (!actualRunId) {
    actualRunId = await findAndLinkActualRun(runId, root);
  }
  if (!compact && actualRunId) {
    compact = await getCompactRunState(actualRunId, root);
  }
  const effectiveRunId = actualRunId || runId;

  const runDir = path.join(root, '.agent', 'runs', effectiveRunId);
  const alias =
    (await getAliasRecord(runId, root)) ||
    (actualRunId ? await getAliasRecord(actualRunId, root) : null);

  let manifest: {
    runId?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    tasks?: string[];
    baseCommit?: string;
    integrationBranch?: string;
    orchestratorProcessId?: number;
  } | null = null;

  try {
    const raw = await fs.promises.readFile(path.join(runDir, 'run.json'), 'utf8');
    manifest = parseJsonFileText<{
      runId?: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      tasks?: string[];
      baseCommit?: string;
      integrationBranch?: string;
      orchestratorProcessId?: number;
    }>(raw);
  } catch {
    // Run manifest might not exist yet if just launched
  }

  if (!manifest && !compact) {
    return null;
  }

  let isStaleMismatch = compact?.error === STALE_PROCESS_MISMATCH_REASON;
  if (compact) {
    const evalResult = await evaluateRunLiveness(compact, root, actualRunId, livenessOptions);
    if (evalResult.wasCorrected && evalResult.updatedCompact) {
      await saveCompactRunState(evalResult.updatedCompact, root);
      compact = evalResult.updatedCompact;
      isStaleMismatch = true;
    }
  } else if (manifest) {
    const normManifestStatus = normalizeRunStatus(manifest.status);
    const isManifestActive =
      normManifestStatus === 'running' ||
      normManifestStatus === 'planning' ||
      normManifestStatus === 'pending';

    if (isManifestActive) {
      const pseudoCompact: CompactRunState = {
        runId,
        actualRunId: effectiveRunId,
        prompt: alias?.prompt || `작업 (${runId})`,
        createdAt: manifest.createdAt || new Date().toISOString(),
        updatedAt: manifest.updatedAt || new Date().toISOString(),
        status: normManifestStatus,
        requiresUserAction: false,
        tasksCount: Array.isArray(manifest.tasks) ? manifest.tasks.length : 1,
        activeWorkersCount: normManifestStatus === 'running' ? 1 : 0,
        completedTasksCount: 0,
        orchestratorProcessId: manifest.orchestratorProcessId,
      };
      const evalResult = await evaluateRunLiveness(pseudoCompact, root, actualRunId, livenessOptions);
      if (evalResult.wasCorrected && evalResult.updatedCompact) {
        await saveCompactRunState(evalResult.updatedCompact, root);
        compact = evalResult.updatedCompact;
        isStaleMismatch = true;
      }
    }
  }

  const now = new Date().toISOString();
  const prompt = alias?.prompt || compact?.prompt || `작업 (${runId})`;
  const createdAt = manifest?.createdAt || compact?.createdAt || now;
  const updatedAt = manifest?.updatedAt || compact?.updatedAt || now;

  const delivery = await loadDeliveryInfo(runDir, manifest, compact, root);
  if (delivery && compact) {
    compact.delivery = delivery;
  }

  const isDeliveryStage =
    delivery?.stage === 'review_validation' ||
    delivery?.stage === 'divergence_check' ||
    delivery?.stage === 'conflict_check' ||
    delivery?.stage === 'candidate_verification' ||
    delivery?.stage === 'main_integration' ||
    delivery?.stage === 'post_integration_verification' ||
    delivery?.stage === 'push' ||
    manifest?.status === 'delivering' ||
    manifest?.status === 'review_validation' ||
    manifest?.status === 'divergence_check' ||
    manifest?.status === 'conflict_check' ||
    manifest?.status === 'candidate_verification' ||
    manifest?.status === 'main_integration' ||
    manifest?.status === 'post_integration_verification' ||
    manifest?.status === 'push';

  const rawStatus = isStaleMismatch
    ? 'failed'
    : delivery?.status === 'delivered'
    ? 'delivered'
    : delivery?.status === 'failed'
    ? 'failed'
    : delivery?.status === 'delivering'
    ? (delivery.stage || 'delivering')
    : (manifest?.status || compact?.status || 'running');
  const status = normalizeRunStatus<RunStatus>(rawStatus);

  const tasks: TaskProgressSummary[] = [];
  const activeWorkers: LiveWorkerData[] = [];
  const historyWorkers: LiveWorkerData[] = [];

  // Read tasks and workers from .agent/runs/<effectiveRunId>/
  const tasksDir = path.join(runDir, 'tasks');
  const resultsDir = path.join(runDir, 'results');
  const workersDir = path.join(runDir, 'workers');

  let taskIds: string[] = manifest?.tasks || [];
  if (taskIds.length === 0) {
    try {
      const taskFiles = await fs.promises.readdir(tasksDir);
      taskIds = taskFiles.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    } catch {
      // Ignore
    }
  }
  if (taskIds.length === 0) {
    try {
      const workerFiles = await fs.promises.readdir(workersDir);
      taskIds = workerFiles.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    } catch {
      // Ignore
    }
  }
  // Suppress virtual TASK-001 on initial launcher failures (Criterion 5)
  const isLauncher = compact?.errorCategory === 'launcher_error' || isLauncherError(compact?.failureReason || compact?.error);
  if (taskIds.length === 0 && !isLauncher && (status === 'running' || isStaleMismatch)) {
    taskIds = ['TASK-001'];
  }

  for (const tid of taskIds) {
    let taskName = tid;
    try {
      const taskFile = path.join(tasksDir, `${tid}.json`);
      const taskRaw = await fs.promises.readFile(taskFile, 'utf8');
      const parsedTask = parseJsonFileText<{ name?: string }>(taskRaw);
      if (parsedTask.name) taskName = parsedTask.name;
    } catch {
      // Ignore
    }

    let workerData: LiveWorkerData | null = null;

    // Check results dir first (final result)
    try {
      const resFile = path.join(resultsDir, `${tid}-result.json`);
      const resRaw = await fs.promises.readFile(resFile, 'utf8');
      workerData = parseJsonFileText<LiveWorkerData>(resRaw);
    } catch {
      // Check workers dir (live worker state)
      try {
        const workerFile = path.join(workersDir, `${tid}.json`);
        const wRaw = await fs.promises.readFile(workerFile, 'utf8');
        workerData = parseJsonFileText<LiveWorkerData>(wRaw);
      } catch {
        // Fallback default worker data
        workerData = {
          runId: effectiveRunId,
          taskId: tid,
          task: taskName,
          model: 'gemini-3.8-flash',
          status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running',
          startedAt: createdAt,
          updatedAt: updatedAt,
          elapsedSeconds: 0,
          recentLogs: [],
          error: isStaleMismatch ? STALE_PROCESS_MISMATCH_REASON : undefined,
        };
      }
    }

    if (workerData) {
      if (taskName === tid && workerData.task) {
        taskName = workerData.task;
      }
      if (isStaleMismatch) {
        workerData.status = 'failed';
        workerData.error = STALE_PROCESS_MISMATCH_REASON;
      } else {
        workerData.status = normalizeWorkerStatus(workerData.status);
      }
      const sanitized = sanitizeWorkerData(workerData, root);

      const isActive = isWorkerActive(sanitized.status);
      if (isActive) {
        activeWorkers.push(sanitized);
      } else {
        historyWorkers.push(sanitized);
      }

      const taskTimeline = extractTimelineEvents({
        runId: effectiveRunId,
        status: sanitized.status,
        startedAt: sanitized.startedAt,
        updatedAt: sanitized.updatedAt,
        recentLogs: sanitized.recentLogs,
        retryHistory: sanitized.retryHistory,
        verification: sanitized.verification,
        escalation: sanitized.escalation,
        changedFiles: sanitized.changedFiles,
        finalResponse: sanitized.finalResponse,
        error: sanitized.error,
        errorCategory: compact?.errorCategory,
      });

      const userAction = requiresUserAction(sanitized.status, sanitized.escalation, compact?.errorCategory, sanitized.error);
      const actionReason = getUserActionReason(sanitized.status, sanitized.escalation, compact?.errorCategory, sanitized.error);

      tasks.push({
        runId: effectiveRunId,
        taskId: tid,
        taskName,
        status: sanitized.status,
        model: sanitized.model,
        attempt: sanitized.attempt || 1,
        retryLimit: sanitized.retryLimit || 2,
        startedAt: sanitized.startedAt,
        updatedAt: sanitized.updatedAt,
        elapsedSeconds: sanitized.elapsedSeconds || 0,
        requiresUserAction: isStaleMismatch ? true : userAction,
        userActionReason: isStaleMismatch ? STALE_PROCESS_MISMATCH_REASON : actionReason,
        currentStage: taskTimeline[taskTimeline.length - 1]?.stage || 'plan',
        timeline: taskTimeline,
        changedFiles: sanitized.changedFiles,
        verificationDecision: sanitized.verification?.decision,
        error: sanitized.error,
      });
    }
  }

  // Combined timeline (Criterion 5: only if real worker/execution evidence exists)
  const firstWorker = activeWorkers[0] || historyWorkers[0];
  const overallTimeline = firstWorker
    ? extractTimelineEvents({
        runId: effectiveRunId,
        status,
        startedAt: createdAt,
        updatedAt: updatedAt,
        recentLogs: firstWorker.recentLogs,
        retryHistory: firstWorker.retryHistory,
        verification: firstWorker.verification,
        escalation: firstWorker.escalation,
        changedFiles: firstWorker.changedFiles,
        finalResponse: firstWorker.finalResponse,
        error: firstWorker.error,
        errorCategory: compact?.errorCategory || delivery?.failureCategory,
        delivery,
      })
    : delivery
    ? extractTimelineEvents({
        runId: effectiveRunId,
        status,
        startedAt: createdAt,
        updatedAt: updatedAt,
        errorCategory: compact?.errorCategory || delivery?.failureCategory,
        delivery,
      })
    : [];

  const runUserAction = isLauncher
    ? false
    : isStaleMismatch
    ? true
    : requiresUserAction(
        status,
        firstWorker?.escalation,
        compact?.errorCategory || delivery?.failureCategory,
        compact?.failureReason || delivery?.failureReason,
        delivery
      );
  const runActionReason = isLauncher
    ? undefined
    : isStaleMismatch
    ? STALE_PROCESS_MISMATCH_REASON
    : getUserActionReason(
        status,
        firstWorker?.escalation,
        compact?.errorCategory || delivery?.failureCategory,
        compact?.failureReason || delivery?.failureReason,
        delivery
      );

  // Read agent message / integration review if present
  let agentMessage: string | undefined = firstWorker?.finalResponse || undefined;
  try {
    const reviewPath = path.join(runDir, 'integration-review.md');
    const reviewRaw = await fs.promises.readFile(reviewPath, 'utf8');
    agentMessage = sanitizeText(reviewRaw, root);
  } catch {
    // Not present
  }

  const isDeliveredOrInDelivery = status === 'delivered' || isDeliveryStage;
  const activeWorkersCount = isStaleMismatch || status === 'failed' || isDeliveredOrInDelivery ? 0 : activeWorkers.length;

  return {
    runId, // Preserve the requested runId
    actualRunId: actualRunId || manifest?.runId || undefined,
    prompt,
    createdAt,
    updatedAt,
    status,
    requiresUserAction: runUserAction,
    userActionReason: runActionReason,
    tasksCount: tasks.length,
    activeWorkersCount,
    completedTasksCount: (status === 'delivered' || status === 'completed' || isDeliveryStage) && historyWorkers.length === 0
      ? (tasks.length || 1)
      : historyWorkers.filter(w => w.status === 'completed').length,
    tasks,
    activeWorkers: isStaleMismatch || status === 'failed' || isDeliveredOrInDelivery ? [] : activeWorkers,
    historyWorkers,
    timeline: overallTimeline,
    agentMessage,
    baseCommit: manifest?.baseCommit || compact?.baseCommit,
    orchestratorProcessId: manifest?.orchestratorProcessId || compact?.orchestratorProcessId,
    integrationBranch: manifest?.integrationBranch,
    error: compact?.error || (isStaleMismatch ? STALE_PROCESS_MISMATCH_REASON : undefined),
    failureLogPath: compact?.failureLogPath || delivery?.diagnosticArtifactPath || (status === 'failed' ? sanitizePath(getRunLogPath(runId, root), root) : undefined),
    failureReason: delivery?.failureReason || compact?.failureReason || compact?.error || undefined,
    exitCode: compact?.exitCode,
    errorCategory: delivery?.failureCategory || compact?.errorCategory,
    errorDisplayName: delivery?.failureCategory
      ? getDeliveryFailureDisplayName(delivery.failureCategory)
      : compact?.errorDisplayName || (isLauncher ? '실행기 오류' : undefined),
    retryable: compact?.retryable !== undefined ? compact.retryable : (isLauncher ? true : undefined),
    delivery,
  };
}

/**
 * Reconstructs the complete deterministic Project Work Graph from durable disk files.
 * Restores genuine parent/child event relationships, activities, files, and tips.
 */
export async function getProjectWorkGraph(
  runId?: string,
  repoRoot?: string,
  livenessOptions?: LivenessOptions
): Promise<ProjectWorkGraphData | null> {
  const root = repoRoot || getAllowedRepoRoot();
  let targetRunId = runId;

  // If no runId provided or is 'current', find the most active or newest run
  if (!targetRunId || targetRunId === 'current') {
    const runs = await listCompactRuns(root, livenessOptions);
    const sorted = [...runs].sort((a, b) => {
      const aActive = isRunActive(a.status) ? 1 : 0;
      const bActive = isRunActive(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    if (sorted.length === 0) return null;
    targetRunId = sorted[0].runId;
  }

  // Settle run state and resolve actual run ID
  const settled = await settleRunState(targetRunId, root, livenessOptions);
  const actualRunId = settled?.actualRunId || (await findAndLinkActualRun(targetRunId, root));
  const effectiveRunId = actualRunId || targetRunId;

  const runDir = path.join(root, '.agent', 'runs', effectiveRunId);
  const compact = settled?.compact || (await getCompactRunState(targetRunId, root)) || (actualRunId ? await getCompactRunState(actualRunId, root) : null);
  const alias = (await getAliasRecord(targetRunId, root)) || (actualRunId ? await getAliasRecord(actualRunId, root) : null);

  let manifest: {
    runId?: string;
    prompt?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    tasks?: string[];
    baseCommit?: string;
    integrationBranch?: string;
    orchestratorProcessId?: number;
    integration?: unknown;
  } | null = null;

  try {
    const raw = await fs.promises.readFile(path.join(runDir, 'run.json'), 'utf8');
    manifest = parseJsonFileText<{
      runId?: string;
      prompt?: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      tasks?: string[];
      baseCommit?: string;
      integrationBranch?: string;
      orchestratorProcessId?: number;
      integration?: unknown;
    }>(raw);
  } catch {}

  if (!manifest && !compact) {
    return null;
  }

  // Read tasks from tasksDir or workersDir
  const tasksDir = path.join(runDir, 'tasks');
  const workersDir = path.join(runDir, 'workers');
  const eventsDir = path.join(runDir, 'events');

  let taskIds: string[] = manifest?.tasks || [];
  if (taskIds.length === 0) {
    try {
      const taskFiles = await fs.promises.readdir(tasksDir);
      taskIds = taskFiles.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    } catch {}
  }
  if (taskIds.length === 0) {
    try {
      const workerFiles = await fs.promises.readdir(workersDir);
      taskIds = workerFiles.filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
    } catch {}
  }
  if (taskIds.length === 0) {
    taskIds = ['TASK-001'];
  }

  const tasks: Array<{ id: string; name?: string; prompt?: string; tier?: string; allowedFiles?: string[]; testCommands?: string[] }> = [];
  for (const tid of taskIds) {
    try {
      const raw = await fs.promises.readFile(path.join(tasksDir, `${tid}.json`), 'utf8');
      tasks.push(parseJsonFileText(raw));
    } catch {
      tasks.push({ id: tid, name: tid });
    }
  }

  // Load workers
  const details = await getRunDetails(targetRunId, root, livenessOptions);
  const workers: LiveWorkerData[] = details ? [...details.activeWorkers, ...details.historyWorkers] : [];
  const delivery = details?.delivery || (await loadDeliveryInfo(runDir, manifest, compact, root));

  // Read events per task
  const eventsByTask: Record<string, string[]> = {};
  for (const tid of taskIds) {
    try {
      const eventFile = path.join(eventsDir, `${tid}.ndjson`);
      const raw = await fs.promises.readFile(eventFile, 'utf8');
      eventsByTask[tid] = raw.split(/\r?\n/).filter(line => line.trim().length > 0);
    } catch {
      eventsByTask[tid] = [];
    }
  }

  // Read integration if present
  let integration: {
    id?: string;
    parentIds?: string[];
    branch?: string;
    decision?: string;
    changedFiles?: string[];
    tests?: LiveWorkerVerificationCommand[];
    diffStat?: string;
    headCommit?: string;
    reviewArtifact?: string;
    startedAt?: string;
    updatedAt?: string;
    [key: string]: unknown;
  } | null = null;

  try {
    const raw = await fs.promises.readFile(path.join(runDir, 'integration.json'), 'utf8');
    integration = parseJsonFileText(raw);
  } catch {
    if (manifest?.integration) {
      integration = manifest.integration as typeof integration;
    }
  }

  const prompt = alias?.prompt || compact?.prompt || manifest?.prompt || `작업 (${targetRunId})`;
  const status = details?.status || compact?.status || manifest?.status || 'running';
  const createdAt = manifest?.createdAt || compact?.createdAt || new Date().toISOString();
  const updatedAt = manifest?.updatedAt || compact?.updatedAt || createdAt;

  const rawGraph = buildProjectWorkGraph({
    runId: targetRunId,
    prompt,
    status,
    createdAt,
    updatedAt,
    baseCommit: manifest?.baseCommit || compact?.baseCommit,
    integrationBranch: manifest?.integrationBranch || integration?.branch,
    tasks,
    workers,
    eventsByTask,
    integration,
    repoRoot: root,
    retryOf: compact?.retryOf,
    retriedByRunId: compact?.retriedByRunId,
    retryCount: compact?.retryCount,
    retryable: compact?.retryable,
    delivery,
  });

  return sanitizeGraphData(rawGraph, root);
}

/**
 * Returns workers for project control.
 * Strictly separates active workers (planning, running, retrying, verifying)
 * from completed/terminated workers (which immediately drop out of the active terminal area).
 * Seamlessly tracks real workers across linked runs and optionally provides project work graph.
 */
export async function getProjectWorkers(
  repoRoot?: string,
  livenessOptions?: LivenessOptions,
  selectedRunId?: string
): Promise<{
  activeWorkers: LiveWorkerData[];
  historyWorkers: LiveWorkerData[];
  graph?: ProjectWorkGraphData | null;
  runs?: CompactRunState[];
}> {
  const root = repoRoot || getAllowedRepoRoot();
  const runs = await listCompactRuns(root, livenessOptions);

  const activeWorkers: LiveWorkerData[] = [];
  const historyWorkers: LiveWorkerData[] = [];

  // Sort runs prioritizing active runs, then latest createdAt
  const sortedRuns = [...runs].sort((a, b) => {
    const aActive = isRunActive(a.status) ? 1 : 0;
    const bActive = isRunActive(b.status) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Inspect recent runs (up to 10)
  for (const run of sortedRuns.slice(0, 10)) {
    const details = await getRunDetails(run.runId, root, livenessOptions);
    if (details) {
      activeWorkers.push(...details.activeWorkers);
      historyWorkers.push(...details.historyWorkers);
    }
  }

  let graph: ProjectWorkGraphData | null = null;
  const targetGraphRunId = selectedRunId || sortedRuns[0]?.runId;
  if (targetGraphRunId) {
    try {
      graph = await getProjectWorkGraph(targetGraphRunId, root, livenessOptions);
    } catch {
      // Fallback gracefully
    }
  }

  return { activeWorkers, historyWorkers, graph, runs: sortedRuns };
}
