'use client';

import React, { useState } from 'react';
import {
  X,
  Bot,
  Sparkles,
  Layers,
  FileCode,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Clock,
  Terminal,
  Shield,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { ProjectGraphNode, GraphNodeOwner } from '../lib/project-event-graph';
import {
  formatDuration,
  WORKER_STATUS_META,
  getRunStatusMeta,
  getDeliveryFailureDisplayName,
  evaluateRunRetrySafety,
} from '../lib/workspace-contract';

interface ProjectEventDetailProps {
  node: ProjectGraphNode | null;
  onClose?: () => void;
  currentRunId?: string;
  onSelectRun?: (runId: string) => void;
  onRefresh?: () => void;
}

function getOwnerBadge(owner: GraphNodeOwner) {
  switch (owner) {
    case 'Codex':
      return {
        label: 'Codex',
        icon: Bot,
        className: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
      };
    case 'Gemini':
      return {
        label: 'Gemini',
        icon: Sparkles,
        className: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
      };
    case 'Orchestrator':
      return {
        label: 'Orchestrator',
        icon: Layers,
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      };
  }
}

export function ProjectEventDetail({
  node,
  onClose,
  currentRunId,
  onSelectRun,
  onRefresh,
}: ProjectEventDetailProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrySuccess, setRetrySuccess] = useState<{ runId: string; retryCount: number } | null>(null);

  const targetRunId = currentRunId || (node?.id?.includes(':') ? node.id.split(':')[0] : node?.id) || '';

  const isDeliveryFailed = Boolean(node?.delivery && node.delivery.status === 'failed');

  const isFailed =
    node?.status === 'failed' ||
    node?.status === 'policy_violation' ||
    node?.status === 'test_failed' ||
    node?.status === 'timed_out' ||
    node?.status === 'escalated' ||
    isDeliveryFailed;

  const retrySafety = evaluateRunRetrySafety({
    status: isFailed ? 'failed' : node?.status,
    requiresUserAction: Boolean(
      node?.escalation?.requiresCodex ||
      node?.status === 'policy_violation' ||
      node?.status === 'test_failed' ||
      node?.status === 'escalated' ||
      isDeliveryFailed
    ),
    errorCategory: (node?.metadata?.errorCategory as string) || node?.delivery?.failureCategory || (node?.status === 'policy_violation' ? 'policy_violation' : undefined),
    failureReason: node?.delivery?.failureReason || node?.error || (node?.metadata?.failureReason as string),
    error: node?.delivery?.failureReason || node?.error,
    retryable: node?.retryable,
    escalation: node?.escalation,
    delivery: node?.delivery,
  });

  const handleRetry = async () => {
    if (!targetRunId || isRetrying) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      const idempotencyKey = `retry-${targetRunId}-${Date.now()}`;
      const res = await fetch(`/api/runs/${encodeURIComponent(targetRunId)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        runId?: string;
        retryCount?: number;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.runId) {
        throw new Error(data.error || '재시도 요청에 실패했습니다.');
      }

      setRetrySuccess({ runId: data.runId, retryCount: data.retryCount || 1 });
      if (onRefresh) {
        onRefresh();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRetryError(msg);
    } finally {
      setIsRetrying(false);
    }
  };

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/80 bg-card/10 p-8 text-center text-slate-500">
        <div>
          <FileCode className="mx-auto h-8 w-8 text-slate-600 mb-2" aria-hidden="true" />
          <p className="text-sm font-medium text-slate-400">선택된 그래프 노드가 없습니다</p>
          <p className="mt-1 text-xs text-slate-500">
            좌측 프로젝트 작업 그래프에서 노드를 선택하면 상세 내역을 확인할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  const ownerBadge = getOwnerBadge(node.owner);
  const OwnerIcon = ownerBadge.icon;
  const statusMeta =
    WORKER_STATUS_META[node.status as keyof typeof WORKER_STATUS_META] ||
    getRunStatusMeta(node.status);

  const hasFiles = Boolean(node.files && node.files.length > 0);
  const hasVerification = Boolean(
    node.verificationCommands && node.verificationCommands.length > 0
  );
  const hasRetries = Boolean(node.retryHistory && node.retryHistory.length > 0);
  const hasError = Boolean(node.error || node.escalation);
  const hasRawOutput = Boolean(node.rawOutput && node.rawOutput.length > 0);

  return (
    <section
      aria-label="선택된 노드 세부 정보"
      className="flex flex-col h-full rounded-xl border border-border/80 bg-[#070a0f] shadow-lg shadow-black/50 overflow-hidden"
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-border/70 bg-[#0c121c] px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold shrink-0 ${ownerBadge.className}`}
          >
            <OwnerIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {ownerBadge.label}
          </span>
          <h3 className="text-sm font-semibold text-white truncate">
            {node.detailTitle || node.label}
          </h3>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`rounded-md border px-2 py-0.5 text-xs font-medium ${statusMeta.badgeClass}`}
          >
            {statusMeta.label}
          </span>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="세부 정보 닫기"
              className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* Tip Banner if Node is Tip */}
      {node.isTip && (
        <div className="border-b border-cyan-500/40 bg-cyan-950/30 px-4 py-2.5 text-xs text-cyan-200">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
              </span>
              <span className="font-semibold text-cyan-300">현재 그래프 Tip 노드</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono text-cyan-200/80">
              <span>소유자: {node.owner}</span>
              <span>상태: {statusMeta.shortLabel}</span>
              {node.elapsedSeconds !== undefined && (
                <span>시간: {formatDuration(node.elapsedSeconds)}</span>
              )}
            </div>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 font-mono">
            {node.startedAt && <span>시작: {node.startedAt}</span>}
            {node.completedAt && <span className="text-emerald-300">완료: {node.completedAt}</span>}
          </div>
        </div>
      )}

      {/* Panel Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 text-xs leading-relaxed text-slate-300">
        {/* Timing Information */}
        <section aria-labelledby="timing-heading" className="rounded-lg border border-border/60 bg-card/30 p-3">
          <h4 id="timing-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
            실행 시각 및 소요 시간
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <span className="text-slate-500">시작 시각: </span>
              <span className="text-slate-200">
                {node.startedAt ? new Date(node.startedAt).toLocaleTimeString('ko-KR', { hour12: false }) : '-'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">완료 시각: </span>
              <span className="text-slate-200">
                {node.completedAt ? new Date(node.completedAt).toLocaleTimeString('ko-KR', { hour12: false }) : '-'}
              </span>
            </div>
            <div>
              <span className="text-slate-500">소요 시간: </span>
              <span className="text-cyan-300">
                {formatDuration(node.elapsedSeconds || 0)}
              </span>
            </div>
          </div>
        </section>

        {/* Automatic Delivery Section */}
        {node.delivery && (
          <section aria-labelledby="delivery-heading" className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 id="delivery-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                자동 전달 (Automatic Delivery)
              </h4>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                  node.delivery.status === 'delivered'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : node.delivery.status === 'failed'
                    ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                }`}
              >
                {node.delivery.status === 'delivered'
                  ? '전달 완료'
                  : node.delivery.status === 'failed'
                  ? '전달 실패'
                  : '전달 진행 중'}
              </span>
            </div>
            <div className="rounded-lg border border-border/70 bg-card/40 p-3 space-y-2 text-[11px]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono">
                {node.delivery.targetBranch && (
                  <div>
                    <span className="text-slate-500">대상 브랜치: </span>
                    <span className="text-slate-200">{node.delivery.targetBranch}</span>
                  </div>
                )}
                {node.delivery.remote && (
                  <div>
                    <span className="text-slate-500">원격 저장소: </span>
                    <span className="text-slate-200">{node.delivery.remote}</span>
                  </div>
                )}
                {node.delivery.deliveredCommit && (
                  <div className="sm:col-span-2">
                    <span className="text-slate-500">전달 커밋: </span>
                    <span className="text-cyan-300 font-mono">{node.delivery.deliveredCommit}</span>
                  </div>
                )}
                {node.delivery.currentStage && (
                  <div>
                    <span className="text-slate-500">진행 단계: </span>
                    <span className="text-slate-200">{node.delivery.currentStage}</span>
                  </div>
                )}
              </div>

              {node.delivery.status === 'failed' && (
                <div className="mt-2 rounded border border-rose-500/30 bg-rose-950/20 p-2.5 space-y-1 text-rose-200">
                  <div className="font-semibold text-rose-300 flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    <span>실패 원인: {getDeliveryFailureDisplayName(node.delivery.failureCategory)}</span>
                  </div>
                  {node.delivery.failureReason && (
                    <p className="text-[11px] text-rose-200/90 font-mono whitespace-pre-wrap">
                      {node.delivery.failureReason}
                    </p>
                  )}
                  {node.delivery.actionGuidance && (
                    <div className="pt-1 text-[11px] text-slate-300">
                      <span className="text-slate-400 font-medium">조치 안내: </span>
                      {node.delivery.actionGuidance}
                    </div>
                  )}
                  {node.delivery.diagnosticArtifact && (
                    <div className="pt-1 text-[11px] font-mono text-slate-400">
                      <span>진단 아티팩트: </span>
                      <span className="text-cyan-300">{node.delivery.diagnosticArtifact}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Persisted Real Instruction / Prompt */}
        {node.instruction && (
          <section aria-labelledby="instruction-heading" className="space-y-2">
            <h4 id="instruction-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              지시 내용 및 프롬프트
            </h4>
            <div className="rounded-lg border border-border/70 bg-card/40 p-3 font-mono text-[11px] whitespace-pre-wrap break-words text-slate-200 leading-relaxed max-h-48 overflow-y-auto">
              {node.instruction}
            </div>
          </section>
        )}

        {/* Changed Files */}
        {hasFiles && (
          <section aria-labelledby="files-heading" className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 id="files-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                수정 및 변경된 파일
              </h4>
              <span className="text-[11px] text-cyan-400 font-mono">
                {node.files?.length}개 파일
              </span>
            </div>
            <div className="rounded-lg border border-border/70 bg-card/40 p-2.5 space-y-1.5">
              {node.files?.map((file, idx) => (
                <div key={idx} className="flex items-center gap-2 font-mono text-[11px] text-cyan-300 break-all">
                  <FileCode className="h-3.5 w-3.5 text-cyan-400 shrink-0" aria-hidden="true" />
                  <span>{file}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Verification Commands & Results */}
        {hasVerification && (
          <section aria-labelledby="verification-heading" className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 id="verification-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                결정론적 검증 결과
              </h4>
              {node.verificationDecision && (
                <span className="text-[11px] font-mono text-purple-300 font-semibold">
                  판정: {node.verificationDecision}
                </span>
              )}
            </div>
            <div className="rounded-lg border border-border/70 bg-card/40 divide-y divide-border/50 overflow-hidden">
              {node.verificationCommands?.map((cmd, idx) => {
                const isPass = cmd.status === 'PASS';
                return (
                  <div key={idx} className="p-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                      <span className="text-slate-200 font-semibold truncate">
                        {cmd.command}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold shrink-0 ${
                          isPass
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {isPass ? (
                          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <XCircle className="h-3 w-3" aria-hidden="true" />
                        )}
                        {cmd.status} (exit {cmd.exitCode})
                      </span>
                    </div>

                    {cmd.output && (
                      <pre className="rounded bg-black/50 p-2 font-mono text-[10px] text-slate-400 overflow-x-auto max-h-32">
                        {cmd.output}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Retry History */}
        {hasRetries && (
          <section aria-labelledby="retries-heading" className="space-y-2">
            <div className="flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
              <h4 id="retries-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                재시도 기록 ({node.retryHistory?.length}회)
              </h4>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 divide-y divide-amber-500/20">
              {node.retryHistory?.map((retry, idx) => (
                <div key={idx} className="p-3 space-y-1">
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="font-semibold text-amber-300">
                      시도 {retry.attempt}회차 ({retry.decision})
                    </span>
                    {retry.verifiedAt && (
                      <span className="text-[10px] text-slate-400">
                        {new Date(retry.verifiedAt).toLocaleTimeString('ko-KR', { hour12: false })}
                      </span>
                    )}
                  </div>
                  {retry.failureLog && (
                    <pre className="rounded bg-black/60 p-2 font-mono text-[10px] text-amber-200/90 overflow-x-auto max-h-28">
                      {retry.failureLog}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Retry & Action Reason Section (Criteria 1 & 3) */}
        {(isFailed || node.retriedByRunId || node.retryOf) && (
          <section aria-labelledby="retry-action-heading" className="space-y-2">
            <h4 id="retry-action-heading" className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              재시도 및 조치 안내
            </h4>

            {/* If this run was a retry of another run */}
            {node.retryOf && (
              <div className="rounded-lg border border-border/60 bg-card/30 p-2.5 text-xs text-slate-400">
                <span>이 작업은 이전 원본 Run (</span>
                <span className="font-mono text-cyan-300 font-semibold">{node.retryOf.slice(-8)}</span>
                <span>)의 {node.retryCount || 1}회차 재시도입니다.</span>
              </div>
            )}

            {/* If this run was already retried into a new run */}
            {node.retriedByRunId && (
              <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/20 p-3 space-y-2 text-xs text-cyan-200">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-semibold text-cyan-300">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    <span>재시도 연결됨 ({node.retryCount || 1}회차)</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-400">
                    새 Run ID: {node.retriedByRunId.slice(-8)}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300">
                  이 실패한 작업은 단일 서버 권위 재시도를 통해 새 Run으로 연결되었습니다.
                </p>
                {onSelectRun && (
                  <button
                    type="button"
                    onClick={() => onSelectRun(node.retriedByRunId!)}
                    className="inline-flex items-center gap-1 rounded-md bg-cyan-500/20 px-2.5 py-1 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/30 transition-colors"
                  >
                    <span>새 Run ({node.retriedByRunId.slice(-8)})으로 전환</span>
                  </button>
                )}
              </div>
            )}

            {/* Safe Retry Button (Criterion 1 & 3: Only when safe to retry and not requiresUserAction) */}
            {retrySafety.canRetry && (
              <div className="rounded-lg border border-cyan-500/40 bg-cyan-950/20 p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-300 font-medium">
                    안전하게 재시도 가능한 실패 상태입니다.
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRetry()}
                    disabled={isRetrying}
                    aria-label="안전 실패 작업 재시도"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs font-semibold text-cyan-300 ring-1 ring-cyan-500/40 hover:bg-cyan-500/30 hover:text-white transition-colors disabled:opacity-50"
                  >
                    <RotateCcw className={`h-3.5 w-3.5 ${isRetrying ? 'animate-spin' : ''}`} aria-hidden="true" />
                    <span>{isRetrying ? '재시도 중…' : '재시도'}</span>
                  </button>
                </div>

                {retrySuccess && (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-950/30 p-2.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
                    <span>새 Run ({retrySuccess.runId.slice(-8)})이 생성되었습니다.</span>
                    {onSelectRun && (
                      <button
                        type="button"
                        onClick={() => onSelectRun(retrySuccess.runId)}
                        className="underline text-emerald-300 font-semibold"
                      >
                        새 Run으로 이동
                      </button>
                    )}
                  </div>
                )}

                {retryError && (
                  <div className="rounded-md border border-rose-500/40 bg-rose-950/30 p-2.5 text-xs text-rose-200">
                    {retryError}
                  </div>
                )}
              </div>
            )}

            {/* Refined Action Reason (Criterion 1: When NOT safe to retry) */}
            {!retrySafety.canRetry && isFailed && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 space-y-1.5 text-xs text-amber-200">
                <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>조치 필요 안내 (재시도 불가)</span>
                </div>
                <p className="text-[11px] leading-relaxed text-amber-100/90 font-mono">
                  {retrySafety.reason}
                </p>
              </div>
            )}
          </section>
        )}

        {/* Error / Escalation History */}
        {hasError && (
          <section aria-labelledby="error-heading" className="space-y-2">
            <div className="flex items-center gap-1.5 text-rose-400">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <h4 id="error-heading" className="text-[11px] font-semibold uppercase tracking-wider">
                오류 및 에스컬레이션 내역
              </h4>
            </div>
            <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 space-y-1.5 text-xs text-rose-200">
              {node.error && (
                <p className="font-mono text-[11px] leading-relaxed">
                  {node.error}
                </p>
              )}
              {node.escalation && (
                <div className="pt-2 border-t border-rose-500/30 text-[11px] font-mono space-y-1">
                  {node.escalation.category && (
                    <div>카테고리: {node.escalation.category}</div>
                  )}
                  {node.escalation.reason && (
                    <div>원인: {node.escalation.reason}</div>
                  )}
                  {node.escalation.requiresCodex && (
                    <div className="font-semibold text-rose-300">
                      Codex 개입 필요 (requiresCodex: true)
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Raw CLI Output (Collapsed by default, Read-only, Masked) */}
        {hasRawOutput && (
          <section aria-labelledby="raw-output-heading" className="space-y-2">
            <button
              type="button"
              onClick={() => setRawOpen(!rawOpen)}
              className="flex w-full items-center justify-between rounded-lg border border-border/70 bg-card/40 px-3 py-2 text-left hover:bg-card/70 transition-colors"
              aria-expanded={rawOpen}
            >
              <span className="flex items-center gap-2 text-[11px] font-semibold text-slate-300">
                <Terminal className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                원시 CLI 스트림 출력 (읽기 전용, 마스킹됨)
              </span>
              {rawOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              )}
            </button>

            {rawOpen && (
              <section
                aria-label="원시 CLI 출력"
                className="rounded-lg border border-border/70 bg-black/60 p-3 font-mono text-[10px] text-slate-300 max-h-56 overflow-y-auto space-y-1 break-all"
              >
                {node.rawOutput?.map((line, idx) => (
                  <div key={idx} className="leading-relaxed">
                    {line}
                  </div>
                ))}
              </section>
            )}
          </section>
        )}
      </div>

      {/* Footer info notice */}
      <div className="flex items-center justify-between border-t border-border/50 bg-[#090d14] px-4 py-2 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <Shield className="h-3 w-3 text-cyan-400" aria-hidden="true" />
          모든 경로 및 비밀값은 안전 경계에서 마스킹되었습니다.
        </span>
        <span className="font-mono text-[10px] text-slate-400">
          ID: {node.id}
        </span>
      </div>
    </section>
  );
}
