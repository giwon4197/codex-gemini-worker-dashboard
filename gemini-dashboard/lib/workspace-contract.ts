// Workspace Data Contract, Status Normalization, and Pure Functions

export type RunStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'escalated';

export type WorkerStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'retrying'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'policy_violation'
  | 'test_failed'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted'
  | 'escalated';

export type TimelineStage =
  | 'plan'
  | 'execute'
  | 'retry'
  | 'verify'
  | 'complete'
  | 'action_required';

export type TimelineEventStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'warning';

export interface TimelineEvent {
  id: string;
  stage: TimelineStage;
  title: string;
  description: string;
  timestamp: string;
  status: TimelineEventStatus;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface LiveWorkerLog {
  timestamp: string;
  message: string;
  type: string;
}

export interface LiveWorkerPolicy {
  filesystemPolicy?: 'v2.1' | string;
  allowedFiles?: string[];
  readScope?: {
    root?: 'task_worktree' | string;
    mode?: 'project_wide_search' | string;
    deny?: string[];
  };
  writeScope?: {
    expected?: string[];
    derived_auto_expand?: boolean;
    derived_approved?: string[];
    sensitive?: string[];
    forbidden?: string[];
  };
  mergeScope?: {
    expected?: string[];
    deny?: string[];
  };
  entries?: Array<{
    path: string;
    classification:
      | 'EXPECTED'
      | 'DERIVED_APPROVED'
      | 'DERIVED_UNAPPROVED'
      | 'SENSITIVE_UNAPPROVED'
      | 'FORBIDDEN'
      | 'MERGE_DENIED'
      | 'MERGE_SCOPE_VIOLATION'
      | string;
    authorized: boolean;
    sensitive?: boolean;
    matchedPattern?: string | null;
    comparisonMode?: 'literal_exact' | 'policy_glob' | 'none' | string;
  }>;
  violations?: string[];
  sensitiveTouched?: number;
  status?: 'PASS' | 'FAIL';
}

export interface LiveWorkerVerificationCommand {
  command: string;
  exitCode: number;
  durationSeconds?: number;
  output?: string;
  status: 'PASS' | 'FAIL';
}

export interface LiveWorkerVerification {
  decision?: string;
  commands?: LiveWorkerVerificationCommand[];
  verifiedAt?: string;
}

export interface LiveWorkerEscalation {
  requiresCodex?: boolean;
  category?: string;
  reason?: string;
}

export interface LiveWorkerRetryRecord {
  attempt: number;
  decision: string;
  fingerprint?: string;
  failureLog?: string;
  verifiedAt?: string;
}

export interface LiveWorkerData {
  runId: string;
  taskId?: string;
  attempt?: number;
  retryLimit?: number;
  task: string;
  model: string;
  status: WorkerStatus;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  recentLogs: (LiveWorkerLog | string)[];
  partialUsage?: {
    prompt: number;
    candidates: number;
    cached: number;
    thoughts: number;
    total: number;
  };
  finalResponse?: string | null;
  error?: string | null;
  policy?: LiveWorkerPolicy;
  verification?: LiveWorkerVerification;
  escalation?: LiveWorkerEscalation;
  changedFiles?: string[];
  commitHashes?: string[];
  retryHistory?: LiveWorkerRetryRecord[];
}

export interface TaskProgressSummary {
  runId: string;
  taskId: string;
  taskName: string;
  status: WorkerStatus;
  model: string;
  attempt: number;
  retryLimit: number;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  requiresUserAction: boolean;
  userActionReason?: string;
  currentStage: TimelineStage;
  timeline: TimelineEvent[];
  changedFiles?: string[];
  verificationDecision?: string;
  error?: string | null;
}

export interface CompactRunState {
  runId: string;
  actualRunId?: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  requiresUserAction: boolean;
  userActionReason?: string;
  tasksCount: number;
  activeWorkersCount: number;
  completedTasksCount: number;
  integrationBranch?: string;
  baseCommit?: string;
  orchestratorProcessId?: number;
  error?: string | null;
  failureLogPath?: string;
  failureReason?: string;
  exitCode?: number | null;
  errorCategory?: string;
  errorDisplayName?: string;
  retryable?: boolean;
  retryOf?: string;
  retriedByRunId?: string;
  retryCount?: number;
}

export interface LaunchMetadata {
  dashboardRunId: string;
  orchestratorProcessId?: number | null;
  startedAt: string;
  endedAt?: string | null;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number | null;
  actualRunId?: string | null;
  error?: string | null;
  logPath?: string;
}

export interface RunAliasRecord {
  dashboardRunId: string;
  actualRunId?: string | null;
  orchestratorProcessId?: number;
  createdAt: string;
  linkedAt?: string;
  prompt?: string;
}

export interface RunDetail extends CompactRunState {
  tasks: TaskProgressSummary[];
  activeWorkers: LiveWorkerData[];
  historyWorkers: LiveWorkerData[];
  timeline: TimelineEvent[];
  agentMessage?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  repositoryPath: string;
  currentBranch?: string;
  activeRunsCount: number;
  activeWorkersCount: number;
  lastRunAt?: string;
}

export interface StatusMeta {
  label: string;
  shortLabel: string;
  koreanDesc: string;
  badgeClass: string;
  textClass: string;
  borderClass: string;
  tone: 'info' | 'success' | 'danger' | 'warning' | 'purple' | 'slate';
}

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  pending: {
    label: '대기 중',
    shortLabel: '대기',
    koreanDesc: '작업 요청이 대기 큐에 등록되었습니다.',
    badgeClass: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-500/40',
    tone: 'slate',
  },
  planning: {
    label: '계획 수립 중',
    shortLabel: '계획',
    koreanDesc: 'Codex 라우터가 작업 계획을 생성하고 있습니다.',
    badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/40',
    tone: 'info',
  },
  running: {
    label: '실행 중',
    shortLabel: '실행',
    koreanDesc: '워커가 작업을 진행 중입니다.',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/50 animate-pulse',
    textClass: 'text-cyan-300',
    borderClass: 'border-cyan-500/50',
    tone: 'info',
  },
  awaiting_review: {
    label: '검토 대기 중',
    shortLabel: '검토대기',
    koreanDesc: '작업이 완료되어 통합 브랜치에서 사용자 검토 및 승인을 기다립니다.',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-400/60 font-semibold',
    textClass: 'text-amber-300',
    borderClass: 'border-amber-500/60',
    tone: 'warning',
  },
  completed: {
    label: '완료됨',
    shortLabel: '완료',
    koreanDesc: '모든 작업과 검증이 정상적으로 완료되었습니다.',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/50',
    tone: 'success',
  },
  failed: {
    label: '실패함',
    shortLabel: '실패',
    koreanDesc: '작업 실행 중 오류가 발생했습니다.',
    badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-400/50',
    textClass: 'text-rose-400',
    borderClass: 'border-rose-500/50',
    tone: 'danger',
  },
  cancelled: {
    label: '취소됨',
    shortLabel: '취소',
    koreanDesc: '사용자 요청 또는 시스템에 의해 작업이 취소되었습니다.',
    badgeClass: 'bg-slate-600/25 text-slate-300 border-slate-500/40',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-600/50',
    tone: 'slate',
  },
  escalated: {
    label: '에스컬레이션',
    shortLabel: '조치필요',
    koreanDesc: '자동 복구 한도 초과 또는 예외로 인해 사용자나 Codex의 확인이 필요합니다.',
    badgeClass: 'bg-purple-500/25 text-purple-300 border-purple-400/60 font-semibold',
    textClass: 'text-purple-300',
    borderClass: 'border-purple-500/60',
    tone: 'purple',
  },
};

