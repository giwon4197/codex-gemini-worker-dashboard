'use client';

import React from 'react';
import Link from 'next/link';
import {
  Terminal,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  History
} from 'lucide-react';
import { WorkerTerminal } from './worker-terminal';
import type { LiveWorkerData } from '../lib/workspace-contract';
import {
  WORKER_STATUS_META,
  formatDuration,
  requiresUserAction,
  getUserActionReason,
} from '../lib/workspace-contract';

interface ProjectControlProps {
  activeWorkers?: LiveWorkerData[];
  historyWorkers?: LiveWorkerData[];
  projectName?: string;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function ProjectControl({
  activeWorkers = [],
  historyWorkers = [],
  projectName = 'codex-gemini-worker-dashboard',
  onRefresh,
  isLoading = false,
}: ProjectControlProps) {

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-card/40 px-6 py-4 backdrop-blur-xs">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            aria-label="대화형 작업 공간으로 돌아가기"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-white">
                프로젝트 관제실
              </h1>
              <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 text-xs font-mono font-medium text-cyan-300 ring-1 ring-cyan-500/30">
                {projectName}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              진행 중인 활성 워커 CLI 스트림 및 작업 기록 모니터링
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-slate-900/80 px-3 py-1 text-xs text-slate-300">
            <span
              className={`h-2 w-2 rounded-full ${
                activeWorkers.length > 0
                  ? 'bg-cyan-400 animate-pulse'
                  : 'bg-emerald-400'
              }`}
            />
            <span>활성 워커: {activeWorkers.length}개</span>
          </span>

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label="관제 화면 새로고침"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>새로고침</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Content Body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-8">
        {/* Section 1: Active Worker CLI Area */}
        <section aria-labelledby="active-workers-heading" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-cyan-400" aria-hidden="true" />
              <h2 id="active-workers-heading" className="text-sm font-semibold text-white">
                활성 워커 관제 CLI (실시간 진행 중)
              </h2>
            </div>
            <span className="text-xs text-slate-400">
              종료된 워커는 즉시 제외되어 아래 기록에 보존됩니다
            </span>
          </div>

          {activeWorkers.length > 0 ? (
            <div className="grid grid-cols-1 gap-6">
              {activeWorkers.map(worker => (
                <WorkerTerminal key={worker.taskId || worker.runId} worker={worker} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/80 bg-card/20 p-8 text-center">
              <Terminal className="mx-auto h-8 w-8 text-slate-600 mb-2" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-300">현재 실행 중인 활성 워커가 없습니다</h3>
              <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
                모든 워커가 작업을 마쳤거나 대기 중입니다. 새로운 작업은 대화형 작업 공간에서 자연어로 지시할 수 있습니다.
              </p>
              <div className="mt-4">
                <Link
                  href="/"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/15 px-3.5 py-1.5 text-xs font-medium text-cyan-300 ring-1 ring-cyan-500/30 hover:bg-cyan-500/25 transition-colors"
                >
                  <span>대화형 작업 공간으로 이동</span>
                </Link>
              </div>
            </div>
          )}
        </section>

        {/* Section 2: Task History & Completed Workers */}
        <section aria-labelledby="history-workers-heading" className="space-y-4">
          <div className="flex items-center justify-between border-t border-border/70 pt-6">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-slate-400" aria-hidden="true" />
              <h2 id="history-workers-heading" className="text-sm font-semibold text-white">
                완료 및 최근 작업 기록
              </h2>
            </div>
            <span className="text-xs text-slate-400 font-mono">
              총 {historyWorkers.length}건
            </span>
          </div>

          {historyWorkers.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {historyWorkers.map(w => {
                const meta = WORKER_STATUS_META[w.status] || WORKER_STATUS_META.completed;
                const actionNeeded = requiresUserAction(w.status, w.escalation);
                const actionReason = getUserActionReason(w.status, w.escalation);

                return (
                  <div
                    key={w.taskId || w.runId}
                    className="flex flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-4 shadow-xs transition-colors hover:border-border"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-semibold text-xs text-slate-200 line-clamp-1">
                          {w.task || w.taskId}
                        </span>
                        <span
                          className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-medium ${meta.badgeClass}`}
                        >
                          {meta.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono">
                        <span>모델: {w.model}</span>
                        <span>시간: {formatDuration(w.elapsedSeconds || 0)}</span>
                      </div>

                      {actionNeeded && (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                          <div className="flex items-center gap-1.5 font-semibold text-amber-300 mb-0.5">
                            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>사용자 조치 필요</span>
                          </div>
                          <p className="text-[11px] leading-relaxed text-amber-100/90">
                            {actionReason}
                          </p>
                        </div>
                      )}

                      {w.changedFiles && w.changedFiles.length > 0 && (
                        <div className="text-[11px] text-slate-400">
                          <span className="font-medium text-slate-300">수정된 파일: </span>
                          <span className="font-mono text-cyan-300">
                            {w.changedFiles.slice(0, 2).join(', ')}
                            {w.changedFiles.length > 2 ? ` 외 ${w.changedFiles.length - 2}건` : ''}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2 text-[10px] text-slate-500 font-mono">
                      <span>RUN: {w.runId.slice(-8)}</span>
                      <span>종료: {new Date(w.updatedAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 p-6 text-center text-xs text-slate-500">
              보존된 작업 기록이 없습니다.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}