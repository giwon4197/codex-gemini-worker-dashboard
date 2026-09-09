import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { GET as getProjectWorkers } from './route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { STALE_PROCESS_MISMATCH_REASON, setGlobalLivenessOptions, resetGlobalLivenessOptions } from '../../../../../lib/process-liveness.ts';

void describe('/api/projects/[projectId]/workers API Route Handlers', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;

  beforeEach(() => {
    resetGlobalLivenessOptions();
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-api-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create minimal agent directory structure
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
  });

  afterEach(() => {
    resetGlobalLivenessOptions();
    if (savedAllowedRepo !== undefined) {
      process.env.ALLOWED_REPO_ROOT = savedAllowedRepo;
    } else {
      delete process.env.ALLOWED_REPO_ROOT;
    }
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  void test('returns 200 and separates active running workers from terminated ones', async () => {
    const runId = '20260909-workers-01';
    const runFolder = path.join(testRepoDir, '.agent', 'runs', runId);
    fs.mkdirSync(path.join(runFolder, 'workers'), { recursive: true });
    fs.mkdirSync(path.join(runFolder, 'results'), { recursive: true });

    // Active worker
    fs.writeFileSync(
      path.join(runFolder, 'workers', 'TASK-001.json'),
      JSON.stringify({
        runId,
        taskId: 'TASK-001',
        task: '대화형 작업 공간 구현',
        status: 'running',
        startedAt: '2026-09-09T10:00:00Z',
        updatedAt: '2026-09-09T10:01:00Z',
        elapsedSeconds: 60,
        changedFiles: [`${testRepoDir}\\gemini-dashboard\\app\\page.tsx`],
        recentLogs: [
          {
            timestamp: '10:00:30',
            message: '단계: tool (ACTIVE)',
            type: 'step',
          },
        ],
      }),
      'utf8'
    );

    // Terminated worker
    fs.writeFileSync(
      path.join(runFolder, 'results', 'TASK-002-result.json'),
      JSON.stringify({
        runId,
        taskId: 'TASK-002',
        task: '단위 테스트 작성',
        status: 'completed',
        startedAt: '2026-09-09T09:00:00Z',
        updatedAt: '2026-09-09T09:05:00Z',
        elapsedSeconds: 300,
        changedFiles: [`${testRepoDir}\\gemini-dashboard\\lib\\workspace.test.ts`],
        recentLogs: [],
      }),
      'utf8'
    );

    fs.writeFileSync(
      path.join(runFolder, 'run.json'),
      JSON.stringify({
        runId,
        status: 'running',
        tasks: ['TASK-001', 'TASK-002'],
      }),
      'utf8'
    );

    const req = new Request('http://localhost:3000/api/projects/current/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      activeWorkers: Array<{ taskId: string; changedFiles: string[] }>;
      historyWorkers: Array<{ taskId: string; changedFiles: string[] }>;
    };

    assert.strictEqual(data.ok, true);

    // Active worker must be present in activeWorkers
    const activeIds = data.activeWorkers.map(w => w.taskId);
    assert.ok(activeIds.includes('TASK-001'));
    assert.ok(!activeIds.includes('TASK-002'));

    // Terminated worker must be in historyWorkers
    const historyIds = data.historyWorkers.map(w => w.taskId);
    assert.ok(historyIds.includes('TASK-002'));

    // Verify sanitization: absolute paths removed from changedFiles
    assert.deepStrictEqual(data.activeWorkers[0].changedFiles, [
      'gemini-dashboard/app/page.tsx',
    ]);
  });

  void test('tracks live worker in project control when dashboard run is linked to actual run', async () => {
    const dashboardRunId = '20260909-PROJ-DASH-01';
    const actualRunId = '20260909-PROJ-ACTUAL-01';

    // Save initial compact state with child PID
    fs.writeFileSync(
      path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${dashboardRunId}.json`),
      JSON.stringify({
        runId: dashboardRunId,
        prompt: '프로젝트 실시간 관제 연동',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 7788,
      }),
      'utf8'
    );

    // Create actual run in .agent/runs/<actualRunId>
    const actualRunDir = path.join(testRepoDir, '.agent', 'runs', actualRunId);
    fs.mkdirSync(path.join(actualRunDir, 'workers'), { recursive: true });
    fs.mkdirSync(path.join(actualRunDir, 'results'), { recursive: true });
    fs.mkdirSync(path.join(actualRunDir, 'tasks'), { recursive: true });

    fs.writeFileSync(
      path.join(actualRunDir, 'run.json'),
      JSON.stringify({
        runId: actualRunId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        repository: testRepoDir,
        orchestratorProcessId: 7788,
        tasks: ['TASK-PROJ-01'],
      }),
      'utf8'
    );

    fs.writeFileSync(
      path.join(actualRunDir, 'workers', 'TASK-PROJ-01.json'),
      JSON.stringify({
        runId: actualRunId,
        taskId: 'TASK-PROJ-01',
        task: '프로젝트 관제 활성 워커',
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        recentLogs: [],
      }),
      'utf8'
    );

    const req = new Request('http://localhost:3000/api/projects/current/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      activeWorkers: Array<{ taskId: string; status: string }>;
    };

    assert.strictEqual(data.ok, true);
    assert.ok(data.activeWorkers.some(w => w.taskId === 'TASK-PROJ-01' && w.status === 'running'));
  });

  void test('rejects path traversal in projectId parameter with status 400', async () => {
    const req = new Request('http://localhost:3000/api/projects/../../secret/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: '../../secret' }),
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json() as { ok: boolean; error: string };
    assert.strictEqual(data.ok, false);
    assert.ok(data.error.includes('유효하지 않은'));
  });

  void test('excludes stale worker with dead PID from activeWorkers and places in historyWorkers', async () => {
    const staleRunId = '20260909-PROJ-STALE-01';
    const oldTime = new Date(Date.now() - 180_000).toISOString(); // 3 minutes ago

    fs.writeFileSync(
      path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${staleRunId}.json`),
      JSON.stringify({
        runId: staleRunId,
        prompt: '죽은 워커 관제 작업',
        createdAt: oldTime,
        updatedAt: oldTime,
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 99999999, // dead PID
      }),
      'utf8'
    );

    const req = new Request('http://localhost:3000/api/projects/current/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      activeWorkers: Array<{ runId: string; status: string }>;
      historyWorkers: Array<{ runId: string; status: string; error?: string }>;
    };

    assert.strictEqual(data.ok, true);
    // Stale worker must NOT be present in activeWorkers
    assert.strictEqual(data.activeWorkers.some((w) => w.runId === staleRunId), false);

    // Stale worker must appear in historyWorkers with status failed
    const historyWorker = data.historyWorkers.find((w) => w.runId === staleRunId);
    assert.ok(historyWorker);
    assert.strictEqual(historyWorker.status, 'failed');
    assert.strictEqual(historyWorker.error, STALE_PROCESS_MISMATCH_REASON);
  });

  void test('excludes stale worker with reused/unrelated PID from activeWorkers', async () => {
    const reusedRunId = '20260909-PROJ-REUSED-01';
    const oldTime = new Date(Date.now() - 180_000).toISOString();

    fs.writeFileSync(
      path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${reusedRunId}.json`),
      JSON.stringify({
        runId: reusedRunId,
        prompt: '재사용 PID 관제 작업',
        createdAt: oldTime,
        updatedAt: oldTime,
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 5566,
      }),
      'utf8'
    );

    setGlobalLivenessOptions({
      processInfoResolver: (pid) => ({
        pid,
        alive: true,
        name: 'notepad.exe',
        command: 'notepad.exe C:\\other.txt',
        metadataAvailable: true,
      }),
    });

    const req = new Request('http://localhost:3000/api/projects/current/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      activeWorkers: Array<{ runId: string; status: string }>;
      historyWorkers: Array<{ runId: string; status: string; error?: string }>;
    };

    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.activeWorkers.some((w) => w.runId === reusedRunId), false);

    const historyWorker = data.historyWorkers.find((w) => w.runId === reusedRunId);
    assert.ok(historyWorker);
    assert.strictEqual(historyWorker.status, 'failed');
  });

  void test('retains newly launched run inside grace period in activeWorkers', async () => {
    const newRunId = '20260909-PROJ-GRACE-01';
    const recentTime = new Date(Date.now() - 5_000).toISOString(); // 5 seconds ago (< 30s)

    fs.writeFileSync(
      path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${newRunId}.json`),
      JSON.stringify({
        runId: newRunId,
        prompt: '새로 시작된 관제 작업',
        createdAt: recentTime,
        updatedAt: recentTime,
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 99999999, // dead PID before manifest written
      }),
      'utf8'
    );

    const req = new Request('http://localhost:3000/api/projects/current/workers');
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      activeWorkers: Array<{ runId: string; status: string }>;
    };

    assert.strictEqual(data.ok, true);
    assert.ok(data.activeWorkers.some((w) => w.runId === newRunId && w.status === 'running'));
  });

  void test('returns additive backward-compatible graph payload reconstructed from durable run files', async () => {
    const runId = '20260910-PROJ-GRAPH-01';
    const runFolder = path.join(testRepoDir, '.agent', 'runs', runId);
    fs.mkdirSync(path.join(runFolder, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(runFolder, 'workers'), { recursive: true });
    fs.mkdirSync(path.join(runFolder, 'events'), { recursive: true });
    fs.mkdirSync(path.join(runFolder, 'results'), { recursive: true });

    // 1. Task file
    fs.writeFileSync(
      path.join(runFolder, 'tasks', 'TASK-001.json'),
      JSON.stringify({
        id: 'TASK-001',
        name: '실시간 그래프 구현',
        prompt: '그래프 컴포넌트 개발',
      }),
      'utf8'
    );

    // 2. Events NDJSON with structured activity
    fs.writeFileSync(
      path.join(runFolder, 'events', 'TASK-001.ndjson'),
      [
        JSON.stringify({
          id: `${runId}:TASK-001:branch`,
          parentId: `${runId}:plan`,
          activity: 'LOAD',
          file: 'lib/workspace-contract.ts',
          timestamp: '2026-09-10T02:00:10Z',
          message: '워커 시작',
        }),
        JSON.stringify({
          id: `${runId}:TASK-001:act-1`,
          parentId: `${runId}:TASK-001:branch`,
          activity: 'EDIT',
          file: 'components/project-work-graph.tsx',
          timestamp: '2026-09-10T02:01:00Z',
          message: '도구 호출: replace_file_content',
        }),
        JSON.stringify({
          id: `${runId}:TASK-001:act-2`,
          parentId: `${runId}:TASK-001:act-1`,
          activity: 'DONE',
          timestamp: '2026-09-10T02:02:00Z',
          message: '작업 종료: 상태=completed',
        }),
      ].join('\n'),
      'utf8'
    );

    // 3. Worker final result
    fs.writeFileSync(
      path.join(runFolder, 'results', 'TASK-001-result.json'),
      JSON.stringify({
        runId,
        taskId: 'TASK-001',
        task: '실시간 그래프 구현',
        status: 'completed',
        startedAt: '2026-09-10T02:00:10Z',
        updatedAt: '2026-09-10T02:02:00Z',
        elapsedSeconds: 110,
        changedFiles: [`${testRepoDir}\\components\\project-work-graph.tsx`],
        verification: {
          decision: 'PASS',
          commands: [
            {
              command: 'npm test',
              status: 'PASS',
              exitCode: 0,
            },
          ],
        },
      }),
      'utf8'
    );

    // 4. Integration json
    fs.writeFileSync(
      path.join(runFolder, 'integration.json'),
      JSON.stringify({
        id: `${runId}:integration`,
        branch: `integration/${runId}`,
        decision: 'AWAITING_CODEX_REVIEW',
        changedFiles: ['components/project-work-graph.tsx'],
        tests: [
          {
            command: 'npm test',
            status: 'PASS',
            exitCode: 0,
          },
        ],
      }),
      'utf8'
    );

    // 5. Run manifest
    fs.writeFileSync(
      path.join(runFolder, 'run.json'),
      JSON.stringify({
        runId,
        prompt: '실시간 프로젝트 작업 그래프 구현 요청',
        status: 'awaiting_review',
        createdAt: '2026-09-10T02:00:00Z',
        updatedAt: '2026-09-10T02:03:00Z',
        tasks: ['TASK-001'],
      }),
      'utf8'
    );

    const req = new Request(`http://localhost:3000/api/projects/current/workers?runId=${runId}`);
    const res = await getProjectWorkers(req, {
      params: Promise.resolve({ projectId: 'current' }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json() as {
      ok: boolean;
      projectId: string;
      activeWorkers: unknown[];
      historyWorkers: Array<{ taskId: string; status: string }>;
      graph: {
        runId: string;
        nodes: Array<{ id: string; type: string; activity?: string; lane: number; files?: string[] }>;
        edges: Array<{ from: string; to: string; type: string }>;
        tips: Array<{ id: string; owner: string; status: string }>;
      };
    };

    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.projectId, 'current');
    assert.ok(Array.isArray(data.activeWorkers), 'Backward compatibility: activeWorkers present');
    assert.ok(Array.isArray(data.historyWorkers), 'Backward compatibility: historyWorkers present');
    assert.ok(data.graph, 'Additive: graph is present');
    assert.strictEqual(data.graph.runId, runId);

    // Verify nodes: Request, Plan, Worker branch, Activities, Integration Merge
    const types = data.graph.nodes.map(n => n.type);
    assert.ok(types.includes('request'));
    assert.ok(types.includes('plan'));
    assert.ok(types.includes('worker_branch'));
    assert.ok(types.includes('activity'));
    assert.ok(types.includes('merge'));

    // Verify Tip is the Integration merge node
    assert.strictEqual(data.graph.tips.length, 1);
    assert.strictEqual(data.graph.tips[0].owner, 'Orchestrator');
    assert.strictEqual(data.graph.tips[0].status, 'awaiting_review');

    // Verify Active vs Terminated Lifecycle: completed worker is in history, NOT in activeWorkers
    assert.strictEqual(data.activeWorkers.length, 0);
    assert.strictEqual(data.historyWorkers.length, 1);
    assert.strictEqual(data.historyWorkers[0].taskId, 'TASK-001');

    // Verify Sanitization: changed files in graph are relative
    const editNode = data.graph.nodes.find(n => n.activity === 'EDIT');
    assert.ok(editNode);
    assert.strictEqual(editNode.files?.[0], 'components/project-work-graph.tsx');
  });
});