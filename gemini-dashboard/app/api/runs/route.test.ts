import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { GET as listRuns, POST as createRun } from './route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { GET as getRunDetail } from './[runId]/route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { POST as retryRunRoute } from './[runId]/retry/route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getProjectWorkGraph, getCompactRunState } from '../../../lib/workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { STALE_PROCESS_MISMATCH_REASON, setGlobalLivenessOptions, resetGlobalLivenessOptions } from '../../../lib/process-liveness.ts';

void describe('/api/runs API Route Handlers', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;
  let savedAgyPath: string | undefined;

  beforeEach(() => {
    resetGlobalLivenessOptions();
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    savedAgyPath = process.env.AGY_PATH;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-api-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create minimal agent directory structure
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
    const agyFixture = path.join(testRepoDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(agyFixture, 'test fixture', 'utf8');
    process.env.AGY_PATH = agyFixture;
  });

  afterEach(() => {
    resetGlobalLivenessOptions();
    if (savedAllowedRepo !== undefined) {
      process.env.ALLOWED_REPO_ROOT = savedAllowedRepo;
    } else {
      delete process.env.ALLOWED_REPO_ROOT;
    }
    if (savedAgyPath === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = savedAgyPath;
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  void describe('POST /api/runs (Submission & Security Controls)', () => {
    void test('creates run and returns stable run ID with status 201 for valid prompt', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '새로운 컴포넌트 추가' }),
      });

      const res = await createRun(req);
      assert.strictEqual(res.status, 201);
      const data = await res.json() as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(data.ok, true);
      assert.ok(data.runId);
      assert.strictEqual(data.isDuplicate, false);
    });

    void test('rejects path traversal in repository parameter with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '작업',
          repository: '../../external-repo',
        }),
      });

      const res = await createRun(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('허용되지 않은') || data.error.includes('안전하지 않은'));
    });

    void test('rejects arbitrary foreign repository path with status 400', async () => {
      const foreignRepo = os.tmpdir();
      if (path.resolve(foreignRepo) !== path.resolve(testRepoDir)) {
        const req = new Request('http://localhost:3000/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '작업',
            repository: foreignRepo,
          }),
        });

        const res = await createRun(req);
        assert.strictEqual(res.status, 400);
        const data = await res.json() as { ok: boolean; error: string };
        assert.strictEqual(data.ok, false);
        assert.ok(data.error.includes('외부 경로'));
      }
    });

    void test('rejects empty or whitespace-only prompt with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   ' }),
      });

      const res = await createRun(req);
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('내용'));
    });

    void test('enforces idempotency: duplicate submission returns 200 with isDuplicate: true and same runId', async () => {
      const idempotencyKey = 'idem-unique-key-999';

      const firstReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '중복 방지 작업',
          idempotencyKey,
        }),
      });

      const firstRes = await createRun(firstReq);
      assert.strictEqual(firstRes.status, 201);
      const firstData = await firstRes.json() as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(firstData.isDuplicate, false);

      // Repeat request with exact same idempotencyKey
      const secondReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '중복 방지 작업',
          idempotencyKey,
        }),
      });

      const secondRes = await createRun(secondReq);
      assert.strictEqual(secondRes.status, 200);
      const secondData = await secondRes.json() as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(secondData.isDuplicate, true);
      assert.strictEqual(secondData.runId, firstData.runId);
    });
  });

  void describe('GET /api/runs', () => {
    void test('returns 200 with array of compact runs', async () => {
      const res = await listRuns();
      assert.strictEqual(res.status, 200);
      const data = await res.json() as { ok: boolean; runs: unknown[] };
      assert.strictEqual(data.ok, true);
      assert.ok(Array.isArray(data.runs));
    });
  });

  void describe('GET /api/runs/[runId]', () => {
    void test('returns 400 when runId contains path traversal sequence', async () => {
      const req = new Request('http://localhost:3000/api/runs/../../etc/passwd');
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: '../../etc/passwd' }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('유효하지 않은'));
    });

    void test('returns 404 for non-existent runId', async () => {
      const req = new Request('http://localhost:3000/api/runs/20260909-000000-00000000');
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: '20260909-000000-00000000' }),
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json() as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
    });

    void test('resolves linked actual worker run and returns live worker data for dashboard runId', async () => {
      const dashboardRunId = '20260909-DASH-RUN-01';
      const actualRunId = '20260909-ACTUAL-RUN-01';

      // Save initial compact state for dashboardRunId
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${dashboardRunId}.json`),
        JSON.stringify({
          runId: dashboardRunId,
          prompt: '실시간 관제 추적 테스트',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 5555,
        }),
        'utf8'
      );

      // Create actual run directory structure in .agent/runs/<actualRunId>
      const actualRunDir = path.join(testRepoDir, '.agent', 'runs', actualRunId);
      fs.mkdirSync(path.join(actualRunDir, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(actualRunDir, 'tasks'), { recursive: true });

      fs.writeFileSync(
        path.join(actualRunDir, 'run.json'),
        JSON.stringify({
          runId: actualRunId,
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          repository: testRepoDir,
          orchestratorProcessId: 5555,
          tasks: ['TASK-001'],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(actualRunDir, 'workers', 'TASK-001.json'),
        JSON.stringify({
          runId: actualRunId,
          taskId: 'TASK-001',
          task: '실시간 워커 상태 연동',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${dashboardRunId}`);
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: dashboardRunId }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as {
        ok: boolean;
        run: {
          runId: string;
          actualRunId?: string;
          activeWorkers: Array<{ taskId: string; status: string }>;
        };
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.run.runId, dashboardRunId);
      assert.strictEqual(data.run.actualRunId, actualRunId);
      assert.strictEqual(data.run.activeWorkers.length, 1);
      assert.strictEqual(data.run.activeWorkers[0].taskId, 'TASK-001');
      assert.strictEqual(data.run.activeWorkers[0].status, 'running');
    });
  });

  void describe('Korean Repository Path Support (한글 저장소 경로)', () => {
    let koreanTestRepo: string;

    beforeEach(() => {
      koreanTestRepo = fs.mkdtempSync(path.join(os.tmpdir(), '한글-저장소-API-'));
      fs.mkdirSync(path.join(koreanTestRepo, '.agent', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(koreanTestRepo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
      fs.mkdirSync(path.join(koreanTestRepo, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(koreanTestRepo, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    void test('POST /api/runs successfully creates run in Korean repository root', async () => {
      const saved = process.env.ALLOWED_REPO_ROOT;
      process.env.ALLOWED_REPO_ROOT = koreanTestRepo;

      try {
        const req = new Request('http://localhost:3000/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: '한글 저장소에서 작업 실행',
            repository: koreanTestRepo,
          }),
        });

        const res = await createRun(req);
        assert.strictEqual(res.status, 201);
        const data = await res.json() as { ok: boolean; runId: string };
        assert.strictEqual(data.ok, true);
        assert.ok(data.runId);
      } finally {
        if (saved !== undefined) {
          process.env.ALLOWED_REPO_ROOT = saved;
        } else {
          delete process.env.ALLOWED_REPO_ROOT;
        }
      }
    });
  });

  void describe('Process Evidence Checking & Stale Run Correction (GET /api/runs & GET /api/runs/[runId])', () => {
    void test('GET /api/runs returns corrected failed state and visible mismatch reason for fake-running compact run', async () => {
      const staleRunId = '20260909-API-STALE-RUN-01';
      const oldTime = new Date(Date.now() - 300_000).toISOString(); // 5 minutes ago

      // Write legacy compact state directly to disk as 'running'
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${staleRunId}.json`),
        JSON.stringify({
          runId: staleRunId,
          prompt: '가짜 실행 중인 레거시 작업',
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

      const res = await listRuns();
      assert.strictEqual(res.status, 200);
      const data = await res.json() as {
        ok: boolean;
        runs: Array<{
          runId: string;
          status: string;
          activeWorkersCount: number;
          error?: string;
          userActionReason?: string;
        }>;
      };

      assert.strictEqual(data.ok, true);
      const correctedRun = data.runs.find((r) => r.runId === staleRunId);
      assert.ok(correctedRun);
      assert.strictEqual(correctedRun.status, 'failed');
      assert.strictEqual(correctedRun.activeWorkersCount, 0);
      assert.strictEqual(correctedRun.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(correctedRun.userActionReason, STALE_PROCESS_MISMATCH_REASON);

      // Verify atomically persisted as failed on disk (not deleted)
      const onDisk = JSON.parse(
        fs.readFileSync(
          path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${staleRunId}.json`),
          'utf8'
        )
      ) as { status: string; activeWorkersCount: number; error: string };
      assert.strictEqual(onDisk.status, 'failed');
      assert.strictEqual(onDisk.activeWorkersCount, 0);
      assert.strictEqual(onDisk.error, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('GET /api/runs/[runId] evaluates process liveness and corrects dead PID with no workers to failed', async () => {
      const staleRunId = '20260909-API-DETAIL-STALE-01';
      const oldTime = new Date(Date.now() - 300_000).toISOString();

      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${staleRunId}.json`),
        JSON.stringify({
          runId: staleRunId,
          prompt: '세부 조회 좀비 작업',
          createdAt: oldTime,
          updatedAt: oldTime,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 99999999,
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${staleRunId}`);
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: staleRunId }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as {
        ok: boolean;
        run: {
          runId: string;
          status: string;
          activeWorkersCount: number;
          activeWorkers: unknown[];
          historyWorkers: Array<{ status: string; error?: string }>;
          error?: string;
          userActionReason?: string;
        };
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.run.status, 'failed');
      assert.strictEqual(data.run.activeWorkersCount, 0);
      assert.strictEqual(data.run.activeWorkers.length, 0);
      assert.strictEqual(data.run.historyWorkers.length, 1);
      assert.strictEqual(data.run.historyWorkers[0].status, 'failed');
      assert.strictEqual(data.run.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(data.run.userActionReason, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('GET /api/runs/[runId] rejects reused/unrelated PID and returns failed with visible mismatch reason', async () => {
      const reusedRunId = '20260909-API-REUSED-PID-01';
      const oldTime = new Date(Date.now() - 300_000).toISOString();

      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${reusedRunId}.json`),
        JSON.stringify({
          runId: reusedRunId,
          prompt: 'PID 재사용 감지 작업',
          createdAt: oldTime,
          updatedAt: oldTime,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 3344,
        }),
        'utf8'
      );

      // Configure mock process resolver returning an unrelated process (e.g. calculator)
      setGlobalLivenessOptions({
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          name: 'calculator.exe',
          command: 'calc.exe',
          metadataAvailable: true,
        }),
      });

      const req = new Request(`http://localhost:3000/api/runs/${reusedRunId}`);
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: reusedRunId }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as {
        ok: boolean;
        run: {
          status: string;
          activeWorkersCount: number;
          activeWorkers: unknown[];
          error?: string;
          userActionReason?: string;
        };
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.run.status, 'failed');
      assert.strictEqual(data.run.activeWorkersCount, 0);
      assert.strictEqual(data.run.activeWorkers.length, 0);
      assert.strictEqual(data.run.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(data.run.userActionReason, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('GET /api/runs/[runId] keeps newly launched run inside grace period active', async () => {
      const newRunId = '20260909-API-NEW-GRACE-01';
      const recentTime = new Date(Date.now() - 5_000).toISOString(); // 5 seconds ago (< 30s grace)

      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${newRunId}.json`),
        JSON.stringify({
          runId: newRunId,
          prompt: '새로 시작된 작업 (grace 보호)',
          createdAt: recentTime,
          updatedAt: recentTime,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 99999999,
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${newRunId}`);
      const res = await getRunDetail(req, {
        params: Promise.resolve({ runId: newRunId }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as {
        ok: boolean;
        run: {
          status: string;
          activeWorkersCount: number;
          activeWorkers: unknown[];
        };
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.run.status, 'running');
      assert.strictEqual(data.run.activeWorkers.length, 1);
    });
  });

  void describe('POST /api/runs/[runId]/retry (Safe Retry Flow & Idempotency)', () => {
    void test('allows retry for failed run without user action required and links DAG', async () => {
      const origRunId = '20260909-FAIL-SAFE-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${origRunId}.json`),
        JSON.stringify({
          runId: origRunId,
          prompt: '안전 실패 작업 원본 프롬프트',
          status: 'failed',
          requiresUserAction: false,
          errorCategory: 'launcher_error',
          failureReason: '프로세스 비정상 종료 (exit code 1)',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${origRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId: origRunId }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json() as {
        ok: boolean;
        runId: string;
        isDuplicate: boolean;
        retryOf: string;
        retryCount: number;
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.isDuplicate, false);
      assert.strictEqual(data.retryOf, origRunId);
      assert.strictEqual(data.retryCount, 1);
      assert.ok(data.runId);
      assert.notStrictEqual(data.runId, origRunId);

      // Verify server persisted relationship on disk
      const updatedOrig = await getCompactRunState(origRunId, testRepoDir);
      assert.strictEqual(updatedOrig?.retriedByRunId, data.runId);

      const newRun = await getCompactRunState(data.runId, testRepoDir);
      assert.strictEqual(newRun?.retryOf, origRunId);
      assert.strictEqual(newRun?.retryCount, 1);
      assert.strictEqual(newRun?.prompt, '안전 실패 작업 원본 프롬프트');
    });

    void test('idempotent deduplication: identical retry request returns 200 with isDuplicate: true and same runId', async () => {
      const origRunId = '20260909-FAIL-IDEMPOTENT-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${origRunId}.json`),
        JSON.stringify({
          runId: origRunId,
          prompt: '멱등 재시도 테스트 프롬프트',
          status: 'failed',
          requiresUserAction: false,
          errorCategory: 'launcher_error',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const makeReq = () =>
        new Request(`http://localhost:3000/api/runs/${origRunId}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

      // 1st request -> 201 Created
      const res1 = await retryRunRoute(makeReq(), {
        params: Promise.resolve({ runId: origRunId }),
      });
      assert.strictEqual(res1.status, 201);
      const data1 = await res1.json() as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(data1.ok, true);
      assert.strictEqual(data1.isDuplicate, false);

      // 2nd request -> 200 OK with identical runId
      const res2 = await retryRunRoute(makeReq(), {
        params: Promise.resolve({ runId: origRunId }),
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json() as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(data2.ok, true);
      assert.strictEqual(data2.isDuplicate, true);
      assert.strictEqual(data2.runId, data1.runId);
    });

    void test('enforces server authority: client cannot override prompt or safety checks', async () => {
      const origRunId = '20260909-FAIL-AUTH-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${origRunId}.json`),
        JSON.stringify({
          runId: origRunId,
          prompt: '서버에 저장된 정품 프롬프트',
          status: 'failed',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const spoofReq = new Request(`http://localhost:3000/api/runs/${origRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: '클라이언트 위조 프롬프트 (malicious)',
          status: 'completed',
        }),
      });

      const res = await retryRunRoute(spoofReq, {
        params: Promise.resolve({ runId: origRunId }),
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json() as { ok: boolean; runId: string };
      assert.strictEqual(data.ok, true);

      const savedRun = await getCompactRunState(data.runId, testRepoDir);
      assert.strictEqual(savedRun?.prompt, '서버에 저장된 정품 프롬프트');
    });

    void test('blocks retry for policy violation with status 400 and clear Korean reason', async () => {
      const runId = '20260909-POLICY-VIOLATION-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '정책 위반 작업',
          status: 'failed',
          errorCategory: 'policy_violation',
          failureReason: 'allowed_files 위반 감지',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
      assert.ok(data.error.includes('허용된 파일 범위'));
    });

    void test('blocks retry for secret disclosures with status 400 without leaking secrets', async () => {
      const runId = '20260909-SECRET-LEAK-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '비밀정보 유출 작업',
          status: 'failed',
          errorCategory: 'secret_violation',
          failureReason: 'OAuth token leak: ya29.secret_token_abc123',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
      assert.ok(!data.error.includes('ya29.secret_token_abc123'));
      assert.ok(data.error.includes('비밀정보'));
    });

    void test('blocks retry for destructive operations with status 400', async () => {
      const runId = '20260909-DESTRUCTIVE-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '파괴적 작업',
          status: 'failed',
          errorCategory: 'destructive_action',
          failureReason: 'git reset --hard detected',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
    });

    void test('blocks retry for Codex escalation with status 400', async () => {
      const runId = '20260909-ESCALATED-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '에스컬레이션 작업',
          status: 'failed',
          escalation: {
            requiresCodex: true,
            reason: 'Gemini 워커 실패 후 Codex 개입 필요',
          },
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
      assert.ok(data.error.includes('Codex') || data.error.includes('개입'));
    });

    void test('blocks retry when requiresUserAction is true with status 400', async () => {
      const runId = '20260909-USER-ACTION-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '사용자 조치 필요 작업',
          status: 'failed',
          requiresUserAction: true,
          userActionReason: '사용자의 설정 변경이 필요합니다.',
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
      assert.ok(data.error.includes('사용자의 설정 변경이 필요'));
    });

    void test('blocks retry for non-failed runs with status 400', async () => {
      const completedRunId = '20260909-COMPLETED-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${completedRunId}.json`),
        JSON.stringify({
          runId: completedRunId,
          prompt: '완료된 작업',
          status: 'completed',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${completedRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId: completedRunId }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
      assert.ok(data.error.includes('완료'));
    });

    void test('recovers retry relationship across server restart in work graph DAG', async () => {
      const origRunId = '20260909-RESTART-DAG-01';
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${origRunId}.json`),
        JSON.stringify({
          runId: origRunId,
          prompt: '재시작 복구 작업',
          status: 'failed',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${origRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId: origRunId }),
      });
      assert.strictEqual(res.status, 201);
      const data = await res.json() as { runId: string };

      // Query graphs after "restart"
      const origGraph = await getProjectWorkGraph(origRunId, testRepoDir);
      assert.ok(origGraph);
      assert.strictEqual(origGraph?.retriedByRunId, data.runId);
      assert.strictEqual(origGraph?.tips[0]?.retriedByRunId, data.runId);

      const retryGraph = await getProjectWorkGraph(data.runId, testRepoDir);
      assert.ok(retryGraph);
      assert.strictEqual(retryGraph?.retryOf, origRunId);
      assert.strictEqual(retryGraph?.tips[0]?.retryOf, origRunId);
      assert.strictEqual(retryGraph?.retryCount, 1);
    });

    void test('returns 404 for non-existent runId with sanitized error and no paths leaked', async () => {
      const missingRunId = '20260909-NONEXISTENT-99';
      const req = new Request(`http://localhost:3000/api/runs/${missingRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await retryRunRoute(req, {
        params: Promise.resolve({ runId: missingRunId }),
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RUN_NOT_FOUND');
      assert.ok(!data.error.includes(testRepoDir));
      assert.ok(!data.error.includes(':\\'));
    });
  });
});
