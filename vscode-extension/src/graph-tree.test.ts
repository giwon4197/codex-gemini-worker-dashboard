import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectWorkGraphData } from '../../packages/orchestrator-core/project-event-graph.ts';
import { buildGraphViewModel, flipLayoutVertically, formatNodeDetail, formatReviewLines, formatRunEvidence, shouldPollRun } from './graph-tree.ts';
import { computeGraphLayoutGeometry } from '../../packages/orchestrator-core/project-event-graph.ts';

function graph(overrides: Partial<ProjectWorkGraphData> = {}): ProjectWorkGraphData {
  return {
    runId: 'run-1',
    prompt: '버튼 수정',
    status: 'running',
    nodes: [
      {
        id: 'req',
        lane: 0,
        depth: 0,
        type: 'request',
        owner: 'Codex',
        label: '요청',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'plan',
        parentId: 'req',
        lane: 0,
        depth: 1,
        type: 'plan',
        owner: 'Codex',
        label: '계획',
        status: 'completed',
        startedAt: '2026-01-01T00:00:01Z',
      },
      {
        id: 'edit-old',
        parentId: 'plan',
        lane: 1,
        depth: 2,
        type: 'activity',
        activity: 'EDIT',
        owner: 'Gemini',
        label: 'EDIT a.ts',
        status: 'completed',
        file: 'a.ts',
        startedAt: '2026-01-01T00:00:02Z',
      },
      {
        id: 'edit-new',
        parentId: 'plan',
        lane: 1,
        depth: 2,
        type: 'activity',
        activity: 'EDIT',
        owner: 'Gemini',
        label: 'EDIT b.ts',
        status: 'running',
        file: 'b.ts',
        startedAt: '2026-01-01T00:00:03Z',
      },
    ],
    edges: [],
    lanesCount: 2,
    tips: [],
    ...overrides,
  };
}

void test('buildGraphViewModel returns null when core has no graph', () => {
  assert.equal(buildGraphViewModel(null), null);
});

void test('graph rows do not invent nodes beyond the stored graph', () => {
  const model = buildGraphViewModel(graph());
  assert.ok(model);
  assert.deepEqual(model.rows.map(row => row.id).sort(), ['edit-new', 'edit-old', 'plan', 'req'].sort());
  assert.equal(model.layout.nodes.length, 4);
  assert.ok(model.layout.edges.length >= 3);
});

void test('rows carry each node recorded changed files for the diff list', () => {
  const model = buildGraphViewModel(
    graph({
      nodes: [
        { id: 'req', lane: 0, depth: 0, type: 'request', owner: 'Codex', label: '요청', status: 'completed' },
        { id: 'edit', lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: '수정', status: 'completed', parentIds: ['req'], files: ['src/a.ts', 'src/b.ts'] },
      ],
    })
  );
  assert.deepEqual(model?.rows.map(row => row.files), [[], ['src/a.ts', 'src/b.ts']]);
});

void test('rows are oldest first so the run reads top-to-bottom', () => {
  const model = buildGraphViewModel(graph());
  assert.deepEqual(model?.rows.map(row => row.id), ['req', 'plan', 'edit-old', 'edit-new']);
});

void test('failed retryable run is marked retryable without extra nodes', () => {
  const model = buildGraphViewModel(
    graph({
      status: 'failed',
      nodes: [
        {
          id: 'fail',
          lane: 0,
          depth: 0,
          type: 'verification',
          owner: 'Orchestrator',
          label: '테스트 실패',
          status: 'failed',
          retryable: true,
          error: 'TEST_FAILED',
        },
      ],
    })
  );
  assert.equal(model?.retryable, true);
  assert.equal(model?.rows[0]?.retryable, true);
  assert.match(model?.rows[0]?.detail || '', /TEST_FAILED/);
});

