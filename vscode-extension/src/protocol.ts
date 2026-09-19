import type { ProjectWorkGraphData } from '../../packages/orchestrator-core/project-event-graph.ts';

export type UsageProvider = 'codex' | 'gemini';
export type AuthState = 'not_installed' | 'unauthenticated' | 'authenticated' | 'unknown';

export interface GeminiTierOption {
  tier: string;
  model: string;
  description: string;
  available?: boolean;
}

/** Sanitized provider/model state. It intentionally has no raw CLI or credential fields. */
export interface AuthModelState {
  codex: {
    installed: boolean;
    authState: AuthState;
    authMethod?: 'ChatGPT' | 'API key';
    selectedModel?: string;
    modelOptions: string[];
  };
  gemini: {
    installed: boolean;
    authState: AuthState;
    selectedTier: string;
    selectedModel?: string;
    availableModels: string[];
    tiers: GeminiTierOption[];
  };
  selectorsDisabled: boolean;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
}

/** Everything the memory panel shows: explicit preferences plus repository memory rows. */
export interface MemoryPanelState {
  enabled: boolean;
  preferences: Array<{
    key: string;
    label: string;
    values: Array<string | boolean>;
    value?: string | boolean;
    updatedAt?: string;
  }>;
  repository: {
    updatedAt: string;
    staleAgainstHead: boolean;
    staleRecords: number;
    rows: Array<{ id: string; label: string; provenance: string; stale: boolean }>;
  };
}

export type HostToWebview =
  | { type: 'session'; sessionId: string; messages: WebviewMessage[] }
  | ({ type: 'memory' } & MemoryPanelState)
  | { type: 'sessions'; items: SessionSummary[]; activeSessionId?: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; provider: UsageProvider; line: string; detail?: string }
  | { type: 'runStatus'; text: string }
  | { type: 'context'; text: string }
  | { type: 'busy'; active: boolean; reason?: string }
  | { type: 'progress'; source: 'codex' | 'run'; lines: string[]; tone?: 'error' }
  | ({ type: 'authModelState' } & AuthModelState)
  /** While a run is in flight every message is a question: no plan card can appear. */
  | { type: 'inputMode'; questionOnly: boolean };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'chat'; text: string; attachContext?: boolean }
  | { type: 'openFile'; file: string }
  | { type: 'refreshUsage'; provider: UsageProvider }
  | { type: 'approvePlan' }
  | { type: 'newSession' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'explainSelection' }
  | { type: 'planFixForSelection' }
  | { type: 'cancel' }
  | { type: 'memoryGet' }
  | {
      type: 'memoryMutate';
      mutation: { operation: string; key?: string; value?: unknown; enabled?: boolean };
    }
  | { type: 'repoMemoryRebuild' }
  | { type: 'repoMemoryClear' }
  | { type: 'refreshAuthModelState' }
  | { type: 'loginCodex' }
  | { type: 'loginGemini' }
  /** Empty string selects the Codex CLI default; null opens validated direct input. */
  | { type: 'setCodexModel'; model: string | null }
  | { type: 'setGeminiTier'; tier: string };

export function busyStatusText(reason?: string): string {
  return reason?.trim() || '요청 처리 중…';
}

export function sessionTitle(session: {
  sessionId: string;
  messages: Array<{ sender: string; text: string }>;
}): string {
  const first = session.messages.find(message => message.sender === 'user')?.text.trim();
  if (!first) return session.sessionId;
  const line = first.split(/\r?\n/)[0];
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/** Keeps the tail of raw CLI output as short, non-empty lines for a live view. */
export function tailProgressLines(buffer: string, limit = 8): string[] {
  return buffer
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-limit);
}

/** One-line run progress for the chat; the Task Graph view carries the detail. */
export function runProgressLines(graph: ProjectWorkGraphData | null): string[] {
  if (!graph) return [];
  const workers = new Set(
    graph.nodes.filter(node => node.taskId && (node.status === 'running' || node.status === 'retrying')).map(node => node.taskId)
  );
  const retries = graph.nodes.reduce((sum, node) => sum + (node.retryHistory?.length || 0), 0);
  return [`Run ${graph.runId} · ${graph.status} · 워커 ${workers.size} · 재시도 ${retries}`];
}

export const TERMINAL_RUN_STATUSES = new Set(['completed', 'awaiting_review', 'failed', 'cancelled', 'timed_out']);

export interface RunCompletionInput {
  runId: string;
  status: string;
  integrationBranch?: string;
  workers: Array<{ taskId?: string; task: string; status: string; changedFiles?: string[]; error?: string | null }>;
}

/** Chat block posted once when a run reaches a terminal state: what ran and which files changed. */
export function runCompletionLines(run: RunCompletionInput): string[] {
  const head = { completed: '✅ Run 완료', awaiting_review: '✅ Run 완료 · 검토 대기', cancelled: '⏹ Run 중단됨' }[run.status]
    || `⚠ Run 종료 · ${run.status}`;
  const lines = [`${head} · ${run.runId}${run.integrationBranch ? ` · ${run.integrationBranch}` : ''}`];
  for (const worker of run.workers) {
    lines.push(`- ${[worker.taskId, worker.task].filter(Boolean).join(' ')} · ${worker.status}`);
    for (const file of worker.changedFiles || []) lines.push(`    ${file}`);
    if (worker.error) lines.push(`    사유: ${worker.error}`);
  }
  if (run.workers.length === 0) lines.push('- 실행된 워커가 없습니다.');
  return lines;
}

export interface WebviewMessage {
  id: string;
  sender: 'user' | 'codex';
  text: string;
  intentType?: string;
  approval?: {
    approvalId: string;
    status: string;
    title: string;
    explanation: string;
    steps: string[];
    affectedFiles?: string[];
  };
}

export interface RunFailureInput {
  status: string;
  error?: string | null;
  failureReason?: string;
  errorDisplayName?: string;
  retryable?: boolean;
  requiresUserAction?: boolean;
  userActionReason?: string;
  retryOf?: string;
}

/** Korean, human-readable failure block for the chat; empty when the run is not failed. */
export function runFailureLines(run: RunFailureInput | null | undefined): string[] {
  if (!run) return [];
  const failed = run.status === 'failed' || run.requiresUserAction;
  if (!failed) return [];
  const reason = (run.failureReason || run.error || '').trim();
  const lines = [`⚠ Run 실패 · ${run.errorDisplayName || (run.requiresUserAction ? '사용자 조치 필요' : '오류')}`];
  if (reason) lines.push(`사유: ${reason}`);
  if (run.requiresUserAction) {
    lines.push(`조치: ${run.userActionReason || '사용자 결정이 필요합니다. 자동 재시도하지 않습니다.'}`);
  } else if (run.retryable === false) {
    lines.push('조치: 자동 재시도할 수 없는 실패입니다.');
  } else {
    lines.push('조치: 원인을 해결한 뒤 Task Graph의 재시도 버튼을 누르세요.');
  }
  if (run.retryOf) lines.push(`이전 시도: ${run.retryOf}`);
  return lines;
}
