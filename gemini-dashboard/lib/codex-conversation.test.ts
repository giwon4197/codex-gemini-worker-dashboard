import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpawnOptions } from 'node:child_process';
// @ts-expect-error TS5097 allowed for test runner
import { evaluateCodexConversation } from './codex-conversation.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getConversationSession, approveConversationPlan, saveCompactRunState, listCompactRuns } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { extractTimelineEvents } from './workspace-contract.ts';

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
