import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRunCompletion, cancelRun, chatWithCore, forgetRepositoryMemory, getActiveRunSummary, getReviewSummary, getRunStatusText, getWorkGraph, mutateWorkspaceMemory, readRepositoryMemoryView, readWorkspaceMemory, rebuildRepositoryMemoryView, restoreWorkspaceBindings, sanitizeUiError, syncWorkerSettings, toWebviewMessages, toWorkerView, withWorkspaceRoot } from './core-host.ts';
import { listCompactRuns, saveCompactRunState, saveConversationSession } from '../../packages/orchestrator-core/workspace-store.ts';
import { CODEX_ABORTED_MESSAGE, defaultCodexRunner } from '../../packages/orchestrator-core/codex-conversation.ts';
import { createEmptyConversationSession } from '../../packages/orchestrator-core/workspace-contract.ts';
import { readRepositoryMemory } from '../../packages/orchestrator-core/repository-memory.ts';
import { isBranchMerged } from './workspace-context.ts';

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

  void test('a reopened window resumes the stored selection and its linked run', async () => {
    const session = createEmptyConversationSession();
    session.linkedRunIds.push('20260101-120000-abcdef12');
    await saveConversationSession(session, repo);
    for (const [runId, status] of [
      ['20260101-120000-abcdef12', 'awaiting_review'],
      ['20260101-130000-beefcafe', 'running'],
    ] as const) {
      await saveCompactRunState(
        {
          runId,
          prompt: '작업',
          status,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:10:00.000Z',
          requiresUserAction: status === 'awaiting_review',
          tasksCount: 1,
          activeWorkersCount: 0,
          completedTasksCount: 0,
        },
        repo
      );
    }

    // A window with nothing in workspaceState: resume state is the only source.
    const restored = await restoreWorkspaceBindings(repo, {});
    assert.equal(restored.sessionId, session.sessionId);
    assert.equal(restored.runId, '20260101-120000-abcdef12');
    // The newer run belongs to no resumed conversation, so it is never adopted.
    assert.notEqual(restored.runId, '20260101-130000-beefcafe');
    assert.equal(restored.status, 'action required');
  });

  void test('resume state written for another repository is ignored', async () => {
    const session = createEmptyConversationSession();
    await saveConversationSession(session, repo);
    const statePath = path.join(repo, '.agent', 'dashboard-state', 'workspace', 'current.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(statePath, JSON.stringify({ ...state, repositoryId: 'deadbeefdeadbeef' }), 'utf8');

    const restored = await restoreWorkspaceBindings(repo, {});
    assert.equal(restored.sessionId, undefined);
    assert.equal(restored.runId, undefined);
  });

  void test('repository memory rows carry provenance and can be rebuilt or forgotten', async () => {
    const runId = '20260101-120000-abcdef12';
    fs.writeFileSync(path.join(repo, 'button.ts'), 'export const a = 1;\n', 'utf8');
    await saveCompactRunState(
      {
        runId,
        prompt: '버튼 오류 수정',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 1,
      },
      repo
    );
    const workerDir = path.join(repo, '.agent', 'runs', runId, 'workers');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, 'TASK-1.json'),
      JSON.stringify({
        runId,
        taskId: 'TASK-1',
        task: '수정',
        model: 'gemini',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z',
        elapsedSeconds: 300,
        recentLogs: [],
        changedFiles: ['button.ts'],
        verification: { commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }] },
      }),
      'utf8'
    );

    assert.deepEqual((await readRepositoryMemoryView(repo)).rows, []);

    const rebuilt = await rebuildRepositoryMemoryView(repo);
    assert.equal(rebuilt.rows.length, 2, 'one task history row and one test mapping row');
    assert.ok(rebuilt.rows.every(row => row.provenance.includes(runId)));
    assert.equal(rebuilt.staleRecords, 0);

    fs.writeFileSync(path.join(repo, 'button.ts'), 'export const a = 2;\n', 'utf8');
    assert.equal((await readRepositoryMemoryView(repo)).staleRecords, 2);

    await forgetRepositoryMemory(repo);
    assert.deepEqual((await readRepositoryMemoryView(repo)).rows, []);
  });

  void test('isBranchMerged asks git only with a safe branch name and a real base', async () => {
    const calls: string[][] = [];
    const runner = (answers: Record<string, number>) => async (args: string[]) => {
      calls.push(args);
      return { stdout: '', exitCode: answers[args.join(' ')] ?? 1 };
    };

    assert.equal(
      await isBranchMerged(repo, 'agent/run-1', runner({
        'rev-parse --verify --quiet refs/heads/main': 0,
        'merge-base --is-ancestor agent/run-1 main': 0,
      })),
      true
    );
    assert.equal(
      await isBranchMerged(repo, 'agent/run-1', runner({
        'rev-parse --verify --quiet refs/heads/master': 0,
        'merge-base --is-ancestor agent/run-1 master': 1,
      })),
      false
    );
    // Neither default branch exists: unknown is reported as not merged.
    assert.equal(await isBranchMerged(repo, 'agent/run-1', runner({})), false);

    calls.length = 0;
    assert.equal(await isBranchMerged(repo, '--upload-pack=x', runner({})), false);
    assert.deepEqual(calls, [], 'an option-looking name never reaches git');
  });

  void test('a finished run is folded into the repository memory right away', async () => {
    const runId = '20260101-120000-abcdef12';
    const session = createEmptyConversationSession();
    session.linkedRunIds.push(runId);
    await saveConversationSession(session, repo);
    fs.writeFileSync(path.join(repo, 'button.ts'), 'export const a = 1;', 'utf8');
    await saveCompactRunState(
      {
        runId,
        prompt: '버튼 오류 수정',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 1,
      },
      repo
    );
    const workerDir = path.join(repo, '.agent', 'runs', runId, 'workers');
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workerDir, 'TASK-1.json'),
      JSON.stringify({
        runId,
        taskId: 'TASK-1',
        task: '수정',
        model: 'gemini',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z',
        elapsedSeconds: 300,
        recentLogs: [],
        changedFiles: ['button.ts'],
      }),
      'utf8'
    );

    const updated = await appendRunCompletion(repo, session.sessionId, runId);
    assert.ok(updated?.messages.some(message => message.id === `run-summary-${runId}`));
    const memory = await withWorkspaceRoot(repo, () => readRepositoryMemory({ repoRoot: repo }));
    assert.equal(memory.taskHistory.length, 1);
    assert.equal(memory.taskHistory[0].value.runId, runId);
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

  void test('workspace memory mutations stay explicit and keep worker settings', async () => {
    await syncWorkerSettings(repo, { tier: 'reasoning' });
    assert.deepEqual(await readWorkspaceMemory(repo), {
      schemaVersion: 1,
      enabled: true,
      preferences: {},
    });

    const saved = await mutateWorkspaceMemory(repo, {
      operation: 'setPreference',
      key: 'responseLanguage',
      value: 'ko',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.memory?.preferences.responseLanguage?.value, 'ko');
    assert.equal(saved.memory?.preferences.responseLanguage?.provenance, 'explicit_user');
    assert.equal(
      (JSON.parse(fs.readFileSync(path.join(repo, 'worker-settings.json'), 'utf8')) as { tier: string }).tier,
      'reasoning'
    );

    const rejected = await mutateWorkspaceMemory(repo, {
      operation: 'setPreference',
      key: 'responseLanguage',
      value: 'C:/Users/test/secret.txt',
    });
    assert.equal(rejected.ok, false);
    assert.doesNotMatch(rejected.error || '', /secret\.txt/);
    assert.equal((await readWorkspaceMemory(repo)).preferences.responseLanguage?.value, 'ko');

    const removed = await mutateWorkspaceMemory(repo, {
      operation: 'deletePreference',
      key: 'responseLanguage',
    });
    assert.equal(removed.memory?.preferences.responseLanguage, undefined);
    assert.equal(removed.memory?.enabled, true);
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
