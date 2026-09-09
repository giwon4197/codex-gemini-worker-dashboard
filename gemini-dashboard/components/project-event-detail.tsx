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
import { formatDuration, WORKER_STATUS_META, RUN_STATUS_META } from '../lib/workspace-contract';

interface ProjectEventDetailProps {
  node: ProjectGraphNode | null;
  onClose?: () => void;
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

export function ProjectEventDetail({ node, onClose }: ProjectEventDetailProps) {
  const [rawOpen, setRawOpen] = useState(false);

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
    RUN_STATUS_META[node.status as keyof typeof RUN_STATUS_META] ||
    RUN_STATUS_META.running;

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
