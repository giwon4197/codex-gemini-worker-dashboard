// Project Work Graph Model, Defensive NDJSON Parser, and Pure DAG Construction

import type {
  RunStatus,
  WorkerStatus,
  LiveWorkerData,
  LiveWorkerVerificationCommand,
  LiveWorkerRetryRecord,
  LiveWorkerEscalation,
} from './workspace-contract.ts';
import {
  normalizeRunStatus,
  normalizeWorkerStatus,
  isWorkerActive,
// @ts-expect-error TS5097 allowed for test runner
} from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizePath, sanitizeCommand, sanitizeText } from './workspace-sanitize.ts';

export type GraphNodeOwner = 'Codex' | 'Gemini' | 'Orchestrator';

export type ActivityType =
  | 'LOAD'
  | 'SEARCH'
  | 'EDIT'
  | 'SAVE'
  | 'RUN'
  | 'PASS'
  | 'FAIL'
  | 'DONE';

export const SUPPORTED_ACTIVITIES: ReadonlySet<ActivityType> = new Set([
  'LOAD',
  'SEARCH',
  'EDIT',
  'SAVE',
  'RUN',
  'PASS',
  'FAIL',
  'DONE',
]);

export type GraphNodeType =
  | 'request'
  | 'plan'
  | 'worker_branch'
  | 'activity'
  | 'verification'
  | 'merge';

export interface ProjectGraphNode {
  id: string;
  parentId?: string;
  parentIds?: string[];
  lane: number;
  depth: number;
  type: GraphNodeType;
  activity?: ActivityType;
  owner: GraphNodeOwner;
  label: string;
  detailTitle?: string;
  instruction?: string;
  status: RunStatus | WorkerStatus;
  isTip?: boolean;
  startedAt?: string;
  completedAt?: string;
  elapsedSeconds?: number;
  taskId?: string;
  taskName?: string;
  model?: string;
  attempt?: number;
  retryLimit?: number;
  file?: string;
  files?: string[];
  command?: string;
  verificationCommands?: LiveWorkerVerificationCommand[];
  verificationDecision?: string;
  retryHistory?: LiveWorkerRetryRecord[];
  error?: string | null;
  escalation?: LiveWorkerEscalation | null;
  rawOutput?: string[];
  metadata?: Record<string, unknown>;
  retryOf?: string;
  retriedByRunId?: string;
  retryCount?: number;
  retryable?: boolean;
}
export interface ProjectGraphEdge {
  from: string;
  to: string;
  fromLane: number;
  toLane: number;
  type: 'direct' | 'branch' | 'merge';
}

export interface ProjectWorkGraphData {
  runId: string;
  prompt: string;
  status: RunStatus;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  lanesCount: number;
  tips: ProjectGraphNode[];
  selectedNodeId?: string;
  retryOf?: string;
  retriedByRunId?: string;
  retryCount?: number;
}

export interface RawWorkerEventRecord {
  id?: string;
  parentId?: string;
  timestamp?: string;
  runId?: string;
  taskId?: string;
  attempt?: number;
  type?: string;
  message?: string;
  activity?: string;
  file?: string;
  targetFile?: string;
  filePath?: string;
  AbsolutePath?: string;
  TargetFile?: string;
  SearchPath?: string;
  SearchDirectory?: string;
  command?: string;
  CommandLine?: string;
  status?: string;
  owner?: string;
  [key: string]: unknown;
}

export interface ParsedWorkerActivity {
  id?: string;
  parentId?: string;
  timestamp: string;
  activity: ActivityType;
  file?: string;
  command?: string;
  message: string;
  type: string;
  raw: string;
  metadata?: Record<string, unknown>;
}

/**
 * Defensively parses a single worker NDJSON line into supported activities:
 * LOAD | SEARCH | EDIT | SAVE | RUN | PASS | FAIL | DONE.
 *
 * Rules:
 * 1. Malformed JSON returns null.
 * 2. Unrecognized/unknown events return null (they remain non-activity raw records or are ignored).
 * 3. File activity is extracted ONLY when the real record supplies it; never synthesized.
 * 4. Never fabricates activity facts.
 */
