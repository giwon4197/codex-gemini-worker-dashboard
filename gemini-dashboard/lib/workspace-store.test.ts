import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error TS5097 allowed for test runner
import { validateRunId, validateRepository, validatePrompt, generateRunId, spawnRouterRun, getCompactRunState, saveCompactRunState, listCompactRuns, getProjectWorkers, resolveRequiredTools, getRunDetails, getAliasRecord, findAndLinkActualRun } from './workspace-store.ts';

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
      assert.strictEqual(compact.requiresUserAction, true);
      assert.ok(compact.userActionReason);
      assert.ok(compact.userActionReason.includes('필수 실행 도구'));

      // Confirm sanitization: error does not expose raw root path
      assert.ok(!compact.userActionReason.includes(testTempDir));
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

      // Verify spawn call passed PowerShell 7 (pwsh) and Korean repo path
      const call = spawnCalls[0];
      assert.ok(call.command.toLowerCase().includes('pwsh'));
      assert.ok(call.args.includes(koreanRepoDir));
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
});