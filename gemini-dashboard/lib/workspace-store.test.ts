import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { validateRunId, validateRepository, validatePrompt, generateRunId, spawnRouterRun, getCompactRunState, saveCompactRunState, listCompactRuns, getProjectWorkers, resolveRequiredTools, getRunDetails, getAliasRecord, findAndLinkActualRun, STALE_PROCESS_MISMATCH_REASON, getProjectWorkGraph } from './workspace-store.ts';
import type { CompactRunState } from './workspace-contract.ts';

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

      // Verify command and argument safety: bootstrap script with safe -InputFile JSON path (Criterion 1)
      const call = spawnCalls[0];
      assert.ok(call.command.toLowerCase().includes('powershell') || call.command.toLowerCase().includes('pwsh'));
      assert.ok(Array.isArray(call.args));
      assert.ok(call.args.includes('-InputFile'));
      const inputIdx = call.args.indexOf('-InputFile');
      const inputPath = call.args[inputIdx + 1];
      assert.ok(inputPath && fs.existsSync(inputPath));
      const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { prompt: string; repoRoot: string };
      assert.strictEqual(inputData.prompt, prompt);
      assert.strictEqual(path.resolve(inputData.repoRoot), path.resolve(testTempDir));

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

  void describe('Tool Resolution & Safe Environment Propagation', () => {
    void test('discovers PowerShell 7 and essential tools (codex, rg, agy) and prepends augmented PATH', () => {
      const result = resolveRequiredTools();
      assert.strictEqual(result.ok, true);
      assert.ok(result.tools);
      assert.ok(result.tools.pwsh);
      assert.ok(result.tools.codex);
      assert.ok(result.tools.rg);
      assert.ok(result.tools.agy);

      // PowerShell 7 (pwsh) must be resolved
      assert.ok(result.tools.pwsh.toLowerCase().includes('pwsh'));

      // Augmented PATH must contain tool directories
      assert.ok(result.tools.augmentedPath);
      const dirs = result.tools.augmentedPath.split(path.delimiter);
      assert.ok(dirs.includes(path.dirname(result.tools.pwsh)));
      assert.ok(dirs.includes(path.dirname(result.tools.codex)));
      assert.ok(dirs.includes(path.dirname(result.tools.rg)));
      assert.ok(dirs.includes(path.dirname(result.tools.agy)));
    });

    void test('immediately transitions to sanitized failed state when required tools are missing', async () => {
      const isolatedEnv: Record<string, string> = {
        PATH: '',
        LOCALAPPDATA: path.join(testTempDir, 'empty-appdata'),
        USERPROFILE: path.join(testTempDir, 'empty-userprofile'),
      };

      // Tool resolution should fail
      const result = resolveRequiredTools({
        env: isolatedEnv,
        platform: process.platform,
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.missing && result.missing.length > 0);

      // spawnRouterRun with missing tools should throw and persist a sanitized failed state
      let thrownError: (Error & { runId?: string }) | null = null;
      try {
        await spawnRouterRun({
          prompt: '도구 누락 작업',
          repoRoot: testTempDir,
          env: isolatedEnv,
        });
      } catch (err: unknown) {
        thrownError = err as Error & { runId?: string };
      }

      assert.ok(thrownError);
      assert.ok(thrownError.runId);

      const compact = await getCompactRunState(thrownError.runId, testTempDir);
      assert.ok(compact);
      assert.strictEqual(compact.status, 'failed');
      assert.strictEqual(compact.requiresUserAction, false);
      assert.strictEqual(compact.errorCategory, 'launcher_error');
      assert.strictEqual(compact.errorDisplayName, '실행기 오류');
      assert.strictEqual(compact.retryable, true);
      assert.ok(compact.failureReason);
      assert.ok(compact.failureReason.includes('필수 실행 도구'));

      // Confirm sanitization: error does not expose raw root path
      assert.ok(!compact.failureReason.includes(testTempDir));
    });
  });

  void describe('Korean Repository Path (한글 경로) Preservation & Execution Without Mojibake', () => {
    let koreanRepoDir: string;

    beforeEach(() => {
      koreanRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), '테스트-저장소-한글경로-'));
      fs.mkdirSync(path.join(koreanRepoDir, '.agent', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepoDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepoDir, '.agent', 'dashboard-state', 'aliases'), { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(koreanRepoDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    void test('validates Korean repository path without mojibake or normalization error', () => {
      const res = validateRepository(koreanRepoDir, koreanRepoDir);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.repoRoot.toLowerCase(), path.resolve(koreanRepoDir).toLowerCase());
    });

    void test('spawnRouterRun and state persistence operate reliably in Korean directory path', async () => {
      const spawnCalls: Array<{ command: string; args: string[]; opts: unknown }> = [];
      const mockSpawner = (command: string, args: string[], opts: unknown) => {
        spawnCalls.push({ command, args, opts });
        return { unref: () => {}, pid: 4321 };
      };

      const result = await spawnRouterRun({
        prompt: '한글 경로 테스트 작업',
        repoRoot: koreanRepoDir,
        spawner: mockSpawner,
      });

      assert.strictEqual(result.status, 'running');
      assert.ok(result.runId);

      const compact = await getCompactRunState(result.runId, koreanRepoDir);
      assert.ok(compact);
      assert.strictEqual(compact.prompt, '한글 경로 테스트 작업');
      assert.strictEqual(compact.orchestratorProcessId, 4321);

      // Verify spawn call passed PowerShell 7 (pwsh) and Korean repo path via -InputFile
      const call = spawnCalls[0];
      assert.ok(call.command.toLowerCase().includes('pwsh'));
      assert.ok(call.args.includes('-InputFile'));
      const inputIdx = call.args.indexOf('-InputFile');
      const inputPath = call.args[inputIdx + 1];
      assert.ok(inputPath && fs.existsSync(inputPath));
      const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { prompt: string; repoRoot: string };
      assert.strictEqual(inputData.prompt, '한글 경로 테스트 작업');
      assert.strictEqual(path.resolve(inputData.repoRoot), path.resolve(koreanRepoDir));
    });

    void test('real child process spawned in Korean path outputs UTF-8 without mojibake', async () => {
      const toolsResult = resolveRequiredTools();
      if (!toolsResult.ok || !toolsResult.tools) {
        return; // Skip if environment cannot resolve pwsh
      }

      const { spawnSync } = await import('node:child_process');
      const testString = '한글_문자열_인코딩_정상_검증';

      const child = spawnSync(toolsResult.tools.pwsh, [
        '-NoProfile',
        '-Command',
        `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output '${testString}'`,
      ], {
        cwd: koreanRepoDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: toolsResult.tools.augmentedPath,
          PYTHONIOENCODING: 'utf-8',
          POWERSHELL_CLI_CONSOLE_ENCODING: 'utf-8',
        },
      });

      assert.strictEqual(child.status, 0);
      assert.ok(
        child.stdout && child.stdout.includes(testString),
        `stdout was: ${JSON.stringify(child.stdout)}, stderr: ${child.stderr}`
      );
    });
  });

  void describe('Actual Child Process ID Connection & Atomic Alias Linking (실제 자식 프로세스 ID 연결)', () => {
    void test('atomically links dashboard runId to actual run manifest via child PID and tracks live worker', async () => {
      const { spawn: nodeSpawn } = await import('node:child_process');

      // Spawn a real short-lived child process to get an authentic OS PID
      const realChild = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
        detached: true,
        stdio: 'ignore',
      });
      realChild.unref();

      const realChildPid = realChild.pid;
      assert.ok(typeof realChildPid === 'number' && realChildPid > 0);

      // Custom spawner returning our real child process
      const realSpawner = () => realChild;

      const prompt = '실제 PID 연결 테스트 작업';
      const spawnResult = await spawnRouterRun({
        prompt,
        repoRoot: testTempDir,
        spawner: realSpawner,
      });

      const dashboardRunId = spawnResult.runId;
      assert.ok(dashboardRunId);

      // Verify child PID was persisted in initial compact state
      const initialCompact = await getCompactRunState(dashboardRunId, testTempDir);
      assert.ok(initialCompact);
      assert.strictEqual(initialCompact.orchestratorProcessId, realChildPid);

      // Simulate the background router orchestrator creating an actual run directory with its own runId
      const actualRunId = '20260909-ACTUAL-ORCHESTRATOR-RUN-77';
      const actualRunDir = path.join(testTempDir, '.agent', 'runs', actualRunId);
      fs.mkdirSync(path.join(actualRunDir, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(actualRunDir, 'results'), { recursive: true });
      fs.mkdirSync(path.join(actualRunDir, 'tasks'), { recursive: true });

      // Write actual run.json containing orchestratorProcessId matching child PID
      fs.writeFileSync(
        path.join(actualRunDir, 'run.json'),
        JSON.stringify({
          runId: actualRunId,
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          repository: testTempDir,
          orchestratorProcessId: realChildPid,
          tasks: ['TASK-REAL-01'],
        }),
        'utf8'
      );

      // Write active live worker
      fs.writeFileSync(
        path.join(actualRunDir, 'workers', 'TASK-REAL-01.json'),
        JSON.stringify({
          runId: actualRunId,
          taskId: 'TASK-REAL-01',
          task: '실제 워커 구현 작업',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [{ timestamp: '12:00:00', message: '작업 진행 중', type: 'log' }],
        }),
        'utf8'
      );

      // 1. Calling findAndLinkActualRun must discover and link via real child PID
      const resolvedActualId = await findAndLinkActualRun(dashboardRunId, testTempDir);
      assert.strictEqual(resolvedActualId, actualRunId);

      // 2. Calling getRunDetails with the dashboardRunId must return actual worker state!
      const detail = await getRunDetails(dashboardRunId, testTempDir);
      assert.ok(detail);
      assert.strictEqual(detail.runId, dashboardRunId);
      assert.strictEqual(detail.actualRunId, actualRunId);
      assert.strictEqual(detail.activeWorkers.length, 1);
      assert.strictEqual(detail.activeWorkers[0].taskId, 'TASK-REAL-01');
      assert.strictEqual(detail.activeWorkers[0].status, 'running');
      assert.strictEqual(detail.tasks.length, 1);
      assert.strictEqual(detail.tasks[0].taskName, '실제 워커 구현 작업');

      // 3. Project control must track the live worker
      const projectWorkers = await getProjectWorkers(testTempDir);
      const activeIds = projectWorkers.activeWorkers.map(w => w.taskId);
      assert.ok(activeIds.includes('TASK-REAL-01'));

      // 4. Verify atomic alias record exists on disk
      const alias = await getAliasRecord(dashboardRunId, testTempDir);
      assert.ok(alias);
      assert.strictEqual(alias.dashboardRunId, dashboardRunId);
      assert.strictEqual(alias.actualRunId, actualRunId);
      assert.strictEqual(alias.orchestratorProcessId, realChildPid);

      // 5. Simulate worker completion
      fs.writeFileSync(
        path.join(actualRunDir, 'results', 'TASK-REAL-01-result.json'),
        JSON.stringify({
          runId: actualRunId,
          taskId: 'TASK-REAL-01',
          task: '실제 워커 구현 작업',
          status: 'completed',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(actualRunDir, 'run.json'),
        JSON.stringify({
          runId: actualRunId,
          status: 'awaiting_review',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          repository: testTempDir,
          orchestratorProcessId: realChildPid,
          tasks: ['TASK-REAL-01'],
        }),
        'utf8'
      );

      // Once completed, worker must immediately drop out of active terminal
      const updatedDetail = await getRunDetails(dashboardRunId, testTempDir);
      assert.ok(updatedDetail);
      assert.strictEqual(updatedDetail.status, 'awaiting_review');
      assert.strictEqual(updatedDetail.requiresUserAction, true);
      assert.strictEqual(updatedDetail.activeWorkers.length, 0);
      assert.strictEqual(updatedDetail.historyWorkers.length, 1);
      assert.strictEqual(updatedDetail.historyWorkers[0].taskId, 'TASK-REAL-01');

      const updatedProject = await getProjectWorkers(testTempDir);
      assert.ok(!updatedProject.activeWorkers.some(w => w.taskId === 'TASK-REAL-01'));
      assert.ok(updatedProject.historyWorkers.some(w => w.taskId === 'TASK-REAL-01'));

      // Clean up child process
      try { realChild.kill(); } catch {}
    });
  });

  void describe('Process Evidence & Stale Compact State Correction (Criterion 1-7)', () => {
    void test('dead PID plus no worker evidence yields activeWorkers 0 and a preserved failed record', async () => {
      const runId = '20260909-dead-worker-001';
      const createdAt = new Date(Date.now() - 120_000).toISOString(); // 2 minutes ago (outside grace)

      await saveCompactRunState(
        {
          runId,
          prompt: '죽은 프로세스 작업',
          createdAt,
          updatedAt: createdAt,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 99999999, // dead PID
        },
        testTempDir
      );

      // 1. Calling getRunDetails must correct the state and return failed
      const detail = await getRunDetails(runId, testTempDir, {
        processInfoResolver: () => ({ pid: 99999999, alive: false, metadataAvailable: true }),
      });
      assert.ok(detail);
      assert.strictEqual(detail.status, 'failed');
      assert.strictEqual(detail.activeWorkersCount, 0);
      assert.strictEqual(detail.activeWorkers.length, 0);
      assert.strictEqual(detail.historyWorkers.length, 1);
      assert.strictEqual(detail.historyWorkers[0].status, 'failed');
      assert.strictEqual(detail.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(detail.userActionReason, STALE_PROCESS_MISMATCH_REASON);

      // 2. Legacy record was preserved (not deleted) and persisted atomically as failed
      const onDisk = await getCompactRunState(runId, testTempDir);
      assert.ok(onDisk);
      assert.strictEqual(onDisk.status, 'failed');
      assert.strictEqual(onDisk.activeWorkersCount, 0);
      assert.strictEqual(onDisk.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(onDisk.userActionReason, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('valid live router PID or real active-worker evidence remains active', async () => {
      const runId = '20260909-live-evidence-001';
      const createdAt = new Date(Date.now() - 120_000).toISOString();

      // Case A: Valid live router PID
      await saveCompactRunState(
        {
          runId,
          prompt: '실제 라우터 작업',
          createdAt,
          updatedAt: createdAt,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 5432,
        },
        testTempDir
      );

      const detailWithLivePid = await getRunDetails(runId, testTempDir, {
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          command: `pwsh.exe -File ${testTempDir}\\codex-router.ps1 -Request 작업`,
          metadataAvailable: true,
        }),
      });
      assert.ok(detailWithLivePid);
      assert.strictEqual(detailWithLivePid.status, 'running');
      assert.strictEqual(detailWithLivePid.activeWorkers.length, 1);

      // Case B: Dead PID but real active-worker file exists
      const workerRunId = '20260909-live-worker-002';
      const workerDir = path.join(testTempDir, '.agent', 'runs', workerRunId, 'workers');
      fs.mkdirSync(workerDir, { recursive: true });
      fs.writeFileSync(
        path.join(workerDir, 'TASK-001.json'),
        JSON.stringify({
          runId: workerRunId,
          taskId: 'TASK-001',
          status: 'running',
          startedAt: createdAt,
          updatedAt: new Date().toISOString(),
        }),
        'utf8'
      );

      await saveCompactRunState(
        {
          runId: workerRunId,
          actualRunId: workerRunId,
          prompt: '워커 활성 작업',
          createdAt,
          updatedAt: createdAt,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 99999999, // dead PID
        },
        testTempDir
      );

      const detailWithWorker = await getRunDetails(workerRunId, testTempDir, {
        processInfoResolver: () => ({ pid: 99999999, alive: false, metadataAvailable: true }),
      });
      assert.ok(detailWithWorker);
      assert.strictEqual(detailWithWorker.status, 'running');
      assert.strictEqual(detailWithWorker.activeWorkers.length, 1);
    });

    void test('reused/unrelated PID is NOT accepted as active', async () => {
      const runId = '20260909-reused-pid-test';
      const createdAt = new Date(Date.now() - 120_000).toISOString();

      await saveCompactRunState(
        {
          runId,
          prompt: '재사용 PID 작업',
          createdAt,
          updatedAt: createdAt,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 9988,
        },
        testTempDir
      );

      const detail = await getRunDetails(runId, testTempDir, {
        processInfoResolver: (pid) => ({
          pid,
          alive: true,
          name: 'notepad.exe',
          command: 'notepad.exe C:\\other.txt',
          metadataAvailable: true,
        }),
      });

      assert.ok(detail);
      assert.strictEqual(detail.status, 'failed');
      assert.strictEqual(detail.activeWorkersCount, 0);
      assert.strictEqual(detail.activeWorkers.length, 0);
      assert.strictEqual(detail.error, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('new run inside grace period remains active', async () => {
      const runId = '20260909-new-grace-test';
      const createdAt = new Date(Date.now() - 5_000).toISOString(); // 5 seconds ago (< 30s)

      await saveCompactRunState(
        {
          runId,
          prompt: '방금 시작된 작업',
          createdAt,
          updatedAt: createdAt,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 99999999, // dead PID before manifest written
        },
        testTempDir
      );

      const detail = await getRunDetails(runId, testTempDir, {
        processInfoResolver: () => ({ pid: 99999999, alive: false, metadataAvailable: true }),
      });

      assert.ok(detail);
      assert.strictEqual(detail.status, 'running');
      assert.strictEqual(detail.activeWorkers.length, 1);
    });

    void test('legacy fake-running compact state is corrected on API read and persisted atomically', async () => {
      const legacyRunId = '20260909-legacy-fake-01';
      const oldTime = '2026-09-08T10:00:00.000Z'; // long ago

      // Write legacy compact state directly to disk as 'running'
      fs.writeFileSync(
        path.join(testTempDir, '.agent', 'dashboard-state', 'compact', `${legacyRunId}.json`),
        JSON.stringify({
          runId: legacyRunId,
          prompt: '레거시 가짜 실행 상태',
          createdAt: oldTime,
          updatedAt: oldTime,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 1111,
        }),
        'utf8'
      );

      // Call listCompactRuns
      const runs = await listCompactRuns(testTempDir, {
        processInfoResolver: () => ({ pid: 1111, alive: false, metadataAvailable: true }),
      });

      const found = runs.find((r) => r.runId === legacyRunId);
      assert.ok(found);
      assert.strictEqual(found.status, 'failed');
      assert.strictEqual(found.activeWorkersCount, 0);
      assert.strictEqual(found.error, STALE_PROCESS_MISMATCH_REASON);
      assert.strictEqual(found.userActionReason, STALE_PROCESS_MISMATCH_REASON);

      // Check on disk to ensure it was atomically persisted as failed
      const onDisk = JSON.parse(
        fs.readFileSync(
          path.join(testTempDir, '.agent', 'dashboard-state', 'compact', `${legacyRunId}.json`),
          'utf8'
        )
      ) as CompactRunState;
      assert.strictEqual(onDisk.status, 'failed');
      assert.strictEqual(onDisk.activeWorkersCount, 0);
      assert.strictEqual(onDisk.error, STALE_PROCESS_MISMATCH_REASON);
    });

    void test('getProjectWorkers excludes stale workers from activeWorkers and places in history', async () => {
      const staleRunId = '20260909-stale-project-01';
      const oldTime = '2026-09-08T12:00:00.000Z';

      await saveCompactRunState(
        {
          runId: staleRunId,
          prompt: '프로젝트 관제 좀비 작업',
          createdAt: oldTime,
          updatedAt: oldTime,
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 2222,
        },
        testTempDir
      );

      const { activeWorkers, historyWorkers } = await getProjectWorkers(testTempDir, {
        processInfoResolver: () => ({ pid: 2222, alive: false, metadataAvailable: true }),
      });

      // activeWorkers must NOT contain this stale worker
      assert.strictEqual(activeWorkers.some((w) => w.runId === staleRunId), false);

      // historyWorkers must contain this worker with status failed
      const staleWorker = historyWorkers.find((w) => w.runId === staleRunId);
      assert.ok(staleWorker);
      assert.strictEqual(staleWorker.status, 'failed');
      assert.strictEqual(staleWorker.error, STALE_PROCESS_MISMATCH_REASON);
    });
  });

  void describe('Project Work Graph & Restart Recovery', () => {
    void test('reconstructs complete DAG from durable disk artifacts and recovers across restart', async () => {
      const runId = '20260910-graph-test-01';
      const runDir = path.join(testTempDir, '.agent', 'runs', runId);
      fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'events'), { recursive: true });

      // 1. run.json manifest
      fs.writeFileSync(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          runId,
          prompt: '작업 그래프 테스트 프롬프트',
          status: 'awaiting_review',
          createdAt: '2026-09-10T01:00:00.000Z',
          updatedAt: '2026-09-10T01:10:00.000Z',
          tasks: ['TASK-001', 'TASK-002'],
          baseCommit: 'commit-base-123',
          integrationBranch: 'integration/20260910-graph-test-01',
        }),
        'utf8'
      );

      // 2. Task metadata
      fs.writeFileSync(
        path.join(runDir, 'tasks', 'TASK-001.json'),
        JSON.stringify({
          id: 'TASK-001',
          name: 'Task Alpha',
          prompt: 'Alpha 구현',
          allowedFiles: ['src/alpha.ts'],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(runDir, 'tasks', 'TASK-002.json'),
        JSON.stringify({
          id: 'TASK-002',
          name: 'Task Beta',
          prompt: 'Beta 구현',
          allowedFiles: ['src/beta.ts'],
        }),
        'utf8'
      );

      // 3. Worker result files
      fs.writeFileSync(
        path.join(runDir, 'results', 'TASK-001-result.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-001',
          task: 'Task Alpha',
          status: 'completed',
          startedAt: '2026-09-10T01:02:00.000Z',
          completedAt: '2026-09-10T01:05:00.000Z',
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(runDir, 'results', 'TASK-002-result.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-002',
          task: 'Task Beta',
          status: 'completed',
          startedAt: '2026-09-10T01:02:00.000Z',
          completedAt: '2026-09-10T01:06:00.000Z',
        }),
        'utf8'
      );

      // 4. Worker NDJSON events
      const events1 = [
        JSON.stringify({
          timestamp: '2026-09-10T01:02:10.000Z',
          id: 'TASK-001-branch',
          parentId: `${runId}-plan`,
          activity: 'LOAD',
          file: 'src/alpha.ts',
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:03:00.000Z',
          id: 'TASK-001-e1',
          parentId: 'TASK-001-branch',
          activity: 'EDIT',
          file: 'src/alpha.ts',
          diffSnippet: '+export const a = 1;',
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:04:00.000Z',
          id: 'TASK-001-e2',
          parentId: 'TASK-001-e1',
          activity: 'RUN',
          command: 'npm test',
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:04:30.000Z',
          id: 'TASK-001-e3',
          parentId: 'TASK-001-e2',
          activity: 'PASS',
          command: 'npm test',
          result: { success: true },
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:05:00.000Z',
          id: 'TASK-001-done',
          parentId: 'TASK-001-e3',
          activity: 'DONE',
        }),
      ].join('\n');
      fs.writeFileSync(path.join(runDir, 'events', 'TASK-001.ndjson'), events1, 'utf8');

      const events2 = [
        JSON.stringify({
          timestamp: '2026-09-10T01:02:15.000Z',
          id: 'TASK-002-branch',
          parentId: `${runId}-plan`,
          activity: 'LOAD',
          file: 'src/beta.ts',
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:05:30.000Z',
          id: 'TASK-002-save',
          parentId: 'TASK-002-branch',
          activity: 'SAVE',
          file: 'src/beta.ts',
        }),
        JSON.stringify({
          timestamp: '2026-09-10T01:06:00.000Z',
          id: 'TASK-002-done',
          parentId: 'TASK-002-save',
          activity: 'DONE',
        }),
      ].join('\n');
      fs.writeFileSync(path.join(runDir, 'events', 'TASK-002.ndjson'), events2, 'utf8');

      // 5. integration.json
      fs.writeFileSync(
        path.join(runDir, 'integration.json'),
        JSON.stringify({
          id: `${runId}-integration`,
          parentIds: ['TASK-001-done', 'TASK-002-done'],
          branch: 'integration/20260910-graph-test-01',
          decision: 'awaiting_review',
          tests: [
            {
              command: 'npm test',
              exitCode: 0,
              output: 'all tests passed',
            },
          ],
        }),
        'utf8'
      );

      // Reconstruct graph via getProjectWorkGraph
      const graph = await getProjectWorkGraph(runId, testTempDir);
      assert.ok(graph, 'Graph should be non-null');
      assert.strictEqual(graph.runId, runId);
      assert.strictEqual(graph.prompt, '작업 그래프 테스트 프롬프트');

      // Verify node types and ownership
      const requestNode = graph.nodes.find((n) => n.type === 'request');
      assert.ok(requestNode, 'Should have request node');
      assert.strictEqual(requestNode.owner, 'Codex');

      const planNode = graph.nodes.find((n) => n.type === 'plan');
      assert.ok(planNode, 'Should have plan node');
      assert.strictEqual(planNode.owner, 'Codex');
      assert.ok(planNode.parentIds, 'Plan node must have parentIds');
      assert.ok(planNode.parentIds.includes(requestNode.id));

      const integrationNode = graph.nodes.find((n) => n.type === 'merge');
      assert.ok(integrationNode, 'Should have integration node');
      assert.strictEqual(integrationNode.owner, 'Orchestrator');
      assert.strictEqual(integrationNode.status, 'awaiting_review');
      assert.ok(integrationNode.parentIds, 'Integration node must have parentIds');
      assert.ok(integrationNode.parentIds.includes('TASK-001-done'));
      assert.ok(integrationNode.parentIds.includes('TASK-002-done'));

      // Check activity nodes
      const editNode = graph.nodes.find((n) => n.id === 'TASK-001-e1');
      assert.ok(editNode);
      assert.strictEqual(editNode.activity, 'EDIT');
      assert.strictEqual(editNode.file, 'src/alpha.ts');

      const passNode = graph.nodes.find((n) => n.id === 'TASK-001-e3');
      assert.ok(passNode);
      assert.strictEqual(passNode.activity, 'PASS');
      assert.strictEqual(passNode.command, 'npm test');

      // Check tips
      assert.ok(graph.tips.length > 0, 'Graph tips should be populated');
      for (const tip of graph.tips) {
        assert.ok(tip.owner, 'Tip must have an owner');
        assert.ok(tip.status, 'Tip must have a status');
      }

      // Test additive return from getProjectWorkers with restart recovery
      const projectWorkersRes = await getProjectWorkers(testTempDir, undefined, runId);
      assert.ok(projectWorkersRes.graph);
      assert.strictEqual(projectWorkersRes.graph.runId, runId);
      assert.strictEqual(projectWorkersRes.historyWorkers.length, 2);
      assert.strictEqual(projectWorkersRes.activeWorkers.length, 0);
    });
  });
});