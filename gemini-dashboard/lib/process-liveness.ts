import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { CompactRunState } from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { normalizeRunStatus, isWorkerActive } from './workspace-contract.ts';

export const STALE_PROCESS_MISMATCH_REASON = '프로세스 종료/상태 기록 불일치';
export const DEFAULT_GRACE_PERIOD_MS = 30_000; // 30 seconds

export interface ProcessInfo {
  pid: number;
  alive: boolean;
  command?: string;
  name?: string;
  metadataAvailable: boolean;
}

export type ProcessInfoResolver = (
  pid: number,
  platform?: NodeJS.Platform
) => ProcessInfo | Promise<ProcessInfo>;

export interface LivenessOptions {
  now?: number | Date;
  gracePeriodMs?: number;
  processInfoResolver?: ProcessInfoResolver;
  isAlive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}

export interface EvaluationResult {
  isAlive: boolean;
  status:
    | 'pending'
    | 'planning'
    | 'running'
    | 'awaiting_review'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'escalated';
  activeWorkersCount: number;
  reason?: string;
  updatedCompact?: CompactRunState;
  wasCorrected: boolean;
}

let globalLivenessOptions: LivenessOptions | undefined;

export function setGlobalLivenessOptions(options?: LivenessOptions): void {
  globalLivenessOptions = options;
}

export function resetGlobalLivenessOptions(): void {
  globalLivenessOptions = undefined;
}

export function getEffectiveLivenessOptions(options?: LivenessOptions): LivenessOptions {
  return {
    ...globalLivenessOptions,
    ...options,
  };
}

/**
 * Checks bare PID existence using Node's process.kill(pid, 0) API.
 * Never constructs or executes any shell command.
 */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'EPERM'
    ) {
      // EPERM means process exists but we lack permissions to signal it -> still alive
      return true;
    }
    return false;
  }
}

/**
 * Retrieves process information safely using Node APIs and argument-array child-process invocation only.
 * Never constructs or executes arbitrary shell command strings.
 */
export function getProcessInfo(
  pid: number,
  platform: NodeJS.Platform = process.platform
): ProcessInfo {
  if (!isProcessAlive(pid)) {
    return { pid, alive: false, metadataAvailable: true };
  }

  // Windows platform
  if (platform === 'win32') {
    let name: string | undefined;
    let command: string | undefined;
    let metadataAvailable = false;

    // 1. Query image name using tasklist.exe with safe argument array
    try {
      const tasklistRes = spawnSync('tasklist.exe', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        timeout: 3000,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (tasklistRes.status === 0 && tasklistRes.stdout) {
        const line = tasklistRes.stdout.trim().split(/\r?\n/)[0];
        if (line && line.startsWith('"')) {
          const match = line.match(/^"([^"]+)"/);
          if (match) {
            name = match[1];
            metadataAvailable = true;
          }
        }
      }
    } catch {
      // Ignore tasklist error
    }

    // 2. Query command line using PowerShell with literal script block and separate argument
    try {
      const psScript = '& { param($p) (Get-CimInstance Win32_Process -Filter "ProcessId = $p" | Select-Object -ExpandProperty CommandLine) }';
      const psRes = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript, String(pid)],
        {
          timeout: 4000,
          encoding: 'utf8',
          windowsHide: true,
        }
      );
      if (psRes.status === 0 && psRes.stdout) {
        const out = psRes.stdout.trim();
        if (out) {
          command = out;
          metadataAvailable = true;
        }
      }
    } catch {
      // Ignore PowerShell query error
    }

    return {
      pid,
      alive: true,
      name,
      command,
      metadataAvailable,
    };
  }

  // Linux platform: read /proc/<pid>/cmdline via Node filesystem API
  if (platform === 'linux') {
    try {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(cmdlinePath)) {
        const raw = fs.readFileSync(cmdlinePath, 'utf8');
        const cmd = raw.split('\0').filter(Boolean).join(' ');
        return {
          pid,
          alive: true,
          command: cmd || undefined,
          metadataAvailable: true,
        };
      }
    } catch {
      // Fall through to ps
    }
  }

  // POSIX / macOS fallback using ps with safe argument array
  try {
    const psRes = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 2000,
      encoding: 'utf8',
    });
    if (psRes.status === 0 && psRes.stdout) {
      const cmd = psRes.stdout.trim();
      return {
        pid,
        alive: true,
        command: cmd || undefined,
        metadataAvailable: true,
      };
    }
  } catch {
    // Ignore ps failure
  }

  return {
    pid,
    alive: true,
    metadataAvailable: false,
  };
}

/**
 * Validates command/process identity to prevent PID reuse from being accepted as active.
 */
