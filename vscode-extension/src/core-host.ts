import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ConversationSession, LiveWorkerData } from '../../packages/orchestrator-core/workspace-contract.ts';
import { defaultCodexRunner, evaluateCodexConversation } from '../../packages/orchestrator-core/codex-conversation.ts';
import type { CodexRunnerFn } from '../../packages/orchestrator-core/codex-conversation.ts';
import { approveConversationPlan, getConversationSession, getProjectWorkGraph, getRunDetails, getWorkspaceResumeState, listCompactRuns, listConversationSessions, retryRun, saveConversationSession, saveWorkspaceResumeState } from '../../packages/orchestrator-core/workspace-store.ts';
import type { SpawnerFn } from '../../packages/orchestrator-core/workspace-store.ts';
import { getCodexDailyUsage } from '../../packages/orchestrator-core/codex-usage.ts';
import { getGeminiQuota } from '../../packages/orchestrator-core/gemini-quota.ts';
import type { ProjectWorkGraphData } from '../../packages/orchestrator-core/project-event-graph.ts';
import { formatUsageDetail, formatUsageLine, isBranchMerged, readGitIdentity, summarizeRunStatus, type UsageWindow } from './workspace-context.ts';
import { sanitizeSpawnEnv } from '../../packages/orchestrator-core/spawn-env.ts';
import { sanitizeText } from '../../packages/orchestrator-core/workspace-sanitize.ts';
import {
  POST as saveWorkerSettingsRequest,
  EXPLANATION_DETAILS,
  PLAN_PRESENTATIONS,
  RESPONSE_LANGUAGES,
  deleteWorkerPreference,
  readWorkerMemory,
  resetWorkerPreferences,
  setWorkerMemoryEnabled,
  setWorkerPreference,
} from '../../packages/orchestrator-core/worker-settings.ts';
import type {
  WorkerMemorySettings,
  WorkerPreferenceKey,
} from '../../packages/orchestrator-core/worker-settings.ts';
import {
  clearRepositoryMemory,
  readRepositoryMemory,
  rebuildRepositoryMemory,
} from '../../packages/orchestrator-core/repository-memory.ts';
import type {
  TaskHistoryValue,
  TestMapValue,
} from '../../packages/orchestrator-core/repository-memory.ts';
import { countUnlinkedActiveRuns, resolveSessionId, resolveTrackedRunId } from './restore-state.ts';
import { runCompletionLines, runFailureLines, sessionTitle, type SessionSummary, type WebviewMessage } from './protocol.ts';

export function sanitizeUiError(error: unknown, repoRoot?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeText(raw, repoRoot) || '작업을 완료하지 못했습니다.';
}

export async function restoreWorkspaceBindings(
  repoRoot: string,
  stored: { sessionId?: string; runId?: string }
): Promise<{
  sessionId?: string;
  runId?: string;
  status: string;
  unlinkedActiveRuns: number;
}> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const sessions = await listConversationSessions(repoRoot);
    const resume = await getWorkspaceResumeState(repoRoot);
    const sessionId = resolveSessionId(stored.sessionId, sessions, resume?.activeSessionId);
    const resumedSession = sessions.find(session => session.sessionId === sessionId);
    const runId = resolveTrackedRunId(stored.runId, runs, resumedSession?.linkedRunIds.at(-1));
    const run = runs.find(item => item.runId === runId || item.actualRunId === runId);
    return {
      sessionId,
      runId,
      unlinkedActiveRuns: countUnlinkedActiveRuns(runId, runs),
      status: summarizeRunStatus({
        status: run?.status,
        requiresUserAction: run?.requiresUserAction,
        activeWorkers: run?.activeWorkersCount,
      }),
    };
  });
}

/** Records the conversation the user selected so the next window resumes it. */
export async function rememberActiveSession(
  repoRoot: string,
  session: ConversationSession
): Promise<void> {
  await withWorkspaceRoot(repoRoot, () =>
    saveWorkspaceResumeState(
      {
        activeSessionId: session.sessionId,
        lastMessageId: session.messages.at(-1)?.id,
        activeRunId: session.linkedRunIds.at(-1),
      },
      repoRoot
    )
  );
}