export function parseWorkerNDJSONLine(
  line: string,
  repoRoot?: string
): ParsedWorkerActivity | null {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let record: RawWorkerEventRecord;
  try {
    record = JSON.parse(trimmed) as RawWorkerEventRecord;
  } catch {
    return null;
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return null;
  }

  // 1. Direct explicit activity match
  let matchedActivity: ActivityType | null = null;
  if (record.activity && typeof record.activity === 'string') {
    const actUpper = record.activity.trim().toUpperCase() as ActivityType;
    if (SUPPORTED_ACTIVITIES.has(actUpper)) {
      matchedActivity = actUpper;
    }
  }

  // 2. Type-based activity matching
  if (!matchedActivity && record.type && typeof record.type === 'string') {
    const typeUpper = record.type.trim().toUpperCase() as ActivityType;
    if (SUPPORTED_ACTIVITIES.has(typeUpper)) {
      matchedActivity = typeUpper;
    }
  }

  // 3. Defensive mapping from genuine tool names / structured logs
  if (!matchedActivity) {
    const msg = typeof record.message === 'string' ? record.message : '';
    const recType = typeof record.type === 'string' ? record.type.toLowerCase() : '';

    if (recType === 'tool' || msg.includes('도구 호출:')) {
      if (
        msg.includes('view_file') ||
        msg.includes('read_file') ||
        msg.includes('read_url_content')
      ) {
        matchedActivity = 'LOAD';
      } else if (
        msg.includes('grep_search') ||
        msg.includes('find_by_name') ||
        msg.includes('search_web')
      ) {
        matchedActivity = 'SEARCH';
      } else if (
        msg.includes('replace_file_content') ||
        msg.includes('edit_file')
      ) {
        matchedActivity = 'EDIT';
      } else if (
        msg.includes('write_to_file') ||
        msg.includes('save_file')
      ) {
        matchedActivity = 'SAVE';
      } else if (
        msg.includes('run_command') ||
        msg.includes('execute_command')
      ) {
        matchedActivity = 'RUN';
      }
    } else if (recType === 'verification') {
      if (record.status === 'PASS' || msg.includes('PASS') || msg.includes('성공')) {
        matchedActivity = 'PASS';
      } else if (record.status === 'FAIL' || msg.includes('FAIL') || msg.includes('실패')) {
        matchedActivity = 'FAIL';
      } else if (record.command || msg.includes('실행')) {
        matchedActivity = 'RUN';
      }
    } else if (recType === 'confirmed_usage' || recType === 'result') {
      if (record.status === 'completed' || msg.includes('SUCCESS') || msg.includes('완료')) {
        matchedActivity = 'DONE';
      } else if (record.status === 'failed' || msg.includes('FAIL') || msg.includes('실패')) {
        matchedActivity = 'FAIL';
      }
    } else if (msg.includes('작업 종료: 상태=completed')) {
      matchedActivity = 'DONE';
    } else if (msg.includes('작업 종료: 상태=failed') || recType === 'error' || msg.startsWith('에러:') || msg.includes('예외:')) {
      matchedActivity = 'FAIL';
    }
  }

  // Unknown / unsupported records are safely ignored or remain non-activity records
  if (!matchedActivity) {
    return null;
  }

  // Extract file only when a real record supplies it
  let file: string | undefined;
  const rawFile =
    record.file ||
    record.targetFile ||
    record.filePath ||
    record.AbsolutePath ||
    record.TargetFile ||
    record.SearchPath;
  if (typeof rawFile === 'string' && rawFile.trim()) {
    file = sanitizePath(rawFile.trim(), repoRoot);
  }

  // Extract command only when a real record supplies it
  let command: string | undefined;
  const rawCmd = record.command || record.CommandLine;
  if (typeof rawCmd === 'string' && rawCmd.trim()) {
    command = sanitizeCommand(rawCmd.trim(), repoRoot);
  }

  const timestamp = record.timestamp || new Date().toISOString();
  const id = typeof record.id === 'string' ? record.id : undefined;
  const parentId = typeof record.parentId === 'string' ? record.parentId : undefined;

  return {
    id,
    parentId,
    timestamp,
    activity: matchedActivity,
    file,
    command,
    message: record.message || '',
    type: record.type || 'activity',
    raw: trimmed,
    metadata: record,
  };
}