export const WORKER_STATUS_META: Record<WorkerStatus, StatusMeta> = {
  pending: {
    label: '대기 중',
    shortLabel: '대기',
    koreanDesc: '워커 시작 대기 중입니다.',
    badgeClass: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-500/40',
    tone: 'slate',
  },
  planning: {
    label: '계획 수립',
    shortLabel: '계획',
    koreanDesc: '작업 환경 준비 및 작업 계획 분석 중입니다.',
    badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    textClass: 'text-cyan-400',
    borderClass: 'border-cyan-500/40',
    tone: 'info',
  },
  running: {
    label: '실행 중',
    shortLabel: '실행',
    koreanDesc: '코드 수정 및 추론이 백그라운드에서 진행 중입니다.',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/50',
    textClass: 'text-cyan-300',
    borderClass: 'border-cyan-500/50',
    tone: 'info',
  },
  retrying: {
    label: '재시도 중',
    shortLabel: '재시도',
    koreanDesc: '이전 시도 실패 후 상위 모델 또는 전략으로 재시도 중입니다.',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-400/50',
    textClass: 'text-amber-300',
    borderClass: 'border-amber-500/50',
    tone: 'warning',
  },
  verifying: {
    label: '검증 중',
    shortLabel: '검증',
    koreanDesc: '빌드, 테스트, 린트 결정론적 검사를 실행하고 있습니다.',
    badgeClass: 'bg-violet-500/20 text-violet-300 border-violet-400/50',
    textClass: 'text-violet-300',
    borderClass: 'border-violet-500/50',
    tone: 'purple',
  },
  completed: {
    label: '완료됨',
    shortLabel: '완료',
    koreanDesc: '모든 검증을 통과하고 성공적으로 커밋되었습니다.',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/40',
    tone: 'success',
  },
  failed: {
    label: '실패함',
    shortLabel: '실패',
    koreanDesc: '워커 프로세스 오류가 발생했습니다.',
    badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-400/40',
    textClass: 'text-rose-400',
    borderClass: 'border-rose-500/40',
    tone: 'danger',
  },
  policy_violation: {
    label: '정책 위반',
    shortLabel: '정책위반',
    koreanDesc: '허용 범위(allowed_files) 외부 파일 변경이 감지되어 차단되었습니다.',
    badgeClass: 'bg-amber-500/25 text-amber-300 border-amber-400/60 font-semibold',
    textClass: 'text-amber-300',
    borderClass: 'border-amber-500/60',
    tone: 'warning',
  },
  test_failed: {
    label: '검증 실패',
    shortLabel: '검증실패',
    koreanDesc: '결정론적 검증 테스트를 통과하지 못했습니다.',
    badgeClass: 'bg-rose-500/25 text-rose-300 border-rose-400/60 font-semibold',
    textClass: 'text-rose-300',
    borderClass: 'border-rose-500/60',
    tone: 'danger',
  },
  timed_out: {
    label: '시간 초과',
    shortLabel: '타임아웃',
    koreanDesc: '제한 시간을 초과하여 프로세스가 중지되었습니다.',
    badgeClass: 'bg-orange-500/20 text-orange-300 border-orange-400/50',
    textClass: 'text-orange-400',
    borderClass: 'border-orange-500/50',
    tone: 'warning',
  },
  cancelled: {
    label: '취소됨',
    shortLabel: '취소',
    koreanDesc: '사용자 또는 시스템에 의해 작업이 취소되었습니다.',
    badgeClass: 'bg-slate-600/25 text-slate-300 border-slate-500/40',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-600/50',
    tone: 'slate',
  },
  interrupted: {
    label: '중단됨',
    shortLabel: '중단',
    koreanDesc: '오케스트레이터 종료 후 정리되었습니다.',
    badgeClass: 'bg-slate-600/25 text-slate-300 border-slate-500/40',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-600/50',
    tone: 'slate',
  },
  escalated: {
    label: '에스컬레이션',
    shortLabel: '에스컬레이션',
    koreanDesc: '자동 복구 불가로 Codex 또는 사용자 조치가 필요합니다.',
    badgeClass: 'bg-purple-500/25 text-purple-300 border-purple-400/60 font-semibold',
    textClass: 'text-purple-300',
    borderClass: 'border-purple-500/60',
    tone: 'purple',
  },
};

