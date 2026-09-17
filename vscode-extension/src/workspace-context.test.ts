import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDirtyWorktreeMessage,
  mergeBranch,
  isMergeInProgress,
  readGitDirtyFiles,
  pickCodexModel,
  buildExplainPrompt,
  buildPlanFixPrompt,
  formatUsageDetail,
  formatUsageLine,
  buildAttachedPrompt,
  formatWorkspaceContextLine,
  relativeWorkspacePath,
  shortSelectionLabel,
  summarizeRunStatus,
  readGitIdentity,
  readGitDiffSummary,
  selectedTestFailures,
} from './workspace-context.ts';

void test('merge branch runs a no-edit merge and surfaces git stderr on refusal', async () => {
  const calls: string[][] = [];
  const ok = await mergeBranch('C:/repo', async args => {
    calls.push(args);
    return { stdout: 'Updating 1..2', stderr: '', exitCode: 0 };
  }, 'integration/r-1');
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls, [['merge', '--no-edit', 'integration/r-1']]);

  const refused = await mergeBranch('C:/repo', async () => ({
    stdout: '',
    stderr: 'error: Your local changes would be overwritten by merge.\n',
    exitCode: 1,
  }), 'integration/r-1');
  assert.deepEqual(refused, {
    ok: false,
    error: 'integration/r-1 merge 실패: error: Your local changes would be overwritten by merge.',
  });
});

void test('merge in progress is read from MERGE_HEAD', async () => {
  const calls: string[][] = [];
  const runner = (exitCode: number) => async (args: string[]) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode };
  };
  assert.equal(await isMergeInProgress('C:/repo', runner(0)), true);
  assert.equal(await isMergeInProgress('C:/repo', runner(1)), false);
  assert.deepEqual(calls[0], ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
});

void test('relative workspace path strips the repo root', () => {
  assert.equal(
    relativeWorkspacePath('C:/repo/src/app.ts', 'C:/repo'),
    'src/app.ts'
  );
});

void test('workspace context line does not expose user home paths', () => {
  const line = formatWorkspaceContextLine({
    workspaceRoot: 'C:/Users/LEE/Downloads/codex-gemini-worker-dashboard-main',
    branch: 'main',
    head: 'abc1234',
    activeFile:
      'C:/Users/LEE/Downloads/codex-gemini-worker-dashboard-main/.vscode/launch.json',
  });
  assert.equal(
    line,
    'workspace codex-gemini-worker-dashboard-main · branch main · HEAD abc1234 · file .vscode/launch.json'
  );
  assert.doesNotMatch(line, /Users\\LEE|Users\/LEE/);
});

void test('selection labels stay short and omit source code', () => {
  const ctx = {
    workspaceRoot: 'C:/repo',
    activeFile: 'C:/repo/src/sum.ts',
    selectedText: 'return a - b;',
  };
  assert.equal(shortSelectionLabel('explain', ctx), '선택 코드 설명: src/sum.ts');
  assert.equal(shortSelectionLabel('plan', ctx), '선택 코드 수정 계획: src/sum.ts');
});