export function formatActivityLabel(
  activity: ActivityType,
  file?: string,
  command?: string
): string {
  switch (activity) {
    case 'LOAD':
      return file ? `파일 로드: ${file}` : '파일 읽기';
    case 'SEARCH':
      return file ? `검색: ${file}` : '코드베이스 검색';
    case 'EDIT':
      return file ? `파일 수정: ${file}` : '코드 수정';
    case 'SAVE':
      return file ? `파일 저장: ${file}` : '파일 저장';
    case 'RUN':
      return command ? `명령 실행: ${command}` : '명령 실행';
    case 'PASS':
      return '검증 통과 (PASS)';
    case 'FAIL':
      return '검증 실패 (FAIL)';
    case 'DONE':
      return '작업 완료 (DONE)';
    default:
      return activity;
  }
}

export interface BuildProjectGraphOptions {
  runId: string;
  prompt?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  baseCommit?: string;
  integrationBranch?: string;
  tasks?: Array<{
    id: string;
    name?: string;
    prompt?: string;
    tier?: string;
    allowedFiles?: string[];
    testCommands?: string[];
    [key: string]: unknown;
  }>;
  workers?: LiveWorkerData[];
  eventsByTask?: Record<string, string[] | ParsedWorkerActivity[]>;
  integration?: {
    id?: string;
    parentIds?: string[];
    branch?: string;
    decision?: string;
    changedFiles?: string[];
    tests?: LiveWorkerVerificationCommand[];
    diffStat?: string;
    headCommit?: string;
    reviewArtifact?: string;
    startedAt?: string;
    updatedAt?: string;
    [key: string]: unknown;
  } | null;
  repoRoot?: string;
  retryOf?: string;
  retriedByRunId?: string;
  retryCount?: number;
  retryable?: boolean;
}

/**
 * Builds a deterministic Project Work Graph DAG ordered bottom-to-top.
 *
 * Sequence (bottom-to-top):
 * 1. User Request (Lane 0, Owner: Codex)
 * 2. Codex Planning & Distribution (Lane 0, Owner: Codex, Parent: Request)
 * 3. Gemini Worker Branches (Lanes 1..N, Owner: Gemini, Parent: Plan)
 *    - Genuine worker activity nodes parsed from NDJSON (LOAD/SEARCH/EDIT/SAVE/RUN/PASS/FAIL/DONE)
 *    - Real parent-child chaining per worker branch
 * 4. Integration Review Merge (Lane 0, Owner: Orchestrator, Parents: all worker tips)
 *
 * Tips: Every current tip reports owner, normalized status, elapsed time, start time, completion time.
 */
