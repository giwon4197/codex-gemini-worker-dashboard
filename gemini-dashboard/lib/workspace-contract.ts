// Workspace Data Contract, Status Normalization, and Pure Functions

export type DeliveryStage =
  | 'review_validation'
  | 'divergence_check'
  | 'conflict_check'
  | 'candidate_verification'
  | 'main_integration'
  | 'post_integration_verification'
  | 'push'
  | 'delivered';

export type DeliveryFailureCategory =
  | 'conflict'
  | 'divergence'
  | 'review_failed'
  | 'policy_violation'
  | 'unexpected_changes'
  | 'verification_failed'
  | 'missing_upstream'
  | 'push_rejected'
  | 'unknown';

export interface DeliveryInfo {
  status: 'delivering' | 'in_progress' | 'delivered' | 'failed' | 'skipped' | 'awaiting_review';
  stage?: DeliveryStage;
  stageName?: string;
  currentStage?: string;
  targetBranch?: string;
  remote?: string;
  candidateCommit?: string;
  deliveredCommit?: string;
  deliveredAt?: string;
  failureCategory?: DeliveryFailureCategory;
  failureReason?: string;
  diagnosticArtifactPath?: string;
  diagnosticArtifact?: string;
  guidance?: string;
  actionGuidance?: string;
  verificationCommands?: LiveWorkerVerificationCommand[];
}

export type LegacyRunStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'escalated';

export type DeliveryRunStatus =
  | 'delivering'
  | 'review_validation'
  | 'divergence_check'
  | 'conflict_check'
  | 'candidate_verification'
  | 'main_integration'
  | 'post_integration_verification'
  | 'push'
  | 'delivered';