void test('node detail includes recorded activity and tests only', () => {
  const detail = formatNodeDetail({
    id: 'verify',
    lane: 0,
    depth: 0,
    type: 'verification',
    owner: 'Orchestrator',
    label: '검증',
    status: 'failed',
    activity: 'FAIL',
    verificationCommands: [
      { command: 'npm test', exitCode: 1, status: 'FAIL', output: 'expected 2\nreceived 3' },
    ],
    file: 'src/sum.test.ts',
  });
  assert.match(detail, /activity: FAIL/);
  assert.match(detail, /## Tests/);
  assert.match(detail, /FAIL `npm test`/);
  assert.doesNotMatch(detail, /LOAD/);
});

void test('run evidence omits git and problems when they were not supplied', () => {
  const markdown = formatRunEvidence(graph());
  assert.match(markdown, /## Events/);
  assert.match(markdown, /- EDIT b.ts/);
  assert.doesNotMatch(markdown, /## Git diff/);
  assert.doesNotMatch(markdown, /## VS Code Problems/);
  assert.doesNotMatch(markdown, /## Tests/);
});

void test('run evidence lists tests, diff, and problems without inventing events', () => {
  const markdown = formatRunEvidence(
    graph({
      nodes: [
        {
          id: 'verify',
          lane: 0,
          depth: 0,
          type: 'verification',
          owner: 'Orchestrator',
          label: '검증',
          status: 'failed',
          verificationCommands: [{ command: 'npm test', exitCode: 1, status: 'FAIL' }],
        },
      ],
    }),
    {
      integrationBranch: 'integration/run-1',
      diffSummary: ' src/sum.ts | 2 +-\n 1 file changed',
      problems: [{ file: 'src/sum.ts', message: 'unused', severity: 'Warning' }],
    }
  );
  assert.match(markdown, /integration\/run-1/);
  assert.match(markdown, /## Tests/);
  assert.match(markdown, /FAIL `npm test`/);
  assert.match(markdown, /## Git diff/);
  assert.match(markdown, /## VS Code Problems/);
  assert.doesNotMatch(markdown, /## Events/);
});

void test('shouldPollRun is true only for in-flight statuses', () => {
  assert.equal(shouldPollRun('running'), true);
  assert.equal(shouldPollRun('awaiting_review'), false);
  assert.equal(shouldPollRun('failed'), false);
  assert.equal(shouldPollRun(undefined), false);
});

void test('node detail lists the worker timeline oldest-first from recorded nodes only', () => {
  const data = graph();
  for (const node of data.nodes) if (node.type === 'activity') node.taskId = 'TASK-1';
  const detail = formatNodeDetail(data.nodes[3]!, data);
  const timeline = detail.slice(detail.indexOf('## Timeline TASK-1'));
  assert.match(timeline, /- 00:00:02 · EDIT a.ts · completed\n- 00:00:03 · EDIT b.ts · running/);
  assert.doesNotMatch(formatNodeDetail(data.nodes[3]!), /## Timeline/);
});

void test('run evidence events carry owner, task and time without inventing fields', () => {
  const markdown = formatRunEvidence(graph());
  assert.match(markdown, /- EDIT b.ts · Gemini · running · 00:00:03/);
});

void test('graph view reads top-to-bottom with mirrored geometry', () => {
  const data = graph();
  const model = buildGraphViewModel(data);
  assert.ok(model);
  assert.equal(model.rows[0]?.id, 'req');
  assert.equal(model.rows[model.rows.length - 1]?.id, 'edit-new');
  const ys = model.layout.nodes.map(item => item.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys);
  assert.equal(model.layout.nodes[0]?.rowIndex, 0);
  const original = computeGraphLayoutGeometry(data);
  const flipped = flipLayoutVertically(original);
  assert.equal(flipped.edges.length, original.edges.length);
  for (const [index, edge] of flipped.edges.entries()) {
    const source = original.edges[index]!;
    assert.equal(edge.fromY, original.height - source.fromY);
    assert.equal(edge.toY, original.height - source.toY);
    assert.match(edge.pathD, new RegExp(`^M ${edge.fromX} ${edge.fromY} `));
  }
  for (const [index, segment] of flipped.passThroughSegments.entries()) {
    assert.equal(segment.fromY, original.height - original.passThroughSegments[index]!.fromY);
  }
});

void test('review lines count tests and problems and name the integration branch', () => {
  assert.deepEqual(formatReviewLines(graph()), ['테스트 · 기록 없음', '통합 브랜치 · 없음']);
  const lines = formatReviewLines(
    graph({
      nodes: [
        {
          id: 'verify',
          lane: 0,
          depth: 0,
          type: 'verification',
          owner: 'Orchestrator',
          label: '검증',
          status: 'failed',
          verificationCommands: [
            { command: 'npm test', status: 'PASS', exitCode: 0 },
            { command: 'npm run lint', status: 'FAIL', exitCode: 1 },
          ],
        },
      ],
    }),
    { integrationBranch: 'integration/r-1', problems: [{ file: 'a.ts', message: 'x', severity: 'Error' }] }
  );
  assert.deepEqual(lines, [
    '테스트 · PASS 1 · FAIL 1',
    '  FAIL npm run lint (exit 1)',
    'Problems · 1',
    '통합 브랜치 · integration/r-1',
  ]);
});