export function buildProjectWorkGraph(
  options: BuildProjectGraphOptions
): ProjectWorkGraphData {
  const {
    runId,
    prompt = `작업 (${runId})`,
    createdAt = new Date().toISOString(),
    updatedAt = createdAt,
    tasks = [],
    workers = [],
    eventsByTask = {},
    integration = null,
    repoRoot,
  } = options;

  const normalizedRunStatus = normalizeRunStatus(options.status);
  const nodes: ProjectGraphNode[] = [];
  const edges: ProjectGraphEdge[] = [];
  let depthCounter = 0;

  // 1. User Request Node (Lane 0, Owner: Codex)
  const reqNodeId = `${runId}:request`;
  const reqNode: ProjectGraphNode = {
    id: reqNodeId,
    lane: 0,
    depth: depthCounter++,
    type: 'request',
    owner: 'Codex',
    label: '사용자 요청',
    detailTitle: '사용자 자연어 요청',
    instruction: prompt,
    status: normalizedRunStatus,
    startedAt: createdAt,
    completedAt: createdAt,
    elapsedSeconds: 0,
  };
  nodes.push(reqNode);

  // 2. Codex Planning & Distribution Node (Lane 0, Owner: Codex)
  const planNodeId = `${runId}:plan`;
  const planStatus: RunStatus =
    normalizedRunStatus === 'pending'
      ? 'pending'
      : normalizedRunStatus === 'planning'
        ? 'running'
        : 'completed';

  const planInstruction =
    tasks.length > 0
      ? tasks.map(t => `• [${t.id}] ${t.name || t.prompt || ''}`).join('\n')
      : prompt;

  const planNode: ProjectGraphNode = {
    id: planNodeId,
    parentId: reqNodeId,
    parentIds: [reqNodeId],
    lane: 0,
    depth: depthCounter++,
    type: 'plan',
    owner: 'Codex',
    label: tasks.length > 1 ? `작업 분배 (${tasks.length}개 워커)` : '작업 계획 수립',
    detailTitle: 'Codex 작업 계획 및 파일 소유권 분배',
    instruction: planInstruction,
    status: planStatus,
    startedAt: createdAt,
    completedAt: tasks.length > 0 ? (workers[0]?.startedAt || updatedAt) : undefined,
  };
  nodes.push(planNode);
  edges.push({
    from: reqNodeId,
    to: planNodeId,
    fromLane: 0,
    toLane: 0,
    type: 'direct',
  });

  // Effective task list: if tasks is empty but workers exist, infer from workers
  const effectiveTasks = tasks.length > 0
    ? tasks
    : (workers.length > 0 ? workers.map(w => ({ id: w.taskId || 'TASK-001', name: w.task, prompt: w.task })) : [{ id: 'TASK-001', name: prompt, prompt }]);

  const workerTips: Map<string, ProjectGraphNode> = new Map();
  let maxLane = 0;

  // 3. Per-Gemini-Worker Branches
  effectiveTasks.forEach((task, taskIdx) => {
    const lane = taskIdx + 1;
    if (lane > maxLane) maxLane = lane;
    const taskId = task.id;

    const worker = workers.find(w => w.taskId === taskId) || workers[taskIdx];
    const workerStatus = worker ? normalizeWorkerStatus(worker.status) : 'pending';

    // Worker Branch Start Node (Lane = taskIdx + 1, Owner: Gemini)
    const branchId = `${runId}:${taskId}:branch`;
    const branchStartTime = worker?.startedAt || createdAt;
    const branchEndTime = worker && !isWorkerActive(worker.status) ? worker.updatedAt : undefined;

    const branchNode: ProjectGraphNode = {
      id: branchId,
      parentId: planNodeId,
      parentIds: [planNodeId],
      lane,
      depth: depthCounter++,
      type: 'worker_branch',
      owner: 'Gemini',
      label: `워커 브랜치 (${taskId})`,
      detailTitle: task.name ? `${taskId}: ${task.name}` : `워커 브랜치: ${taskId}`,
      instruction: task.prompt || prompt,
      status: workerStatus,
      startedAt: branchStartTime,
      completedAt: branchEndTime,
      elapsedSeconds: worker?.elapsedSeconds || 0,
      taskId,
      taskName: task.name || taskId,
      model: worker?.model || ('tier' in task && typeof task.tier === 'string' ? task.tier : undefined) || 'gemini-3.8-flash-high',
      attempt: worker?.attempt || 1,
      retryLimit: worker?.retryLimit,
      files: worker?.changedFiles,
    };
    nodes.push(branchNode);
    edges.push({
      from: planNodeId,
      to: branchId,
      fromLane: 0,
      toLane: lane,
      type: 'branch',
    });

    let currentParentId = branchId;
    let tipCandidate: ProjectGraphNode = branchNode;

    // Parse NDJSON events for this task
    const taskEventsRaw = eventsByTask[taskId] || [];
    let actIndex = 0;

    for (const item of taskEventsRaw) {
      let act: ParsedWorkerActivity | null = null;
      if (typeof item === 'string') {
        act = parseWorkerNDJSONLine(item, repoRoot);
      } else if (item && typeof item === 'object' && 'activity' in item) {
        act = item as ParsedWorkerActivity;
      }

      if (!act) continue;

      actIndex++;
      const actNodeId = act.id || `${runId}:${taskId}:act-${actIndex}`;
      const actParent = act.parentId || currentParentId;

      let actStatus: WorkerStatus = 'running';
      if (act.activity === 'DONE') actStatus = 'completed';
      else if (act.activity === 'FAIL') actStatus = 'failed';
      else if (act.activity === 'PASS') actStatus = 'completed';

      const actNode: ProjectGraphNode = {
        id: actNodeId,
        parentId: actParent,
        parentIds: [actParent],
        lane,
        depth: depthCounter++,
        type: 'activity',
        activity: act.activity,
        owner: 'Gemini',
        label: formatActivityLabel(act.activity, act.file, act.command),
        detailTitle: `${taskId} - 활동: ${act.activity}`,
        instruction: task.prompt,
        status: actStatus,
        startedAt: act.timestamp,
        completedAt: act.activity === 'DONE' || act.activity === 'FAIL' ? act.timestamp : undefined,
        taskId,
        taskName: task.name,
        model: worker?.model,
        file: act.file,
        files: act.file ? [act.file] : undefined,
        command: act.command,
        rawOutput: [act.raw],
        metadata: act.metadata,
      };

      nodes.push(actNode);
      edges.push({
        from: actParent,
        to: actNodeId,
        fromLane: lane,
        toLane: lane,
        type: 'direct',
      });

      currentParentId = actNodeId;
      tipCandidate = actNode;
    }

    // If worker has verification commands not present in NDJSON, append them
    if (worker?.verification?.commands && worker.verification.commands.length > 0) {
      worker.verification.commands.forEach((cmd, cmdIdx) => {
        const vNodeId = `${runId}:${taskId}:verify-${cmdIdx + 1}`;
        const vStatus: WorkerStatus = cmd.status === 'PASS' ? 'completed' : 'test_failed';
        const vNode: ProjectGraphNode = {
          id: vNodeId,
          parentId: currentParentId,
          parentIds: [currentParentId],
          lane,
          depth: depthCounter++,
          type: 'verification',
          activity: cmd.status === 'PASS' ? 'PASS' : 'FAIL',
          owner: 'Gemini',
          label: `검증: ${cmd.status} (${sanitizeCommand(cmd.command, repoRoot)})`,
          detailTitle: `${taskId} - 결정론적 검증`,
          instruction: task.prompt,
          status: vStatus,
          startedAt: worker.updatedAt,
          completedAt: worker.updatedAt,
          taskId,
          taskName: task.name,
          model: worker.model,
          command: cmd.command,
          verificationCommands: [cmd],
          rawOutput: cmd.output ? [cmd.output] : undefined,
        };
        nodes.push(vNode);
        edges.push({
          from: currentParentId,
          to: vNodeId,
          fromLane: lane,
          toLane: lane,
          type: 'direct',
        });
        currentParentId = vNodeId;
        tipCandidate = vNode;
      });
    }

    // Populate the latest tip node for this worker with full worker summary fields
    if (worker) {
      tipCandidate.status = workerStatus;
      tipCandidate.elapsedSeconds = worker.elapsedSeconds;
      tipCandidate.startedAt = worker.startedAt;
      if (!isWorkerActive(worker.status)) {
        tipCandidate.completedAt = worker.updatedAt;
      }
      if (worker.changedFiles && worker.changedFiles.length > 0) {
        tipCandidate.files = worker.changedFiles.map(f => sanitizePath(f, repoRoot));
      }
      if (worker.verification?.commands) {
        tipCandidate.verificationCommands = worker.verification.commands;
      }
      if (worker.verification?.decision) {
        tipCandidate.verificationDecision = worker.verification.decision;
      }
      if (worker.retryHistory && worker.retryHistory.length > 0) {
        tipCandidate.retryHistory = worker.retryHistory;
      }
      if (worker.error) {
        tipCandidate.error = worker.error;
      }
      if (worker.escalation) {
        tipCandidate.escalation = worker.escalation;
      }
    }

    workerTips.set(taskId, tipCandidate);
  });

  // 4. Integration Review Merge Node (Lane 0, Owner: Orchestrator)
  const hasIntegrationEvidence = Boolean(
    integration ||
    normalizedRunStatus === 'awaiting_review' ||
    normalizedRunStatus === 'completed' ||
    options.integrationBranch
  );

  let mergeNode: ProjectGraphNode | null = null;
  if (hasIntegrationEvidence && workerTips.size > 0) {
    const mergeNodeId = integration?.id || `${runId}:integration`;
    const tipNodes = Array.from(workerTips.values());
    const parentIds = tipNodes.map(t => t.id);

    const mergeLabel =
      normalizedRunStatus === 'awaiting_review'
        ? '통합 검토 대기 (main 병합 승인 필요)'
        : normalizedRunStatus === 'completed'
          ? '통합 검증 및 병합 완료'
          : normalizedRunStatus === 'failed'
            ? '통합 검토 실패'
            : '통합 검토';

    const integrationBranch =
      integration?.branch || options.integrationBranch || `integration/${runId}`;

    mergeNode = {
      id: mergeNodeId,
      parentId: parentIds[0],
      parentIds,
      lane: 0,
      depth: depthCounter++,
      type: 'merge',
      owner: 'Orchestrator',
      label: mergeLabel,
      detailTitle: `통합 브랜치: ${integrationBranch}`,
      instruction: '모든 Gemini 워커 브랜치를 통합 브랜치로 체리픽하고 통합 검증을 수행했습니다.',
      status: normalizedRunStatus,
      startedAt: integration?.startedAt || updatedAt,
      completedAt:
        normalizedRunStatus === 'completed' || normalizedRunStatus === 'awaiting_review'
          ? updatedAt
          : undefined,
      elapsedSeconds: Math.max(...tipNodes.map(t => t.elapsedSeconds || 0), 0),
      files: integration?.changedFiles?.map(f => sanitizePath(f, repoRoot)),
      verificationCommands: integration?.tests,
      verificationDecision: integration?.decision as string | undefined,
      metadata: integration || undefined,
    };

    nodes.push(mergeNode);

    // Merge edges from each worker tip back to Lane 0
    for (const tip of tipNodes) {
      edges.push({
        from: tip.id,
        to: mergeNodeId,
        fromLane: tip.lane,
        toLane: 0,
        type: 'merge',
      });
    }
  }

  // 5. Tips Calculation:
  // Every current graph tip shows owner (Codex, Gemini, or Orchestrator),
  // normalized status, elapsed time, start time, and completion time when present.
  const tips: ProjectGraphNode[] = [];
  if (mergeNode) {
    mergeNode.isTip = true;
    tips.push(mergeNode);
  } else if (workerTips.size > 0) {
    for (const tip of workerTips.values()) {
      tip.isTip = true;
      tips.push(tip);
    }
  } else {
    planNode.isTip = true;
    tips.push(planNode);
  }

  // Propagate run retry metadata to tips
  for (const tip of tips) {
    if (options.retryOf) tip.retryOf = options.retryOf;
    if (options.retriedByRunId) tip.retriedByRunId = options.retriedByRunId;
    if (options.retryCount !== undefined) tip.retryCount = options.retryCount;
    if (options.retryable !== undefined) tip.retryable = options.retryable;
  }

  return {
    runId,
    prompt: sanitizeText(prompt, repoRoot),
    status: normalizedRunStatus,
    nodes,
    edges,
    lanesCount: maxLane + 1,
    tips,
    retryOf: options.retryOf,
    retriedByRunId: options.retriedByRunId,
    retryCount: options.retryCount,
  };
}