export type RunStatus = LegacyRunStatus | DeliveryRunStatus;

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
  | 'delivery'
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
  allowedFiles?: string[];
  violations?: string[];
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
  delivery?: DeliveryInfo;
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
  delivering: {
    label: '전달 진행 중',
    shortLabel: '전달중',
    koreanDesc: 'main 브랜치 자동 검증 및 전달 파이프라인이 진행 중입니다.',
    badgeClass: 'bg-cyan-500/25 text-cyan-200 border-cyan-400/60 animate-pulse font-medium',
    textClass: 'text-cyan-300',
    borderClass: 'border-cyan-500/60',
    tone: 'info',
  },
  review_validation: {
    label: '검토 검증 중',
    shortLabel: '검토검증',
    koreanDesc: 'Codex 검토 결과 및 파일 변경 정책을 검증하고 있습니다.',
    badgeClass: 'bg-indigo-500/25 text-indigo-200 border-indigo-400/60 animate-pulse font-medium',
    textClass: 'text-indigo-300',
    borderClass: 'border-indigo-500/60',
    tone: 'info',
  },
  divergence_check: {
    label: '원격 분기 검사 중',
    shortLabel: '분기검사',
    koreanDesc: '원격 최신 변경사항 조회 및 로컬/원격 분기 여부를 확인하고 있습니다.',
    badgeClass: 'bg-sky-500/25 text-sky-200 border-sky-400/60 animate-pulse font-medium',
    textClass: 'text-sky-300',
    borderClass: 'border-sky-500/60',
    tone: 'info',
  },
  conflict_check: {
    label: '충돌 검사 중',
    shortLabel: '충돌검사',
    koreanDesc: 'main 브랜치와의 비파괴적 병합 가능성 및 충돌 여부를 검사하고 있습니다.',
    badgeClass: 'bg-amber-500/25 text-amber-200 border-amber-400/60 animate-pulse font-medium',
    textClass: 'text-amber-300',
    borderClass: 'border-amber-500/60',
    tone: 'warning',
  },
  candidate_verification: {
    label: '후보 커밋 검증 중',
    shortLabel: '후보검증',
    koreanDesc: '전달 대상 후보 커밋에서 결정론적 검증 테스트를 수행하고 있습니다.',
    badgeClass: 'bg-violet-500/25 text-violet-200 border-violet-400/60 animate-pulse font-medium',
    textClass: 'text-violet-300',
    borderClass: 'border-violet-500/60',
    tone: 'purple',
  },
  main_integration: {
    label: 'main 통합 중',
    shortLabel: '통합중',
    koreanDesc: 'main 브랜치로 비파괴적 병합을 진행하고 있습니다.',
    badgeClass: 'bg-blue-500/25 text-blue-200 border-blue-400/60 animate-pulse font-medium',
    textClass: 'text-blue-300',
    borderClass: 'border-blue-500/60',
    tone: 'info',
  },
  post_integration_verification: {
    label: '통합 후 최종 검증 중',
    shortLabel: '최종검증',
    koreanDesc: 'main 통합 후 모든 빌드 및 테스트를 재검증하고 있습니다.',
    badgeClass: 'bg-teal-500/25 text-teal-200 border-teal-400/60 animate-pulse font-medium',
    textClass: 'text-teal-300',
    borderClass: 'border-teal-500/60',
    tone: 'info',
  },
  push: {
    label: '원격 푸시 중',
    shortLabel: '푸시중',
    koreanDesc: '검증된 커밋을 원격 저장소로 푸시하고 있습니다.',
    badgeClass: 'bg-emerald-500/25 text-emerald-200 border-emerald-400/60 animate-pulse font-medium',
    textClass: 'text-emerald-300',
    borderClass: 'border-emerald-500/60',
    tone: 'info',
  },
  delivered: {
    label: '전달 완료',
    shortLabel: '전달완료',
    koreanDesc: 'main 브랜치 비파괴적 통합 및 원격 저장소 푸시가 안전하게 완료되었습니다.',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50 font-semibold',
    textClass: 'text-emerald-400',
    borderClass: 'border-emerald-500/50',
    tone: 'success',
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

/**
 * Safely resolves StatusMeta for any run status string, tolerating unknown future statuses.
 */
export function getRunStatusMeta(status?: string | null): StatusMeta {
  if (!status) return RUN_STATUS_META.running;
  const s = status.trim().toLowerCase();
  if (s in RUN_STATUS_META) {
    return RUN_STATUS_META[s as keyof typeof RUN_STATUS_META];
  }
  return {
    label: status,
    shortLabel: status.length > 8 ? status.slice(0, 8) : status,
    koreanDesc: `상태: ${status}`,
    badgeClass: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    textClass: 'text-slate-400',
    borderClass: 'border-slate-500/40',
    tone: 'slate',
  };
}

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
export function normalizeRunStatus<T extends RunStatus = LegacyRunStatus>(status?: string | null): T {
  let result: RunStatus = 'running';
  if (!status) return result as unknown as T;
  const s = status.trim().toLowerCase();
  if (s === 'delivered') result = 'delivered';
  else if (s === 'delivering') result = 'delivering';
  else if (s === 'review_validation' || s === 'validating_review' || s === 'review_validating') result = 'review_validation';
  else if (s === 'divergence_check' || s === 'checking_divergence' || s === 'fetch_check' || s === 'checking_remote') result = 'divergence_check';
  else if (s === 'conflict_check' || s === 'checking_conflicts') result = 'conflict_check';
  else if (s === 'candidate_verification' || s === 'verifying_candidate') result = 'candidate_verification';
  else if (s === 'main_integration' || s === 'integrating_main') result = 'main_integration';
  else if (s === 'post_integration_verification' || s === 'verifying_main' || s === 'post_verification') result = 'post_integration_verification';
  else if (s === 'push' || s === 'pushing') result = 'push';
  else if (s === 'awaiting_review') result = 'awaiting_review';
  else if (s === 'completed' || s === 'success' || s === 'done') result = 'completed';
  else if (s === 'failed' || s === 'error' || s === 'delivery_failed') result = 'failed';
  else if (s === 'cancelled' || s === 'canceled') result = 'cancelled';
  else if (s === 'escalated' || s === 'requirescodex') result = 'escalated';
  else if (s === 'planning') result = 'planning';
  else if (s === 'pending') result = 'pending';
  else result = 'running';
  return result as unknown as T;
}

/**
 * Returns true if the run is currently actively running (in planning, running, pending, or delivering stages).
 * Terminal states (completed, delivered, failed, cancelled, escalated, awaiting_review) return false.
 */
export function isRunActive(status?: string | null): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  if (
    s === 'completed' ||
    s === 'delivered' ||
    s === 'failed' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'escalated' ||
    s === 'requirescodex' ||
    s === 'awaiting_review'
  ) {
    return false;
  }
  const normalized = normalizeRunStatus<RunStatus>(status);
  return (
    normalized === 'planning' ||
    normalized === 'running' ||
    normalized === 'pending' ||
    normalized === 'delivering' ||
    normalized === 'review_validation' ||
    normalized === 'divergence_check' ||
    normalized === 'conflict_check' ||
    normalized === 'candidate_verification' ||
    normalized === 'main_integration' ||
    normalized === 'post_integration_verification' ||
    normalized === 'push'
  );
}