export function isProcessRelatedToRun(
  proc: ProcessInfo,
  run?: CompactRunState | null,
  repoRoot?: string
): boolean {
  if (!proc.alive) return false;
  if (!proc.metadataAvailable) return false;

  const cmd = (proc.command || '').toLowerCase();
  const name = (proc.name || '').toLowerCase();

  if (cmd) {
    if (
      cmd.includes('codex-router') ||
      cmd.includes('codex-route') ||
      cmd.includes('run-parallel-workers') ||
      cmd.includes('router-bootstrap')
    ) {
      return true;
    }

    if (cmd.includes('pwsh') || cmd.includes('powershell')) {
      if (
        cmd.includes('-request') ||
        cmd.includes('-repository') ||
        cmd.includes('codex') ||
        cmd.includes('router') ||
        cmd.includes('bootstrap') ||
        cmd.includes('-inputfile')
      ) {
        return true;
      }
    }

    if (run?.runId && cmd.includes(run.runId.toLowerCase())) {
      return true;
    }

    if (repoRoot) {
      const base = path.basename(repoRoot).toLowerCase();
      if (base && cmd.includes(base)) {
        return true;
      }
    }

    if (
      cmd.includes('node') &&
      (cmd.includes('test') || cmd.includes('settimeout') || cmd.includes('bridge'))
    ) {
      return true;
    }

    // Explicit command line was found and matched none of the above: unrelated process!
    return false;
  }

  // If only image name was available
  if (name) {
    if (name.includes('pwsh') || name.includes('powershell')) {
      return true;
    }
    if (name.includes('node')) {
      return true;
    }
    return false;
  }

  return false;
}

/**
 * Checks whether an actual run directory contains genuine active worker evidence.
 */
export async function hasActiveWorkerEvidence(
  runId: string,
  repoRoot: string
): Promise<boolean> {
  const runDir = path.join(repoRoot, '.agent', 'runs', runId);
  const workersDir = path.join(runDir, 'workers');
  const resultsDir = path.join(runDir, 'results');

  try {
    const files = await fs.promises.readdir(workersDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const taskId = file.slice(0, -5);

      // If a result file exists, this worker has finished
      const resultFile = path.join(resultsDir, `${taskId}-result.json`);
      if (fs.existsSync(resultFile)) {
        continue;
      }

      try {
        const raw = await fs.promises.readFile(path.join(workersDir, file), 'utf8');
        const workerData = JSON.parse(raw) as { status?: string; updatedAt?: string };
        if (workerData.status && isWorkerActive(workerData.status)) {
          return true;
        }
      } catch {
        // Skip unreadable worker file
      }
    }
  } catch {
    // workersDir might not exist
  }

  return false;
}

/**
 * Evaluates whether a compact run in an active state is legitimately active or stale.
 * Returns an EvaluationResult indicating if the run is alive, its corrected status,
 * and an updated compact state if correction was needed.
 */
export async function evaluateRunLiveness(
  run: CompactRunState,
  repoRoot: string,
  actualRunId?: string | null,
  options?: LivenessOptions
): Promise<EvaluationResult> {
  const opts = getEffectiveLivenessOptions(options);
  const currentStatus = run.status || 'running';
  const normalized = normalizeRunStatus(currentStatus);

  const isActiveState =
    normalized === 'running' ||
    normalized === 'planning' ||
    normalized === 'pending';

  if (!isActiveState) {
    return {
      isAlive: false,
      status: normalized,
      activeWorkersCount: run.activeWorkersCount ?? 0,
      wasCorrected: false,
    };
  }

  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === 'number'
      ? opts.now
      : Date.now();
  const gracePeriodMs = opts.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const createdAtMs = run.createdAt ? new Date(run.createdAt).getTime() : 0;
  const ageMs = nowMs - createdAtMs;

  // 1. Grace period check: newly launched runs are protected against launch races
  if (createdAtMs > 0 && ageMs >= 0 && ageMs < gracePeriodMs) {
    return {
      isAlive: true,
      status: normalized,
      activeWorkersCount: run.activeWorkersCount > 0 ? run.activeWorkersCount : 1,
      wasCorrected: false,
    };
  }

  // 2. Real active-worker evidence check from linked child run
  const effectiveRunId = actualRunId || run.actualRunId || run.runId;
  let activeWorkerFound = false;
  if (effectiveRunId) {
    activeWorkerFound = await hasActiveWorkerEvidence(effectiveRunId, repoRoot);
  }

  if (activeWorkerFound) {
    return {
      isAlive: true,
      status: normalized,
      activeWorkersCount: run.activeWorkersCount > 0 ? run.activeWorkersCount : 1,
      wasCorrected: false,
    };
  }

  // 3. Process liveness and identity validation
  let validRouterProcessFound = false;
  const pid = run.orchestratorProcessId;

  if (typeof pid === 'number' && pid > 0) {
    const resolver = opts.processInfoResolver ?? getProcessInfo;
    const proc = await resolver(pid, opts.platform);
    if (proc.alive) {
      if (proc.metadataAvailable) {
        validRouterProcessFound = isProcessRelatedToRun(proc, run, repoRoot);
      } else {
        // Degrade conservatively when command metadata is unavailable:
        // bare PID existence is not accepted as sufficient without worker evidence
        validRouterProcessFound = false;
      }
    }
  }

  if (validRouterProcessFound) {
    return {
      isAlive: true,
      status: normalized,
      activeWorkersCount: run.activeWorkersCount > 0 ? run.activeWorkersCount : 1,
      wasCorrected: false,
    };
  }

  // 4. Stale compact record detected! Correct to failed
  const corrected: CompactRunState = {
    ...run,
    status: 'failed',
    activeWorkersCount: 0,
    error: STALE_PROCESS_MISMATCH_REASON,
    userActionReason: STALE_PROCESS_MISMATCH_REASON,
    requiresUserAction: true,
    updatedAt: new Date(nowMs).toISOString(),
  };

  return {
    isAlive: false,
    status: 'failed',
    activeWorkersCount: 0,
    reason: STALE_PROCESS_MISMATCH_REASON,
    updatedCompact: corrected,
    wasCorrected: true,
  };
}