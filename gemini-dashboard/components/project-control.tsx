'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Terminal,
  AlertTriangle,
  RefreshCw,
  ArrowLeft,
  History,
  GitBranch,
} from 'lucide-react';
import { WorkerTerminal } from './worker-terminal';
import { ProjectWorkGraph } from './project-work-graph';
import { ProjectEventDetail } from './project-event-detail';
import type {
  LiveWorkerData,
  CompactRunState,
} from '../lib/workspace-contract';
import type {
  ProjectWorkGraphData,
  ProjectGraphNode,
} from '../lib/project-event-graph';
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
  graph?: ProjectWorkGraphData | null;
  runs?: CompactRunState[];
  selectedRunId?: string;
  onSelectRun?: (runId: string) => void;
  selectedNodeId?: string;
  onSelectNode?: (nodeId: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
}

export function ProjectControl({
  activeWorkers = [],
  historyWorkers = [],
  projectName = 'codex-gemini-worker-dashboard',
  graph = null,
  runs = [],
  selectedRunId,
  onSelectRun,
  selectedNodeId: propSelectedNodeId,
  onSelectNode: propOnSelectNode,
  onRefresh,
  isLoading = false,
}: ProjectControlProps) {
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string | undefined>(
    propSelectedNodeId
  );

  const effectiveSelectedNodeId = propSelectedNodeId !== undefined ? propSelectedNodeId : internalSelectedNodeId;

  const handleSelectNode = (node: ProjectGraphNode) => {
    setInternalSelectedNodeId(node.id);
    if (propOnSelectNode) {
      propOnSelectNode(node.id);
    }
  };

  // Resolve selected node with deterministic fallback:
  // 1. Matched by effectiveSelectedNodeId
  // 2. Primary tip node in graph.tips
  // 3. Last node in graph.nodes (accumulated upward at top)
  // 4. Null
  const selectedNode = useMemo<ProjectGraphNode | null>(() => {
    if (!graph || graph.nodes.length === 0) return null;
    if (effectiveSelectedNodeId) {
      const found = graph.nodes.find(n => n.id === effectiveSelectedNodeId);
      if (found) return found;
    }
    if (graph.tips && graph.tips.length > 0) {
      return graph.tips[0];
    }
    return graph.nodes[graph.nodes.length - 1];
  }, [graph, effectiveSelectedNodeId]);

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
              실시간 작업 그래프, 활성 워커 CLI 스트림 및 보존된 작업 기록 관제
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Run Selector Dropdown (when multiple runs exist) */}
          {runs.length > 1 && onSelectRun && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-400">실행 선택:</span>
              <select
                aria-label="관제 대상 실행 선택"
                value={selectedRunId || (graph ? graph.runId : '')}
                onChange={e => onSelectRun(e.target.value)}
                className="rounded-lg border border-border bg-slate-900 px-2.5 py-1 text-xs font-mono text-cyan-300 focus:outline-hidden focus:ring-1 focus:ring-cyan-400"
              >
                {runs.map(r => (
                  <option key={r.runId} value={r.runId}>
                    {r.runId.slice(-8)} ({r.status}) - {r.prompt.slice(0, 20)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Active Workers Badge */}
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
              종료된 워커는 즉시 제외되어 아래 작업 그래프와 기록에 보존됩니다
            </span>
          </div>

          {activeWorkers.length > 0 ? (
            <div className="grid grid-cols-1 gap-6">
              {activeWorkers.map(worker => (
                <WorkerTerminal key={worker.taskId || worker.runId} worker={worker} />
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/80 bg-card/20 p-6 text-center">
              <Terminal className="mx-auto h-7 w-7 text-slate-600 mb-2" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-300">현재 실행 중인 활성 워커가 없습니다</h3>
              <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
                모든 워커가 작업을 마쳤거나 대기 중입니다. 아래 작업 그래프에서 전체 부모-자식 흐름과 검증 내역을 검토할 수 있습니다.
              </p>
              <div className="mt-3">
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

        {/* Section 2: Real-time Project Work Graph & Event Detail */}
        {graph && graph.nodes.length > 0 && (
          <section aria-labelledby="work-graph-heading" className="space-y-4">
            <div className="flex items-center justify-between border-t border-border/70 pt-6">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                <h2 id="work-graph-heading" className="text-sm font-semibold text-white">
                  실시간 프로젝트 작업 그래프 (Visual Studio Git Graph)
                </h2>
              </div>
              <span className="text-xs text-slate-400">
                사용자 요청 → Codex 계획/분배 → 독립 Gemini 워커 브랜치 → 통합 검토 병합
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: Work Graph (7 cols) */}
              <div className="lg:col-span-7">
                <ProjectWorkGraph
                  graph={graph}
                  selectedNodeId={selectedNode?.id}
                  onSelectNode={handleSelectNode}
                />
              </div>

              {/* Right: Selected Node Detail Panel (5 cols) */}
              <div className="lg:col-span-5 sticky top-4">
                <ProjectEventDetail
                  node={selectedNode}
                  onClose={() => setInternalSelectedNodeId(undefined)}
                />
              </div>
            </div>
          </section>
        )}

        {/* Section 3: Task History & Completed Workers */}
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