/**
 * Normalizes run status string to strict RunStatus union.
 */
export function normalizeRunStatus(status?: string | null): RunStatus {
  if (!status) return 'running';
  const s = status.trim().toLowerCase();
  if (s === 'awaiting_review') return 'awaiting_review';
  if (s === 'completed' || s === 'success' || s === 'done') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'escalated' || s === 'requirescodex') return 'escalated';
  if (s === 'planning') return 'planning';
  if (s === 'pending') return 'pending';
  return 'running';
}

/**
 * Normalizes worker status string to strict WorkerStatus union.
 */
export function normalizeWorkerStatus(status?: string | null): WorkerStatus {
  if (!status) return 'running';
  const s = status.trim().toLowerCase();
  if (s === 'policy_violation') return 'policy_violation';
  if (s === 'test_failed') return 'test_failed';
  if (s === 'timed_out' || s === 'timeout') return 'timed_out';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  if (s === 'interrupted') return 'interrupted';
  if (s === 'escalated' || s === 'requirescodex') return 'escalated';
  if (s === 'retrying' || s === 'retry') return 'retrying';
  if (s === 'verifying' || s === 'verification') return 'verifying';
  if (s === 'planning') return 'planning';
  if (s === 'completed' || s === 'success' || s === 'done' || s === 'awaiting_review') return 'completed';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'pending') return 'pending';
  return 'running';
}