/**
 * Scopes core calls to the workspace. The router and worker scripts run from
 * the workspace copy of the toolkit, so worker-settings.json lives there too.
 */
export async function withWorkspaceRoot<T>(
  repoRoot: string,
  fn: () => Promise<T>
): Promise<T> {
  const resolved = path.resolve(repoRoot);
  const previous = {
    ALLOWED_REPO_ROOT: process.env.ALLOWED_REPO_ROOT,
    CODEX_GEMINI_INSTALL_ROOT: process.env.CODEX_GEMINI_INSTALL_ROOT,
  };
  process.env.ALLOWED_REPO_ROOT = resolved;
  process.env.CODEX_GEMINI_INSTALL_ROOT = resolved;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Persists the VS Code settings into the workspace worker-settings.json shared with the web UI. */
export async function syncWorkerSettings(
  repoRoot: string,
  settings: { tier: string; codexModel?: string }
): Promise<{ ok: boolean; error?: string }> {
  return withWorkspaceRoot(repoRoot, async () => {
    const response = await saveWorkerSettingsRequest(
      new Request('http://localhost/api/settings', {
        method: 'POST',
        body: JSON.stringify({ tier: settings.tier, codexModel: settings.codexModel?.trim() || null }),
      })
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error || `설정 저장 실패 (${response.status})` };
  });
}

/** Explicit presentation preferences the extension can show, change, and delete. */
export const MEMORY_PREFERENCES: Array<{
  key: WorkerPreferenceKey;
  label: string;
  values: Array<string | boolean>;
}> = [
  { key: 'responseLanguage', label: '응답 언어', values: [...RESPONSE_LANGUAGES] },
  { key: 'explanationDetail', label: '설명 상세도', values: [...EXPLANATION_DETAILS] },
  { key: 'planPresentation', label: '계획 표현', values: [...PLAN_PRESENTATIONS] },
  { key: 'preferTargetedTests', label: 'Targeted test 우선 표시', values: [true, false] },
  { key: 'completionNotifications', label: '완료 알림', values: [true, false] },
];

export type MemoryMutation =
  | { operation: 'setEnabled'; enabled: boolean }
  | { operation: 'setPreference'; key: WorkerPreferenceKey; value: unknown }
  | { operation: 'deletePreference'; key: WorkerPreferenceKey }
  | { operation: 'reset' };

/** Reads the workspace worker-settings.json memory block shared with the web UI. */
export async function readWorkspaceMemory(repoRoot: string): Promise<WorkerMemorySettings> {
  return withWorkspaceRoot(repoRoot, async () => readWorkerMemory());
}

/** Applies one explicit user mutation; inferred values never reach this path. */
export async function mutateWorkspaceMemory(
  repoRoot: string,
  mutation: MemoryMutation
): Promise<{ ok: boolean; memory?: WorkerMemorySettings; error?: string }> {
  return withWorkspaceRoot(repoRoot, async () => {
    try {
      switch (mutation.operation) {
        case 'setEnabled':
          return { ok: true, memory: setWorkerMemoryEnabled(mutation.enabled) };
        case 'setPreference':
          return { ok: true, memory: setWorkerPreference(mutation.key, mutation.value as never) };
        case 'deletePreference':
          return { ok: true, memory: deleteWorkerPreference(mutation.key) };
        case 'reset':
          return { ok: true, memory: resetWorkerPreferences() };
      }
    } catch (error) {
      const message = sanitizeUiError(error, repoRoot);
      return {
        ok: false,
        error: message === 'INVALID_MEMORY_MUTATION' ? '유효하지 않은 메모리 설정 요청입니다.' : message,
      };
    }
  });
}

/** One display row per repository memory record, with where it came from. */
export interface RepositoryMemoryRow {
  id: string;
  label: string;
  provenance: string;
  stale: boolean;
}

export interface RepositoryMemoryView {
  updatedAt: string;
  headCommit?: string;
  staleAgainstHead: boolean;
  staleRecords: number;
  rows: RepositoryMemoryRow[];
}

function toRow(record: {
  id: string;
  confidence: string;
  source: { type: string; runId: string; baseCommit?: string };
  lastValidatedAt: string;
  value: TaskHistoryValue | TestMapValue;
}): RepositoryMemoryRow {
  const value = record.value;
  const label =
    'file' in value
      ? `${value.file} · ${value.commands.join(', ') || '검증 명령 없음'}`
      : `${value.prompt.slice(0, 60)} · ${value.changedFiles.length}개 파일${
          value.merged === true ? ' · merged' : value.merged === false ? ' · unmerged' : ''
        }`;
  return {
    id: record.id,
    label,
    provenance: `${record.confidence} · ${record.source.type}:${record.source.runId}${
      record.source.baseCommit ? ` · ${record.source.baseCommit}` : ''
    } · ${record.lastValidatedAt.slice(0, 16).replace('T', ' ')}`,
    stale: record.confidence === 'stale',
  };
}

async function currentHeadCommit(repoRoot: string): Promise<string | undefined> {
  return (await readGitIdentity(repoRoot, createGitRunner())).head;
}

/** Rebuilds against the current HEAD, asking git which integration branches landed. */
async function rebuildMemory(repoRoot: string): Promise<void> {
  const headCommit = await currentHeadCommit(repoRoot);
  const git = createGitRunner();
  await rebuildRepositoryMemory({
    repoRoot,
    headCommit,
    isMerged: branch => isBranchMerged(repoRoot, branch, git),
  });
}

/** Reads the repository memory revalidated against the current checkout. */
export async function readRepositoryMemoryView(repoRoot: string): Promise<RepositoryMemoryView> {
  const headCommit = await currentHeadCommit(repoRoot);
  const snapshot = await withWorkspaceRoot(repoRoot, () =>
    readRepositoryMemory({ repoRoot, headCommit })
  );
  const rows = [...snapshot.taskHistory, ...snapshot.testMap].map(toRow);
  return {
    updatedAt: snapshot.updatedAt,
    headCommit: snapshot.headCommit,
    staleAgainstHead: snapshot.staleAgainstHead,
    staleRecords: rows.filter(row => row.stale).length,
    rows,
  };
}

/** Rebuilds the memory from the finished runs on disk. */
export async function rebuildRepositoryMemoryView(repoRoot: string): Promise<RepositoryMemoryView> {
  await withWorkspaceRoot(repoRoot, () => rebuildMemory(repoRoot));
  return readRepositoryMemoryView(repoRoot);
}

/** Deletes everything the repository memory holds for this workspace. */
export async function forgetRepositoryMemory(repoRoot: string): Promise<void> {
  await withWorkspaceRoot(repoRoot, () => clearRepositoryMemory(repoRoot));
}

export interface RunWorkerView {
  taskId?: string;
  task: string;
  model: string;
  status: string;
  elapsedSeconds: number;
  logs: string[];
}

export function toWorkerView(worker: LiveWorkerData): RunWorkerView {
  return {
    taskId: worker.taskId,
    task: worker.task,
    model: worker.model,
    status: String(worker.status),
    elapsedSeconds: worker.elapsedSeconds || 0,
    logs: (worker.recentLogs || []).map(log =>
      typeof log === 'string'
        ? log
        : [log.timestamp && `[${log.timestamp}]`, log.type && `[${log.type}]`, log.message]
            .filter(Boolean)
            .join(' ')
    ),
  };
}

/** Live workers keep their sanitized CLI tail; finished ones move to history. */
export async function getRunWorkers(
  repoRoot: string,
  runId: string
): Promise<{ active: RunWorkerView[]; history: RunWorkerView[]; failure: string[] }> {
  return withWorkspaceRoot(repoRoot, async () => {
    const details = await getRunDetails(runId, repoRoot);
    return {
      active: (details?.activeWorkers || []).map(toWorkerView),
      history: (details?.historyWorkers || []).map(toWorkerView),
      failure: runFailureLines(details).map(line => sanitizeText(line, repoRoot)),
    };
  });
}

export function toWebviewMessages(session: ConversationSession): WebviewMessage[] {
  return session.messages.map(message => ({
    id: message.id,
    sender: message.sender,
    text: message.text,
    intentType: message.intentType,
    approval: message.approval?.plan
      ? {
          approvalId: message.approval.approvalId,
          status: message.approval.status,
          title: message.approval.plan.title,
          explanation: message.approval.plan.explanation,
          steps: message.approval.plan.steps,
          affectedFiles: message.approval.plan.affectedFiles,
        }
      : undefined,
  }));
}

export async function chatWithCore(options: {
  message: string;
  executionPrompt?: string;
  repoRoot: string;
  sessionId?: string;
  forbidWorkers?: boolean;
  /** Overrides the model for this call; unset falls back to the saved settings. */
  codexModel?: string;
  codexRunner?: CodexRunnerFn;
  /** Receives sanitized Codex CLI output as it streams. */
  onOutput?: (text: string) => void;
  /** Aborting kills the Codex CLI; the result then carries CODEX_ABORTED_MESSAGE. */
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  session?: ConversationSession;
  error?: string;
}> {
  const onOutput = options.onOutput;
  const codexRunner: CodexRunnerFn | undefined =
    options.codexRunner ||
    (onOutput || options.signal
      ? params =>
          defaultCodexRunner({
            ...params,
            signal: options.signal,
            onOutput: onOutput && (chunk => onOutput(sanitizeText(chunk, options.repoRoot))),
          })
      : undefined);
  return withWorkspaceRoot(options.repoRoot, () =>
    evaluateCodexConversation({
      message: options.message,
      executionPrompt: options.executionPrompt,
      repoRoot: options.repoRoot,
      sessionId: options.sessionId,
      forbidWorkers: options.forbidWorkers,
      codexModel: options.codexModel,
      codexRunner,
    })
  );
}

export async function listSessionSummaries(repoRoot: string): Promise<SessionSummary[]> {
  return withWorkspaceRoot(repoRoot, async () => {
    const sessions = await listConversationSessions(repoRoot);
    return sessions.map(session => ({
      sessionId: session.sessionId,
      title: sessionTitle(session),
      updatedAt: session.updatedAt,
    }));
  });
}

export async function approvePlanWithCore(options: {
  sessionId: string;
  repoRoot: string;
  spawner?: SpawnerFn;
}): Promise<{
  ok: boolean;
  runId?: string;
  session?: ConversationSession;
  error?: string;
}> {
  return withWorkspaceRoot(options.repoRoot, () =>
    approveConversationPlan({
      sessionId: options.sessionId,
      repoRoot: options.repoRoot,
      spawner: options.spawner,
    })
  );
}

export async function loadSession(
  sessionId: string,
  repoRoot: string
): Promise<ConversationSession | null> {
  return withWorkspaceRoot(repoRoot, () => getConversationSession(sessionId, repoRoot));
}

/**
 * Status of the run this window tracks. Without a tracked run the line reads
 * `idle` even if older runs on disk failed: those belong to other sessions.
 */
export async function getRunStatusText(
  repoRoot: string,
  hasPendingApproval?: boolean,
  trackedRunId?: string
): Promise<string> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = trackedRunId ? await listCompactRuns(repoRoot) : [];
    const run = runs.find(item => item.runId === trackedRunId || item.actualRunId === trackedRunId);
    if (!run && !hasPendingApproval) return 'idle';
    return summarizeRunStatus({
      hasPendingApproval,
      status: run?.status,
      requiresUserAction: run?.requiresUserAction,
      activeWorkers: run?.activeWorkersCount,
    });
  });
}

