import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpawnOptions } from 'node:child_process';
import { buildCodexExecArgs, defaultCodexRunner, evaluateCodexConversation, normalizeAffectedFiles, parseAndValidateCodexDecision, sanitizeSpawnEnv } from './codex-conversation.ts';
import { getConversationSession, approveConversationPlan, saveCompactRunState, listCompactRuns } from './workspace-store.ts';
import { extractTimelineEvents } from './workspace-contract.ts';
import { CODEX_DEFAULT_MODEL } from './model-tiers.ts';

void describe('Codex Conversational Workspace & Decision Engine', () => {
  let testRepoDir: string;
  let savedAllowedRepo: string | undefined;
  let savedAgyPath: string | undefined;

  beforeEach(() => {
    savedAllowedRepo = process.env.ALLOWED_REPO_ROOT;
    savedAgyPath = process.env.AGY_PATH;
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-conv-test-'));
    process.env.ALLOWED_REPO_ROOT = testRepoDir;

    // Create required directories
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'idempotency'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(testRepoDir, '.agent', 'dashboard-state', 'aliases'), { recursive: true });

    // Dummy router script
    fs.writeFileSync(path.join(testRepoDir, 'codex-router.ps1'), '# Dummy router\n', 'utf8');
    const agyFixture = path.join(testRepoDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
    fs.writeFileSync(agyFixture, 'test fixture', 'utf8');
    process.env.AGY_PATH = agyFixture;
  });

  afterEach(() => {
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

  void test('the npm-installed codex binary wins over the desktop app bundle', async t => {
    if (process.platform !== 'win32') return t.skip('windows-only lookup');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lookup-'));
    const npmExe = path.join(
      fakeHome, 'roaming', 'npm', 'node_modules', '@openai', 'codex',
      'node_modules', '@openai', 'codex-win32-x64', 'vendor',
      'x86_64-pc-windows-msvc', 'bin', 'codex.exe'
    );
    const bundledExe = path.join(fakeHome, 'local', 'OpenAI', 'Codex', 'bin', 'abc123', 'codex.exe');
    for (const exe of [npmExe, bundledExe]) {
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      fs.writeFileSync(exe, '');
    }

    let seenExecutable = '';
    await evaluateCodexConversation({
      message: '아아 들려?',
      repoRoot: testRepoDir,
      env: {
        PATH: '',
        APPDATA: path.join(fakeHome, 'roaming'),
        LOCALAPPDATA: path.join(fakeHome, 'local'),
      },
      codexRunner: async params => {
        seenExecutable = params.executable;
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      },
    });

    fs.rmSync(fakeHome, { recursive: true, force: true });
    assert.strictEqual(seenExecutable, npmExe);
  });

  void test('an injected runner still receives the resolved codex path, not a bare name', async () => {
    let seenExecutable = '';
    const result = await evaluateCodexConversation({
      message: '아아 들려?',
      repoRoot: testRepoDir,
      toolOverrides: { codex: process.execPath },
      codexRunner: async params => {
        seenExecutable = params.executable;
        return {
          stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    assert.strictEqual(result.ok, true);
    // A bare 'codex' reaches spawn() as ENOENT on Windows, where PATH only has shims.
    assert.notStrictEqual(seenExecutable, 'codex');
    assert.strictEqual(seenExecutable, process.execPath);
  });

  void describe('1. 일반 대화 처리 (General Chat)', () => {
    void test('일반 대화(아아 들려?)는 워커를 0개 생성하고 Codex 대화 응답만 반환한다', async () => {
      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'chat',
          reply: '네, 잘 들립니다! 무엇을 도와드릴까요?',
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '아아 들려?',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.session);
      assert.strictEqual(result.message?.intentType, 'chat');
      assert.strictEqual(result.message?.text, '네, 잘 들립니다! 무엇을 도와드릴까요?');
      assert.strictEqual(result.approval, undefined);
      assert.strictEqual(result.session.pendingApproval, undefined);

      // Verify no router/worker spawned (Criterion 1 & 10)
      const runs = await listCompactRuns(testRepoDir);
      assert.strictEqual(runs.length, 0);
    });

    void test('Codex human-readable exec output still yields a chat decision', async () => {
      const mixed = [
        'OpenAI Codex v0.147.0-alpha.6.5',
        '--------',
        'workdir: C:\\tmp\\repo',
        'model: gpt-5.6-luna',
        '--------',
        'user',
        'Respond ONLY with a JSON object',
        'codex',
        '{"intent":"chat","reply":"네, 잘 들립니다."}',
        'tokens used',
        '14330',
      ].join('\n');
      const parsed = parseAndValidateCodexDecision(mixed, testRepoDir);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.decision?.intent, 'chat');
      assert.equal(parsed.decision?.reply, '네, 잘 들립니다.');

      const result = await evaluateCodexConversation({
        message: '잘 들려?',
        repoRoot: testRepoDir,
        codexRunner: async () => ({ stdout: mixed, stderr: '', exitCode: 0 }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.message?.intentType, 'chat');
    });

    void test('the project default model is used when nothing overrides it', async () => {
      let seenArgs: string[] = [];
      await evaluateCodexConversation({
        message: '아아 들려?',
        repoRoot: testRepoDir,
        env: {},
        codexRunner: async params => {
          seenArgs = params.args;
          return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
        },
      });
      assert.equal(seenArgs[seenArgs.indexOf('--model') + 1], CODEX_DEFAULT_MODEL);
    });

    void test('an explicit CLI-default selection omits --model without changing the saved fallback', async () => {
      let seenArgs: string[] = [];
      await evaluateCodexConversation({
        message: 'CLI 기본 모델을 사용해줘',
        repoRoot: testRepoDir,
        codexModel: null,
        codexRunner: async params => {
          seenArgs = params.args;
          return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
        },
      });
      assert.equal(seenArgs.includes('--model'), false);
    });

    void test('exec args omit --model unless one is chosen', () => {
      const inherited = buildCodexExecArgs({ prompt: 'hi', cwd: testRepoDir });
      assert.equal(inherited.includes('--model'), false);

      const pinned = buildCodexExecArgs({ prompt: 'hi', cwd: testRepoDir, model: 'gpt-6-astra' });
      assert.equal(pinned[pinned.indexOf('--model') + 1], 'gpt-6-astra');
      assert.equal(pinned.at(-1), '-');
    });

    void test('an explicit model beats the environment so a workflow stage can switch it', async () => {
      let seenArgs: string[] = [];
      const capture = async (params: { args: string[] }) => {
        seenArgs = params.args;
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      };

      await evaluateCodexConversation({
        message: '아아 들려?',
        repoRoot: testRepoDir,
        env: { CODEX_MODEL: 'from-env' },
        codexModel: 'from-call',
        codexRunner: capture,
      });
      assert.equal(seenArgs[seenArgs.indexOf('--model') + 1], 'from-call');

      await evaluateCodexConversation({
        message: '아아 들려?',
        repoRoot: testRepoDir,
        env: { CODEX_MODEL: 'from-env' },
        codexRunner: capture,
      });
      assert.equal(seenArgs[seenArgs.indexOf('--model') + 1], 'from-env');
    });

    void test('a malformed model id is rejected instead of reaching argv', async () => {
      let seenArgs: string[] = [];
      await evaluateCodexConversation({
        message: '아아 들려?',
        repoRoot: testRepoDir,
        env: {},
        codexModel: 'bad model --sandbox danger-full-access',
        codexRunner: async params => {
          seenArgs = params.args;
          return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
        },
      });
      // The bad id is dropped and the vetted project default takes its place.
      assert.equal(seenArgs[seenArgs.indexOf('--model') + 1], CODEX_DEFAULT_MODEL);
      assert.equal(seenArgs.includes('danger-full-access'), false);
      assert.equal(seenArgs.some(arg => arg.includes('bad model')), false);
    });

    void test('exec args allow non-git workspaces', () => {
      const args = buildCodexExecArgs({
        prompt: 'hello\nworld',
        cwd: testRepoDir,
      });
      assert.equal(args.includes('--skip-git-repo-check'), true);
      assert.equal(args.includes('--ephemeral'), true);
      assert.equal(args.at(-1), '-');
      assert.equal(args.includes('hello\nworld'), false);
    });

    void test('sanitizeSpawnEnv drops undefined values and Electron flags', () => {
      const env = sanitizeSpawnEnv({
        PATH: 'C:\\bin',
        EMPTY: undefined,
        ELECTRON_RUN_AS_NODE: '1',
      });
      assert.equal(env.PATH, 'C:\\bin');
      assert.equal('EMPTY' in env, false);
      assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
    });

    void test('defaultCodexRunner sends the prompt on stdin without spawn EINVAL', async () => {
      const result = await defaultCodexRunner({
        executable: process.execPath,
        args: [
          '-e',
          'let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", d => s += d); process.stdin.on("end", () => { process.stdout.write(s); });',
        ],
        cwd: testRepoDir,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UNSET: undefined },
        timeoutMs: 8000,
        stdinText: '{"intent":"chat","reply":"ok"}',
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /"intent":"chat"/);
    });

    void test('executionPrompt is sent to Codex while the visible user message stays short', async () => {
      let capturedStdin = '';
      const result = await evaluateCodexConversation({
        message: '선택 코드 수정 계획: src/sum.ts',
        executionPrompt:
          '아래 선택 코드의 수정 계획을 세우세요.\n승인 전에는 파일을 변경하지 마세요.\n```\nreturn a - b;\n```',
        repoRoot: testRepoDir,
        codexRunner: async params => {
          capturedStdin = params.stdinText || '';
          return {
            stdout: JSON.stringify({
              intent: 'action_plan',
              reply: '빼기 연산을 고치겠습니다.',
              plan: {
                title: '합산 수정',
                explanation: 'return을 더하기로 바꿉니다.',
                steps: ['수정', '테스트'],
                affectedFiles: ['src/sum.ts'],
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        },
      });

      assert.equal(result.ok, true);
      const user = result.session?.messages.find(message => message.sender === 'user');
      assert.equal(user?.text, '선택 코드 수정 계획: src/sum.ts');
      assert.match(capturedStdin, /return a - b/);
      assert.doesNotMatch(user?.text || '', /return a - b/);
      assert.match(result.approval?.prompt || '', /return a - b/);
    });

    void test('forbidWorkers는 action_plan 분류를 chat으로 내리고 승인과 워커를 만들지 않는다', async () => {
      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '이 함수는 입력 배열을 합산합니다.',
          plan: {
            title: '합산 함수 수정',
            explanation: '선택 코드를 변경합니다.',
            steps: ['파일 수정'],
            affectedFiles: ['src/sum.ts'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '이 코드를 설명해주세요. 파일을 수정하지 마세요.',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
        forbidWorkers: true,
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.message?.intentType, 'chat');
      assert.strictEqual(result.approval, undefined);
      assert.strictEqual(result.session?.pendingApproval, undefined);
      const runs = await listCompactRuns(testRepoDir);
      assert.strictEqual(runs.length, 0);
    });
  });

  void describe('2. 상태 질문 처리 (Status Inquiry)', () => {
    void test('상태 질문은 저장된 상태만 조회하여 답하고 새 Run이나 워커를 만들지 않는다', async () => {
      // Seed an existing run in the store
      await saveCompactRunState(
        {
          runId: 'existing-run-001',
          prompt: '기존 완료된 작업',
          status: 'completed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 0,
          completedTasksCount: 1,
        },
        testRepoDir
      );

      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'status',
          reply: '현재 프로젝트 및 워커 상태를 조회했습니다.',
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '현재 프로젝트 상태 어때?',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.message?.intentType, 'status');
      assert.ok(result.message?.text.includes('프로젝트 상태 안내'));
      assert.ok(result.message?.text.includes('existing-run-001'));
      assert.strictEqual(result.message?.statusSummary?.totalRuns, 1);
      assert.strictEqual(result.approval, undefined);

      // Verify no worker spawned (Criterion 2 & 10)
      const runs = await listCompactRuns(testRepoDir);
      assert.strictEqual(runs.length, 1); // Only the pre-existing run
    });
  });

  void describe('3. 코드 구현·수정 요청 및 승인 전 워커 0개 검증', () => {
    void test('코드 수정 요청(버튼 오류를 수정해)은 실행 계획과 승인 카드를 반환하며 승인 전 워커는 0개다', async () => {
      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '버튼 오류를 수정하기 위한 안전한 실행 계획을 수립했습니다.',
          plan: {
            title: '버튼 컴포넌트 이벤트 오류 수정',
            explanation: '클릭 이벤트 핸들러의 예외 처리와 키보드 접근성을 개선합니다.',
            steps: [
              '버튼 컴포넌트 코드 확인',
              '클릭 이벤트 및 disabled 상태 처리 수정',
              '단위 테스트 및 린트 검증',
            ],
            affectedFiles: ['components/ui/button.tsx'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '버튼 오류를 수정해',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.session);
      assert.strictEqual(result.message?.intentType, 'action_plan');
      assert.ok(result.approval);
      assert.strictEqual(result.approval.status, 'pending');
      assert.strictEqual(result.approval.plan.title, '버튼 컴포넌트 이벤트 오류 수정');
      assert.strictEqual(result.approval.plan.steps.length, 3);
      assert.deepStrictEqual(result.approval.plan.affectedFiles, ['components/ui/button.tsx']);
      assert.strictEqual(result.session.pendingApproval?.approvalId, result.approval.approvalId);

      // Verify ZERO workers spawned before approval (Criterion 3 & 10)
      const runs = await listCompactRuns(testRepoDir);
      assert.strictEqual(runs.length, 0);
    });
  });

  void describe('4. 승인 후 정확히 1개 워커 생성 및 중복 승인 멱등성', () => {
    void test('승인 버튼 클릭 시 정확히 1회만 spawn하고, 중복 승인 재전송에도 spawn 1회만 유지된다', async () => {
      const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
      const mockSpawner = (command: string, args: string[], options: SpawnOptions) => {
        spawnCalls.push({ command, args, options });
        return { pid: 5678, unref: () => {} };
      };

      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '실행 계획입니다.',
          plan: {
            title: '작업 계획',
            explanation: '작업 설명',
            steps: ['1단계', '2단계'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      // 1. Initial request to get pending approval card
      const evalResult = await evaluateCodexConversation({
        message: '대시보드 기능 추가해줘',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
      });

      assert.strictEqual(evalResult.ok, true);
      const sessionId = evalResult.session!.sessionId;
      const approvalId = evalResult.approval!.approvalId;
      assert.strictEqual(spawnCalls.length, 0); // Still 0

      // 2. User approves the plan (First execution)
      const approveResult1 = await approveConversationPlan({
        sessionId,
        approvalId,
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        toolOverrides: { pwsh: 'pwsh.exe' },
      });

      assert.strictEqual(approveResult1.ok, true);
      assert.strictEqual(approveResult1.isDuplicate, false);
      assert.ok(approveResult1.runId);
      assert.strictEqual(approveResult1.approval?.status, 'approved');
      assert.strictEqual(spawnCalls.length, 1); // Exactly 1 worker spawned!

      // 3. User double clicks / network retry with same approvalId
      const approveResult2 = await approveConversationPlan({
        sessionId,
        approvalId,
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        toolOverrides: { pwsh: 'pwsh.exe' },
      });

      assert.strictEqual(approveResult2.ok, true);
      assert.strictEqual(approveResult2.isDuplicate, true);
      assert.strictEqual(approveResult2.runId, approveResult1.runId); // Identical run ID
      assert.strictEqual(spawnCalls.length, 1); // STILL exactly 1 call! No duplicate spawn!
    });
  });

  void describe('5. 새로고침 및 재로드 후 대화 및 승인 세션 복구', () => {
    void test('세션 파일에 원자적으로 저장되어 새로고침 후 대화, 승인 카드, 승인 결과와 Run 연결이 복구된다', async () => {
      const mockSpawner = () => ({ pid: 5678, unref: () => {} });

      const mockCodexRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '수정 계획을 승인해주세요.',
          plan: {
            title: '복구 테스트 계획',
            explanation: '세션 복구 검증',
            steps: ['단계 1'],
          },
        }),
        stderr: '',
        exitCode: 0,
      });

      const evalResult = await evaluateCodexConversation({
        message: '새로고침 복구 테스트',
        repoRoot: testRepoDir,
        codexRunner: mockCodexRunner,
      });

      const sessionId = evalResult.session!.sessionId;
      const approvalId = evalResult.approval!.approvalId;

      await approveConversationPlan({
        sessionId,
        approvalId,
        repoRoot: testRepoDir,
        spawner: mockSpawner,
        toolOverrides: { pwsh: 'pwsh.exe' },
      });

      // Simulate server restart or fresh page load: read directly from disk
      const recoveredSession = await getConversationSession(sessionId, testRepoDir);
      assert.ok(recoveredSession);
      assert.strictEqual(recoveredSession.sessionId, sessionId);
      assert.strictEqual(recoveredSession.lastApproval?.status, 'approved');
      assert.ok(recoveredSession.lastApproval?.runId);
      assert.ok(recoveredSession.linkedRunIds.includes(recoveredSession.lastApproval.runId));
      assert.ok(recoveredSession.messages.length >= 3);
    });
  });

  void describe('6. Codex CLI 불가 / 오류 / 타임아웃 처리', () => {
    void test('Codex 실행 불가 시 워커를 전혀 생성하지 않고 정제된 오류를 반환한다', async () => {
      // Injected runner simulates process failure
      const failingRunner = async () => ({
        stdout: '',
        stderr: 'Error: Cannot find module codex',
        exitCode: 1,
      });

      const result = await evaluateCodexConversation({
        message: '코드 수정 요청',
        repoRoot: testRepoDir,
        codexRunner: failingRunner,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error);
      const runs = await listCompactRuns(testRepoDir);
      assert.strictEqual(runs.length, 0); // ZERO workers spawned!
    });

    void test('Codex 실행 시간이 초과되면 프로세스를 정리하고 정제된 오류를 반환한다', async () => {
      const timeoutRunner = async () => {
        throw new Error('Codex CLI 실행 시간이 초과되었습니다.');
      };

      const result = await evaluateCodexConversation({
        message: '느린 요청',
        repoRoot: testRepoDir,
        codexRunner: timeoutRunner,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes('초과'));
    });

    void test('Codex가 잘못된 응답(JSON 파싱 불가)을 반환하면 워커를 만들지 않고 오류를 반환한다', async () => {
      const invalidRunner = async () => ({
        stdout: 'This is not valid json at all',
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '잘못된 응답 테스트',
        repoRoot: testRepoDir,
        codexRunner: invalidRunner,
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes('JSON'));
    });
  });

  void describe('7. 비밀정보 및 저장소 절대경로 마스킹 (Sanitization)', () => {
    void test('응답 및 에러에 포함된 API 키, 토큰, 절대경로를 정제한다', async () => {
      const secretKey = 'AIzaSy' + 'A'.repeat(33);
      const secretToken = 'sk-' + 'B'.repeat(25);
      const userDir = path.join(os.homedir(), 'secrets.txt');

      const leakingRunner = async () => ({
        stdout: JSON.stringify({
          intent: 'chat',
          reply: `인증 키: ${secretKey}, 토큰: ${secretToken}, 파일: ${userDir}`,
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await evaluateCodexConversation({
        message: '비밀정보 정제 확인',
        repoRoot: testRepoDir,
        codexRunner: leakingRunner,
      });

      assert.strictEqual(result.ok, true);
      const reply = result.message?.text || '';
      assert.ok(!reply.includes(secretKey));
      assert.ok(reply.includes('[API_KEY_REDACTED]'));
      assert.ok(!reply.includes(secretToken));
      assert.ok(reply.includes('[TOKEN_REDACTED]'));
      assert.ok(!reply.includes(os.homedir()));
    });
  });

  void describe('8. 실제 이벤트 부재 시 고정 실행 타임라인 없음 (Criterion 8 & 10)', () => {
    void test('대화 상태 또는 근거 없는 대기 상태에서는 도구 및 코드 수정 실행이 생성되지 않는다', () => {
      const events = extractTimelineEvents({
        runId: 'pending-run-no-events',
        status: 'pending',
      });

      assert.strictEqual(events.length, 0);
      assert.ok(!events.some(e => e.title.includes('도구 및 코드 수정 실행')));
      assert.ok(!events.some(e => e.title.includes('계획 수립')));
    });

    void test('실제 변경 파일 근거가 있을 때만 실행 이벤트가 생성된다', () => {
      const events = extractTimelineEvents({
        runId: 'evidenced-run',
        status: 'running',
        changedFiles: ['components/ui/button.tsx'],
      });

      assert.ok(events.length >= 2);
      assert.ok(events.some(e => e.title.includes('도구 및 코드 수정 실행')));
    });
  });

  void describe('9. 안전한 인자 배열 및 저장소 디렉터리 격리', () => {
    void test('Codex 실행 인자는 셸 문자열 결합 없이 배열로 전달되며 cwd는 저장소 루트로 제한된다', async () => {
      let capturedArgs: string[] = [];
      let capturedCwd = '';

      const inspectingRunner = async (params: { args: string[]; cwd: string }) => {
        capturedArgs = params.args;
        capturedCwd = params.cwd;
        return {
          stdout: JSON.stringify({ intent: 'chat', reply: '확인 완료' }),
          stderr: '',
          exitCode: 0,
        };
      };

      await evaluateCodexConversation({
        message: '인자 배열 검증',
        repoRoot: testRepoDir,
        codexRunner: inspectingRunner,
      });

      assert.strictEqual(capturedCwd, testRepoDir);
      assert.ok(Array.isArray(capturedArgs));
      assert.ok(capturedArgs.includes('exec'));
      assert.ok(capturedArgs.includes('--sandbox'));
      assert.ok(capturedArgs.includes('read-only'));
      assert.ok(capturedArgs.includes('--cd'));
      assert.ok(capturedArgs.includes(testRepoDir));
      assert.equal(capturedArgs.at(-1), '-');
    });

    void test('외부 경로 또는 경로 탈출 시도는 거부된다', async () => {
      const result = await evaluateCodexConversation({
        message: '경로 탈출 시도',
        repoRoot: path.join(testRepoDir, '..', 'foreign-repo'),
      });

      assert.strictEqual(result.ok, false);
      assert.ok(result.error?.includes('허용되지 않은'));
    });
  });
});

void test('affectedFiles keeps relative paths and drops descriptive labels', () => {
  assert.deepStrictEqual(
    normalizeAffectedFiles(['src/a.ts', './src\\b.test.ts', 'README.md', '경로 비교 구현 파일', 'the test file', 'C:/abs/c.ts', '']),
    ['src/a.ts', 'src/b.test.ts', 'README.md']
  );
});