/**
 * Returns true if the worker is currently active and should appear in the live terminal panel.
 * Terminal states (completed, failed, timed_out, cancelled, escalated, etc.) return false
 * and must immediately drop out of the active terminal panel.
 */
export function isWorkerActive(status?: string | null): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  if (
    s === 'completed' ||
    s === 'success' ||
    s === 'done' ||
    s === 'failed' ||
    s === 'error' ||
    s === 'policy_violation' ||
    s === 'test_failed' ||
    s === 'timed_out' ||
    s === 'timeout' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'interrupted' ||
    s === 'escalated' ||
    s === 'requirescodex' ||
    s === 'awaiting_review'
  ) {
    return false;
  }
  const normalized = normalizeWorkerStatus(status);
  return (
    normalized === 'planning' ||
    normalized === 'running' ||
    normalized === 'retrying' ||
    normalized === 'verifying' ||
    normalized === 'pending'
  );
}

/**
 * Identifies whether an error represents an orchestrator / launcher failure
 * (e.g. bootstrap, PowerShell initialization, missing tools, early exit, manifest timeout).
 * Criterion 6: 실행기 오류는 requiresUserAction=false, 표시명 '실행기 오류', 재시도 가능으로 분류.
 */
export function isLauncherError(
  reason?: string | null,
  errorCategory?: string | null
): boolean {
  if (errorCategory === 'launcher_error') return true;
  if (!reason) return false;
  const r = reason.toLowerCase();
  return (
    r.includes('실행기 오류') ||
    r.includes('bootstrap') ||
    r.includes('powershell') ||
    r.includes('매니페스트') ||
    r.includes('manifest') ||
    r.includes('조기 종료') ||
    r.includes('도구') ||
    r.includes('pwsh') ||
    r.includes('launcher') ||
    r.includes('환경') ||
    r.includes('environment')
  );
}

/**
 * Identifies whether a run or worker state requires explicit user or Codex action.
 * Criterion 6: bootstrap/PowerShell/환경/조기 종료/manifest 미생성 같은 실행기 오류는
 * requiresUserAction=false로 분류한다.
 * awaiting_review, 정책 위반, 실제 검토/escalation처럼 승인·검토가 필요한 상태만 true로 남긴다.
 */
