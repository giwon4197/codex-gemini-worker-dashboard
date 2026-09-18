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
  runs: RestorableRun[],
  linkedToSession?: string
): string | undefined {
  const match = (id?: string) =>
    id ? runs.find(run => run.runId === id || run.actualRunId === id) : undefined;
  const storedMatch = match(stored);
  if (storedMatch) return storedMatch.runId;
  // Only the resumed conversation's own run comes back. A run this window never
  // tracked stays unlinked; use "Show Active Run" to pick it up deliberately.
  return match(linkedToSession)?.runId;
}

export function resolveSessionId(
  stored: string | undefined,
  sessions: RestorableSession[],
  resumeSessionId?: string
): string | undefined {
  if (stored && sessions.some(session => session.sessionId === stored)) {
    return stored;
  }
  // A window without its own stored session resumes the workspace selection,
  // never just the newest conversation on disk.
  if (resumeSessionId && sessions.some(session => session.sessionId === resumeSessionId)) {
    return resumeSessionId;
  }
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
