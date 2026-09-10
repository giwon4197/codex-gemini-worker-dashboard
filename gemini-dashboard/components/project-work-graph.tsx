'use client';

import React, { useMemo } from 'react';
import {
  GitCommit,
  GitBranch,
  FileCode,
  Search,
  Save,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Bot,
  Layers,
  Sparkles,
  ArrowUp,
} from 'lucide-react';
import type {
  ProjectWorkGraphData,
  ProjectGraphNode,
  GraphNodeOwner,
  ActivityType,
} from '../lib/project-event-graph';
import {
  sortGraphNodesNewestFirst,
  computeGraphLayoutGeometry,
  GRAPH_LAYOUT_CONFIG,
} from '../lib/project-event-graph';
import { formatDuration, WORKER_STATUS_META, getRunStatusMeta } from '../lib/workspace-contract';

interface ProjectWorkGraphProps {
  graph: ProjectWorkGraphData;
  selectedNodeId?: string;
  onSelectNode: (node: ProjectGraphNode) => void;
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

function getActivityIcon(activity?: ActivityType) {
  switch (activity) {
    case 'LOAD':
      return FileCode;
    case 'SEARCH':
      return Search;
    case 'EDIT':
      return FileCode;
    case 'SAVE':
      return Save;
    case 'RUN':
      return Play;
    case 'PASS':
      return CheckCircle2;
    case 'FAIL':
      return XCircle;
    case 'DONE':
      return CheckCircle2;
    default:
      return GitCommit;
  }
}

function getActivityBadgeClass(activity?: ActivityType): string {
  switch (activity) {
    case 'LOAD':
      return 'bg-blue-500/20 text-blue-300 border-blue-500/30';
    case 'SEARCH':
      return 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30';
    case 'EDIT':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
    case 'SAVE':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
    case 'RUN':
      return 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30';
    case 'PASS':
      return 'bg-green-500/20 text-green-300 border-green-500/30';
    case 'FAIL':
      return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
    case 'DONE':
      return 'bg-teal-500/20 text-teal-300 border-teal-500/30';
    default:
      return 'bg-slate-500/20 text-slate-300 border-slate-500/30';
  }
}

export function ProjectWorkGraph({
  graph,
  selectedNodeId,
  onSelectNode,
}: ProjectWorkGraphProps) {
  // Ordered bottom-to-top so the newest events accumulate upward.
  // In the visual list, the top item is the newest event, and the bottom item is the oldest (User Request).
  const displayNodes = useMemo(() => {
    return sortGraphNodesNewestFirst(graph.nodes);
  }, [graph.nodes]);

  const layout = useMemo(() => {
    return computeGraphLayoutGeometry(displayNodes, {
      minLanes: Math.max(graph.lanesCount || 1, 2),
    });
  }, [displayNodes, graph.lanesCount]);

  return (
    <div className="flex flex-col rounded-xl border border-border/80 bg-[#070a0f] shadow-lg shadow-black/50">
      {/* Graph Top Header / Tips Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-[#0c121c] px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-white">
            프로젝트 작업 그래프
          </h2>
          <span className="rounded-md bg-cyan-500/15 px-2 py-0.5 text-xs font-mono text-cyan-300 ring-1 ring-cyan-500/30">
            {graph.runId.slice(-8)}
          </span>
        </div>

        {/* Tip status indicators */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <ArrowUp className="h-3 w-3 text-cyan-400 animate-bounce" aria-hidden="true" />
            최신 이벤트 상단 누적
          </span>

          {graph.tips.map(tip => {
            const ownerBadge = getOwnerBadge(tip.owner);
            const statusMeta =
              WORKER_STATUS_META[tip.status as keyof typeof WORKER_STATUS_META] ||
              getRunStatusMeta(tip.status);

            return (
              <div
                key={tip.id}
                className="flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-950/40 px-2.5 py-1 text-[11px] text-slate-200"
                title={`현재 Graph Tip: ${tip.owner} (${statusMeta.label})`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
                </span>
                <span className="font-semibold text-cyan-300">Tip:</span>
                <span className={`rounded px-1 py-0.2 border text-[10px] ${ownerBadge.className}`}>
                  {tip.owner}
                </span>
                <span className={`rounded px-1 py-0.2 border text-[10px] ${statusMeta.badgeClass}`}>
                  {statusMeta.shortLabel}
                </span>
                {tip.elapsedSeconds !== undefined && tip.elapsedSeconds > 0 && (
                  <span className="font-mono text-[10px] text-slate-400">
                    {formatDuration(tip.elapsedSeconds)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Graph Body: Visual Studio Git Graph style single global SVG + semantic list rows */}
      <div className="relative overflow-y-auto max-h-[580px] focus:outline-hidden">
        {/* Single full-graph SVG spanning the entire rendered graph height */}
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-0 overflow-visible"
          width={layout.width}
          height={layout.height}
          style={{ width: layout.width, height: layout.height }}
        >
          {/* Inactive-row pass-through vertical lane segments */}
          {layout.passThroughSegments.map((seg, idx) => (
            <line
              key={`pass-${seg.lane}-${idx}`}
              x1={seg.x}
              y1={seg.fromY}
              x2={seg.x}
              y2={seg.toY}
              stroke={seg.color}
              strokeWidth={2}
              strokeOpacity={0.4}
            />
          ))}
          {/* Continuous graph edges (direct edges, branch curves, merge curves) */}
          {layout.edges.map((edge) => (
            <path
              key={`edge-${edge.id}`}
              d={edge.pathD}
              stroke={edge.color}
              strokeWidth={2.5}
              fill="none"
            />
          ))}

          {/* Graph Nodes & Tips */}
          {layout.nodes.map((layoutNode) => {
            const { node, x, y, color, isTip } = layoutNode;
            return (
              <g key={`node-${node.id}`}>
                {isTip && (
                  <circle
                    cx={x}
                    cy={y}
                    r={GRAPH_LAYOUT_CONFIG.nodeRadius + 4}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    className="animate-spin-slow"
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={GRAPH_LAYOUT_CONFIG.nodeRadius}
                  fill={node.type === 'merge' ? '#10b981' : color}
                  stroke="#070a0f"
                  strokeWidth={2}
                />
              </g>
            );
          })}
        </svg>

        {/* Semantic list of event rows */}
        <ul
          aria-label="프로젝트 작업 그래프 목록 (최신 이벤트 상단 누적)"
          className="divide-y divide-border/40 list-none p-0 m-0"
        >
          {displayNodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const ownerBadge = getOwnerBadge(node.owner);
            const OwnerIcon = ownerBadge.icon;
            const ActivityIcon = getActivityIcon(node.activity);
            const statusMeta =
              WORKER_STATUS_META[node.status as keyof typeof WORKER_STATUS_META] ||
              getRunStatusMeta(node.status);

            return (
              <li key={node.id} className="list-none h-[52px] box-border">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelectNode(node)}
                  className={`w-full h-full text-left flex items-center gap-3 px-3 cursor-pointer transition-colors select-none focus:outline-hidden focus:ring-1 focus:ring-cyan-400 ${
                    isSelected
                      ? 'bg-cyan-950/40 border-l-2 border-l-cyan-400'
                      : 'hover:bg-slate-900/60 border-l-2 border-l-transparent'
                  }`}
                >
                  {/* Spacer column reserving exact width for the global SVG graph */}
                  <div
                    className="shrink-0"
                    style={{ width: layout.width, height: layout.rowHeight }}
                    aria-hidden="true"
                  />

                  {/* Node Details Row */}
                  <div className="flex-1 min-w-0 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Owner Badge */}
                      <span
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold shrink-0 ${ownerBadge.className}`}
                      >
                        <OwnerIcon className="h-3 w-3" aria-hidden="true" />
                        {ownerBadge.label}
                      </span>

                      {/* Activity Badge (if applicable) */}
                      {node.activity && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono font-bold shrink-0 ${getActivityBadgeClass(
                            node.activity
                          )}`}
                        >
                          <ActivityIcon className="h-3 w-3" aria-hidden="true" />
                          {node.activity}
                        </span>
                      )}

                      {/* Node Main Label */}
                      <span className="text-xs font-medium text-slate-200 truncate">
                        {node.label}
                      </span>

                      {/* Tip Badge */}
                      {node.isTip && (
                        <span className="rounded-full bg-cyan-500/20 px-2 py-0.2 text-[9px] font-bold text-cyan-300 ring-1 ring-cyan-400/40 shrink-0">
                          TIP
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0 text-[11px] text-slate-400 font-mono">
                      {/* Status Badge */}
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[10px] font-medium shrink-0 ${statusMeta.badgeClass}`}
                      >
                        {statusMeta.shortLabel}
                      </span>

                      {/* Timing */}
                      {node.elapsedSeconds !== undefined && node.elapsedSeconds > 0 && (
                        <span className="hidden sm:inline-flex items-center gap-1 text-[10px]">
                          <Clock className="h-3 w-3 text-slate-500" aria-hidden="true" />
                          {formatDuration(node.elapsedSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Graph Footer */}
      <div className="flex items-center justify-between border-t border-border/50 bg-[#090d14] px-4 py-2 text-[11px] text-slate-500">
        <span>총 {graph.nodes.length}개 노드 · {graph.edges.length}개 엣지 (실제 이벤트 관계 기반)</span>
        <span className="text-[10px] text-slate-400">
          노드를 클릭하면 상세 기록 패널이 열립니다
        </span>
      </div>
    </div>
  );
}