export function requiresUserAction(
  status?: string | null,
  escalation?: LiveWorkerEscalation | null,
  errorCategory?: string | null,
  errorReason?: string | null
): boolean {
  if (errorCategory === 'launcher_error' || isLauncherError(errorReason, errorCategory)) {
    return false;
  }
  if (escalation?.requiresCodex) return true;
  if (!status) return false;
  const s = status.trim().toLowerCase();
  return (
    s === 'awaiting_review' ||
    s === 'escalated' ||
    s === 'policy_violation' ||
    s === 'test_failed' ||
    s === 'requirescodex'
  );
}

/**
 * Returns a human-friendly Korean reason string explaining the required action.
 */
export function getUserActionReason(
  status?: string | null,
  escalation?: LiveWorkerEscalation | null,
  errorCategory?: string | null,
  errorReason?: string | null
): string | undefined {
  if (errorCategory === 'launcher_error' || isLauncherError(errorReason, errorCategory)) {
    return undefined;
  }
  if (escalation?.requiresCodex && escalation?.reason) {
    return escalation.reason;
  }
  if (!status) return undefined;
  const s = status.trim().toLowerCase();
  if (s === 'awaiting_review') {
    return '통합 브랜치 생성이 완료되었습니다. main 병합 전 integration 브랜치 및 결과를 검토하고 승인하세요.';
  }
  if (s === 'policy_violation') {
    return '허용된 파일 범위(allowed_files) 외부의 수정이 감지되었습니다. 작업 범위를 검토하거나 승인해야 합니다.';
  }
  if (s === 'test_failed') {
    return '빌드 또는 테스트 검증에 실패했습니다. 테스트 실패 로그를 확인하고 수정 조치를 취하세요.';
  }
  if (s === 'escalated' || s === 'requirescodex') {
    return escalation?.reason || '자동 재시도 한도를 초과하여 상위 모델 또는 수동 개입이 필요합니다.';
  }
  return undefined;
}

export interface RetrySafetyDecision {
  canRetry: boolean;
  reason?: string;
}

/**
 * Pure function evaluating whether a failed run or graph tip is safe to retry.
 * Acceptance criteria 1:
 * - Only failed items that are retryable and do NOT require user action can be retried.
 * - Policy violation, secrets/credentials, destructive operations, Codex escalation,
 *   or user action required must NOT show retry, returning a sanitized action reason instead.
 */