/**
 * Returns nodes sorted bottom-to-top (oldest event at bottom, newest event accumulated upward at top).
 * Matches Visual Studio Git Graph layout where latest events sit at the top.
 */
export function sortGraphNodesNewestFirst(nodes: ProjectGraphNode[]): ProjectGraphNode[] {
  return [...nodes].reverse();
}

/**
 * Returns nodes in forward chronological order (request -> plan -> activities -> merge).
 */
export function sortGraphNodesOldestFirst(nodes: ProjectGraphNode[]): ProjectGraphNode[] {
  return [...nodes];
}

export const LANE_COLORS = [
  '#38bdf8', // Lane 0: Sky (Main / Orchestrator / Codex)
  '#c084fc', // Lane 1: Purple (Worker 1)
  '#f472b6', // Lane 2: Pink (Worker 2)
  '#34d399', // Lane 3: Emerald (Worker 3)
  '#fbbf24', // Lane 4: Amber (Worker 4)
  '#818cf8', // Lane 5: Indigo (Worker 5)
] as const;

export function getLaneColor(lane: number): string {
  const index = Math.abs(lane) % LANE_COLORS.length;
  return LANE_COLORS[index];
}

export const GRAPH_LAYOUT_CONFIG = {
  rowHeight: 52,
  laneWidth: 26,
  laneXOffset: 14,
  nodeCenterYOffset: 26,
  nodeRadius: 5,
  defaultMinLanes: 2,
  svgExtraWidth: 16,
} as const;