export async function getActiveRunSummary(repoRoot: string): Promise<string> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const active = runs.find(run =>
      ['planning', 'running', 'retrying'].includes(run.status)
    );
    const target = active || runs[0];
    if (!target) return '실행 중인 Run이 없습니다.';
    const runId = target.actualRunId || target.runId;
    return `Run ${runId} · ${summarizeRunStatus({
      status: target.status,
      requiresUserAction: target.requiresUserAction,
      activeWorkers: target.activeWorkersCount,
    })} · ${target.prompt}`;
  });
}

export async function getWorkGraph(
  repoRoot: string,
  runId?: string
): Promise<ProjectWorkGraphData | null> {
  return withWorkspaceRoot(repoRoot, () => getProjectWorkGraph(runId || 'current', repoRoot));
}

export async function retryTrackedRun(options: {
  runId: string;
  repoRoot: string;
  spawner?: SpawnerFn;
}): Promise<{ ok: boolean; runId?: string; error?: string; isDuplicate?: boolean }> {
  try {
    const result = await withWorkspaceRoot(options.repoRoot, () =>
      retryRun({
        runId: options.runId,
        repoRoot: options.repoRoot,
        spawner: options.spawner,
      })
    );
    return {
      ok: true,
      runId: result.runId,
      isDuplicate: result.isDuplicate,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Mirrors stop-parallel-run.ps1: drop cancel.requested and kill the worker processes. */
export async function cancelRun(repoRoot: string, runId: string): Promise<boolean> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const run = runs.find(item => item.runId === runId || item.actualRunId === runId);
    const runDir = path.join(repoRoot, '.agent', 'runs', run?.actualRunId || runId);
    if (!fs.existsSync(runDir)) return false;
    await fs.promises.writeFile(path.join(runDir, 'cancel.requested'), new Date().toISOString(), 'utf8');
    const workersDir = path.join(runDir, 'workers');
    const files = fs.existsSync(workersDir) ? await fs.promises.readdir(workersDir) : [];
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try {
        const state = JSON.parse(await fs.promises.readFile(path.join(workersDir, file), 'utf8')) as {
          agentProcessId?: number;
          runnerProcessId?: number;
        };
        for (const pid of [state.agentProcessId, state.runnerProcessId]) {
          if (pid) try { process.kill(pid); } catch { /* already gone */ }
        }
      } catch {
        // Unreadable worker state: nothing to kill.
      }
    }
    return true;
  });
}