/**
 * Defensively classifies a delivery or run failure into a strict DeliveryFailureCategory.
 */
export function classifyDeliveryFailureCategory(
  category?: string | null,
  reason?: string | null,
  error?: string | null
): DeliveryFailureCategory {
  const c = (category || '').trim().toLowerCase();
  if (c === 'conflict' || c === 'merge_conflict') return 'conflict';
  if (c === 'divergence' || c === 'remote_diverged' || c === 'diverged') return 'divergence';
  if (c === 'push_rejected' || c === 'push_failure' || c === 'push_failed') return 'push_rejected';
  if (c === 'missing_upstream' || c === 'auth_failed' || c === 'authentication_failure' || c === 'auth_failure') return 'missing_upstream';
  if (c === 'unexpected_changes' || c === 'dirty_worktree' || c === 'unexpected_files') return 'unexpected_changes';
  if (c === 'review_failed' || c === 'review_failure' || c === 'review_rejected') return 'review_failed';
  if (c === 'policy_violation') return 'policy_violation';
  if (c === 'verification_failed' || c === 'test_failed' || c === 'build_failed') return 'verification_failed';

  const combined = `${c} ${reason || ''} ${error || ''}`.toLowerCase();
  if (/conflict|충돌/i.test(combined)) return 'conflict';
  if (/diverg|분기|behind|ahead/i.test(combined)) return 'divergence';
  if (/push.*reject|non-fast-forward|fast-forward|rejected.*push/i.test(combined)) return 'push_rejected';
  if (/upstream|remote.*not found|인증|credential|권한|authentication|auth/i.test(combined)) return 'missing_upstream';
  if (/unexpected.*change|dirty.*worktree|untracked|추적되지 않은/i.test(combined)) return 'unexpected_changes';
  if (/review.*fail|allowed_files|정책.*위반/i.test(combined)) return 'review_failed';
  if (/verification.*fail|test.*fail|build.*fail|검증.*실패/i.test(combined)) return 'verification_failed';

  return 'unknown';
}

/**
 * Returns a human-friendly Korean display name for a DeliveryFailureCategory.
 */
export function getDeliveryFailureDisplayName(category?: DeliveryFailureCategory): string {
  switch (category) {
    case 'conflict':
      return '통합 충돌';
    case 'divergence':
      return '원격 분기 감지';
    case 'review_failed':
      return '검토 실패';
    case 'policy_violation':
      return '정책 위반';
    case 'unexpected_changes':
      return '예상치 못한 파일 변경';
    case 'verification_failed':
      return '검증 실패';
    case 'missing_upstream':
      return '원격 저장소/인증 누락';
    case 'push_rejected':
      return '원격 푸시 거부';
    case 'unknown':
    default:
      return '자동 전달 오류';
  }
}

/**
 * Returns actionable, safe guidance for delivery failure recovery without leaking secrets.
 */
