import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRunCompletion, cancelRun, chatWithCore, getActiveRunSummary, getReviewSummary, getRunStatusText, getWorkGraph, restoreWorkspaceBindings, sanitizeUiError, syncWorkerSettings, toWebviewMessages, toWorkerView, withWorkspaceRoot } from './core-host.ts';
import { listCompactRuns, saveCompactRunState, saveConversationSession } from '../../packages/orchestrator-core/workspace-store.ts';
import { CODEX_ABORTED_MESSAGE, defaultCodexRunner } from '../../packages/orchestrator-core/codex-conversation.ts';
import { createEmptyConversationSession } from '../../packages/orchestrator-core/workspace-contract.ts';

void describe('vscode core host', () => {
  let repo: string;
  let savedAllowed: string | undefined;

  beforeEach(() => {
    savedAllowed = process.env.ALLOWED_REPO_ROOT;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-core-host-'));
    process.env.ALLOWED_REPO_ROOT = repo;
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'codex-router.ps1'), '# fixture\n');
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.ALLOWED_REPO_ROOT;
    else process.env.ALLOWED_REPO_ROOT = savedAllowed;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void test('chat with forbidWorkers does not create a run', async () => {
    const result = await chatWithCore({
      message: '이 코드를 설명해주세요. 파일을 수정하지 마세요.\n```\nconst x = 1;\n```',
      repoRoot: repo,
      forbidWorkers: true,
      codexRunner: async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '상수 x는 1입니다.',
          plan: {
            title: '수정',
            explanation: '바꾸면 안 됩니다',
            steps: ['edit'],
            affectedFiles: ['a.ts'],
          },
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.session?.pendingApproval, undefined);
    assert.equal(result.session?.messages.at(-1)?.intentType, 'chat');
    const runs = await withWorkspaceRoot(repo, () => listCompactRuns(repo));
    assert.equal(runs.length, 0);
    const webview = toWebviewMessages(result.session!);
    assert.equal(webview.some(message => message.approval), false);
  });

  void test('restoreWorkspaceBindings on an empty folder is idle with no invented run', async () => {
    const restored = await restoreWorkspaceBindings(repo, { sessionId: 'missing', runId: 'missing' });
    assert.equal(restored.status, 'idle');
    assert.equal(restored.runId, undefined);
    assert.equal(restored.sessionId, undefined);
  });

  void test('sanitizeUiError redacts repository paths', () => {
    const message = sanitizeUiError(new Error(`failed ${repo}\\worker.json`), repo);
    assert.doesNotMatch(message, new RegExp(repo.replace(/[\\/]/g, '[\\\\/]')));
    assert.match(message, /failed/);
  });

  void test('run status on a folder without .agent does not throw', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-empty-ws-'));
    try {
      assert.equal(await getRunStatusText(empty), 'idle');
      assert.match(await getActiveRunSummary(empty), /없습니다/);
      assert.match(await getReviewSummary(empty), /없습니다/);
      assert.equal(await getWorkGraph(empty), null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  void test('plan chat keeps a pending approval and still creates no run', async () => {
    const result = await chatWithCore({
      message: '아래 선택 코드의 수정 계획을 세우세요. 승인 전에는 파일을 변경하지 마세요.',
      repoRoot: repo,
      codexRunner: async () => ({
        stdout: JSON.stringify({
          intent: 'action_plan',
          reply: '계획을 준비했습니다.',
          plan: {
            title: '버그 수정',
            explanation: '선택 범위를 고칩니다.',
            steps: ['분석', '수정', '테스트'],
            affectedFiles: ['src/sum.ts'],
          },
        }),
        stderr: '',
        exitCode: 0,
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.session?.pendingApproval?.status, 'pending');
    const runs = await withWorkspaceRoot(repo, () => listCompactRuns(repo));
    assert.equal(runs.length, 0);
  });
});

void describe('vscode core host settings', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-core-settings-'));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void test('withWorkspaceRoot scopes the install root to the workspace and restores it', async () => {
    const saved = process.env.CODEX_GEMINI_INSTALL_ROOT;
    process.env.CODEX_GEMINI_INSTALL_ROOT = 'elsewhere';
    try {
      const seen = await withWorkspaceRoot(repo, async () => process.env.CODEX_GEMINI_INSTALL_ROOT);
      assert.equal(seen, path.resolve(repo));
      assert.equal(process.env.CODEX_GEMINI_INSTALL_ROOT, 'elsewhere');
    } finally {
      if (saved === undefined) delete process.env.CODEX_GEMINI_INSTALL_ROOT;
      else process.env.CODEX_GEMINI_INSTALL_ROOT = saved;
    }
  });

  void test('syncWorkerSettings writes worker-settings.json next to the workspace router', async () => {
    const ok = await syncWorkerSettings(repo, { tier: 'reasoning', codexModel: ' gpt-x ' });
    assert.deepEqual(ok, { ok: true });
    const saved = JSON.parse(fs.readFileSync(path.join(repo, 'worker-settings.json'), 'utf8')) as {
      tier: string;
      model: string;
      codexModel: string;
    };
    assert.equal(saved.tier, 'reasoning');
    assert.equal(saved.model, 'gemini-3.1-pro-high');
    assert.equal(saved.codexModel, 'gpt-x');
    const bad = await syncWorkerSettings(repo, { tier: 'nope' });
    assert.equal(bad.ok, false);
    assert.match(bad.error || '', /모델 등급/);
  });

  void test('toWorkerView flattens sanitized logs into display lines', () => {
    const view = toWorkerView({
      runId: 'run-1',
      taskId: 'TASK-1',
      task: 'fix',
      model: 'gemini',
      status: 'running',
      startedAt: '',
      updatedAt: '',
      elapsedSeconds: 3,
      recentLogs: ['plain', { timestamp: '12:00:01', type: 'tool', message: 'read a.ts' }],
    });
    assert.deepEqual(view.logs, ['plain', '[12:00:01] [tool] read a.ts']);
    assert.equal(view.status, 'running');
  });

  void test('run status follows the tracked run, not the newest run on disk', async () => {
    await saveCompactRunState(
      {
        runId: 'old-failed',
        prompt: '이전 실패',
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        requiresUserAction: true,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 0,
      },
      repo
    );
    assert.equal(await getRunStatusText(repo), 'idle');
    assert.equal(await getRunStatusText(repo, true), 'awaiting approval');
    assert.equal(await getRunStatusText(repo, false, 'old-failed'), 'action required');
  });

  void test('cancelRun drops cancel.requested into the run directory', async () => {
    assert.equal(await cancelRun(repo, 'missing'), false);
    const runDir = path.join(repo, '.agent', 'runs', 'run-1');
    fs.mkdirSync(path.join(runDir, 'workers'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'workers', 't1.json'), JSON.stringify({ agentProcessId: 2147483000 }));
    assert.equal(await cancelRun(repo, 'run-1'), true);
    assert.ok(fs.existsSync(path.join(runDir, 'cancel.requested')));
  });

  void test('appendRunCompletion skips runs the session never linked', async () => {
    const session = createEmptyConversationSession('s-1');
    await saveConversationSession(session, repo);
    assert.equal(await appendRunCompletion(repo, 's-1', 'run-x'), null);
  });

  void test('aborting the codex runner rejects with the user-facing message', async () => {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      defaultCodexRunner({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},5000)'], cwd: repo, signal: abort.signal }),
      { message: CODEX_ABORTED_MESSAGE }
    );
  });
});
