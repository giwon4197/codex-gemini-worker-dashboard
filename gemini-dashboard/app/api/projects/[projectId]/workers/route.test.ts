import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { GET as getProjectWorkers } from './route.ts';

void describe('/api/projects/[projectId]/workers API Route Handlers', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;

  beforeEach(() => {
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workers-api-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create minimal agent directory structure
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
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
});