export function getDeliveryActionGuidance(
  category?: DeliveryFailureCategory,
  reason?: string | null,
  diagnosticPath?: string | null
): string {
  const artifactNote = diagnosticPath ? ` (진단 파일: ${diagnosticPath})` : '';
  switch (category) {
    case 'conflict':
      return `main 브랜치와의 병합 충돌이 감지되었습니다. 충돌 파일을 검토하고 수동으로 충돌을 해결하거나 통합 브랜치를 검토하세요.${artifactNote}`;
    case 'divergence':
      return `로컬 main과 원격 저장소 간 커밋 이력이 분기되었습니다. 원격 최신 변경사항을 가져와 동기화하세요.${artifactNote}`;
    case 'review_failed':
    case 'policy_violation':
      return `Codex 통합 검토 또는 허용된 파일 정책(allowed_files) 검증을 통과하지 못했습니다. 변경 범위와 검토 의견을 확인하세요.${artifactNote}`;
    case 'unexpected_changes':
      return `작업 트리에 예상치 못한 파일 변경 또는 미추적 파일이 감지되었습니다. 작업 트리를 정리한 후 다시 시도하세요.${artifactNote}`;
    case 'verification_failed':
      return `전달 후보 커밋 또는 main 통합 후 결정론적 테스트/빌드 검증에 실패했습니다. 테스트 실패 로그를 확인하고 수정하세요.${artifactNote}`;
    case 'missing_upstream':
      return `원격 저장소(upstream) 설정 또는 인증 자격 증명이 누락되었습니다. git remote 및 인증 설정을 확인하세요 (비밀값/토큰은 마스킹됨).${artifactNote}`;
    case 'push_rejected':
      return `원격 브랜치 푸시가 거부되었습니다(Non-fast-forward). 안전 정책상 강제 푸시(--force)는 사용되지 않으므로 원격 변경사항을 병합해야 합니다.${artifactNote}`;
    case 'unknown':
    default:
      return reason || `자동 전달 중 오류가 발생했습니다. 진단 내역을 확인하고 수동 조치를 진행하세요.${artifactNote}`;
  }
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
 * 자동 전달 진행 중 및 정상 전달 완료(delivered) 상태는 false를 반환하고,
 * 충돌, 분기, 푸시 거부 등 전달 실패는 true를 반환한다.
 */
export function requiresUserAction(
  status?: string | null,
  escalation?: LiveWorkerEscalation | null,
  errorCategory?: string | null,
  errorReason?: string | null,
  delivery?: DeliveryInfo | null
): boolean {
  if (errorCategory === 'launcher_error' || isLauncherError(errorReason, errorCategory)) {
    return false;
  }
  if (escalation?.requiresCodex) return true;
  if (!status) return false;
  const s = status.trim().toLowerCase();

  // Active delivery stages do NOT require user action
  if (
    s === 'delivering' ||
    s === 'review_validation' ||
    s === 'divergence_check' ||
    s === 'conflict_check' ||
    s === 'candidate_verification' ||
    s === 'main_integration' ||
    s === 'post_integration_verification' ||
    s === 'push'
  ) {
    return false;
  }

  // Delivered run does NOT require user action
  if (s === 'delivered') return false;

  // Legacy awaiting_review requires user action
  if (s === 'awaiting_review') return true;

  // Worker escalation and policy violations
  if (
    s === 'escalated' ||
    s === 'policy_violation' ||
    s === 'test_failed' ||
    s === 'requirescodex'
  ) {
    return true;
  }

  // Terminal delivery failure checks
  if (delivery?.status === 'failed' || s === 'failed') {
    const delCategory = delivery?.failureCategory || errorCategory;
    const cat = classifyDeliveryFailureCategory(delCategory, errorReason, delivery?.failureReason);
    if (cat !== 'unknown') {
      return true;
    }
  }

  return false;
}

/**
 * Returns a human-friendly Korean reason string explaining the required action.
 */
export function getUserActionReason(
  status?: string | null,
  escalation?: LiveWorkerEscalation | null,
  errorCategory?: string | null,
  errorReason?: string | null,
  delivery?: DeliveryInfo | null
): string | undefined {
  if (errorCategory === 'launcher_error' || isLauncherError(errorReason, errorCategory)) {
    return undefined;
  }
  if (escalation?.requiresCodex && escalation?.reason) {
    return escalation.reason;
  }
  if (!status) return undefined;
  const s = status.trim().toLowerCase();

  // Delivered status requires no action
  if (s === 'delivered') return undefined;

  // Active delivery stages require no action
  if (
    s === 'delivering' ||
    s === 'review_validation' ||
    s === 'divergence_check' ||
    s === 'conflict_check' ||
    s === 'candidate_verification' ||
    s === 'main_integration' ||
    s === 'post_integration_verification' ||
    s === 'push'
  ) {
    return undefined;
  }

  // Legacy awaiting_review
  if (s === 'awaiting_review') {
    return '통합 브랜치 생성이 완료되었습니다. main 병합 전 integration 브랜치 및 결과를 검토하고 승인하세요.';
  }

  // Terminal delivery failure guidance
  if (delivery?.status === 'failed' || s === 'failed') {
    const delCategory = delivery?.failureCategory || errorCategory;
    const cat = classifyDeliveryFailureCategory(delCategory, errorReason, delivery?.failureReason);
    if (cat !== 'unknown') {
      return getDeliveryActionGuidance(
        cat,
        delivery?.failureReason || errorReason,
        delivery?.diagnosticArtifactPath || delivery?.diagnosticArtifact
      );
    }
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
  delivery?: DeliveryInfo | null;
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
    if (s === 'delivered') {
      return {
        canRetry: false,
        reason: '이미 자동 전달이 정상 완료된 작업입니다.',
      };
    }
    if (
      s === 'running' ||
      s === 'planning' ||
      s === 'pending' ||
      s === 'retrying' ||
      s === 'verifying' ||
      s === 'delivering' ||
      s === 'review_validation' ||
      s === 'divergence_check' ||
      s === 'conflict_check' ||
      s === 'candidate_verification' ||
      s === 'main_integration' ||
      s === 'post_integration_verification' ||
      s === 'push'
    ) {
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
    run.delivery?.failureCategory === 'policy_violation' ||
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

  // 6. Delivery failure categories (conflict, divergence, push rejection, missing upstream)
  const delCategory = classifyDeliveryFailureCategory(
    run.delivery?.failureCategory || run.errorCategory,
    run.failureReason,
    run.error
  );
  if (delCategory === 'conflict') {
    return {
      canRetry: false,
      reason: 'main 브랜치와의 병합 충돌이 감지되어 자동 재시도가 차단되었습니다. 충돌을 수동으로 해결하거나 통합 브랜치를 검토하세요.',
    };
  }
  if (delCategory === 'divergence') {
    return {
      canRetry: false,
      reason: '자동 전달 중 로컬 main 브랜치와 원격 저장소 간 분기가 감지되어 자동 재시도가 차단되었습니다. 원격 최신 변경사항을 동기화하세요.',
    };
  }
  if (delCategory === 'push_rejected') {
    return {
      canRetry: false,
      reason: '원격 브랜치 푸시 거부로 인해 자동 재시도가 차단되었습니다. 비파괴 정책상 강제 푸시는 허용되지 않습니다.',
    };
  }
  if (delCategory === 'missing_upstream') {
    return {
      canRetry: false,
      reason: '원격 저장소 설정 또는 인증 문제로 인해 자동 재시도가 차단되었습니다. git remote 및 인증 설정을 확인하세요.',
    };
  }
  if (delCategory === 'unexpected_changes') {
    return {
      canRetry: false,
      reason: '예상치 못한 파일 변경이 감지되어 자동 재시도가 차단되었습니다. 작업 트리를 정리한 후 다시 시도하세요.',
    };
  }
  if (delCategory === 'review_failed') {
    return {
      canRetry: false,
      reason: 'Codex 통합 검토 정책을 통과하지 못해 자동 재시도가 차단되었습니다. 검토 의견을 확인하세요.',
    };
  }

  // 7. Requires user action check
  if (
    run.requiresUserAction ||
    requiresUserAction(run.status, run.escalation, run.errorCategory, run.failureReason || run.error, run.delivery)
  ) {
    const actionReason =
      getUserActionReason(run.status, run.escalation, run.errorCategory, run.failureReason || run.error, run.delivery) ||
      run.userActionReason ||
      '사용자 결정 또는 승인이 필요한 상태이므로 자동 재시도할 수 없습니다.';
    return {
      canRetry: false,
      reason: actionReason,
    };
  }

  // 8. Explicit retryable flag set to false
  if (run.retryable === false) {
    return {
      canRetry: false,
      reason: run.failureReason || run.error || '재시도할 수 없는 작업입니다.',
    };
  }

  // 9. Safe to retry
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
  delivery?: DeliveryInfo;
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
  const hasDeliveryEvidence = Boolean(params.delivery) || params.status === 'delivered';
  const hasCompletion = params.status === 'completed' || params.status === 'delivered' || Boolean(params.finalResponse);
  const hasEscalation = Boolean(params.escalation?.requiresCodex || params.escalation?.reason);

  // Pure execution evidence: simple 'failed' or launcher error is explicitly NOT execution evidence
  const hasExecutionEvidence =
    hasLogs ||
    hasChangedFiles ||
    hasRetries ||
    hasVerification ||
    hasDeliveryEvidence ||
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
      params.status === 'delivered' ||
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

  // 5. Completion / Delivery Stage
  if (params.status === 'delivered' || params.delivery?.status === 'delivered') {
    events.push({
      id: `${params.runId}-stage-delivered`,
      stage: 'complete',
      title: '자동 전달 완료',
      description: params.delivery?.deliveredCommit
        ? `main 통합 및 원격 푸시 완료 (커밋: ${params.delivery.deliveredCommit.slice(0, 7)})`
        : 'main 통합 및 원격 푸시 완료',
      timestamp: params.delivery?.deliveredAt || updateTime,
      status: 'passed',
      detail: params.delivery?.targetBranch ? `대상 브랜치: ${params.delivery.targetBranch}` : undefined,
    });
  } else if (params.status === 'completed') {
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

  // 5b. In-progress delivery stage
  const s = String(params.status || '').trim().toLowerCase();
  const isDeliveringStage =
    s === 'delivering' ||
    s === 'review_validation' ||
    s === 'divergence_check' ||
    s === 'conflict_check' ||
    s === 'candidate_verification' ||
    s === 'main_integration' ||
    s === 'post_integration_verification' ||
    s === 'push' ||
    params.delivery?.status === 'delivering';

  if (isDeliveringStage) {
    const meta = getRunStatusMeta(params.status);
    events.push({
      id: `${params.runId}-stage-delivering`,
      stage: 'delivery',
      title: meta.label,
      description: params.delivery?.stageName || meta.koreanDesc,
      timestamp: updateTime,
      status: 'in_progress',
    });
  }

  // 6. User Action Required / Delivery Failure Stage (if applicable)
  if (requiresUserAction(params.status, params.escalation, params.errorCategory, params.error, params.delivery)) {
    const actionReason = getUserActionReason(params.status, params.escalation, params.errorCategory, params.error, params.delivery);
    const isDeliveryFail = params.delivery?.status === 'failed' || (s === 'failed' && Boolean(params.delivery?.failureCategory));
    events.push({
      id: `${params.runId}-stage-action`,
      stage: 'action_required',
      title:
        params.status === 'awaiting_review'
          ? '통합 검토 및 승인 필요'
          : isDeliveryFail
            ? `자동 전달 중지 (${getDeliveryFailureDisplayName(classifyDeliveryFailureCategory(params.delivery?.failureCategory || params.errorCategory))})`
            : '사용자 조치 필요',
      description: actionReason || '사용자 또는 Codex의 후속 조치가 필요합니다.',
      timestamp: updateTime,
      status: params.status === 'awaiting_review' ? 'warning' : 'failed',
      detail: params.delivery?.diagnosticArtifactPath ? `진단 파일: ${params.delivery.diagnosticArtifactPath}` : (params.error || params.escalation?.reason),
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