export interface GraphLayoutNode {
  id: string;
  node: ProjectGraphNode;
  rowIndex: number;
  x: number;
  y: number;
  lane: number;
  color: string;
  isTip: boolean;
}

export type GraphLayoutEdgeType = 'direct' | 'branch' | 'merge';

export interface GraphLayoutEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  fromRowIndex: number;
  toRowIndex: number;
  fromLane: number;
  toLane: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  type: GraphLayoutEdgeType;
  color: string;
  pathD: string;
}

export interface GraphPassThroughSegment {
  lane: number;
  x: number;
  fromY: number;
  toY: number;
  fromRowIndex: number;
  toRowIndex: number;
  color: string;
  fromNodeId?: string;
  toNodeId?: string;
}

export interface GraphLayoutGeometry {
  width: number;
  height: number;
  rowHeight: number;
  laneWidth: number;
  lanesCount: number;
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  passThroughSegments: GraphPassThroughSegment[];
}

export interface ComputeGraphGeometryOptions {
  rowHeight?: number;
  laneWidth?: number;
  laneXOffset?: number;
  nodeCenterYOffset?: number;
  minLanes?: number;
}

export function computeLaneX(
  lane: number,
  laneWidth: number = GRAPH_LAYOUT_CONFIG.laneWidth,
  xOffset: number = GRAPH_LAYOUT_CONFIG.laneXOffset
): number {
  return xOffset + lane * laneWidth;
}

