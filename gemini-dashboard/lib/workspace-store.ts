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
} from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { normalizeRunStatus, normalizeWorkerStatus, isWorkerActive, requiresUserAction, getUserActionReason, extractTimelineEvents } from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeText, sanitizeWorkerData } from './workspace-sanitize.ts';

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
    return JSON.parse(raw) as IdempotencyRecord;
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
    return JSON.parse(raw) as CompactRunState;
  } catch {
    return null;
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
    return JSON.parse(raw) as RunAliasRecord;
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

  // 4. Scan .agent/runs/ for candidate runs matching process ID or time window
  const runsDir = path.join(root, '.agent', 'runs');
  try {
    const entries = await fs.promises.readdir(runsDir);
    let matchedId: string | null = null;

    for (const folder of entries) {
      if (!validateRunId(folder) || folder === runId) continue;
      const manifestPath = path.join(runsDir, folder, 'run.json');
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as {
          runId?: string;
          orchestratorProcessId?: number;
          createdAt?: string;
          repository?: string;
        };

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
export async function listCompactRuns(repoRoot?: string): Promise<CompactRunState[]> {
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
        const parsed = JSON.parse(raw) as CompactRunState;

        // Try to link to actual run if not linked yet
        const actualRunId = parsed.actualRunId || (await findAndLinkActualRun(runId, root));
        if (actualRunId) {
          handledActualRuns.add(actualRunId);
          parsed.actualRunId = actualRunId;

          // Merge live status from actual run manifest if available
          const actualManifestPath = path.join(root, '.agent', 'runs', actualRunId, 'run.json');
          try {
            const mRaw = await fs.promises.readFile(actualManifestPath, 'utf8');
            const m = JSON.parse(mRaw) as {
              status?: string;
              updatedAt?: string;
              tasks?: string[];
              baseCommit?: string;
              orchestratorProcessId?: number;
            };
            if (m.status) {
              const norm = normalizeRunStatus(m.status);
              parsed.status = norm;
              parsed.requiresUserAction = requiresUserAction(norm);
              parsed.userActionReason = getUserActionReason(norm);
            }
            if (m.updatedAt) parsed.updatedAt = m.updatedAt;
            if (Array.isArray(m.tasks)) parsed.tasksCount = m.tasks.length;
            if (m.baseCommit) parsed.baseCommit = m.baseCommit;
            if (m.orchestratorProcessId) parsed.orchestratorProcessId = m.orchestratorProcessId;
          } catch {
            // Ignore unreadable manifest
          }
        }

        runsMap.set(runId, parsed);
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

      const manifestPath = path.join(runsDir, folder, 'run.json');
      try {
        const raw = await fs.promises.readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(raw) as {
          runId?: string;
          status?: string;
          createdAt?: string;
          updatedAt?: string;
          tasks?: string[];
          baseCommit?: string;
          orchestratorProcessId?: number;
        };

        const existing = runsMap.get(folder);
        const normStatus = normalizeRunStatus(manifest.status);
        const actionRequired = requiresUserAction(normStatus);

        const recovered: CompactRunState = {
          runId: folder,
          actualRunId: folder,
          prompt: alias?.prompt || existing?.prompt || `작업 실행 (${folder})`,
          createdAt: manifest.createdAt || existing?.createdAt || new Date().toISOString(),
          updatedAt: manifest.updatedAt || existing?.updatedAt || new Date().toISOString(),
          status: normStatus,
          requiresUserAction: actionRequired,
          userActionReason: getUserActionReason(normStatus),
          tasksCount: Array.isArray(manifest.tasks) ? manifest.tasks.length : existing?.tasksCount || 1,
          activeWorkersCount: normStatus === 'running' ? 1 : 0,
          completedTasksCount: normStatus === 'completed' ? 1 : existing?.completedTasksCount || 0,
          baseCommit: manifest.baseCommit || existing?.baseCommit,
          orchestratorProcessId: manifest.orchestratorProcessId || existing?.orchestratorProcessId,
        };

        runsMap.set(folder, recovered);
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

  if (!toolResult.ok || !toolResult.tools) {
    const sanitizedReason = sanitizeText(
      `필수 실행 도구 또는 PowerShell 7을 찾을 수 없습니다: ${toolResult.missing?.join(', ')}`,
      root
    );
    const failedCompact: CompactRunState = {
      runId,
      prompt: validatedPrompt.prompt,
      createdAt: now,
      updatedAt: now,
      status: 'failed',
      requiresUserAction: true,
      userActionReason: sanitizedReason,
      tasksCount: 1,
      activeWorkersCount: 0,
      completedTasksCount: 0,
      error: sanitizedReason,
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

  // Atomically save initial compact state
  const initialCompact: CompactRunState = {
    runId,
    prompt: validatedPrompt.prompt,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    requiresUserAction: false,
    tasksCount: 1,
    activeWorkersCount: 1,
    completedTasksCount: 0,
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

  // Fixed router script path inside repository root
  const routerScript = path.join(root, 'codex-router.ps1');

  // Use injected spawner or default spawn
  const spawnFn: SpawnerFn = options.spawner || ((cmd, args, opts) => spawn(cmd, args, opts));

  // Use resolved PowerShell 7 executable (never legacy powershell.exe on Windows to prevent Korean path mojibake)
  const executable = tools.pwsh;

  // Strict argument array without shell: true
  const safeArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    routerScript,
    '-Request',
    validatedPrompt.prompt,
    '-Repository',
    root,
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

  let childPid: number | undefined;
  try {
    const child = spawnFn(executable, safeArgs, {
      detached: true,
      stdio: 'ignore',
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
  } catch {
    // If process launch failed, mark compact state as failed
    initialCompact.status = 'failed';
    initialCompact.updatedAt = new Date().toISOString();
    initialCompact.error = '워커 프로세스 시작에 실패했습니다.';
    await saveCompactRunState(initialCompact, root);
    throw new Error('워커 프로세스 시작에 실패했습니다.');
  }

  // Save child PID and initial alias record
  if (childPid !== undefined) {
    initialCompact.orchestratorProcessId = childPid;
    await saveCompactRunState(initialCompact, root);

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
 * Reads detailed state for a specific run, building sanitized worker and timeline data.
 * Seamlessly resolves dashboard run IDs to actual worker run directories in .agent/runs/.
 */
export async function getRunDetails(
  runId: string,
  repoRoot?: string
): Promise<RunDetail | null> {
  if (!validateRunId(runId)) {
    return null;
  }

  const root = repoRoot || getAllowedRepoRoot();

  // 1. Resolve actual worker run ID if linked or newly created
  const actualRunId = await findAndLinkActualRun(runId, root);
  const effectiveRunId = actualRunId || runId;

  const runDir = path.join(root, '.agent', 'runs', effectiveRunId);
  const compact =
    (await getCompactRunState(runId, root)) ||
    (actualRunId ? await getCompactRunState(actualRunId, root) : null);
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
    manifest = JSON.parse(raw);
  } catch {
    // Run manifest might not exist yet if just launched
  }

  if (!manifest && !compact) {
    return null;
  }

  const now = new Date().toISOString();
  const prompt = alias?.prompt || compact?.prompt || `작업 (${runId})`;
  const createdAt = manifest?.createdAt || compact?.createdAt || now;
  const updatedAt = manifest?.updatedAt || compact?.updatedAt || now;
  const rawStatus = manifest?.status || compact?.status || 'running';
  const status = normalizeRunStatus(rawStatus);

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
  if (taskIds.length === 0) {
    taskIds = ['TASK-001'];
  }

  for (const tid of taskIds) {
    let taskName = tid;
    try {
      const taskFile = path.join(tasksDir, `${tid}.json`);
      const taskRaw = await fs.promises.readFile(taskFile, 'utf8');
      const parsedTask = JSON.parse(taskRaw) as { name?: string };
      if (parsedTask.name) taskName = parsedTask.name;
    } catch {
      // Ignore
    }

    let workerData: LiveWorkerData | null = null;

    // Check results dir first (final result)
    try {
      const resFile = path.join(resultsDir, `${tid}-result.json`);
      const resRaw = await fs.promises.readFile(resFile, 'utf8');
      workerData = JSON.parse(resRaw) as LiveWorkerData;
    } catch {
      // Check workers dir (live worker state)
      try {
        const workerFile = path.join(workersDir, `${tid}.json`);
        const wRaw = await fs.promises.readFile(workerFile, 'utf8');
        workerData = JSON.parse(wRaw) as LiveWorkerData;
      } catch {
        // Fallback default worker data
        workerData = {
          runId: effectiveRunId,
          taskId: tid,
          task: taskName,
          model: 'gemini-3.8-flash',
          status: status === 'completed' ? 'completed' : 'running',
          startedAt: createdAt,
          updatedAt: updatedAt,
          elapsedSeconds: 0,
          recentLogs: [],
        };
      }
    }

    if (workerData) {
      if (taskName === tid && workerData.task) {
        taskName = workerData.task;
      }
      // Normalize worker status
      workerData.status = normalizeWorkerStatus(workerData.status);
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
      });

      const userAction = requiresUserAction(sanitized.status, sanitized.escalation);
      const actionReason = getUserActionReason(sanitized.status, sanitized.escalation);

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
        requiresUserAction: userAction,
        userActionReason: actionReason,
        currentStage: taskTimeline[taskTimeline.length - 1]?.stage || 'plan',
        timeline: taskTimeline,
        changedFiles: sanitized.changedFiles,
        verificationDecision: sanitized.verification?.decision,
        error: sanitized.error,
      });
    }
  }

  // Combined timeline
  const firstWorker = activeWorkers[0] || historyWorkers[0];
  const overallTimeline = extractTimelineEvents({
    runId: effectiveRunId,
    status,
    startedAt: createdAt,
    updatedAt: updatedAt,
    verification: firstWorker?.verification,
    escalation: firstWorker?.escalation,
    changedFiles: firstWorker?.changedFiles,
    finalResponse: firstWorker?.finalResponse,
    error: firstWorker?.error,
  });

  const runUserAction = requiresUserAction(status, firstWorker?.escalation);
  const runActionReason = getUserActionReason(status, firstWorker?.escalation);

  // Read agent message / integration review if present
  let agentMessage: string | undefined = firstWorker?.finalResponse || undefined;
  try {
    const reviewPath = path.join(runDir, 'integration-review.md');
    const reviewRaw = await fs.promises.readFile(reviewPath, 'utf8');
    agentMessage = sanitizeText(reviewRaw, root);
  } catch {
    // Not present
  }

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
    activeWorkersCount: activeWorkers.length,
    completedTasksCount: historyWorkers.filter(w => w.status === 'completed').length,
    tasks,
    activeWorkers,
    historyWorkers,
    timeline: overallTimeline,
    agentMessage,
    baseCommit: manifest?.baseCommit || compact?.baseCommit,
    orchestratorProcessId: manifest?.orchestratorProcessId || compact?.orchestratorProcessId,
    integrationBranch: manifest?.integrationBranch,
    error: compact?.error,
  };
}

/**
 * Returns workers for project control.
 * Strictly separates active workers (planning, running, retrying, verifying)
 * from completed/terminated workers (which immediately drop out of the active terminal area).
 * Seamlessly tracks real workers across linked runs.
 */
export async function getProjectWorkers(
  repoRoot?: string
): Promise<{ activeWorkers: LiveWorkerData[]; historyWorkers: LiveWorkerData[] }> {
  const root = repoRoot || getAllowedRepoRoot();
  const runs = await listCompactRuns(root);

  const activeWorkers: LiveWorkerData[] = [];
  const historyWorkers: LiveWorkerData[] = [];

  // Sort runs prioritizing active runs, then latest createdAt
  const sortedRuns = [...runs].sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'planning' ? 1 : 0;
    const bActive = b.status === 'running' || b.status === 'planning' ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Inspect recent runs (up to 10)
  for (const run of sortedRuns.slice(0, 10)) {
    const details = await getRunDetails(run.runId, root);
    if (details) {
      activeWorkers.push(...details.activeWorkers);
      historyWorkers.push(...details.historyWorkers);
    }
  }

  return { activeWorkers, historyWorkers };
}