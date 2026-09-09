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

/**
 * Resolves the currently allowed repository root.
 * Defaults to process.env.ALLOWED_REPO_ROOT if set.
 * Otherwise walks up from process.cwd() or looks for .agent/.git directory.
 */
export function getAllowedRepoRoot(): string {
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
 * Lists all compact runs, combining saved dashboard-state and existing .agent/runs directories
 * so that state is seamlessly recovered across server restarts and page reloads.
 */
export async function listCompactRuns(repoRoot?: string): Promise<CompactRunState[]> {
  const root = repoRoot || getAllowedRepoRoot();
  const runsMap = new Map<string, CompactRunState>();

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
        runsMap.set(runId, parsed);
      } catch {
        // Ignore corrupted file
      }
    }
  } catch {
    // Directory might not exist yet
  }

  // 2. Read runs from .agent/runs to recover external or previous runs
  const runsDir = path.join(root, '.agent', 'runs');
  try {
    const runFolders = await fs.promises.readdir(runsDir);
    for (const folder of runFolders) {
      if (!validateRunId(folder)) continue;
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
        };

        const existing = runsMap.get(folder);
        const normStatus = normalizeRunStatus(manifest.status);
        const actionRequired = requiresUserAction(normStatus);

        const recovered: CompactRunState = {
          runId: folder,
          prompt: existing?.prompt || `작업 실행 (${folder})`,
          createdAt: manifest.createdAt || existing?.createdAt || new Date().toISOString(),
          updatedAt: manifest.updatedAt || existing?.updatedAt || new Date().toISOString(),
          status: normStatus,
          requiresUserAction: actionRequired,
          userActionReason: getUserActionReason(normStatus),
          tasksCount: Array.isArray(manifest.tasks) ? manifest.tasks.length : existing?.tasksCount || 1,
          activeWorkersCount: normStatus === 'running' ? 1 : 0,
          completedTasksCount: normStatus === 'completed' ? 1 : existing?.completedTasksCount || 0,
          baseCommit: manifest.baseCommit || existing?.baseCommit,
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
 * 4. Atomic persistence of pending run record
 * 5. Asynchronous detached launch returning stable runId immediately
 */
export async function spawnRouterRun(options: {
  prompt: string;
  idempotencyKey?: string;
  repoRoot?: string;
  spawner?: SpawnerFn;
}): Promise<{ runId: string; isDuplicate: boolean; status: string }> {
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

  // Determine binary: powershell.exe on Windows, pwsh on others
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

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

  try {
    const child = spawnFn(executable, safeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: root,
    });
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch {
    // If process launch failed, mark compact state as failed
    initialCompact.status = 'failed';
    initialCompact.updatedAt = new Date().toISOString();
    await saveCompactRunState(initialCompact, root);
    throw new Error('워커 프로세스 시작에 실패했습니다.');
  }

  return { runId, isDuplicate: false, status: 'running' };
}

/**
 * Reads detailed state for a specific run, building sanitized worker and timeline data.
 */
export async function getRunDetails(
  runId: string,
  repoRoot?: string
): Promise<RunDetail | null> {
  if (!validateRunId(runId)) {
    return null;
  }

  const root = repoRoot || getAllowedRepoRoot();
  const runDir = path.join(root, '.agent', 'runs', runId);
  const compact = await getCompactRunState(runId, root);

  let manifest: {
    runId?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    tasks?: string[];
    baseCommit?: string;
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
  const prompt = compact?.prompt || `작업 (${runId})`;
  const createdAt = manifest?.createdAt || compact?.createdAt || now;
  const updatedAt = manifest?.updatedAt || compact?.updatedAt || now;
  const rawStatus = manifest?.status || compact?.status || 'running';
  const status = normalizeRunStatus(rawStatus);

  const tasks: TaskProgressSummary[] = [];
  const activeWorkers: LiveWorkerData[] = [];
  const historyWorkers: LiveWorkerData[] = [];

  // Read tasks and workers from .agent/runs/<runId>/
  const tasksDir = path.join(runDir, 'tasks');
  const resultsDir = path.join(runDir, 'results');
  const workersDir = path.join(runDir, 'workers');

  const taskIds: string[] = manifest?.tasks || ['TASK-001'];
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
          runId,
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
        runId,
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
        runId,
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
    runId,
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
    runId,
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
  };
}

/**
 * Returns workers for project control.
 * Strictly separates active workers (planning, running, retrying, verifying)
 * from completed/terminated workers (which immediately drop out of the active terminal area).
 */
export async function getProjectWorkers(
  repoRoot?: string
): Promise<{ activeWorkers: LiveWorkerData[]; historyWorkers: LiveWorkerData[] }> {
  const root = repoRoot || getAllowedRepoRoot();
  const runs = await listCompactRuns(root);

  const activeWorkers: LiveWorkerData[] = [];
  const historyWorkers: LiveWorkerData[] = [];

  // Inspect recent runs (up to 5)
  for (const run of runs.slice(0, 5)) {
    const details = await getRunDetails(run.runId, root);
    if (details) {
      activeWorkers.push(...details.activeWorkers);
      historyWorkers.push(...details.historyWorkers);
    }
  }

  return { activeWorkers, historyWorkers };
}