/**
 * Appends a one-time completion note for the run to the session and returns the
 * saved session, or null when the note already exists or the run is unknown.
 */
export async function appendRunCompletion(
  repoRoot: string,
  sessionId: string,
  runId: string
): Promise<ConversationSession | null> {
  return withWorkspaceRoot(repoRoot, async () => {
    const session = await getConversationSession(sessionId, repoRoot);
    const id = `run-summary-${runId}`;
    if (!session || session.messages.some(message => message.id === id)) return null;
    const details = await getRunDetails(runId, repoRoot);
    const linked = [runId, details?.actualRunId, details?.runId].some(id => id && session.linkedRunIds.includes(id));
    if (!details || !linked) return null;
    const workers = [...(details.activeWorkers || []), ...(details.historyWorkers || [])].map(worker => ({
      taskId: worker.taskId,
      task: worker.task,
      status: String(worker.status),
      changedFiles: worker.changedFiles,
      error: worker.error && sanitizeText(worker.error, repoRoot),
    }));
    const text = runCompletionLines({
      runId: details.actualRunId || runId,
      status: details.status,
      integrationBranch: details.integrationBranch,
      workers,
    }).join('\n');
    const timestamp = new Date().toISOString();
    session.messages.push({ id, sender: 'codex', text, timestamp, intentType: 'chat' });
    session.updatedAt = timestamp;
    await saveConversationSession(session, repoRoot);
    // A finished run is new evidence; fold it into the repository memory right away.
    await rebuildMemory(repoRoot);
    return session;
  });
}