export function computeNodeY(
  rowIndex: number,
  rowHeight: number = GRAPH_LAYOUT_CONFIG.rowHeight,
  yOffset: number = GRAPH_LAYOUT_CONFIG.nodeCenterYOffset
): number {
  return rowIndex * rowHeight + yOffset;
}

export function computeGraphSvgWidth(
  lanesCount: number,
  laneWidth: number = GRAPH_LAYOUT_CONFIG.laneWidth,
  extraWidth: number = GRAPH_LAYOUT_CONFIG.svgExtraWidth
): number {
  const effectiveLanes = Math.max(lanesCount || 1, GRAPH_LAYOUT_CONFIG.defaultMinLanes);
  return effectiveLanes * laneWidth + extraWidth;
}

export function computeGraphSvgHeight(
  nodeCount: number,
  rowHeight: number = GRAPH_LAYOUT_CONFIG.rowHeight
): number {
  return Math.max(nodeCount, 0) * rowHeight;
}

/**
 * Computes deterministic global layout geometry for the full-graph SVG.
 * All coordinates are in a unified global system:
 * - rowHeight defaults to 52px
 * - node centers at rowIndex * rowHeight + nodeCenterYOffset (26px)
 * - edges directly connect node centers (solid direct edges, smooth cubic bezier branches/merges)
 * - pass-through segments connect inactive-row spans without duplicate lines underneath direct edges
 */
