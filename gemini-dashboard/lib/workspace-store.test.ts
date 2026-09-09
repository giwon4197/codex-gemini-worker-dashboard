import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { validateRunId, validateRepository, validatePrompt, generateRunId, spawnRouterRun, getCompactRunState, saveCompactRunState, listCompactRuns, getProjectWorkers } from './workspace-store.ts';

void describe('Workspace Store (Idempotency, Path Traversal, & Recovery)', () => {
  let testTempDir: string;

  beforeEach(() => {
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-store-test-'));
    // Setup minimal .agent directories in test repo
    fs.mkdirSync(path.join(testTempDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testTempDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(testTempDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  void describe('validateRunId (Path Traversal & Injection Prevention)', () => {
    void test('accepts valid run IDs and rejects dangerous or malformed strings', () => {
      assert.strictEqual(validateRunId('20260909-204119-f1a5d0f8'), true);
      assert.strictEqual(validateRunId('TASK-001'), true);
      assert.strictEqual(validateRunId('run_12345'), true);

      // Path traversal attempts
      assert.strictEqual(validateRunId('../../etc/passwd'), false);
      assert.strictEqual(validateRunId('..\\..\\Windows'), false);
      assert.strictEqual(validateRunId('sub/path'), false);
      assert.strictEqual(validateRunId('sub\\path'), false);

      // Injection and null bytes
      assert.strictEqual(validateRunId('run-id\0malicious'), false);
      assert.strictEqual(validateRunId('run-id; rm -rf /'), false);
      assert.strictEqual(validateRunId('run id with space'), false);
      assert.strictEqual(validateRunId(''), false);
      assert.strictEqual(validateRunId(null), false);
      assert.strictEqual(validateRunId(undefined), false);
      assert.strictEqual(validateRunId('a'.repeat(65)), false);
    });
  });

  void describe('validateRepository (Repository Confinement)', () => {
    void test('strictly confines operations to allowed repository root', () => {
      const allowed = testTempDir;

      // Safe matching cases
      assert.strictEqual(validateRepository(allowed, allowed).ok, true);
      assert.strictEqual(validateRepository('.', allowed).ok, true);
      assert.strictEqual(validateRepository('', allowed).ok, true);
      assert.strictEqual(validateRepository(undefined, allowed).ok, true);

      // Path traversal or external directories
      const traversal = path.join(allowed, '..');
      const resTraversal = validateRepository(traversal, allowed);
      assert.strictEqual(resTraversal.ok, false);
      assert.ok(resTraversal.error?.includes('외부 경로') || resTraversal.error?.includes('안전하지 않은'));

      // Outside path
      const outside = os.tmpdir();
      if (path.resolve(outside) !== path.resolve(allowed)) {
        assert.strictEqual(validateRepository(outside, allowed).ok, false);
      }

      // Null byte injection
      assert.strictEqual(validateRepository(allowed + '\0external', allowed).ok, false);
    });
  });

  void describe('validatePrompt', () => {
    void test('validates non-empty prompt within length bounds', () => {
      assert.strictEqual(validatePrompt('작업을 실행해주세요').ok, true);
      assert.strictEqual(validatePrompt('   공백 포함 작업   ').ok, true);
      assert.strictEqual(validatePrompt('   ').ok, false);
      assert.strictEqual(validatePrompt('').ok, false);
      assert.strictEqual(validatePrompt(null).ok, false);
      assert.strictEqual(validatePrompt('a'.repeat(10001)).ok, false);
    });
  });

  void describe('generateRunId', () => {
    void test('generates unique chronological run IDs matching validateRunId format', () => {
      const id1 = generateRunId();
      const id2 = generateRunId();
      assert.notStrictEqual(id1, id2);
      assert.strictEqual(validateRunId(id1), true);
      assert.strictEqual(validateRunId(id2), true);
      assert.ok(id1.includes('-'));
    });
  });

  void describe('spawnRouterRun & Idempotency', () => {
    void test('executes router with safe argument array and prevents duplicate executions', async () => {
      const spawnCalls: Array<{ command: string; args: string[]; opts: unknown }> = [];
      const mockSpawner = (command: string, args: string[], opts: unknown) => {
        spawnCalls.push({ command, args, opts });
        return { unref: () => {} };
      };

      const key = 'idem-test-key-1';
      const prompt = '대시보드 기능 개선';

      // 1st submission
      const first = await spawnRouterRun({
        prompt,
        idempotencyKey: key,
        repoRoot: testTempDir,
        spawner: mockSpawner,
      });

      assert.strictEqual(first.isDuplicate, false);
      assert.ok(first.runId);
      assert.strictEqual(spawnCalls.length, 1);

      // Verify command and argument safety: NO shell string concat!
      const call = spawnCalls[0];
      assert.ok(call.command.includes('powershell') || call.command.includes('pwsh'));
      assert.ok(Array.isArray(call.args));
      assert.ok(call.args.includes('-Request'));
      assert.ok(call.args.includes(prompt));
      assert.ok(call.args.includes('-Repository'));

      // 2nd duplicate submission with SAME idempotency key
      const second = await spawnRouterRun({
        prompt,
        idempotencyKey: key,
        repoRoot: testTempDir,
        spawner: mockSpawner,
      });

      // Must return existing run ID immediately without re-spawning
      assert.strictEqual(second.isDuplicate, true);
      assert.strictEqual(second.runId, first.runId);
      assert.strictEqual(spawnCalls.length, 1); // Spawner was NOT called a second time
    });
  });

  void describe('Restart Recovery & Compact State', () => {
    void test('recovers run state across server restart from atomically saved compact state', async () => {
      const runId = generateRunId();
      const now = new Date().toISOString();

      // Simulate a run being saved before restart
      await saveCompactRunState(
        {
          runId,
          prompt: '복구 테스트 작업',
          createdAt: now,
          updatedAt: now,
          status: 'awaiting_review',
          requiresUserAction: true,
          userActionReason: '통합 브랜치 검토 필요',
          tasksCount: 1,
          activeWorkersCount: 0,
          completedTasksCount: 1,
        },
        testTempDir
      );

      // Retrieve after restart
      const recovered = await getCompactRunState(runId, testTempDir);
      assert.ok(recovered);
      assert.strictEqual(recovered.runId, runId);
      assert.strictEqual(recovered.status, 'awaiting_review');
      assert.strictEqual(recovered.requiresUserAction, true);

      // List all runs contains the recovered run
      const allRuns = await listCompactRuns(testTempDir);
      assert.ok(allRuns.some(r => r.runId === runId));
    });

    void test('recovers external run from .agent/runs manifest on disk', async () => {
      const runId = '20260909-disk-run-01';
      const runFolder = path.join(testTempDir, '.agent', 'runs', runId);
      fs.mkdirSync(runFolder, { recursive: true });

      // Write mock run.json
      fs.writeFileSync(
        path.join(runFolder, 'run.json'),
        JSON.stringify({
          runId,
          status: 'awaiting_review',
          createdAt: '2026-09-09T08:00:00Z',
          updatedAt: '2026-09-09T08:05:00Z',
          tasks: ['TASK-001'],
        }),
        'utf8'
      );

      const allRuns = await listCompactRuns(testTempDir);
      const diskRun = allRuns.find(r => r.runId === runId);
      assert.ok(diskRun);
      assert.strictEqual(diskRun.status, 'awaiting_review');
      assert.strictEqual(diskRun.requiresUserAction, true);
    });
  });

  void describe('Active vs Terminated Worker Filtering', () => {
    void test('getProjectWorkers separates active workers from terminated workers', async () => {
      const runId = generateRunId();
      const runFolder = path.join(testTempDir, '.agent', 'runs', runId);
      fs.mkdirSync(path.join(runFolder, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(runFolder, 'results'), { recursive: true });

      // Active running worker
      fs.writeFileSync(
        path.join(runFolder, 'workers', 'TASK-ACTIVE.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-ACTIVE',
          task: '활성 작업',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      // Terminated completed worker
      fs.writeFileSync(
        path.join(runFolder, 'results', 'TASK-DONE-result.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-DONE',
          task: '완료 작업',
          status: 'completed',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(runFolder, 'run.json'),
        JSON.stringify({
          runId,
          status: 'running',
          tasks: ['TASK-ACTIVE', 'TASK-DONE'],
        }),
        'utf8'
      );

      const { activeWorkers, historyWorkers } = await getProjectWorkers(testTempDir);

      const activeIds = activeWorkers.map(w => w.taskId);
      const historyIds = historyWorkers.map(w => w.taskId);

      // Active CLI contains only TASK-ACTIVE
      assert.ok(activeIds.includes('TASK-ACTIVE'));
      assert.ok(!activeIds.includes('TASK-DONE'));

      // History contains TASK-DONE
      assert.ok(historyIds.includes('TASK-DONE'));
    });
  });
});