/** Git refs a run's changes are compared against: its recorded base and integration branch. */
export interface RunRefs {
  baseCommit?: string;
  integrationBranch?: string;
}

export async function getRunRefs(repoRoot: string, runId: string): Promise<RunRefs> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const run = runs.find(item => item.runId === runId || item.actualRunId === runId);
    return { baseCommit: run?.baseCommit, integrationBranch: run?.integrationBranch };
  });
}

export async function getReviewContext(repoRoot: string): Promise<{
  graph: ProjectWorkGraphData | null;
  integrationBranch?: string;
  baseCommit?: string;
  runId?: string;
  status?: string;
}> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const review = runs.find(run => run.status === 'awaiting_review') || runs[0];
    if (!review) return { graph: null };
    const graph = await getProjectWorkGraph(review.runId, repoRoot);
    return {
      graph,
      integrationBranch: review.integrationBranch,
      baseCommit: review.baseCommit,
      runId: review.actualRunId || review.runId,
      status: review.status,
    };
  });
}

export async function getReviewSummary(repoRoot: string): Promise<string> {
  return withWorkspaceRoot(repoRoot, async () => {
    const runs = await listCompactRuns(repoRoot);
    const review = runs.find(run => run.status === 'awaiting_review') || runs[0];
    if (!review) return '검토할 변경이 없습니다.';
    const details = await getRunDetails(review.runId, repoRoot);
    const files = [
      ...(details?.activeWorkers || []).flatMap(worker => worker.changedFiles || []),
      ...(details?.historyWorkers || []).flatMap(worker => worker.changedFiles || []),
    ].slice(0, 12);
    const branch = review.integrationBranch || details?.integrationBranch;
    const fileList = files.length > 0 ? `\n변경 파일:\n${files.map(file => `- ${file}`).join('\n')}` : '';
    return `Run ${review.actualRunId || review.runId} · ${review.status}${
      branch ? ` · ${branch}` : ''
    }${fileList}`;
  });
}

