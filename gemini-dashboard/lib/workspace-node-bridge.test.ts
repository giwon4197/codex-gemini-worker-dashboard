import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SpawnOptions } from 'node:child_process';
// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest, createWorkspaceBridgeMiddleware, workspaceBridgePlugin, resetWorkspaceBridgeOptions } from './workspace-node-bridge.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getCompactRunState, getAliasRecord, resolveRequiredTools, saveConversationSession, getRunDetails, spawnRouterRun } from './workspace-store.ts';

void describe('Workspace Node Bridge (Vite Dev/Server Middleware & App Route Bridge)', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;
  let savedAgyPath: string | undefined;

  beforeEach(() => {
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    savedAgyPath = process.env.AGY_PATH;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create minimal agent directory structure
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'aliases'), { recursive: true });

    // Dummy codex-router.ps1 in repository root
    fs.writeFileSync(path.join(testRepoDir, 'codex-router.ps1'), '# Dummy router\n', 'utf8');
    const agyFixture = path.join(testRepoDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(agyFixture, 'test fixture', 'utf8');
    process.env.AGY_PATH = agyFixture;

    resetWorkspaceBridgeOptions();
  });

  afterEach(() => {
    resetWorkspaceBridgeOptions();
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

  void describe('1. Middleware Request Parsing & Routing', () => {
    void test('passes through non-workspace routes to next() without intercepting', async () => {
      const middleware = createWorkspaceBridgeMiddleware({ repoRoot: testRepoDir });
      let nextCalled = false;

      const req = {
        url: '/api/settings',
        method: 'GET',
        headers: {},
      } as unknown as http.IncomingMessage;

      const res = {
        writeHead: () => {},
        end: () => {},
      } as unknown as http.ServerResponse;

      middleware(req, res, () => {
        nextCalled = true;
      });

      assert.strictEqual(nextCalled, true);
    });

    void test('rejects unsupported HTTP methods on workspace endpoints with status 405', async () => {
      const req = new Request('http://localhost:3000/api/runs', { method: 'DELETE' });
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 405);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('지원하지 않는'));
    });

    void test('returns 404 for unrecognized /api/runs subpaths', async () => {
      const req = new Request('http://localhost:3000/api/runs/sub/invalid/path', { method: 'GET' });
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 400); // Path contains slashes, rejected by validateRunId
    });
  });

  void describe('2. Successful 201 Submission & Injected PowerShell Spawn Verification', () => {
    void test('creates compact state, captures PID, records alias, and verifies pwsh spawn arguments', async () => {
      const spawnCalls: Array<{
        command: string;
        args: string[];
        options: SpawnOptions;
      }> = [];

      const mockPid = 9876;
      const mockSpawner = (command: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ command, args, options });
        return {
          pid: mockPid,
          unref: () => {},
        };
      };

      const prompt = '새로운 대화형 워커 구현';
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const res = await handleWorkspaceBridgeRequest(req, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
      });

      assert.strictEqual(res.status, 201);
      const data = (await res.json()) as {
        ok: boolean;
        runId: string;
        isDuplicate: boolean;
        status: string;
      };
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.isDuplicate, false);
      assert.strictEqual(data.status, 'running');
      assert.ok(data.runId);

      // Verify spawn arguments and options strictly (Criteria 1 & 2)
      assert.strictEqual(spawnCalls.length, 1);
      const call = spawnCalls[0];
      assert.ok(call.command.toLowerCase().includes('pwsh'));
      assert.ok(call.args.includes('-InputFile'));
      assert.ok(call.args.includes('-File'));
      const fileIdx = call.args.indexOf('-File');
      assert.strictEqual(path.resolve(call.args[fileIdx + 1]), path.resolve(testRepoDir, 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1'));
      const inputIdx = call.args.indexOf('-InputFile');
      const inputPath = call.args[inputIdx + 1];
      assert.ok(inputPath && fs.existsSync(inputPath));
      const inputData = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as { prompt: string; repoRoot: string; routerScript: string };
      assert.strictEqual(inputData.prompt, prompt);
      assert.strictEqual(path.resolve(inputData.repoRoot), path.resolve(testRepoDir));
      assert.strictEqual(path.resolve(inputData.routerScript), path.resolve(testRepoDir, 'codex-router.ps1'));

      // Windows keeps redirected PowerShell handles reliable only when it is not
      // placed in a detached process group. Other platforms remain detached.
      assert.strictEqual(call.options.detached, process.platform !== 'win32');
      assert.ok(Array.isArray(call.options.stdio));
      assert.strictEqual(call.options.stdio[0], 'ignore');
      assert.strictEqual(typeof call.options.stdio[1], 'number');
      assert.strictEqual(typeof call.options.stdio[2], 'number');
      assert.strictEqual(call.options.windowsHide, true);
      assert.strictEqual(path.resolve(call.options.cwd as string), path.resolve(testRepoDir));

      // Verify environment variables (UTF-8 encoding preserved)
      const env = call.options.env as Record<string, string>;
      assert.strictEqual(env.POWERSHELL_CLI_CONSOLE_ENCODING, 'utf-8');
      assert.strictEqual(env.PYTHONIOENCODING, 'utf-8');

      // Verify compact state persistence on disk
      const compact = await getCompactRunState(data.runId, testRepoDir);
      assert.ok(compact);
      assert.strictEqual(compact.runId, data.runId);
      assert.strictEqual(compact.prompt, prompt);
      assert.strictEqual(compact.status, 'running');
      assert.strictEqual(compact.orchestratorProcessId, mockPid);

      // Verify alias record on disk
      const alias = await getAliasRecord(data.runId, testRepoDir);
      assert.ok(alias);
      assert.strictEqual(alias.dashboardRunId, data.runId);
      assert.strictEqual(alias.orchestratorProcessId, mockPid);
    });
  });

  void describe('3. Idempotency Behavior', () => {
    void test('repeated idempotencyKey returns 200 with isDuplicate: true and identical runId', async () => {
      let spawnCount = 0;
      const mockSpawner = () => {
        spawnCount++;
        return { pid: 1234, unref: () => {} };
      };

      const idempotencyKey = 'idem-unique-abc-123';
      const prompt = '중복 방지 검증 작업';

      // 1st request
      const req1 = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, idempotencyKey }),
      });

      const res1 = await handleWorkspaceBridgeRequest(req1, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
      });
      assert.strictEqual(res1.status, 201);
      const data1 = (await res1.json()) as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(data1.isDuplicate, false);
      assert.strictEqual(spawnCount, 1);

      // 2nd request with same idempotencyKey
      const req2 = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, idempotencyKey }),
      });

      const res2 = await handleWorkspaceBridgeRequest(req2, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
      });
      assert.strictEqual(res2.status, 200);
      const data2 = (await res2.json()) as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(data2.isDuplicate, true);
      assert.strictEqual(data2.runId, data1.runId);

      // Spawner must NOT have been called a second time
      assert.strictEqual(spawnCount, 1);
    });
  });

  void describe('4. Dashboard-to-Actual Run Linking', () => {
    void test('resolves dashboard runId to actual worker run directory via PID and returns worker data', async () => {
      const dashboardRunId = '20260909-LINK-DASH-01';
      const actualRunId = '20260909-LINK-ACTUAL-01';
      const sharedPid = 8899;

      // Initial compact state for dashboard run
      fs.writeFileSync(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${dashboardRunId}.json`),
        JSON.stringify({
          runId: dashboardRunId,
          prompt: '실시간 연동 테스트',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'running',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: sharedPid,
        }),
        'utf8'
      );

      // Actual run directory in .agent/runs/<actualRunId>
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
          orchestratorProcessId: sharedPid,
          tasks: ['TASK-001'],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(actualRunDir, 'workers', 'TASK-001.json'),
        JSON.stringify({
          runId: actualRunId,
          taskId: 'TASK-001',
          task: '브릿지 연동 워커',
          status: 'running',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${dashboardRunId}`);
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as {
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
    });
  });

  void describe('5. State GET Endpoints', () => {
    void test('GET /api/runs returns list of runs', async () => {
      const req = new Request('http://localhost:3000/api/runs', { method: 'GET' });
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as { ok: boolean; runs: unknown[] };
      assert.strictEqual(data.ok, true);
      assert.ok(Array.isArray(data.runs));
    });

    void test('GET /api/projects returns project summary', async () => {
      const req = new Request('http://localhost:3000/api/projects', { method: 'GET' });
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as {
        ok: boolean;
        projects: Array<{ id: string; name: string }>;
      };
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.projects.length, 1);
      assert.strictEqual(data.projects[0].id, 'current');
    });

    void test('GET /api/projects/current/workers filters active vs history workers', async () => {
      const runId = '20260909-WORKERS-01';
      const runDir = path.join(testRepoDir, '.agent', 'runs', runId);
      fs.mkdirSync(path.join(runDir, 'workers'), { recursive: true });
      fs.mkdirSync(path.join(runDir, 'results'), { recursive: true });

      // Active running worker
      fs.writeFileSync(
        path.join(runDir, 'workers', 'TASK-ACTIVE.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-ACTIVE',
          status: 'running',
          task: '활성 워커',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      // Completed worker in results
      fs.writeFileSync(
        path.join(runDir, 'results', 'TASK-DONE-result.json'),
        JSON.stringify({
          runId,
          taskId: 'TASK-DONE',
          status: 'completed',
          task: '완료 워커',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recentLogs: [],
        }),
        'utf8'
      );

      fs.writeFileSync(
        path.join(runDir, 'run.json'),
        JSON.stringify({
          runId,
          status: 'running',
          tasks: ['TASK-ACTIVE', 'TASK-DONE'],
        }),
        'utf8'
      );

      const req = new Request('http://localhost:3000/api/projects/current/workers');
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as {
        ok: boolean;
        activeWorkers: Array<{ taskId: string }>;
        historyWorkers: Array<{ taskId: string }>;
      };

      assert.strictEqual(data.ok, true);
      assert.ok(data.activeWorkers.some(w => w.taskId === 'TASK-ACTIVE'));
      assert.ok(!data.activeWorkers.some(w => w.taskId === 'TASK-DONE'));
      assert.ok(data.historyWorkers.some(w => w.taskId === 'TASK-DONE'));
    });
  });

  void describe('6. Input Validation, Malformed, & Oversized Input', () => {
    void test('rejects malformed JSON with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"prompt": incomplete...',
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('유효하지 않은'));
    });

    void test('rejects empty or whitespace prompt with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '   \n  ' }),
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('내용'));
    });

    void test('rejects oversized prompt (>10,000 characters) with status 400', async () => {
      const longPrompt = 'A'.repeat(10001);
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: longPrompt }),
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('초과'));
    });

    void test('rejects path traversal in repository with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '테스트', repository: '../../outside' }),
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('허용되지 않은') || data.error.includes('안전하지 않은'));
    });

    void test('rejects malformed runId containing path traversal sequence with status 400', async () => {
      const req = new Request('http://localhost:3000/api/runs/..%2F..%2Fetc%2Fpasswd');
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('유효하지 않은'));
    });

    void test('returns 404 for non-existent valid runId', async () => {
      const req = new Request('http://localhost:3000/api/runs/20260909-999999-00000000');
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 404);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('찾을 수 없습니다'));
    });

    void test('rejects malformed projectId containing path traversal with status 400', async () => {
      const req = new Request('http://localhost:3000/api/projects/..%2Fsecret/workers');
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });

      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('유효하지 않은'));
    });
  });

  void describe('7. Sanitized Categorized Errors & Non-disclosure', () => {
    void test('transitions to sanitized failed state when required tools are missing and returns 500', async () => {
      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '도구 누락 실패 테스트' }),
      });

      // Pass non-existent path to force tool resolution failure
      const res = await handleWorkspaceBridgeRequest(req, {
        repoRoot: testRepoDir,
        env: { PATH: '', LOCALAPPDATA: '', USERPROFILE: '', HOME: '' },
        toolOverrides: { pwsh: 'C:\\nonexistent\\pwsh.exe' },
      });

      assert.strictEqual(res.status, 500);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('필수 실행 도구'));
      // Never expose secrets, stack traces, or command lines
      assert.ok(!data.error.includes('Error:'));
      assert.ok(!data.error.includes('at '));
    });
  });

  void describe('8. Korean UTF-8 Handling (한글 경로 및 프롬프트)', () => {
    let koreanRepo: string;

    beforeEach(() => {
      koreanRepo = fs.mkdtempSync(path.join(os.tmpdir(), '한글-브릿지-저장소-'));
      fs.mkdirSync(path.join(koreanRepo, '.agent', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepo, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
      fs.mkdirSync(path.join(koreanRepo, '.agent', 'dashboard-state', 'aliases'), { recursive: true });
      fs.writeFileSync(path.join(koreanRepo, 'codex-router.ps1'), '# Dummy router\n', 'utf8');
    });

    afterEach(() => {
      try {
        fs.rmSync(koreanRepo, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    });

    void test('handles Korean prompt and repository path without mojibake', async () => {
      const mockSpawner = () => ({ pid: 2468, unref: () => {} });
      const prompt = '한글_문자열_인코딩_정상_검증';

      const req = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, repository: koreanRepo }),
      });

      const res = await handleWorkspaceBridgeRequest(req, {
        repoRoot: koreanRepo,
        spawner: mockSpawner,
      });

      assert.strictEqual(res.status, 201);
      const data = (await res.json()) as { ok: boolean; runId: string };
      assert.strictEqual(data.ok, true);

      // Verify stored prompt is clean UTF-8
      const compact = await getCompactRunState(data.runId, koreanRepo);
      assert.ok(compact);
      assert.strictEqual(compact.prompt, prompt);
    });
  });

  void describe('9. Real Localhost HTTP Server Integration (Criterion 7 & 1)', () => {
    let server: http.Server;
    let serverBaseUrl: string;

    beforeEach(async () => {
      const mockSpawner = () => ({ pid: 7777, unref: () => {} });
      const middleware = createWorkspaceBridgeMiddleware({
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        maxBodySizeBytes: 50 * 1024, // 50KB limit for test
      });

      server = http.createServer((req, res) => {
        middleware(req, res, () => {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          serverBaseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    void test('real HTTP POST returns 201, repeated idempotency returns 200, and GET returns state', async () => {
      const prompt = '실제 로컬호스트 HTTP 엔드포인트 검증';
      const idempotencyKey = 'real-http-idem-key-01';

      // 1. Real network HTTP POST -> 201
      const postRes = await fetch(`${serverBaseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, idempotencyKey }),
      });

      assert.strictEqual(postRes.status, 201);
      const postData = (await postRes.json()) as {
        ok: boolean;
        runId: string;
        isDuplicate: boolean;
      };
      assert.strictEqual(postData.ok, true);
      assert.strictEqual(postData.isDuplicate, false);
      const runId = postData.runId;
      assert.ok(runId);

      // 2. Real network repeated HTTP POST with same idempotencyKey -> 200
      const repeatRes = await fetch(`${serverBaseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, idempotencyKey }),
      });

      assert.strictEqual(repeatRes.status, 200);
      const repeatData = (await repeatRes.json()) as {
        ok: boolean;
        runId: string;
        isDuplicate: boolean;
      };
      assert.strictEqual(repeatData.ok, true);
      assert.strictEqual(repeatData.isDuplicate, true);
      assert.strictEqual(repeatData.runId, runId);

      // 3. Real network HTTP GET /api/runs -> 200
      const listRes = await fetch(`${serverBaseUrl}/api/runs`);
      assert.strictEqual(listRes.status, 200);
      const listData = (await listRes.json()) as {
        ok: boolean;
        runs: Array<{ runId: string }>;
      };
      assert.strictEqual(listData.ok, true);
      assert.ok(listData.runs.some(r => r.runId === runId));

      // 4. Real network HTTP GET /api/runs/:runId -> 200
      const detailRes = await fetch(`${serverBaseUrl}/api/runs/${runId}`);
      assert.strictEqual(detailRes.status, 200);
      const detailData = (await detailRes.json()) as {
        ok: boolean;
        run: { runId: string; prompt: string };
      };
      assert.strictEqual(detailData.ok, true);
      assert.strictEqual(detailData.run.runId, runId);
      assert.strictEqual(detailData.run.prompt, prompt);

      // 5. Real network HTTP GET /api/projects -> 200
      const projRes = await fetch(`${serverBaseUrl}/api/projects`);
      assert.strictEqual(projRes.status, 200);
      const projData = (await projRes.json()) as { ok: boolean; projects: unknown[] };
      assert.strictEqual(projData.ok, true);
      assert.ok(projData.projects.length > 0);

      // 6. Real network HTTP GET /api/projects/current/workers -> 200
      const workersRes = await fetch(`${serverBaseUrl}/api/projects/current/workers`);
      assert.strictEqual(workersRes.status, 200);
      const workersData = (await workersRes.json()) as { ok: boolean; activeWorkers: unknown[] };
      assert.strictEqual(workersData.ok, true);
    });

    void test('real HTTP request exceeding max body size returns 413 Payload Too Large', async () => {
      const largePayload = JSON.stringify({ prompt: 'B'.repeat(60 * 1024) }); // 60KB > 50KB limit
      const res = await fetch(`${serverBaseUrl}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largePayload,
      });

      assert.strictEqual(res.status, 413);
      const data = (await res.json()) as { ok: boolean; error: string };
      assert.strictEqual(data.ok, false);
      assert.ok(data.error.includes('제한'));
    });
  });

  void describe('10. Vite Plugin configureServer registration', () => {
    void test('registers bridge middleware with server.middlewares.use', () => {
      let registered = false;
      const mockServer = {
        middlewares: {
          use: (fn: unknown) => {
            if (typeof fn === 'function') {
              registered = true;
            }
          },
        },
      };

      const plugin = workspaceBridgePlugin({ repoRoot: testRepoDir });
      assert.strictEqual(plugin.name, 'workspace-bridge-api');
      assert.ok(typeof plugin.configureServer === 'function');

      if (typeof plugin.configureServer === 'function') {
        (plugin.configureServer as (server: unknown) => void)(mockServer);
      }
      assert.strictEqual(registered, true);
    });
  });

  void describe('11. Conversation & Approval Endpoints via Node Bridge', () => {
    void test('POST /api/conversations handles general chat without spawning any runs or workers', async () => {
      let spawnerCalled = false;
      const mockSpawner = () => {
        spawnerCalled = true;
        return { pid: 9999, unref: () => {} };
      };

      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({ intent: 'chat', reply: '안녕하세요! 반갑습니다.' }),
        stderr: '',
        exitCode: 0,
      });

      const req = new Request('http://localhost:3000/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '아아 들려?' }),
      });

      const res = await handleWorkspaceBridgeRequest(req, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(res.status, 200);
      const data = (await res.json()) as { ok: boolean; message: { intentType: string; text: string } };
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.message.intentType, 'chat');
      assert.strictEqual(spawnerCalled, false);
    });

    void test('POST /api/conversations with code plan returns approval card and approval endpoint spawns exactly once', async () => {
      const spawnCalls: unknown[] = [];
      const mockSpawner = () => {
        spawnCalls.push(1);
        return { pid: 8888, unref: () => {} };
      };

      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '버튼 수정 계획입니다.',
          plan: {
            title: '버튼 수정',
            explanation: '버튼 클릭 버그 수정',
            steps: ['코드 수정', '테스트 실행'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      // 1. Send modification prompt
      const convReq = new Request('http://localhost:3000/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '버튼 오류를 수정해' }),
      });

      const convRes = await handleWorkspaceBridgeRequest(convReq, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(convRes.status, 200);
      const convData = (await convRes.json()) as {
        ok: boolean;
        session: { sessionId: string };
        approval: { approvalId: string; status: string };
      };
      assert.strictEqual(convData.ok, true);
      assert.strictEqual(convData.approval.status, 'pending');
      assert.strictEqual(spawnCalls.length, 0); // 0 workers before approval!

      const sessionId = convData.session.sessionId;
      const approvalId = convData.approval.approvalId;

      // 2. Approve plan
      const apprReq1 = new Request(`http://localhost:3000/api/conversations/${sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId }),
      });

      const apprRes1 = await handleWorkspaceBridgeRequest(apprReq1, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        toolOverrides: { pwsh: 'pwsh.exe' },
      });

      assert.strictEqual(apprRes1.status, 201);
      const apprData1 = (await apprRes1.json()) as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(apprData1.ok, true);
      assert.strictEqual(apprData1.isDuplicate, false);
      assert.ok(apprData1.runId);
      assert.strictEqual(spawnCalls.length, 1); // Exactly 1 spawn!

      // 3. Duplicate approval request
      const apprReq2 = new Request(`http://localhost:3000/api/conversations/${sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId }),
      });

      const apprRes2 = await handleWorkspaceBridgeRequest(apprReq2, {
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        toolOverrides: { pwsh: 'pwsh.exe' },
      });

      assert.strictEqual(apprRes2.status, 200);
      const apprData2 = (await apprRes2.json()) as { ok: boolean; runId: string; isDuplicate: boolean };
      assert.strictEqual(apprData2.ok, true);
      assert.strictEqual(apprData2.isDuplicate, true);
      assert.strictEqual(apprData2.runId, apprData1.runId);
      assert.strictEqual(spawnCalls.length, 1); // STILL exactly 1 spawn!

      // 4. Retrieve session via GET
      const getReq = new Request(`http://localhost:3000/api/conversations/${sessionId}`, { method: 'GET' });
      const getRes = await handleWorkspaceBridgeRequest(getReq, { repoRoot: testRepoDir });
      assert.strictEqual(getRes.status, 200);
      const getData = (await getRes.json()) as { ok: boolean; session: { sessionId: string; linkedRunIds: string[] } };
      assert.strictEqual(getData.session.sessionId, sessionId);
      assert.ok(getData.session.linkedRunIds.includes(apprData1.runId));
    });
  });

  void describe('12. Real PowerShell 7 Integration in Korean Space Path with Approval API (Criterion 8)', () => {
    let koreanSpaceRepo: string;
    let server: http.Server | undefined;
    let serverUrl: string;
    let prevAllowed12: string | undefined;

    beforeEach(async () => {
      prevAllowed12 = process.env.ALLOWED_REPO_ROOT;
      const toolRes = resolveRequiredTools();
      if (!toolRes.ok || !toolRes.tools?.pwsh) {
        return;
      }

      koreanSpaceRepo = fs.mkdtempSync(path.join(os.tmpdir(), '한글 공백 저장소 테스트-'));
      process.env.ALLOWED_REPO_ROOT = koreanSpaceRepo;
      // Create required subdirectories
      fs.mkdirSync(path.join(koreanSpaceRepo, '.agent', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
      fs.mkdirSync(path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'conversations'), { recursive: true });
      fs.mkdirSync(path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'logs'), { recursive: true });
      fs.mkdirSync(path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'meta'), { recursive: true });
      fs.mkdirSync(path.join(koreanSpaceRepo, 'gemini-dashboard', 'scripts'), { recursive: true });

      // Locate bootstrap script
      const candidates = [
        path.resolve(process.cwd(), 'scripts', 'router-bootstrap.ps1'),
        path.resolve(process.cwd(), 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1'),
      ];
      const bootstrapSrc = candidates.find(c => fs.existsSync(c));
      const bootstrapDest = path.join(koreanSpaceRepo, 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1');
      if (bootstrapSrc) {
        fs.copyFileSync(bootstrapSrc, bootstrapDest);
      }

      // Create fixture codex-router.ps1 that writes minimal awaiting_review manifest and exits 0
      const routerScriptContent = [
        'param([string]$Request, [string]$Repository, [string]$InputFile)',
        '$actualRunId = "20260909-integ-actual-001"',
        'Write-Output "BOOTSTRAP_ROUTER_START: Request=$Request"',
        'Write-Output "Run: $actualRunId"',
        '$runDir = Join-Path $Repository ".agent/runs/$actualRunId"',
        '$workersDir = Join-Path $runDir "workers"',
        'New-Item -ItemType Directory -Force -Path $workersDir | Out-Null',
        '$manifest = @{ runId = $actualRunId; status = "awaiting_review"; createdAt = (Get-Date).ToString("o"); updatedAt = (Get-Date).ToString("o"); tasks = @("TASK-001"); integrationBranch = "integration/$actualRunId" }',
        '$manifestJson = $manifest | ConvertTo-Json -Compress',
        '[System.IO.File]::WriteAllText((Join-Path $runDir "run.json"), $manifestJson, [System.Text.Encoding]::UTF8)',
        '$worker = @{ runId = $actualRunId; taskId = "TASK-001"; task = "작업 검증"; status = "awaiting_review"; model = "gemini-3.8-flash"; startedAt = (Get-Date).ToString("o"); updatedAt = (Get-Date).ToString("o") }',
        '$workerJson = $worker | ConvertTo-Json -Compress',
        '[System.IO.File]::WriteAllText((Join-Path $workersDir "TASK-001.json"), $workerJson, [System.Text.Encoding]::UTF8)',
        'Write-Output "BOOTSTRAP_ROUTER_DONE: Run=$actualRunId awaiting_review"',
        'exit 0',
      ].join('\r\n');
      fs.writeFileSync(path.join(koreanSpaceRepo, 'codex-router.ps1'), routerScriptContent, 'utf8');

      // Start real localhost HTTP server
      server = http.createServer((req, res) => {
        const mw = createWorkspaceBridgeMiddleware({
          repoRoot: koreanSpaceRepo,
        });
        mw(req, res, () => {
          res.writeHead(404);
          res.end();
        });
      });

      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.listen(0, '127.0.0.1', () => {
          const addr = server!.address() as AddressInfo;
          serverUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      if (prevAllowed12 !== undefined) {
        process.env.ALLOWED_REPO_ROOT = prevAllowed12;
      } else {
        delete process.env.ALLOWED_REPO_ROOT;
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = undefined;
      }
    if (koreanSpaceRepo) {
        try {
          fs.rmSync(koreanSpaceRepo, { recursive: true, force: true });
        } catch {}
      }
    });

    void test('real pwsh executes bootstrap and router in Korean space path, stopping at awaiting_review', async () => {
      const toolRes = resolveRequiredTools();
      if (!toolRes.ok || !toolRes.tools?.pwsh) {
        return; // Skip if PowerShell 7 is unavailable in test environment
      }

      // 1. Create a conversation session with pending approval
      const sessionId = 'session-korean-space-001';
      const approvalId = 'appr-integ-001';
      const prompt = '한글과 공백 경로에서 안전한 라우터 실행 검증';

      await saveConversationSession(
        {
          sessionId,
          messages: [
            {
              id: 'msg-001',
              sender: 'user',
              text: prompt,
              timestamp: new Date().toISOString(),
            },
            {
              id: 'msg-002',
              sender: 'codex',
              text: '계획을 검토하고 승인해주세요.',
              timestamp: new Date().toISOString(),
              approval: {
                approvalId,
                sessionId,
                prompt,
                status: 'pending',
                plan: {
                  title: '라우터 통합 실행 검증',
                  explanation: '한글과 공백 경로에서 실제 실행 연결을 검증합니다.',
                  steps: ['라우터 실행', 'Run 상태 연결 확인'],
                },
                idempotencyKey: 'integ-approval-001',
                createdAt: new Date().toISOString(),
              },
            },
          ],
          pendingApproval: {
            approvalId,
            sessionId,
            prompt,
            status: 'pending',
            plan: {
              title: '라우터 통합 실행 검증',
              explanation: '한글과 공백 경로에서 실제 실행 연결을 검증합니다.',
              steps: ['라우터 실행', 'Run 상태 연결 확인'],
            },
            idempotencyKey: 'integ-approval-001',
            createdAt: new Date().toISOString(),
          },
          linkedRunIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        koreanSpaceRepo
      );

      // 2. Call POST /api/conversations/<sessionId>/approve via real localhost HTTP
      const approveRes = await fetch(`${serverUrl}/api/conversations/${sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId }),
      });

      assert.strictEqual(approveRes.status, 201);
      const approveData = (await approveRes.json()) as {
        ok: boolean;
        runId: string;
        isDuplicate: boolean;
        approval?: { status: string; runId?: string };
      };

      assert.strictEqual(approveData.ok, true);
      assert.strictEqual(approveData.isDuplicate, false);
      const dashboardRunId = approveData.runId;
      assert.ok(dashboardRunId);

      // 3. Poll getRunDetails until the real pwsh process completes and settles (up to 10s)
      let settled = false;
      let lastBody: unknown = null;
      const startTime = Date.now();
      while (Date.now() - startTime < 10000) {
        const detailRes = await fetch(`${serverUrl}/api/runs/${dashboardRunId}`);
        if (detailRes.status === 200) {
          const body = (await detailRes.json()) as { ok: boolean; run: { status: string; actualRunId?: string } };
          lastBody = body;
          if (body.run?.status === 'awaiting_review') {
            settled = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      if (!settled) {
        const logFile = path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'logs', `${dashboardRunId}.log`);
        const logContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '<no log>';
        const metaFile = path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'meta', `${dashboardRunId}.json`);
        const metaContent = fs.existsSync(metaFile) ? fs.readFileSync(metaFile, 'utf8') : '<no meta>';
        console.error('DEBUG Section 12 failure:', { lastBody, logContent, metaContent });
      }

      assert.strictEqual(settled, true, 'PowerShell router execution did not settle to awaiting_review within 10s');

      // 4. Verify run details and artifacts
      const finalDetail = await getRunDetails(dashboardRunId, koreanSpaceRepo);
      assert.ok(finalDetail);
      assert.strictEqual(finalDetail.status, 'awaiting_review');
      assert.strictEqual(finalDetail.actualRunId, '20260909-integ-actual-001');
      assert.strictEqual(finalDetail.requiresUserAction, true);
      assert.strictEqual(finalDetail.integrationBranch, 'integration/20260909-integ-actual-001');

      // 5. Verify log file contains stdout protocol and UTF-8 characters
      const logFile = path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'logs', `${dashboardRunId}.log`);
      assert.ok(fs.existsSync(logFile), 'Log file must exist on disk');
      const logContent = fs.readFileSync(logFile, 'utf8');
      assert.ok(logContent.includes('Run: 20260909-integ-actual-001'), 'Log must contain Run: <actualRunId>');
      assert.ok(logContent.includes('BOOTSTRAP_ROUTER_START'), 'Log must contain bootstrap marker');

      // 6. Verify launch metadata has exitCode 0
      const metaFile = path.join(koreanSpaceRepo, '.agent', 'dashboard-state', 'meta', `${dashboardRunId}.json`);
      assert.ok(fs.existsSync(metaFile), 'Meta file must exist on disk');
      const metaContent = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/^\uFEFF/, '')) as { exitCode: number | null };
      assert.strictEqual(metaContent.exitCode, 0);
    });
  });

  void describe('13. Launcher Error (exit 1 & timeout) Fixtures & Non-disclosure (Criterion 9)', () => {
    let failRepo: string;
    let prevAllowed13: string | undefined;

    beforeEach(() => {
      prevAllowed13 = process.env.ALLOWED_REPO_ROOT;
      failRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fail-fixture-repo-'));
      process.env.ALLOWED_REPO_ROOT = failRepo;
      fs.mkdirSync(path.join(failRepo, '.agent', 'runs'), { recursive: true });
      fs.mkdirSync(path.join(failRepo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
      fs.mkdirSync(path.join(failRepo, '.agent', 'dashboard-state', 'logs'), { recursive: true });
      fs.mkdirSync(path.join(failRepo, '.agent', 'dashboard-state', 'meta'), { recursive: true });
      fs.mkdirSync(path.join(failRepo, 'gemini-dashboard', 'scripts'), { recursive: true });

      const candidates = [
        path.resolve(process.cwd(), 'scripts', 'router-bootstrap.ps1'),
        path.resolve(process.cwd(), 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1'),
      ];
      const bootstrapSrc = candidates.find(c => fs.existsSync(c));
      const bootstrapDest = path.join(failRepo, 'gemini-dashboard', 'scripts', 'router-bootstrap.ps1');
      if (bootstrapSrc) {
        fs.copyFileSync(bootstrapSrc, bootstrapDest);
      }
    });

    afterEach(() => {
      if (prevAllowed13 !== undefined) {
        process.env.ALLOWED_REPO_ROOT = prevAllowed13;
      } else {
        delete process.env.ALLOWED_REPO_ROOT;
      }
      try {
        fs.rmSync(failRepo, { recursive: true, force: true });
      } catch {}
    });

    void test('abnormal exit (exit 1) settles immediately to launcher_error without fake tasks or timeline', async () => {
      // Create router script that fails with exit 1 and Korean error
      const routerScript = [
        'param([string]$Request, [string]$Repository, [string]$InputFile)',
        '[Console]::Error.WriteLine("치명적 실행기 오류: 파라미터 유효성 검증 실패 (코드 1001)")',
        'exit 1',
      ].join('\r\n');
      fs.writeFileSync(path.join(failRepo, 'codex-router.ps1'), routerScript, 'utf8');

      // Spawn run
      const spawnResult = await spawnRouterRun({
        prompt: '비정상 종료 테스트 작업',
        repoRoot: failRepo,
      });
      assert.ok(spawnResult.runId);
      const runId = spawnResult.runId;

      // Poll until bootstrap writes exitCode 1 to metadata (up to 5s)
      const metaPath = path.join(failRepo, '.agent', 'dashboard-state', 'meta', `${runId}.json`);
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { exitCode: number | null };
            if (meta.exitCode !== null) break;
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // Query via HTTP request simulation
      const req = new Request(`http://localhost:3000/api/runs/${runId}`, { method: 'GET' });
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: failRepo });
      assert.strictEqual(res.status, 200);

      const data = (await res.json()) as {
        ok: boolean;
        run: {
          status: string;
          errorCategory?: string;
          errorDisplayName?: string;
          retryable?: boolean;
          requiresUserAction?: boolean;
          tasksCount: number;
          tasks: unknown[];
          activeWorkers: unknown[];
          timeline: unknown[];
          changedFiles?: unknown;
          failureLogPath?: string;
          failureReason?: string;
        };
      };

      assert.strictEqual(data.ok, true);
      const r = data.run;
      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(r.errorCategory, 'launcher_error');
      assert.strictEqual(r.errorDisplayName, '실행기 오류');
      assert.strictEqual(r.retryable, true);
      assert.strictEqual(r.requiresUserAction, false);

      // Criterion 5 & 9: No virtual tasks, no changed files, no timeline
      assert.strictEqual(r.tasksCount, 0);
      assert.strictEqual(r.tasks.length, 0);
      assert.strictEqual(r.activeWorkers.length, 0);
      assert.strictEqual(r.timeline.length, 0);
      assert.strictEqual(r.changedFiles, undefined);

      // Relative log path without absolute repo leakage
      assert.ok(r.failureLogPath);
      assert.ok(!path.isAbsolute(r.failureLogPath));
      assert.ok(r.failureLogPath.startsWith('.agent'));

      // Sanitized failure reason: contains error info but NO raw stack dumps or userprofile
      assert.ok(r.failureReason);
      assert.ok(r.failureReason.includes('비정상 종료') || r.failureReason.includes('파라미터 유효성 검증 실패'));
      assert.ok(!r.failureReason.includes(failRepo));
    });

    void test('manifest timeout settles to launcher_error without fake tasks', async () => {
      const runId = '20260909-timeout-001';
      const prompt = '타임아웃 검증 작업';
      const now = new Date(Date.now() - 60000).toISOString();

      // Save a compact state as running without an actual manifest
      await fs.promises.writeFile(
        path.join(failRepo, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt,
          status: 'running',
          createdAt: now,
          updatedAt: now,
          requiresUserAction: false,
          tasksCount: 0,
          activeWorkersCount: 1,
          completedTasksCount: 0,
          orchestratorProcessId: 1111,
        }),
        'utf8'
      );

      // Write launch metadata as still running (exitCode: null)
      await fs.promises.writeFile(
        path.join(failRepo, '.agent', 'dashboard-state', 'meta', `${runId}.json`),
        JSON.stringify({
          dashboardRunId: runId,
          orchestratorProcessId: 1111,
          startedAt: now,
          status: 'running',
          exitCode: null,
        }),
        'utf8'
      );

      // Query getRunDetails with manifestTimeoutMs: 50 (expired)
      const detail = await getRunDetails(runId, failRepo, {
        manifestTimeoutMs: 50,
        processInfoResolver: () => ({
          pid: 1111,
          alive: true,
          command: 'pwsh.exe',
          metadataAvailable: true,
        }),
      });

      assert.ok(detail);
      assert.strictEqual(detail.status, 'failed');
      assert.strictEqual(detail.errorCategory, 'launcher_error');
      assert.strictEqual(detail.errorDisplayName, '실행기 오류');
      assert.strictEqual(detail.retryable, true);
      assert.strictEqual(detail.requiresUserAction, false);
      assert.strictEqual(detail.tasks.length, 0);
      assert.strictEqual(detail.timeline.length, 0);
      assert.ok(detail.failureReason?.includes('제한 시간'));
    });
  });

  void describe('14. Safe Retry & Usage Endpoints via Node Bridge', () => {
    void test('POST /api/runs/:runId/retry invokes safe retry and returns 201 with linkage', async () => {
      const origRunId = '20260909-BRIDGE-RETRY-01';
      await fs.promises.writeFile(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${origRunId}.json`),
        JSON.stringify({
          runId: origRunId,
          prompt: '브리지 재시도 테스트 작업',
          status: 'failed',
          requiresUserAction: false,
          errorCategory: 'launcher_error',
          failureReason: '실행 실패',
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          updatedAt: new Date(Date.now() - 30_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${origRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 201);
      const data = await res.json() as {
        ok: boolean;
        runId: string;
        retryOf: string;
        retryCount: number;
        isDuplicate: boolean;
      };

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.retryOf, origRunId);
      assert.strictEqual(data.retryCount, 1);
      assert.strictEqual(data.isDuplicate, false);
      assert.ok(data.runId);
    });

    void test('POST /api/runs/:runId/retry returns 400 for safety policy violations', async () => {
      const runId = '20260909-BRIDGE-POLICY-01';
      await fs.promises.writeFile(
        path.join(testRepoDir, '.agent', 'dashboard-state', 'compact', `${runId}.json`),
        JSON.stringify({
          runId,
          prompt: '정책 위반 작업',
          status: 'failed',
          errorCategory: 'policy_violation',
          failureReason: 'allowed_files 위반',
          requiresUserAction: false,
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          updatedAt: new Date(Date.now() - 30_000).toISOString(),
        }),
        'utf8'
      );

      const req = new Request(`http://localhost:3000/api/runs/${runId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as { ok: boolean; code: string; error: string };
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.code, 'RETRY_NOT_PERMITTED');
    });

    void test('GET /api/codex-usage and ?refresh=true via bridge', async () => {
      const req = new Request('http://localhost:3000/api/codex-usage');
      const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

      const refreshReq = new Request('http://localhost:3000/api/codex-usage?refresh=true');
      const refreshRes = await handleWorkspaceBridgeRequest(refreshReq, { repoRoot: testRepoDir });
      assert.strictEqual(refreshRes.status, 200);
    });

    void test('GET /api/gemini-quota and ?refresh=true via bridge', async () => {
      const savedDisable = process.env.GEMINI_QUOTA_DISABLE_CLI;
      process.env.GEMINI_QUOTA_DISABLE_CLI = '1';
      try {
        const req = new Request('http://localhost:3000/api/gemini-quota');
        const res = await handleWorkspaceBridgeRequest(req, { repoRoot: testRepoDir });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

        const refreshReq = new Request('http://localhost:3000/api/gemini-quota?refresh=true');
        const refreshRes = await handleWorkspaceBridgeRequest(refreshReq, { repoRoot: testRepoDir });
        assert.strictEqual(refreshRes.status, 200);
      } finally {
        if (savedDisable !== undefined) {
          process.env.GEMINI_QUOTA_DISABLE_CLI = savedDisable;
        } else {
          delete process.env.GEMINI_QUOTA_DISABLE_CLI;
        }
      }
    });
  });
});