export function computeGraphLayoutGeometry(
  input: ProjectGraphNode[] | ProjectWorkGraphData,
  options?: ComputeGraphGeometryOptions
): GraphLayoutGeometry {
  const displayNodes = Array.isArray(input)
    ? input
    : sortGraphNodesNewestFirst(input.nodes);

  const rowHeight = options?.rowHeight ?? GRAPH_LAYOUT_CONFIG.rowHeight;
  const laneWidth = options?.laneWidth ?? GRAPH_LAYOUT_CONFIG.laneWidth;
  const laneXOffset = options?.laneXOffset ?? GRAPH_LAYOUT_CONFIG.laneXOffset;
  const nodeCenterYOffset = options?.nodeCenterYOffset ?? GRAPH_LAYOUT_CONFIG.nodeCenterYOffset;
  const minLanes = options?.minLanes ?? (('lanesCount' in input && typeof input.lanesCount === 'number') ? input.lanesCount : GRAPH_LAYOUT_CONFIG.defaultMinLanes);

  let maxLane = 0;
  for (const node of displayNodes) {
    if (node.lane > maxLane) maxLane = node.lane;
  }
  const lanesCount = Math.max(maxLane + 1, minLanes, GRAPH_LAYOUT_CONFIG.defaultMinLanes);
  const width = computeGraphSvgWidth(lanesCount, laneWidth);
  const height = computeGraphSvgHeight(displayNodes.length, rowHeight);

  const nodeIndexMap = new Map<string, number>();
  displayNodes.forEach((n, idx) => nodeIndexMap.set(n.id, idx));

  // 1. Nodes layout
  const layoutNodes: GraphLayoutNode[] = displayNodes.map((node, rowIndex) => {
    const x = computeLaneX(node.lane, laneWidth, laneXOffset);
    const y = computeNodeY(rowIndex, rowHeight, nodeCenterYOffset);
    const color = getLaneColor(node.lane);
    return {
      id: node.id,
      node,
      rowIndex,
      x,
      y,
      lane: node.lane,
      color,
      isTip: Boolean(node.isTip),
    };
  });

  // 2. Edges layout
  const layoutEdges: GraphLayoutEdge[] = [];
  const edgePairKeys = new Set<string>();

  const addEdge = (parent: ProjectGraphNode, child: ProjectGraphNode, explicitType?: GraphLayoutEdgeType) => {
    const parentRow = nodeIndexMap.get(parent.id);
    const childRow = nodeIndexMap.get(child.id);
    if (parentRow === undefined || childRow === undefined) return;
    if (parentRow <= childRow) return; // In displayNodes (newest first), parent is below child

    const edgeKey = `${parent.id}->${child.id}`;
    if (edgePairKeys.has(edgeKey)) return;
    edgePairKeys.add(edgeKey);
    edgePairKeys.add(`${parent.id}<->${child.id}`);
    edgePairKeys.add(`${child.id}<->${parent.id}`);

    const fromX = computeLaneX(parent.lane, laneWidth, laneXOffset);
    const fromY = computeNodeY(parentRow, rowHeight, nodeCenterYOffset);
    const toX = computeLaneX(child.lane, laneWidth, laneXOffset);
    const toY = computeNodeY(childRow, rowHeight, nodeCenterYOffset);

    let edgeType: GraphLayoutEdgeType;
    if (explicitType) {
      edgeType = explicitType;
    } else if (parent.lane === child.lane) {
      edgeType = 'direct';
    } else if (child.type === 'merge') {
      edgeType = 'merge';
    } else {
      edgeType = 'branch';
    }

    let edgeColor: string;
    let pathD: string;

    if (edgeType === 'direct') {
      edgeColor = getLaneColor(child.lane);
      pathD = `M ${fromX} ${fromY} L ${toX} ${toY}`;
    } else if (edgeType === 'merge') {
      edgeColor = getLaneColor(parent.lane);
      const midY = (fromY + toY) / 2;
      pathD = `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
    } else {
      edgeColor = getLaneColor(child.lane);
      const midY = (fromY + toY) / 2;
      pathD = `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
    }

    layoutEdges.push({
      id: edgeKey,
      fromNodeId: parent.id,
      toNodeId: child.id,
      fromRowIndex: parentRow,
      toRowIndex: childRow,
      fromLane: parent.lane,
      toLane: child.lane,
      fromX,
      fromY,
      toX,
      toY,
      type: edgeType,
      color: edgeColor,
      pathD,
    });
  };

  // Add edges from child node parentIds / parentId
  for (const childNode of displayNodes) {
    const pIds = childNode.parentIds && childNode.parentIds.length > 0
      ? childNode.parentIds
      : (childNode.parentId ? [childNode.parentId] : []);

    for (const pId of pIds) {
      const parentRow = nodeIndexMap.get(pId);
      if (parentRow !== undefined) {
        addEdge(displayNodes[parentRow], childNode);
      }
    }
  }

  // If input has explicit edges array, ensure any additional defined edges are included
  if (!Array.isArray(input) && input.edges) {
    for (const e of input.edges) {
      const parentRow = nodeIndexMap.get(e.from);
      const childRow = nodeIndexMap.get(e.to);
      if (parentRow !== undefined && childRow !== undefined && parentRow > childRow) {
        addEdge(displayNodes[parentRow], displayNodes[childRow], e.type);
      }
    }
  }

  // 3. Pass-Through Segments for Inactive Rows
  const passThroughSegments: GraphPassThroughSegment[] = [];

  for (let l = 0; l < lanesCount; l++) {
    const laneNodes: Array<{ node: ProjectGraphNode; rowIndex: number }> = [];
    for (let i = 0; i < displayNodes.length; i++) {
      if (displayNodes[i].lane === l) {
        laneNodes.push({ node: displayNodes[i], rowIndex: i });
      }
    }

    if (laneNodes.length < 2) continue;

    for (let j = 0; j < laneNodes.length - 1; j++) {
      const upper = laneNodes[j];
      const lower = laneNodes[j + 1];

      // If there is no direct edge connecting this pair, lane l passes through
      const hasDirectEdge = edgePairKeys.has(`${upper.node.id}<->${lower.node.id}`);

      if (!hasDirectEdge) {
        const x = computeLaneX(l, laneWidth, laneXOffset);
        const fromY = computeNodeY(upper.rowIndex, rowHeight, nodeCenterYOffset);
        const toY = computeNodeY(lower.rowIndex, rowHeight, nodeCenterYOffset);

        passThroughSegments.push({
          lane: l,
          x,
          fromY,
          toY,
          fromRowIndex: upper.rowIndex,
          toRowIndex: lower.rowIndex,
          color: getLaneColor(l),
          fromNodeId: upper.node.id,
          toNodeId: lower.node.id,
        });
      }
    }
  }

  return {
    width,
    height,
    rowHeight,
    laneWidth,
    lanesCount,
    nodes: layoutNodes,
    edges: layoutEdges,
    passThroughSegments,
  };
}