export function evaluateRunRetrySafety(run: {
  status?: string | null;
  requiresUserAction?: boolean;
  userActionReason?: string;
  errorCategory?: string | null;
  failureReason?: string | null;
  error?: string | null;
  retryable?: boolean;
  escalation?: LiveWorkerEscalation | null;
}): RetrySafetyDecision {
  const s = (run.status || '').trim().toLowerCase();

  // 1. Must be in failed state
  if (s !== 'failed') {
    if (s === 'awaiting_review') {
      return {
        canRetry: false,
        reason: '통합 브랜치 검토 및 승인 대기 상태입니다. main 병합 전 검토 및 승인이 필요합니다.',
      };
    }
    if (s === 'running' || s === 'planning' || s === 'pending' || s === 'retrying' || s === 'verifying') {
      return {
        canRetry: false,
        reason: '작업이 현재 진행 중입니다.',
      };
    }
    if (s === 'completed') {
      return {
        canRetry: false,
        reason: '이미 정상 완료된 작업입니다.',
      };
    }
    return {
      canRetry: false,
      reason: '실패한 작업만 재시도할 수 있습니다.',
    };
  }

  // 2. Policy violations (allowed_files violation)
  const isPolicyViolation =
    run.errorCategory === 'policy_violation' ||
    /정책\s*위반|allowed_files|policy_violation/i.test(run.failureReason || '') ||
    /정책\s*위반|allowed_files|policy_violation/i.test(run.error || '');
  if (isPolicyViolation) {
    return {
      canRetry: false,
      reason: '허용된 파일 범위(allowed_files) 외부 수정이 감지되어 자동 재시도가 차단되었습니다. 작업 범위를 검토하거나 승인하세요.',
    };
  }

  // 3. Secrets / credential leaks / token disclosure
  const isSecretsRelated =
    run.errorCategory === 'secret_violation' ||
    /비밀|secret|token|credential|api[_-]?key|password|passwd|auth/i.test(run.failureReason || '') ||
    /비밀|secret|token|credential|api[_-]?key|password|passwd|auth/i.test(run.error || '');
  if (isSecretsRelated) {
    return {
      canRetry: false,
      reason: '비밀정보 또는 인증 관련 오류가 감지되어 보안을 위해 자동 재시도가 차단되었습니다. 환경 설정과 인증 정보를 확인하세요.',
    };
  }

  // 4. Destructive operations (git hard reset, rm -rf, clean -fd, etc.)
  const isDestructive =
    run.errorCategory === 'destructive_action' ||
    /파괴적|destructive|reset\s+--hard|clean\s+-fd|rm\s+-rf|drop\s+table/i.test(run.failureReason || '') ||
    /파괴적|destructive/i.test(run.error || '');
  if (isDestructive) {
    return {
      canRetry: false,
      reason: '파괴적 작업 감지로 인해 자동 재시도가 차단되었습니다. 수동 확인 및 조치가 필요합니다.',
    };
  }

  // 5. Codex Escalation (requiresCodex: true or escalated status)
  const isEscalation =
    run.errorCategory === 'escalated' ||
    run.errorCategory === 'requirescodex' ||
    Boolean(run.escalation?.requiresCodex) ||
    /에스컬레이션|requirescodex|자동\s*복구\s*한도/i.test(run.failureReason || '') ||
    /에스컬레이션|requirescodex/i.test(run.error || '');
  if (isEscalation) {
    return {
      canRetry: false,
      reason: run.escalation?.reason || 'Codex 에스컬레이션 상태로 상위 모델 또는 대화형 수동 개입이 필요합니다.',
    };
  }

  // 6. Requires user action check
  if (
    run.requiresUserAction ||
    requiresUserAction(run.status, run.escalation, run.errorCategory, run.failureReason || run.error)
  ) {
    const actionReason =
      getUserActionReason(run.status, run.escalation, run.errorCategory, run.failureReason || run.error) ||
      run.userActionReason ||
      '사용자 결정 또는 승인이 필요한 상태이므로 자동 재시도할 수 없습니다.';
    return {
      canRetry: false,
      reason: actionReason,
    };
  }

  // 7. Explicit retryable flag set to false
  if (run.retryable === false) {
    return {
      canRetry: false,
      reason: run.failureReason || run.error || '재시도할 수 없는 작업입니다.',
    };
  }

  // 8. Safe to retry
  return {
    canRetry: true,
  };
}

/**
 * Pure function to extract a chronological list of timeline events from worker logs and metadata.
 * Criterion 5: 실제 run manifest, plan, worker/tool 로그, changedFiles 같은 실행 증거가 없으면
 * 계획 수립 및 도구·코드 수정 타임라인을 만들지 않는다.
 * 단순 failed 상태나 실행기 오류 자체는 실행 증거로 간주하지 않는다.
 */
