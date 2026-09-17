import type { GraphLayoutGeometry, ProjectGraphNode, ProjectWorkGraphData } from '../../packages/orchestrator-core/project-event-graph.ts';
import { computeGraphLayoutGeometry } from '../../packages/orchestrator-core/project-event-graph.ts';
import { evaluateRunRetrySafety } from '../../packages/orchestrator-core/workspace-contract.ts';

export const ACTIVE_RUN_STATUSES = new Set(['planning', 'running', 'retrying', 'pending']);

function parentIdsOf(node: ProjectGraphNode): string[] {
  if (Array.isArray(node.parentIds) && node.parentIds.length > 0) {
    return node.parentIds.filter(Boolean);
  }
  return node.parentId ? [node.parentId] : [];
}

function compareNewestFirst(left: ProjectGraphNode, right: ProjectGraphNode): number {
  const leftTime = Date.parse(left.startedAt || left.completedAt || '') || 0;
  const rightTime = Date.parse(right.startedAt || right.completedAt || '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return 0;
}

function formatNodeDescription(node: ProjectGraphNode): string {
  const parts = [node.owner, String(node.status)];
  if (node.activity) parts.push(node.activity);
  if (typeof node.elapsedSeconds === 'number') parts.push(`${node.elapsedSeconds}s`);
  return parts.join(' · ');
}

function timeLabel(iso?: string): string | undefined {
  return iso && !Number.isNaN(Date.parse(iso)) ? iso.slice(11, 19) : undefined;
}

/** Oldest-first recorded activities of one worker, each a real graph node. */
export function workerTimelineLines(graph: ProjectWorkGraphData, taskId: string): string[] {
  return graph.nodes
    .filter(node => node.taskId === taskId && node.activity)
    .slice()
    .sort((left, right) => -compareNewestFirst(left, right))
    .map(node => {
      const target = node.file || node.command || node.label;
      const parts = [timeLabel(node.startedAt || node.completedAt), `${node.activity} ${target}`, String(node.status)];
      return `- ${parts.filter(Boolean).join(' · ')}`;
    });
}

export function formatNodeDetail(node: ProjectGraphNode, graph?: ProjectWorkGraphData): string {
  const lines = [`# ${node.label}`, '', `- owner: ${node.owner}`, `- status: ${node.status}`];
  if (node.activity) lines.push(`- activity: ${node.activity}`);
  if (node.taskId) lines.push(`- task: ${node.taskId}`);
  if (node.model) lines.push(`- model: ${node.model}`);
  if (node.attempt) lines.push(`- attempt: ${node.attempt}`);
  if (node.startedAt) lines.push(`- started: ${node.startedAt}`);
  if (node.completedAt) lines.push(`- completed: ${node.completedAt}`);
  if (node.file) lines.push(`- file: ${node.file}`);
  if (node.files?.length) lines.push(`- files: ${node.files.join(', ')}`);
  if (node.command) lines.push(`- command: ${node.command}`);
  if (node.verificationDecision) lines.push(`- verification: ${node.verificationDecision}`);
  const tests = node.verificationCommands || [];
  if (tests.length > 0) {
    lines.push('', '## Tests');
    for (const test of tests) {
      lines.push(`- ${test.status} \`${test.command}\` (exit ${test.exitCode})`);
      if (test.output?.trim()) {
        lines.push('```', ...test.output.trim().split(/\r?\n/).slice(-20), '```');
      }
    }
  }
  if (node.retryHistory?.length) {
    lines.push('', '## Retry history');
    for (const retry of node.retryHistory) {
      lines.push(`- attempt ${retry.attempt}: ${retry.decision}`);
    }
  }
  if (node.error) lines.push('', `- error: ${node.error}`);
  const timeline = graph && node.taskId ? workerTimelineLines(graph, node.taskId) : [];
  if (timeline.length > 0) lines.push('', `## Timeline ${node.taskId}`, ...timeline);
  if (node.rawOutput?.length) {
    lines.push('', '## CLI output', '```', ...node.rawOutput.slice(-40), '```');
  }
  return lines.join('\n');
}

export interface RunEvidenceExtras {
  integrationBranch?: string;
  diffSummary?: string;
  problems?: Array<{ file: string; message: string; severity: string }>;
}

export function collectActivityEvents(graph: ProjectWorkGraphData) {
  return graph.nodes
    .filter(node => node.activity)
    .slice()
    .sort(compareNewestFirst)
    .map(node => ({
      activity: node.activity as string,
      label: node.label,
      file: node.file,
      status: String(node.status),
      owner: node.owner,
      taskId: node.taskId,
      time: timeLabel(node.startedAt || node.completedAt),
    }));
}

export function collectTestResults(graph: ProjectWorkGraphData) {
  return graph.nodes.flatMap(node => node.verificationCommands || []);
}

/** Short review summary for the Task Graph's review section: tests, problems, branch. */
export function formatReviewLines(graph: ProjectWorkGraphData, extras: RunEvidenceExtras = {}): string[] {
  const tests = collectTestResults(graph);
  const failed = tests.filter(test => test.status === 'FAIL');
  const lines = [
    tests.length > 0
      ? `테스트 · PASS ${tests.length - failed.length} · FAIL ${failed.length}`
      : '테스트 · 기록 없음',
    ...failed.map(test => `  ${test.status} ${test.command} (exit ${test.exitCode})`),
  ];
  if (extras.problems) lines.push(`Problems · ${extras.problems.length}`);
  lines.push(extras.integrationBranch ? `통합 브랜치 · ${extras.integrationBranch}` : '통합 브랜치 · 없음');
  return lines;
}

export function formatRunEvidence(
  graph: ProjectWorkGraphData,
  extras: RunEvidenceExtras = {}
): string {
  const lines = [
    `# Run ${graph.runId}`,
    '',
    `- status: ${graph.status}`,
    `- prompt: ${graph.prompt}`,
  ];
  if (extras.integrationBranch) lines.push(`- integration branch: ${extras.integrationBranch}`);

  const activities = collectActivityEvents(graph);
  if (activities.length > 0) {
    lines.push('', '## Events');
    for (const event of activities) {
      const file = event.file ? ` ${event.file}` : '';
      const parts = [`${event.activity}${file}`, event.owner, event.taskId, event.status, event.time];
      lines.push(`- ${parts.filter(Boolean).join(' · ')}`);
    }
  }

  const tests = collectTestResults(graph);
  if (tests.length > 0) {
    lines.push('', '## Tests');
    for (const test of tests) {
      lines.push(`- ${test.status} \`${test.command}\` (exit ${test.exitCode})`);
    }
  }

  if (extras.diffSummary) {
    lines.push('', '## Git diff', '```', extras.diffSummary, '```');
  }

  if (extras.problems && extras.problems.length > 0) {
    lines.push('', '## VS Code Problems');
    for (const problem of extras.problems) {
      lines.push(`- [${problem.severity}] ${problem.file}: ${problem.message}`);
    }
  }

  return lines.join('\n');
}

export interface GraphRow {
  id: string;
  runId: string;
  label: string;
  owner: string;
  status: string;
  activity?: string;
  elapsedSeconds?: number;
  isTip: boolean;
  retryable: boolean;
  tooltip: string;
  detail: string;
  /** Workspace-relative files this node changed; each opens a diff. */
  files: string[];
}

export interface GraphViewModel {
  runId: string;
  prompt: string;
  status: string;
  retryable: boolean;
  layout: GraphLayoutGeometry;
  rows: GraphRow[];
}

/**
 * Mirrors the core's newest-on-top layout so the run reads top-to-bottom
 * (request first). Edge curves are vertically symmetric, so flipping y is exact.
 */
export function flipLayoutVertically(layout: GraphLayoutGeometry): GraphLayoutGeometry {
  const flipY = (y: number) => layout.height - y;
  const rowCount = layout.nodes.length;
  const flipRow = (row: number) => rowCount - 1 - row;
  const pathFor = (edge: { type: string; fromX: number; fromY: number; toX: number; toY: number }) => {
    if (edge.type === 'direct') return `M ${edge.fromX} ${edge.fromY} L ${edge.toX} ${edge.toY}`;
    const midY = (edge.fromY + edge.toY) / 2;
    return `M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`;
  };
  return {
    ...layout,
    nodes: layout.nodes
      .map(item => ({ ...item, y: flipY(item.y), rowIndex: flipRow(item.rowIndex) }))
      .reverse(),
    edges: layout.edges.map(edge => {
      const flipped = {
        ...edge,
        fromY: flipY(edge.fromY),
        toY: flipY(edge.toY),
        fromRowIndex: flipRow(edge.fromRowIndex),
        toRowIndex: flipRow(edge.toRowIndex),
      };
      return { ...flipped, pathD: pathFor(flipped) };
    }),
    passThroughSegments: layout.passThroughSegments.map(segment => ({
      ...segment,
      fromY: flipY(segment.fromY),
      toY: flipY(segment.toY),
      fromRowIndex: flipRow(segment.fromRowIndex),
      toRowIndex: flipRow(segment.toRowIndex),
    })),
  };
}

/** Oldest-first rows plus SVG geometry, computed from the stored graph only. */
export function buildGraphViewModel(graph: ProjectWorkGraphData | null): GraphViewModel | null {
  if (!graph) return null;
  const layout = flipLayoutVertically(computeGraphLayoutGeometry(graph));
  const rows = layout.nodes.map(({ node, isTip }) => ({
    id: node.id,
    runId: graph.runId,
    label: node.label,
    owner: node.owner,
    status: String(node.status),
    activity: node.activity,
    elapsedSeconds: node.elapsedSeconds,
    isTip,
    retryable: evaluateRunRetrySafety({
      status: node.status,
      retryable: node.retryable,
      error: node.error,
      escalation: node.escalation,
    }).canRetry,
    tooltip: node.instruction || node.detailTitle || node.label,
    detail: formatNodeDetail(node, graph),
    files: node.files || [],
  }));
  return {
    runId: graph.runId,
    prompt: graph.prompt || graph.runId,
    status: graph.status,
    retryable: evaluateRunRetrySafety({ status: graph.status }).canRetry,
    layout,
    rows,
  };
}

export function shouldPollRun(status?: string): boolean {
  return Boolean(status && ACTIVE_RUN_STATUSES.has(status));
}
