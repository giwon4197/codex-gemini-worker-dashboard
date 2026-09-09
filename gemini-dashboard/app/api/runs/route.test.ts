import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { GET as listRuns, POST as createRun } from './route.ts';
// @ts-expect-error TS5097 allowed for test runner
import { GET as getRunDetail } from './[runId]/route.ts';

void describe('/api/runs API Route Handlers', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;

  beforeEach(() => {
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-api-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create minimal agent directory structure
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
  });

  afterEach(() => {
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
});