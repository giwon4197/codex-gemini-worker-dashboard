import { ACTIVE_RUN_STATUSES } from './graph-tree.ts';
export interface RestorableRun {
  runId: string;
  actualRunId?: string;
  status: string;
  createdAt: string;
}

export interface RestorableSession {
  sessionId: string;
  updatedAt: string;
}

export function resolveTrackedRunId(
  stored: string | undefined,
  runs: RestorableRun[]
): string | undefined {
  const storedMatch = stored
    ? runs.find(run => run.runId === stored || run.actualRunId === stored)
    : undefined;
  if (storedMatch) return storedMatch.runId;
  // A fresh window never adopts a run it did not start; use "Show Active Run"
  // to pick up work left over from a previous window.
  return undefined;
}

export function resolveSessionId(
  stored: string | undefined,
  sessions: RestorableSession[]
): string | undefined {
  if (stored && sessions.some(session => session.sessionId === stored)) {
    return stored;
  }
  // No stored session means a fresh window, which starts a new conversation.
  return undefined;
}

/** In-flight runs on disk that this window is not tracking (left over from another window). */
export function countUnlinkedActiveRuns(
  trackedRunId: string | undefined,
  runs: RestorableRun[]
): number {
  return runs.filter(
    run =>
      ACTIVE_RUN_STATUSES.has(run.status) &&
      run.runId !== trackedRunId &&
      run.actualRunId !== trackedRunId
  ).length;
}

export function statusBarLabel(status: string, unlinkedActiveRuns = 0): string {
  const base = `$(comment-discussion) ${status}`;
  return unlinkedActiveRuns > 0 ? `${base} · 진행 중 Run ${unlinkedActiveRuns} (연결 안 됨)` : base;
}
