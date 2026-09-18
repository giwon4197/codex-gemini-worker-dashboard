import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  clearRepositoryMemory,
  getMemoryDir,
  readRepositoryMemory,
  rebuildRepositoryMemory,
} from './repository-memory.ts';
import { saveCompactRunState } from './workspace-store.ts';
import type { CompactRunState, LiveWorkerData } from './workspace-contract.ts';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

function writeWorker(repo: string, runId: string, worker: Partial<LiveWorkerData>): void {
  const directory = path.join(repo, '.agent', 'runs', runId, 'workers');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${worker.taskId || 'TASK-1'}.json`),
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
      ...worker,
    }),
    'utf8'
  );
}

function runFixture(overrides: Partial<CompactRunState> & { runId: string }): CompactRunState {
  return {
    prompt: '버튼 오류 수정',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    requiresUserAction: false,
    tasksCount: 1,
    activeWorkersCount: 0,
    completedTasksCount: 1,
    baseCommit: 'abc1234',
    ...overrides,
  };
}

void describe('Repository memory (Phase 3)', () => {
  let repo: string;
  let savedAllowed: string | undefined;

  beforeEach(() => {
    savedAllowed = process.env.ALLOWED_REPO_ROOT;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-memory-'));
    process.env.ALLOWED_REPO_ROOT = repo;
    fs.mkdirSync(path.join(repo, '.agent', 'dashboard-state', 'compact'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.agent', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'button.ts'), 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'codex-router.ps1'), '# fixture\n', 'utf8');
  });

  afterEach(() => {
    if (savedAllowed === undefined) delete process.env.ALLOWED_REPO_ROOT;
    else process.env.ALLOWED_REPO_ROOT = savedAllowed;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  void test('a verified run becomes task history and a test mapping', async () => {
    await saveCompactRunState(runFixture({ runId: '20260101-120000-abcdef12' }), repo);
    writeWorker(repo, '20260101-120000-abcdef12', {
      changedFiles: ['src/button.ts'],
      verification: {
        decision: 'PASS',
        commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }],
        verifiedAt: '2026-01-01T00:09:00.000Z',
      },
    });

    const snapshot = await rebuildRepositoryMemory({ repoRoot: repo, headCommit: 'abc1234' });
    assert.equal(snapshot.taskHistory.length, 1);
    const record = snapshot.taskHistory[0];
    assert.equal(record.confidence, 'verified');
    assert.equal(record.source.type, 'verifier');
    assert.equal(record.source.baseCommit, 'abc1234');
    assert.deepEqual(record.value.changedFiles, ['src/button.ts']);
    assert.ok(record.fileHashes['src/button.ts']);

    assert.equal(snapshot.testMap.length, 1);
    assert.deepEqual(snapshot.testMap[0].value.commands, ['npm test']);
  });

  void test('a run without passing verification is evidence, but not verified', async () => {
    await saveCompactRunState(
      runFixture({
        runId: '20260101-130000-beefcafe',
        status: 'failed',
        errorCategory: 'verification_failed',
        failureReason: 'npm test 실패',
        requiresUserAction: true,
      }),
      repo
    );
    writeWorker(repo, '20260101-130000-beefcafe', {
      status: 'test_failed',
      changedFiles: ['src/button.ts'],
      verification: { commands: [{ command: 'npm test', exitCode: 1, status: 'FAIL' }] },
    });

    const snapshot = await rebuildRepositoryMemory({ repoRoot: repo });
    assert.equal(snapshot.taskHistory[0].confidence, 'inferred');
    assert.equal(snapshot.taskHistory[0].value.failure?.category, 'verification_failed');
    // A failed run never teaches which tests cover a file.
    assert.equal(snapshot.testMap.length, 0);
  });

  void test('editing a remembered file marks its records stale', async () => {
    await saveCompactRunState(runFixture({ runId: '20260101-120000-abcdef12' }), repo);
    writeWorker(repo, '20260101-120000-abcdef12', {
      changedFiles: ['src/button.ts'],
      verification: { commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }] },
    });
    await rebuildRepositoryMemory({ repoRoot: repo, headCommit: 'abc1234' });

    const fresh = await readRepositoryMemory({ repoRoot: repo, headCommit: 'abc1234' });
    assert.equal(fresh.taskHistory[0].confidence, 'verified');
    assert.equal(fresh.staleAgainstHead, false);

    fs.writeFileSync(path.join(repo, 'src', 'button.ts'), 'export const a = 2;\n', 'utf8');
    const afterEdit = await readRepositoryMemory({ repoRoot: repo, headCommit: 'def5678' });
    assert.equal(afterEdit.taskHistory[0].confidence, 'stale');
    assert.equal(afterEdit.testMap[0].confidence, 'stale');
    assert.equal(afterEdit.staleAgainstHead, true);
  });

  void test('expired records are dropped instead of being served', async () => {
    await saveCompactRunState(runFixture({ runId: '20260101-120000-abcdef12' }), repo);
    writeWorker(repo, '20260101-120000-abcdef12', { changedFiles: ['src/button.ts'] });
    await rebuildRepositoryMemory({ repoRoot: repo, now: new Date('2026-01-01T00:00:00.000Z') });

    const later = await readRepositoryMemory({
      repoRoot: repo,
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    assert.equal(later.taskHistory.length, 0);
  });

  void test('secret material and files outside the repository are not stored', async () => {
    await saveCompactRunState(
      runFixture({
        runId: '20260101-120000-abcdef12',
        prompt: 'deploy with GEMINI_API_KEY=AIzaSyA1234567890123456789012345678901234',
      }),
      repo
    );
    writeWorker(repo, '20260101-120000-abcdef12', {
      changedFiles: ['src/button.ts'],
      verification: { commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }] },
    });
    await saveCompactRunState(runFixture({ runId: '20260101-140000-cafed00d' }), repo);
    writeWorker(repo, '20260101-140000-cafed00d', {
      taskId: 'TASK-2',
      changedFiles: ['../../etc/passwd', 'C:/Users/tester/secret.ts', 'src/button.ts'],
      verification: { commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }] },
    });

    const snapshot = await rebuildRepositoryMemory({ repoRoot: repo });
    const ids = snapshot.taskHistory.map(record => record.value.runId);
    assert.equal(ids.includes('20260101-120000-abcdef12'), false, 'secret prompt is skipped');
    const kept = snapshot.taskHistory.find(record => record.value.runId === '20260101-140000-cafed00d');
    assert.deepEqual(kept?.value.changedFiles, ['src/button.ts']);
  });

  void test('merge state is recorded only when git could answer', async () => {
    await saveCompactRunState(
      runFixture({ runId: '20260101-120000-abcdef12', integrationBranch: 'agent/run-abcdef12' }),
      repo
    );
    writeWorker(repo, '20260101-120000-abcdef12', {
      changedFiles: ['src/button.ts'],
      verification: { commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }] },
    });

    const unknown = await rebuildRepositoryMemory({ repoRoot: repo });
    assert.equal(unknown.taskHistory[0].value.merged, undefined);

    const asked: string[] = [];
    const known = await rebuildRepositoryMemory({
      repoRoot: repo,
      isMerged: async branch => {
        asked.push(branch);
        return true;
      },
    });
    assert.deepEqual(asked, ['agent/run-abcdef12']);
    assert.equal(known.taskHistory[0].value.merged, true);
  });

  void test('clearing removes the memory directory', async () => {
    await saveCompactRunState(runFixture({ runId: '20260101-120000-abcdef12' }), repo);
    writeWorker(repo, '20260101-120000-abcdef12', { changedFiles: ['src/button.ts'] });
    await rebuildRepositoryMemory({ repoRoot: repo });
    assert.equal(fs.existsSync(getMemoryDir(repo)), true);

    await clearRepositoryMemory(repo);
    assert.equal(fs.existsSync(getMemoryDir(repo)), false);
    const empty = await readRepositoryMemory({ repoRoot: repo });
    assert.deepEqual(empty.taskHistory, []);
  });

  void test('memory written for another repository is not served', async () => {
    await saveCompactRunState(runFixture({ runId: '20260101-120000-abcdef12' }), repo);
    writeWorker(repo, '20260101-120000-abcdef12', { changedFiles: ['src/button.ts'] });
    await rebuildRepositoryMemory({ repoRoot: repo });

    const filePath = path.join(getMemoryDir(repo), 'task-history.json');
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(filePath, JSON.stringify({ ...stored, repositoryId: 'deadbeefdeadbeef' }), 'utf8');

    const snapshot = await readRepositoryMemory({ repoRoot: repo });
    assert.deepEqual(snapshot.taskHistory, []);
    assert.equal(snapshot.staleAgainstHead, true);
  });

  void test('the memory directory is ignored by git in this repository', t => {
    const result = spawnSync('git', ['check-ignore', '.agent/memory/task-history.json'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.error) return t.skip('git is unavailable');
    assert.equal(result.status, 0, 'add .agent/memory/ to .gitignore');
  });
});