export function extractTimelineEvents(params: {
  runId: string;
  status: WorkerStatus | RunStatus;
  startedAt?: string;
  updatedAt?: string;
  recentLogs?: (LiveWorkerLog | string)[];
  retryHistory?: LiveWorkerRetryRecord[];
  verification?: LiveWorkerVerification;
  escalation?: LiveWorkerEscalation;
  changedFiles?: string[];
  finalResponse?: string | null;
  error?: string | null;
  errorCategory?: string | null;
}): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const baseTime = params.startedAt || new Date().toISOString();
  const updateTime = params.updatedAt || baseTime;

  // Genuine execution evidence checks
  const hasLogs = Boolean(params.recentLogs && params.recentLogs.length > 0);
  const hasChangedFiles = Boolean(params.changedFiles && params.changedFiles.length > 0);
  const hasRetries = Boolean(params.retryHistory && params.retryHistory.length > 0);
  const hasVerification = Boolean(
    params.verification?.verifiedAt ||
    params.verification?.commands?.length ||
    params.status === 'verifying' ||
    params.status === 'test_failed'
  );
  const hasCompletion = params.status === 'completed' || Boolean(params.finalResponse);
  const hasEscalation = Boolean(params.escalation?.requiresCodex || params.escalation?.reason);

  // Pure execution evidence: simple 'failed' or launcher error is explicitly NOT execution evidence
  const hasExecutionEvidence =
    hasLogs ||
    hasChangedFiles ||
    hasRetries ||
    hasVerification ||
    hasCompletion ||
    hasEscalation;

  // If status is failed, cancelled, or pending without any genuine execution evidence, return empty timeline
  if (!hasExecutionEvidence && (params.status === 'failed' || params.status === 'cancelled' || params.status === 'pending')) {
    return [];
  }

  // 1. Planning Stage (Only if planning is ongoing or genuine execution has evidence)
  const hasPlanningEvidence = params.status === 'planning' || hasExecutionEvidence;
  if (hasPlanningEvidence) {
    events.push({
      id: `${params.runId}-stage-plan`,
      stage: 'plan',
      title: '계획 수립',
      description: '작업 요청 분석 및 안전한 실행 계획 수립',
      timestamp: baseTime,
      status: params.status === 'planning' ? 'in_progress' : 'passed',
    });
  }

  // 2. Execution Stage (Only if actual execution evidence exists)
  if (hasExecutionEvidence) {
    const isExecuting =
      params.status === 'running' ||
      params.status === 'retrying' ||
      params.status === 'verifying';
    const hasExecuted =
      params.status === 'completed' ||
      params.status === 'awaiting_review' ||
      params.status === 'test_failed' ||
      params.status === 'policy_violation' ||
      params.status === 'failed' ||
      params.status === 'timed_out' ||
      params.status === 'escalated';

    events.push({
      id: `${params.runId}-stage-execute`,
      stage: 'execute',
      title: '도구 및 코드 수정 실행',
      description: params.changedFiles?.length
        ? `${params.changedFiles.length}개 파일 변경 진행됨`
        : '에이전트 모델 추론 및 파일 작업 진행',
      timestamp: baseTime,
      status: isExecuting
        ? 'in_progress'
        : hasExecuted
          ? 'passed'
          : 'pending',
      meta: { changedFilesCount: params.changedFiles?.length || 0 },
    });
  }

  // 3. Retry Stage (if applicable)
  const retries = params.retryHistory || [];
  if (retries.length > 0 || params.status === 'retrying') {
    const latestRetry = retries[retries.length - 1];
    events.push({
      id: `${params.runId}-stage-retry`,
      stage: 'retry',
      title: `재시도 진행 (${retries.length}회)`,
      description: latestRetry?.decision || '실패 원인 분석 후 재시도 실행',
      timestamp: latestRetry?.verifiedAt || updateTime,
      status: params.status === 'retrying' ? 'in_progress' : 'warning',
      detail: latestRetry?.failureLog,
    });
  }

  // 4. Verification Stage
  const verification = params.verification;
  if (hasVerification) {
    const isPass = verification?.commands?.every(c => c.status === 'PASS');
    events.push({
      id: `${params.runId}-stage-verify`,
      stage: 'verify',
      title: '결정론적 검증 검사',
      description: isPass
        ? '빌드, 테스트, 린트 검증 통과'
        : params.status === 'verifying'
          ? '검증 테스트 수행 중'
          : '검증 테스트 실패 감지',
      timestamp: verification?.verifiedAt || updateTime,
      status:
        params.status === 'verifying'
          ? 'in_progress'
          : isPass
            ? 'passed'
            : 'failed',
      detail: verification?.decision,
    });
  }

  // 5. Completion Stage
  if (params.status === 'completed') {
    events.push({
      id: `${params.runId}-stage-complete`,
      stage: 'complete',
      title: '작업 완료',
      description: '모든 검증 통과 및 정상 커밋 완료',
      timestamp: updateTime,
      status: 'passed',
      detail: params.finalResponse || undefined,
    });
  }

  // 6. User Action Required Stage (if applicable)
  if (requiresUserAction(params.status, params.escalation)) {
    const actionReason = getUserActionReason(params.status, params.escalation);
    events.push({
      id: `${params.runId}-stage-action`,
      stage: 'action_required',
      title:
        params.status === 'awaiting_review'
          ? '통합 검토 및 승인 필요'
          : '사용자 조치 필요',
      description: actionReason || '사용자 또는 Codex의 후속 조치가 필요합니다.',
      timestamp: updateTime,
      status: params.status === 'awaiting_review' ? 'warning' : 'failed',
      detail: params.error || params.escalation?.reason,
    });
  } else if (params.status === 'failed' || params.status === 'timed_out') {
    events.push({
      id: `${params.runId}-stage-failed`,
      stage: 'complete',
      title: params.status === 'timed_out' ? '시간 초과로 중지됨' : '실행 실패',
      description: params.error || '워커 프로세스 오류 발생',
      timestamp: updateTime,
      status: 'failed',
    });
  }

  return events;
}

