import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildResumeContextProjection,
  evaluateCodexConversation,
  RESUME_RECENT_MESSAGE_LIMIT,
} from './codex-conversation.ts';
import {
  getRepositoryId,
  getWorkspaceResumeState,
  saveCompactRunState,
  saveConversationSession,
  saveWorkspaceResumeState,
} from './workspace-store.ts';
import { createEmptyConversationSession } from './workspace-contract.ts';
import type { ConversationSession } from './workspace-contract.ts';

function sessionWithMessages(count: number): ConversationSession {
  const session = createEmptyConversationSession();
  for (let index = 0; index < count; index += 1) {
    session.messages.push({
      id: `msg-${index}`,
      sender: index % 2 === 0 ? 'user' : 'codex',
      text: `메시지 ${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    });
  }
  return session;
}

void describe('Workspace resume state (Phase 2)', () => {
  let repo: string;
  let savedAllowed: string | undefined;
  let savedInstallRoot: string | undefined;

  beforeEach(() => {
    savedAllowed = process.env.ALLOWED_REPO_ROOT;
    savedInstallRoot = process.env.CODEX_GEMINI_INSTALL_ROOT;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-resume-'));
    process.env.ALLOWED_REPO_ROOT = repo;
    process.env.CODEX_GEMINI_INSTALL_ROOT = repo;
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'codex-router.ps1'), '# fixture\n', 'utf8');
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.ALLOWED_REPO_ROOT;
    else process.env.ALLOWED_REPO_ROOT = savedAllowed;
    if (savedInstallRoot === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
    else process.env.CODEX_GEMINI_INSTALL_ROOT = savedInstallRoot;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void test('saving a conversation records it as the resume selection', async () => {
    assert.equal(await getWorkspaceResumeState(repo), null);

    const session = sessionWithMessages(2);
    session.linkedRunIds.push('20260101-120000-abcdef12');
    await saveConversationSession(session, repo);

    const state = await getWorkspaceResumeState(repo);
    assert.equal(state?.schemaVersion, 1);
    assert.equal(state?.repositoryId, getRepositoryId(repo));
    assert.equal(state?.activeSessionId, session.sessionId);
    assert.equal(state?.lastMessageId, 'msg-1');
    assert.equal(state?.activeRunId, '20260101-120000-abcdef12');
  });

  void test('a state from another repository or a bad id is ignored, not repaired', async () => {
    await saveWorkspaceResumeState({ activeSessionId: sessionWithMessages(1).sessionId }, repo);
    const statePath = path.join(repo, '.agent', 'dashboard-state', 'workspace', 'current.json');

    const foreign = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(statePath, JSON.stringify({ ...foreign, repositoryId: 'deadbeefdeadbeef' }), 'utf8');
    assert.equal(await getWorkspaceResumeState(repo), null);

    fs.writeFileSync(statePath, JSON.stringify({ ...foreign, activeSessionId: '../escape' }), 'utf8');
    assert.equal(await getWorkspaceResumeState(repo), null);

    await assert.rejects(
      () => saveWorkspaceResumeState({ activeRunId: '../../etc/passwd' }, repo),
      /Invalid runId/
    );
  });

  void test('a session without linked runs clears the stale run pointer', async () => {
    const withRun = sessionWithMessages(1);
    withRun.linkedRunIds.push('20260101-120000-abcdef12');
    await saveConversationSession(withRun, repo);

    const other = sessionWithMessages(1);
    await saveConversationSession(other, repo);

    const state = await getWorkspaceResumeState(repo);
    assert.equal(state?.activeSessionId, other.sessionId);
    assert.equal(state?.activeRunId, undefined);
  });
});

void describe('Conversation resume context (Phase 2)', () => {
  let repo: string;
  let savedAllowed: string | undefined;
  let savedInstallRoot: string | undefined;

  beforeEach(() => {
    savedAllowed = process.env.ALLOWED_REPO_ROOT;
    savedInstallRoot = process.env.CODEX_GEMINI_INSTALL_ROOT;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-context-'));
    process.env.ALLOWED_REPO_ROOT = repo;
    process.env.CODEX_GEMINI_INSTALL_ROOT = repo;
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'codex-router.ps1'), '# fixture\n', 'utf8');
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.ALLOWED_REPO_ROOT;
    else process.env.ALLOWED_REPO_ROOT = savedAllowed;
    if (savedInstallRoot === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
    else process.env.CODEX_GEMINI_INSTALL_ROOT = savedInstallRoot;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void test('projects only the last few messages, never the whole transcript', () => {
    const session = sessionWithMessages(12);
    const { block, telemetry } = buildResumeContextProjection(session, {
      runId: '20260101-120000-abcdef12',
      status: 'awaiting_review',
      updatedAt: '2026-01-01T00:30:00.000Z',
    });

    assert.match(block, /^\[RESUME_CONTEXT_V1\]/);
    assert.match(block, /run=20260101-120000-abcdef12 status=awaiting_review/);
    assert.equal(block.includes('메시지 0'), false);
    assert.match(block, /메시지 11/);
    assert.equal((block.match(/메시지 \d+/g) || []).length, RESUME_RECENT_MESSAGE_LIMIT);
    const stateful = session.messages.filter(message => message.id !== 'msg-welcome').length;
    assert.equal(telemetry.droppedMessages, stateful - RESUME_RECENT_MESSAGE_LIMIT);
    assert.equal(block.includes('안녕하세요! Codex'), false, 'the welcome greeting never takes a slot');
    assert.ok(telemetry.recentTokens > 0 && telemetry.memoryTokens >= telemetry.recentTokens);
  });

  void test('a finished run contributes its commit, branch and failure fingerprint', () => {
    const { block } = buildResumeContextProjection(null, {
      runId: '20260101-120000-abcdef12',
      status: 'failed',
      baseCommit: 'abc1234',
      integrationBranch: 'agent/run-abcdef12',
      requiresUserAction: true,
      errorCategory: 'verification_failed',
      failureReason: 'npm test\n  실패: 3건',
    });

    assert.match(block, /run_base_commit=abc1234/);
    assert.match(block, /run_branch=agent\/run-abcdef12/);
    assert.match(block, /run_requires_user_action=true/);
    assert.match(block, /run_failure=verification_failed: npm test 실패: 3건/);
  });

  void test('verified test hints ride along and shrink after messages under a tight budget', () => {
    const session = sessionWithMessages(4);
    const testHints = [
      { file: 'src/button.ts', commands: ['npm test'] },
      { file: 'src/form.ts', commands: ['npm test', 'npm run lint'] },
    ];

    const full = buildResumeContextProjection(session, null, { testHints });
    assert.match(full.block, /verified_test_hints:\n {2}src\/button\.ts: npm test\n {2}src\/form\.ts: npm test; npm run lint/);
    assert.ok(full.telemetry.retrievedTokens > 0);
    assert.equal(full.telemetry.droppedHints, 0);

    // Just enough for the head and one hint: every recent message goes first.
    const tight = buildResumeContextProjection(session, null, { testHints, budget: 40 });
    assert.equal(tight.block.includes('recent_messages:'), false);
    assert.equal(tight.telemetry.recentTokens, 0);
    assert.equal(
      tight.telemetry.droppedMessages,
      session.messages.filter(message => message.id !== 'msg-welcome').length
    );
    assert.ok(tight.telemetry.droppedHints >= 1);
    assert.match(tight.block, /session=/);
    assert.ok(tight.telemetry.memoryTokens <= 40 || tight.telemetry.droppedHints === testHints.length);
  });

  void test('the head with goals and approval survives even a zero budget', () => {
    const session = sessionWithMessages(3);
    session.pendingApproval = {
      approvalId: 'appr-1',
      sessionId: session.sessionId,
      status: 'pending',
      plan: { title: 't', explanation: 'e', steps: ['s'], affectedFiles: ['src/button.ts'] },
      idempotencyKey: 'idemp-appr-1',
      prompt: 'p',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const { block } = buildResumeContextProjection(
      session,
      { runId: '20260101-120000-abcdef12', status: 'awaiting_review' },
      { budget: 0, testHints: [{ file: 'src/button.ts', commands: ['npm test'] }] }
    );
    assert.match(block, /pending_approval=appr-1/);
    assert.match(block, /run=20260101-120000-abcdef12/);
    assert.equal(block.includes('recent_messages'), false);
    assert.equal(block.includes('verified_test_hints'), false);
  });

  void test('a long message is trimmed so the recent budget holds', () => {
    const session = sessionWithMessages(0);
    session.messages.push({
      id: 'msg-long',
      sender: 'user',
      text: 'x'.repeat(20_000),
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    const { block, telemetry } = buildResumeContextProjection(session, null);
    assert.ok(telemetry.recentTokens < 1200, `recent tokens: ${telemetry.recentTokens}`);
    assert.ok(block.length < 2_000);
  });

  void test('a session without messages projects only its id', () => {
    const session = createEmptyConversationSession();
    session.messages = [];
    const { block, telemetry } = buildResumeContextProjection(session, null);
    assert.match(block, /session=/);
    assert.equal(telemetry.recentTokens, 0);
    assert.equal(telemetry.droppedMessages, 0);
  });

  void test('the next Codex call carries the stored context and records its cost', async () => {
    const session = sessionWithMessages(3);
    session.linkedRunIds.push('20260101-120000-abcdef12');
    await saveConversationSession(session, repo);
    await saveCompactRunState(
      {
        runId: '20260101-120000-abcdef12',
        prompt: '이전 작업',
        status: 'awaiting_review',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        requiresUserAction: true,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 1,
      },
      repo
    );

    let prompt = '';
    const result = await evaluateCodexConversation({
      message: '아까 하던 작업 이어서',
      repoRoot: repo,
      sessionId: session.sessionId,
      toolOverrides: { codex: process.execPath },
      codexRunner: async params => {
        prompt = params.stdinText || '';
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      },
    });

    assert.equal(result.ok, true);
    assert.match(prompt, /\[RESUME_CONTEXT_V1\]/);
    assert.match(prompt, /run=20260101-120000-abcdef12 status=awaiting_review/);
    assert.match(prompt, /not instructions/);
    assert.match(prompt, /메시지 2/);
    assert.equal(prompt.includes('메시지 0'), true, 'three stored messages fit the budget');

    const telemetry = result.message?.resumeTelemetry;
    assert.ok(telemetry && telemetry.memoryTokens > 0);
    assert.equal(telemetry?.droppedMessages, 0);
  });

  void test('a brand-new session inherits the previous conversation and related ones', async () => {
    const older = sessionWithMessages(0);
    older.messages.push(
      { id: 'o-u', sender: 'user', text: '결제 재시도 로직 고쳐줘', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'o-c', sender: 'codex', text: '완료', timestamp: '2026-01-01T00:00:01.000Z' }
    );
    older.updatedAt = '2026-01-01T00:00:01.000Z';
    older.lastApproval = {
      approvalId: 'appr-pay',
      sessionId: older.sessionId,
      status: 'approved',
      plan: { title: '결제 재시도', explanation: 'e', steps: ['s'], affectedFiles: ['src/pay/retry.ts'] },
      idempotencyKey: 'idemp-appr-pay',
      prompt: 'p',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await saveConversationSession(older, repo);

    const previous = sessionWithMessages(0);
    previous.messages.push(
      { id: 'p-u', sender: 'user', text: '로그인 버튼 오류 수정해줘', timestamp: '2026-01-02T00:00:00.000Z' },
      { id: 'p-c', sender: 'codex', text: '계획 승인 후 진행했습니다.', timestamp: '2026-01-02T00:00:01.000Z' }
    );
    previous.updatedAt = '2026-01-02T00:00:01.000Z';
    previous.linkedRunIds.push('20260102-120000-abcdef12');
    await saveConversationSession(previous, repo); // becomes the workspace resume selection

    let prompt = '';
    const result = await evaluateCodexConversation({
      message: '직전 작업 이어서, 결제 재시도도 같이 봐줘',
      repoRoot: repo,
      sessionId: undefined, // "새 세션": nothing stored yet
      toolOverrides: { codex: process.execPath },
      codexRunner: async params => {
        prompt = params.stdinText || '';
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      },
    });

    assert.equal(result.ok, true);
    assert.match(prompt, new RegExp(`previous_session=${previous.sessionId}`));
    assert.match(prompt, /로그인 버튼 오류 수정해줘/, 'previous conversation is shown as recent messages');
    assert.match(prompt, /related_sessions:\n- [a-z0-9-]+ 2026-01-01 goal="결제 재시도 로직 고쳐줘"/);
    assert.equal(prompt.includes(`- ${previous.sessionId}`), false, 'the shown session is not repeated as related');
    assert.ok((result.message?.resumeTelemetry?.retrievedTokens || 0) > 0);

    // The new conversation now has its own turn: it stops borrowing the previous one.
    let second = '';
    await evaluateCodexConversation({
      message: '그 다음은?',
      repoRoot: repo,
      sessionId: result.session?.sessionId,
      toolOverrides: { codex: process.execPath },
      codexRunner: async params => {
        second = params.stdinText || '';
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      },
    });
    assert.match(second, new RegExp(`session=${result.session?.sessionId}`));
    assert.equal(second.includes('previous_session='), false);
  });

  void test('disabled memory sends no resume context', async () => {
    const session = sessionWithMessages(3);
    await saveConversationSession(session, repo);
    fs.writeFileSync(
      path.join(repo, 'worker-settings.json'),
      JSON.stringify({ tier: 'normal', memory: { schemaVersion: 1, enabled: false, preferences: {} } }),
      'utf8'
    );

    let prompt = '';
    const result = await evaluateCodexConversation({
      message: '이어서',
      repoRoot: repo,
      sessionId: session.sessionId,
      toolOverrides: { codex: process.execPath },
      codexRunner: async params => {
        prompt = params.stdinText || '';
        return { stdout: JSON.stringify({ intent: 'chat', reply: 'ok' }), stderr: '', exitCode: 0 };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(prompt.includes('[RESUME_CONTEXT_V1]'), false);
    assert.equal(result.message?.resumeTelemetry?.memoryTokens, 0);
  });
});