void test('explain prompt requires a selection and forbids file changes', () => {
  const missing = buildExplainPrompt({ workspaceRoot: 'C:/repo' });
  assert.equal(missing.ok, false);
  const built = buildExplainPrompt({
    workspaceRoot: 'C:/repo',
    activeFile: 'C:/repo/src/sum.ts',
    languageId: 'typescript',
    selectedText: 'export const sum = (a, b) => a + b;',
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.prompt, /파일을 수정하지 마세요/);
  assert.match(built.prompt, /src\/sum\.ts/);
  assert.match(built.prompt, /export const sum/);
});

void test('plan prompt requires a selection and asks for approval first', () => {
  const missing = buildPlanFixPrompt({});
  assert.equal(missing.ok, false);
  const built = buildPlanFixPrompt({
    workspaceRoot: 'C:/repo',
    activeFile: 'C:/repo/src/sum.ts',
    selectedText: 'return a - b;',
    diagnostics: [
      { file: 'C:/repo/src/sum.ts', message: 'unreachable', severity: 'error' },
    ],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.prompt, /승인 전에는 파일을 변경하지 마세요/);
  assert.match(built.prompt, /return a - b/);
  assert.match(built.prompt, /unreachable/);
});

void test('usage detail shows reset clock beside the button and every window in the tooltip', () => {
  const now = new Date(2026, 8, 17, 12, 0, 0);
  const result = formatUsageDetail(
    [
      { label: '5h', remainingPercent: 59, resetsAt: new Date(2026, 8, 17, 14, 30).getTime() / 1000 },
      { label: 'weekly', remainingPercent: 80.4, resetsAt: new Date(2026, 8, 20, 9, 0).toISOString() },
    ],
    now
  );
  assert.equal(result.line, '59% 남음 · 14:30 초기화');
  assert.equal(
    result.detail,
    '5h 59% 남음 · 14:30 초기화 (2시간 30분 남음)\nweekly 80% 남음 · 9/20 09:00 초기화 (2일 21시간 남음)'
  );
  assert.equal(formatUsageDetail([{ label: '5h', remainingPercent: 10 }], now).line, '10% 남음');
  assert.equal(formatUsageDetail([{ label: '5h', remainingPercent: null }], now).line, '다시 조회');
  assert.equal(formatUsageDetail([], now).line, '다시 조회');
});

void test('usage line never treats a failed lookup as 0%', () => {
  assert.equal(formatUsageLine({ failed: true }), '다시 조회');
  assert.equal(formatUsageLine({ remainingPercent: null }), '다시 조회');
  assert.equal(formatUsageLine({ remainingPercent: 59 }), '59% 남음');
  assert.equal(formatUsageLine({ remainingPercent: 0 }), '0% 남음');
});

void test('run status labels match the extension state contract', () => {
  assert.equal(summarizeRunStatus({}), 'idle');
  assert.equal(summarizeRunStatus({ hasPendingApproval: true }), 'awaiting approval');
  assert.equal(summarizeRunStatus({ requiresUserAction: true }), 'action required');
  assert.equal(summarizeRunStatus({ status: 'awaiting_review' }), 'awaiting review');
  assert.equal(summarizeRunStatus({ status: 'running' }), 'running');
});

void test('plan prompt includes git diff and selected test failures when provided', () => {
  const built = buildPlanFixPrompt({
    workspaceRoot: 'C:/repo',
    activeFile: 'C:/repo/src/sum.test.ts',
    selectedText: 'expect(sum(1,1)).toBe(2);',
    gitDiffSummary: ' src/sum.ts | 2 +-',
    testFailures: ['expected 2 received 3'],
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.match(built.prompt, /Git diff \(stat\)/);
  assert.match(built.prompt, /src\/sum\.ts \| 2/);
  assert.match(built.prompt, /Selected test failures/);
  assert.match(built.prompt, /expected 2 received 3/);
});

void test('selectedTestFailures only uses diagnostics on a test file', () => {
  assert.deepEqual(
    selectedTestFailures({
      activeFile: 'C:/repo/src/sum.ts',
      diagnostics: [{ file: 'C:/repo/src/sum.ts', message: 'unused', severity: 'Error' }],
    }),
    []
  );
  assert.deepEqual(
    selectedTestFailures({
      activeFile: 'C:/repo/src/sum.test.ts',
      diagnostics: [{ file: 'C:/repo/src/sum.test.ts', message: 'expected 2', severity: 'Error' }],
    }),
    ['expected 2']
  );
});

void test('git diff summary is omitted when git fails', async () => {
  const missing = await readGitDiffSummary('C:/repo', async () => ({ stdout: '', exitCode: 1 }));
  assert.equal(missing, undefined);
  const empty = await readGitDiffSummary('C:/repo', async () => ({ stdout: '\n', exitCode: 0 }));
  assert.equal(empty, '변경 없음');
  const stat = await readGitDiffSummary('C:/repo', async args => {
    if (args.includes('main...feature')) return { stdout: 'a.ts | 1 +\n', exitCode: 0 };
    return { stdout: '', exitCode: 1 };
  }, 'main...feature');
  assert.equal(stat, 'a.ts | 1 +');
});

void test('git identity uses the injected runner', async () => {
  const identity = await readGitIdentity('C:/repo', async args => {
    if (args.includes('--abbrev-ref')) return { stdout: 'main\n', exitCode: 0 };
    return { stdout: 'abc1234\n', exitCode: 0 };
  });
  assert.deepEqual(identity, { branch: 'main', head: 'abc1234' });
});

void test('pickCodexModel routes explain-only calls to the chat model and plans to the main model', () => {
  assert.equal(pickCodexModel({ forbidWorkers: true, codexModel: 'main', codexChatModel: 'cheap' }), 'cheap');
  assert.equal(pickCodexModel({ forbidWorkers: false, codexModel: 'main', codexChatModel: 'cheap' }), 'main');
  assert.equal(pickCodexModel({ forbidWorkers: true, codexModel: 'main', codexChatModel: ' ' }), 'main');
  assert.equal(pickCodexModel({ forbidWorkers: false, codexModel: '' }), undefined);
});

void test('dirty worktree check lists porcelain lines and explains the fix', async () => {
  assert.deepEqual(await readGitDirtyFiles('C:/repo', async () => ({ stdout: '', exitCode: 128 })), []);
  const dirty = await readGitDirtyFiles('C:/repo', async () => ({ stdout: ' M a.ts\n?? .agent/dashboard-state/x.json\n\n', exitCode: 0 }));
  assert.deepEqual(dirty, [' M a.ts', '?? .agent/dashboard-state/x.json']);
  const message = formatDirtyWorktreeMessage(dirty);
  assert.match(message, /Run을 시작하지 않았습니다/);
  assert.match(message, /변경 파일 \(2\):\n-  M a.ts\n- \?\? .agent/);
  assert.match(message, /commit 또는 stash/);
  assert.match(message, /\.gitignore/);
  assert.doesNotMatch(formatDirtyWorktreeMessage([' M a.ts']), /\.gitignore/);
  assert.match(formatDirtyWorktreeMessage(Array.from({ length: 10 }, (_, i) => ` M f${i}.ts`)), /외 2개/);
});

void test('attached prompt names the source in the message and carries the selection', () => {
  const ctx = {
    workspaceRoot: 'C:/repo',
    activeFile: 'C:/repo/src/a.ts',
    selectedText: 'const a = 1;',
    selectionRange: { start: 12, end: 30 },
    languageId: 'typescript',
  };
  assert.equal(formatWorkspaceContextLine(ctx), 'workspace repo · file src/a.ts:12-30');
  const attached = buildAttachedPrompt('왜 느린가요?', ctx);
  assert.equal(attached.message, '왜 느린가요?\n\n[첨부 · VS Code: src/a.ts:12-30]');
  assert.match(attached.executionPrompt || '', /출처: VS Code 활성 편집기/);
  assert.match(attached.executionPrompt || '', /File: src\/a.ts:12-30 language=typescript/);
  assert.match(attached.executionPrompt || '', /const a = 1;/);
  // Off, or no active file: the text goes through untouched.
  assert.deepEqual(buildAttachedPrompt('질문', { workspaceRoot: 'C:/repo' }), { message: '질문' });
  const fileOnly = buildAttachedPrompt('질문', { workspaceRoot: 'C:/repo', activeFile: 'C:/repo/b.ts' });
  assert.equal(fileOnly.message, '질문\n\n[첨부 · VS Code: b.ts]');
  assert.doesNotMatch(fileOnly.executionPrompt || '', /```/);
});