export async function refreshCodexUsageLine(): Promise<{ line: string; detail?: string }> {
  const usage = getCodexDailyUsage({ bypassCache: true });
  if (!usage.ok || usage.status === 'error' || usage.status === 'not_found' || usage.status === 'empty') {
    return { line: formatUsageLine({ failed: true }) };
  }
  const windows: UsageWindow[] = [];
  const primary = usage.rateLimits?.primary;
  const secondary = usage.rateLimits?.secondary;
  if (primary) windows.push({ label: windowLabel(primary.window_minutes, '5h'), remainingPercent: primary.remaining_percent, resetsAt: primary.resets_at });
  if (secondary) windows.push({ label: windowLabel(secondary.window_minutes, 'weekly'), remainingPercent: secondary.remaining_percent, resetsAt: secondary.resets_at });
  return formatUsageDetail(windows);
}

function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

export async function refreshGeminiUsageLine(): Promise<{ line: string; detail?: string }> {
  const quota = await getGeminiQuota({ bypassCache: true });
  if (!quota.ok || quota.status !== 'available' || !quota.quota?.fiveHour) {
    return { line: formatUsageLine({ failed: true }) };
  }
  const windows: UsageWindow[] = [
    { label: '5h', remainingPercent: quota.quota.fiveHour.remainingPercent, resetsAt: quota.quota.fiveHour.resetTime },
  ];
  if (quota.quota.weekly) {
    windows.push({ label: 'weekly', remainingPercent: quota.quota.weekly.remainingPercent, resetsAt: quota.quota.weekly.resetTime });
  }
  return formatUsageDetail(windows);
}

export function createGitRunner(): (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return (args, cwd) =>
    new Promise(resolve => {
      const child = spawn('git', args, {
        cwd,
        env: sanitizeSpawnEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', chunk => {
        stderr += String(chunk);
      });
      child.on('error', error => resolve({ stdout: '', stderr: String(error), exitCode: 1 }));
      child.on('close', code => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    });
}
