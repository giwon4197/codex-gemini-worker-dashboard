import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { isProcessAlive, getProcessInfo, isProcessRelatedToRun, hasActiveWorkerEvidence, evaluateRunLiveness, STALE_PROCESS_MISMATCH_REASON, resetGlobalLivenessOptions } from './process-liveness.ts';
import type { CompactRunState } from './workspace-contract.ts';

void describe('Process Liveness & Stale Evidence Check (process-liveness.ts)', () => {
  let tempRepo: string;

  beforeEach(() => {
    resetGlobalLivenessOptions();
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-liveness-test-'));
    fs.mkdirSync(path.join(tempRepo, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(tempRepo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
  });

  afterEach(() => {
    resetGlobalLivenessOptions();
    try {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  void describe('isProcessAlive', () => {
    void test('returns true for current process PID', () => {
      assert.strictEqual(isProcessAlive(process.pid), true);
    });

    void test('returns false for invalid or dead PID', () => {
      assert.strictEqual(isProcessAlive(0), false);
      assert.strictEqual(isProcessAlive(-1), false);
      assert.strictEqual(isProcessAlive(NaN), false);
      // Extremely high PID that does not exist
      assert.strictEqual(isProcessAlive(99999999), false);
    });
  });

  void describe('getProcessInfo', () => {
    void test('returns alive: false for dead PID without invoking child process', () => {
      const info = getProcessInfo(99999999);
      assert.strictEqual(info.alive, false);
      assert.strictEqual(info.pid, 99999999);
    });

    void test('retrieves process info for current process without shell string concatenation', () => {
      const info = getProcessInfo(process.pid);
      assert.strictEqual(info.alive, true);
      assert.strictEqual(info.pid, process.pid);
    });
  });

  void describe('isProcessRelatedToRun (PID Reuse Detection)', () => {
    void test('recognizes router process commands as related', () => {
      const run: CompactRunState = {
        runId: '20260909-test-01',
        prompt: '작업 요청',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
      };

      assert.strictEqual(
        isProcessRelatedToRun(
          {
            pid: 1234,
            alive: true,
            command: 'pwsh.exe -NoProfile -File C:\\repo\\codex-router.ps1 -Request 작업 -Repository C:\\repo',
            metadataAvailable: true,
          },
          run,
          'C:\\repo'
        ),
        true
      );

      assert.strictEqual(
        isProcessRelatedToRun(
          {
            pid: 1234,
            alive: true,
            command: 'powershell.exe -ExecutionPolicy Bypass -Command codex-route.ps1',
            metadataAvailable: true,
          },
          run
        ),
        true
      );

      assert.strictEqual(
        isProcessRelatedToRun(
          {
            pid: 1234,
            alive: true,
            command: 'pwsh.exe -File C:\\repo\\gemini-dashboard\\scripts\\router-bootstrap.ps1 -InputFile C:\\repo\\.agent\\dashboard-state\\input\\run-1.json',
            metadataAvailable: true,
          },
          run,
          'C:\\repo'
        ),
        true
      );
    });

    void test('rejects unrelated processes as PID reuse', () => {
      const run: CompactRunState = {
        runId: '20260909-test-02',
        prompt: '테스트 작업',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
      };

      // Unrelated text editor or calculator
      assert.strictEqual(
        isProcessRelatedToRun(
          {
            pid: 4321,
            alive: true,
            name: 'notepad.exe',
            command: 'notepad.exe C:\\secrets.txt',
            metadataAvailable: true,
          },
          run,
          tempRepo
        ),
        false
      );

      assert.strictEqual(
        isProcessRelatedToRun(
          {
            pid: 4321,
            alive: true,
            name: 'calculator.exe',
            command: 'calc.exe',
            metadataAvailable: true,
          },
          run,
          tempRepo
        ),
        false
      );
    });
  });

  void describe('hasActiveWorkerEvidence', () => {
    void test('returns true when genuinely active worker file exists', async () => {
      const runId = '20260909-worker-ev-01';
      const workersDir = path.join(tempRepo, '.agent', 'runs', runId, 'workers');
      fs.mkdirSync(workersDir, { recursive: true });

      fs.writeFileSync(
        path.join(workersDir, 'TASK-001.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-001',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf8'
      );

      const hasEvidence = await hasActiveWorkerEvidence(runId, tempRepo);
      assert.strictEqual(hasEvidence, true);
    });

    void test('returns false when worker has completed with result file', async () => {
      const runId = '20260909-worker-ev-02';
      const runDir = path.join(tempRepo, '.agent', 'runs', runId);
      fs.mkdirSync(path.join(runDir, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });

      fs.writeFileSync(
        path.join(runDir, 'workers', 'TASK-001.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-001',
          status: 'running',
        }),
        'utf8'
      );

      // Result file marks it complete
      fs.writeFileSync(
        path.join(runDir, 'results', 'TASK-001-result.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-001',
          status: 'completed',
        }),
        'utf8'
      );

      const hasEvidence = await hasActiveWorkerEvidence(runId, tempRepo);
      assert.strictEqual(hasEvidence, false);
    });
  });

  void describe('evaluateRunLiveness', () => {
    void test('preserves terminal statuses (completed, awaiting_review, failed) without modification', async () => {
      const run: CompactRunState = {
        runId: '20260909-terminal-01',
        prompt: '완료된 작업',
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:05:00.000Z',
        status: 'awaiting_review',
        requiresUserAction: true,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 1,
      };

      const result = await evaluateRunLiveness(run, tempRepo);
      assert.strictEqual(result.wasCorrected, false);
      assert.strictEqual(result.status, 'awaiting_review');
    });

    void test('new run inside grace period remains active despite missing PID or workers', async () => {
      const now = new Date('2026-09-09T10:00:10.000Z');
      const run: CompactRunState = {
        runId: '20260909-grace-01',
        prompt: '방금 생성된 작업',
        createdAt: '2026-09-09T10:00:00.000Z', // 10 seconds ago (< 30s grace)
        updatedAt: '2026-09-09T10:00:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 99999999, // dead PID
      };

      const result = await evaluateRunLiveness(run, tempRepo, null, {
        now,
        gracePeriodMs: 30_000,
      });

      assert.strictEqual(result.isAlive, true);
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.wasCorrected, false);
    });

    void test('stale run with dead PID and no worker evidence is corrected to failed with mismatch reason', async () => {
      const now = new Date('2026-09-09T10:05:00.000Z');
      const run: CompactRunState = {
        runId: '20260909-dead-pid-01',
        prompt: '오래된 죽은 작업',
        createdAt: '2026-09-09T10:00:00.000Z', // 5 minutes ago (> 30s grace)
        updatedAt: '2026-09-09T10:00:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 99999999,
      };

      const result = await evaluateRunLiveness(run, tempRepo, null, {
        now,
        gracePeriodMs: 30_000,
        processInfoResolver: () => ({ pid: 99999999, alive: false, metadataAvailable: true }),
      });

      assert.strictEqual(result.isAlive, false);
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.activeWorkersCount, 0);
      assert.strictEqual(result.wasCorrected, true);
      assert.strictEqual(result.reason, STALE_PROCESS_MISMATCH_REASON);
      assert.ok(result.updatedCompact);
      assert.strictEqual(result.updatedCompact.status, 'failed');
      assert.strictEqual(result.updatedCompact.activeWorkersCount, 0);
      assert.strictEqual(result.updatedCompact.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(result.updatedCompact.userActionReason, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('reused/unrelated PID is NOT accepted as active and is corrected to failed', async () => {
      const now = new Date('2026-09-09T10:05:00.000Z');
      const reusedPid = 7777;
      const run: CompactRunState = {
        runId: '20260909-reused-pid-01',
        prompt: '재사용된 PID 작업',
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:00:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: reusedPid,
      };

      const result = await evaluateRunLiveness(run, tempRepo, null, {
        now,
        gracePeriodMs: 30_000,
        // Mock resolver returns an unrelated process like calculator.exe
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          name: 'calculator.exe',
          command: 'C:\\Windows\\System32\\calc.exe',
          metadataAvailable: true,
        }),
      });

      assert.strictEqual(result.isAlive, false);
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.activeWorkersCount, 0);
      assert.strictEqual(result.wasCorrected, true);
      assert.strictEqual(result.reason, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('valid live router PID remains active', async () => {
      const now = new Date('2026-09-09T10:05:00.000Z');
      const routerPid = 8888;
      const run: CompactRunState = {
        runId: '20260909-live-router-01',
        prompt: '실제 실행 중인 라우터 작업',
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:00:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: routerPid,
      };

      const result = await evaluateRunLiveness(run, tempRepo, null, {
        now,
        gracePeriodMs: 30_000,
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          name: 'pwsh.exe',
          command: `pwsh.exe -File ${tempRepo}\\codex-router.ps1 -Request 실행`,
          metadataAvailable: true,
        }),
      });

      assert.strictEqual(result.isAlive, true);
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.wasCorrected, false);
    });

    void test('real active-worker evidence remains active even if router PID has finished', async () => {
      const now = new Date('2026-09-09T10:05:00.000Z');
      const runId = '20260909-active-worker-run';

      // Create run folder with active worker
      const workersDir = path.join(tempRepo, '.agent', 'runs', runId, 'workers');
      fs.mkdirSync(workersDir, { recursive: true });
      fs.writeFileSync(
        path.join(workersDir, 'TASK-001.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-001',
          status: 'running',
          startedAt: '2026-09-09T10:00:00.000Z',
          updatedAt: '2026-09-09T10:04:00.000Z',
        }),
        'utf8'
      );

      const run: CompactRunState = {
        runId,
        actualRunId: runId,
        prompt: '워커 활성 작업',
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:04:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 99999999, // dead router PID
      };

      const result = await evaluateRunLiveness(run, tempRepo, runId, {
        now,
        gracePeriodMs: 30_000,
        processInfoResolver: () => ({ pid: 99999999, alive: false, metadataAvailable: true }),
      });

      assert.strictEqual(result.isAlive, true);
      assert.strictEqual(result.status, 'running');
      assert.strictEqual(result.wasCorrected, false);
    });

    void test('degrades conservatively when command metadata is unavailable (bare PID not trusted)', async () => {
      const now = new Date('2026-09-09T10:05:00.000Z');
      const run: CompactRunState = {
        runId: '20260909-no-metadata-01',
        prompt: '메타데이터 불가 작업',
        createdAt: '2026-09-09T10:00:00.000Z',
        updatedAt: '2026-09-09T10:00:00.000Z',
        status: 'running',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 1,
        completedTasksCount: 0,
        orchestratorProcessId: 6666,
      };

      const result = await evaluateRunLiveness(run, tempRepo, null, {
        now,
        gracePeriodMs: 30_000,
        // Mock resolver where metadata cannot be retrieved
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          metadataAvailable: false,
        }),
      });

      // Conservative degradation: bare PID without metadata & without worker evidence is marked failed
      assert.strictEqual(result.isAlive, false);
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.activeWorkersCount, 0);
      assert.strictEqual(result.wasCorrected, true);
      assert.strictEqual(result.reason, STALE_PROCESS_MISMATCH_REASON);
    });
  });
});