export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0초';
  const sec = Math.round(seconds);
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const rem = sec % 60;
  if (m < 60) return `${m}분 ${rem}초`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}시간 ${remM}분 ${rem}초`;
}

// ==========================================
// Codex Conversational Workspace Contracts
// ==========================================

export type ConversationIntentType = 'chat' | 'status' | 'action_plan';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface PlanDetails {
  title: string;
  explanation: string;
  steps: string[];
  affectedFiles?: string[];
}

export interface ConversationApproval {
  approvalId: string;
  sessionId: string;
  status: ApprovalStatus;
  plan: PlanDetails;
  idempotencyKey: string;
  prompt: string;
  createdAt: string;
  approvedAt?: string;
  runId?: string;
  error?: string;
}

export interface ConversationMessage {
  id: string;
  sender: 'user' | 'codex';
  text: string;
  timestamp: string;
  intentType?: ConversationIntentType;
  approval?: ConversationApproval;
  statusSummary?: {
    totalRuns: number;
    activeRuns?: number;
    activeWorkers: number;
    latestRunStatus?: string;
    latestRunId?: string;
  };
  error?: string;
}

export interface ConversationSession {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  pendingApproval?: ConversationApproval;
  lastApproval?: ConversationApproval;
  linkedRunIds: string[];
}

export function validateSessionId(sessionId: unknown): boolean {
  if (typeof sessionId !== 'string') return false;
  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return false;
  }
  return /^[0-9a-zA-Z_-]+$/.test(trimmed);
}

export function generateSessionId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 10);
  return `session-${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

export function createEmptyConversationSession(sessionId?: string): ConversationSession {
  const id = sessionId || generateSessionId();
  const now = new Date().toISOString();
  return {
    sessionId: id,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: `msg-welcome`,
        sender: 'codex',
        text: '안녕하세요! Codex 대화형 워크스페이스입니다. 질문, 상태 문의, 또는 작업 요청을 자연어로 입력하세요. 코드 변경 요청 시 실행 계획을 먼저 수립하여 승인을 요청합니다.',
        timestamp: now,
        intentType: 'chat',
      },
    ],
    linkedRunIds: [],
  };
}

export type {
  GraphNodeOwner,
  ActivityType,
  GraphNodeType,
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectWorkGraphData,
  RawWorkerEventRecord,
  ParsedWorkerActivity,
  BuildProjectGraphOptions,
} from './project-event-graph.ts';
export {
  SUPPORTED_ACTIVITIES,
  parseWorkerNDJSONLine,
  formatActivityLabel,
  buildProjectWorkGraph,
  sortGraphNodesNewestFirst,
  sortGraphNodesOldestFirst,
// @ts-expect-error TS5097 allowed for test runner
} from './project-event-graph.ts';
