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
} from '../lib/project-event-graph';
import { formatDuration, WORKER_STATUS_META, RUN_STATUS_META } from '../lib/workspace-contract';

interface ProjectWorkGraphProps {
  graph: ProjectWorkGraphData;
  selectedNodeId?: string;
  onSelectNode: (node: ProjectGraphNode) => void;
}

const LANE_COLORS = [
  '#38bdf8', // Lane 0: Sky (Main / Orchestrator / Codex)
  '#c084fc', // Lane 1: Purple (Worker 1)
  '#f472b6', // Lane 2: Pink (Worker 2)
  '#34d399', // Lane 3: Emerald (Worker 3)
  '#fbbf24', // Lane 4: Amber (Worker 4)
  '#818cf8', // Lane 5: Indigo (Worker 5)
];

function getLaneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
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

  const lanesCount = Math.max(graph.lanesCount || 1, 2);
  const laneWidth = 26;
  const svgWidth = lanesCount * laneWidth + 16;
  const nodeRadius = 5;
  const rowHeight = 52;
  const nodeCenterY = 26;

  // Build a lookup map of node index in displayNodes for edge calculation
  const nodeIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    displayNodes.forEach((n, idx) => map.set(n.id, idx));
    return map;
  }, [displayNodes]);

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
              RUN_STATUS_META[tip.status as keyof typeof RUN_STATUS_META] ||
              RUN_STATUS_META.running;

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

      {/* Graph Body: Visual Studio Git Graph style vertical lanes + event rows */}
      <ul
        aria-label="프로젝트 작업 그래프 목록 (최신 이벤트 상단 누적)"
        className="divide-y divide-border/40 overflow-y-auto max-h-[580px] focus:outline-hidden list-none p-0 m-0"
      >
        {displayNodes.map((node, rowIndex) => {
          const isSelected = selectedNodeId === node.id;
          const ownerBadge = getOwnerBadge(node.owner);
          const OwnerIcon = ownerBadge.icon;
          const ActivityIcon = getActivityIcon(node.activity);
          const statusMeta =
            WORKER_STATUS_META[node.status as keyof typeof WORKER_STATUS_META] ||
            RUN_STATUS_META[node.status as keyof typeof RUN_STATUS_META] ||
            RUN_STATUS_META.running;

          const laneX = 14 + node.lane * laneWidth;
          const laneColor = getLaneColor(node.lane);

          // Compute edges for this row's SVG canvas
          // 1. Line to parent (which appears below this row in displayNodes since newest is top)
          const parentEdges: Array<{ fromX: number; fromY: number; toX: number; toY: number; type: string; color: string }> = [];

          if (node.parentIds && node.parentIds.length > 0) {
            for (const pId of node.parentIds) {
              const pIndex = nodeIndexMap.get(pId);
              if (pIndex !== undefined && pIndex > rowIndex) {
                const parentNode = displayNodes[pIndex];
                const pLaneX = 14 + parentNode.lane * laneWidth;
                if (parentNode.lane === node.lane) {
                  // Direct line down to bottom of row
                  parentEdges.push({
                    fromX: laneX,
                    fromY: nodeCenterY,
                    toX: laneX,
                    toY: rowHeight,
                    type: 'direct',
                    color: laneColor,
                  });
                } else if (node.type === 'merge') {
                  // Merge curve coming from parent worker lane up to nodeCenter in Lane 0
                  parentEdges.push({
                    fromX: pLaneX,
                    fromY: rowHeight,
                    toX: laneX,
                    toY: nodeCenterY,
                    type: 'merge',
                    color: getLaneColor(parentNode.lane),
                  });
                } else {
                  parentEdges.push({
                    fromX: pLaneX,
                    fromY: rowHeight,
                    toX: laneX,
                    toY: nodeCenterY,
                    type: 'branch',
                    color: laneColor,
                  });
                }
              }
            }
          }

          // 2. Line to children (which appear above this row in displayNodes)
          const childEdges: Array<{ fromX: number; fromY: number; toX: number; toY: number; type: string; color: string }> = [];
          for (let r = 0; r < rowIndex; r++) {
            const candidateChild = displayNodes[r];
            if (candidateChild.parentIds?.includes(node.id)) {
              const cLaneX = 14 + candidateChild.lane * laneWidth;
              if (candidateChild.lane === node.lane) {
                childEdges.push({
                  fromX: laneX,
                  fromY: nodeCenterY,
                  toX: laneX,
                  toY: 0,
                  type: 'direct',
                  color: laneColor,
                });
              } else if (candidateChild.type === 'worker_branch') {
                // Branching out up towards worker lane
                childEdges.push({
                  fromX: laneX,
                  fromY: nodeCenterY,
                  toX: cLaneX,
                  toY: 0,
                  type: 'branch',
                  color: getLaneColor(candidateChild.lane),
                });
              } else {
                childEdges.push({
                  fromX: laneX,
                  fromY: nodeCenterY,
                  toX: cLaneX,
                  toY: 0,
                  type: 'merge',
                  color: laneColor,
                });
              }
            }
          }

          // 3. Active pass-through lines for lanes that are active both above and below this row
          const activeLanesThroughRow: number[] = [];
          for (let l = 0; l < lanesCount; l++) {
            if (l === node.lane) continue;
            const hasAbove = displayNodes.slice(0, rowIndex).some(n => n.lane === l);
            const hasBelow = displayNodes.slice(rowIndex + 1).some(n => n.lane === l);
            if (hasAbove && hasBelow) {
              activeLanesThroughRow.push(l);
            }
          }

          return (
            <li key={node.id} className="list-none">
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectNode(node)}
                className={`w-full text-left flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors select-none focus:outline-hidden focus:ring-1 focus:ring-cyan-400 ${
                  isSelected
                    ? 'bg-cyan-950/40 border-l-2 border-l-cyan-400'
                    : 'hover:bg-slate-900/60 border-l-2 border-l-transparent'
                }`}
              >
              {/* Git Graph Visual SVG Column */}
              <div
                className="shrink-0 relative"
                style={{ width: svgWidth, height: rowHeight }}
                aria-hidden="true"
              >
                <svg
                  width={svgWidth}
                  height={rowHeight}
                  className="overflow-visible"
                >
                  {/* Pass-through vertical lines */}
                  {activeLanesThroughRow.map(l => {
                    const passX = 14 + l * laneWidth;
                    return (
                      <line
                        key={`pass-${l}`}
                        x1={passX}
                        y1={0}
                        x2={passX}
                        y2={rowHeight}
                        stroke={getLaneColor(l)}
                        strokeWidth={2}
                        strokeOpacity={0.4}
                      />
                    );
                  })}

                  {/* Edges down to parent */}
                  {parentEdges.map((e, eIdx) => {
                    if (e.fromX === e.toX) {
                      return (
                        <line
                          key={`p-${eIdx}`}
                          x1={e.fromX}
                          y1={e.fromY}
                          x2={e.toX}
                          y2={e.toY}
                          stroke={e.color}
                          strokeWidth={2.5}
                        />
                      );
                    }
                    const midY = (e.fromY + e.toY) / 2;
                    return (
                      <path
                        key={`p-${eIdx}`}
                        d={`M ${e.fromX} ${e.fromY} C ${e.fromX} ${midY}, ${e.toX} ${midY}, ${e.toX} ${e.toY}`}
                        stroke={e.color}
                        strokeWidth={2.5}
                        fill="none"
                      />
                    );
                  })}

                  {/* Edges up to child */}
                  {childEdges.map((e, eIdx) => {
                    if (e.fromX === e.toX) {
                      return (
                        <line
                          key={`c-${eIdx}`}
                          x1={e.fromX}
                          y1={e.fromY}
                          x2={e.toX}
                          y2={e.toY}
                          stroke={e.color}
                          strokeWidth={2.5}
                        />
                      );
                    }
                    const midY = (e.fromY + e.toY) / 2;
                    return (
                      <path
                        key={`c-${eIdx}`}
                        d={`M ${e.fromX} ${e.fromY} C ${e.fromX} ${midY}, ${e.toX} ${midY}, ${e.toX} ${e.toY}`}
                        stroke={e.color}
                        strokeWidth={2.5}
                        fill="none"
                      />
                    );
                  })}

                  {/* Node Circle */}
                  {node.isTip && (
                    <circle
                      cx={laneX}
                      cy={nodeCenterY}
                      r={nodeRadius + 4}
                      fill="none"
                      stroke={laneColor}
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                      className="animate-spin-slow"
                    />
                  )}
                  <circle
                    cx={laneX}
                    cy={nodeCenterY}
                    r={nodeRadius}
                    fill={node.type === 'merge' ? '#10b981' : laneColor}
                    stroke="#070a0f"
                    strokeWidth={2}
                  />
                </svg>
              </div>

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
