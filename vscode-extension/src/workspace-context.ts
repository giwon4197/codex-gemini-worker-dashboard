export interface DiagnosticContext {
  file: string;
  message: string;
  severity: string;
}

export interface EditorContext {
  workspaceRoot?: string;
  branch?: string;
  head?: string;
  activeFile?: string;
  selectedText?: string;
  /** 1-based inclusive line range of the selection; absent when nothing is selected. */
  selectionRange?: { start: number; end: number };
  languageId?: string;
  openFiles?: string[];
  diagnostics?: DiagnosticContext[];
  gitDiffSummary?: string;
  testFailures?: string[];
}

export type GitRunner = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

export function workspaceFolderName(workspaceRoot?: string): string | undefined {
  if (!workspaceRoot) return undefined;
  const parts = workspaceRoot.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1];
}

export function formatWorkspaceContextLine(ctx: EditorContext): string {
  const folder = workspaceFolderName(ctx.workspaceRoot);
  const file = selectionLabel(ctx);
  return [
    folder ? `workspace ${folder}` : 'workspace 없음',
    ctx.branch ? `branch ${ctx.branch}` : undefined,
    ctx.head ? `HEAD ${ctx.head}` : undefined,
    file ? `file ${file}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** `src/a.ts:12-30` when a range is selected, else the relative path. */
function selectionLabel(ctx: EditorContext): string | undefined {
  const file = relativeWorkspacePath(ctx.activeFile, ctx.workspaceRoot);
  const range = ctx.selectionRange;
  if (!file || !range) return file;
  return range.start === range.end ? `${file}:${range.start}` : `${file}:${range.start}-${range.end}`;
}

/**
 * Opt-in attachment (decision 8): the chat message names the source, the prompt
 * carries the active file path plus the selected code. Without an active file
 * the text is sent as-is.
 */
export function buildAttachedPrompt(
  text: string,
  ctx: EditorContext
): { message: string; executionPrompt?: string } {
  const label = selectionLabel(ctx);
  if (!label) return { message: text };
  const selected = ctx.selectedText?.trim();
  const lang = ctx.languageId ? ` language=${ctx.languageId}` : '';
  const prompt = [text, '', '첨부 컨텍스트 (출처: VS Code 활성 편집기)', `File: ${label}${lang}`];
  if (selected) prompt.push('```', selected, '```');
  return { message: `${text}\n\n[첨부 · VS Code: ${label}]`, executionPrompt: prompt.join('\n') };
}

export function relativeWorkspacePath(
  filePath: string | undefined,
  workspaceRoot: string | undefined
): string | undefined {
  if (!filePath) return undefined;
  if (!workspaceRoot) return filePath.replace(/\\/g, '/');
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = filePath.replace(/\\/g, '/');
  const prefix = root.toLowerCase();
  if (normalized.toLowerCase().startsWith(prefix + '/')) {
    return normalized.slice(root.length + 1);
  }
  if (normalized.toLowerCase() === prefix) return normalized.split('/').pop();
  return normalized;
}

export function shortSelectionLabel(kind: 'explain' | 'plan', ctx: EditorContext): string {
  const file = relativeWorkspacePath(ctx.activeFile, ctx.workspaceRoot) || 'selection';
  return kind === 'explain' ? `선택 코드 설명: ${file}` : `선택 코드 수정 계획: ${file}`;
}

export function buildExplainPrompt(ctx: EditorContext): { ok: true; prompt: string } | { ok: false; error: string } {
  const selected = ctx.selectedText?.trim();
  if (!selected) {
    return { ok: false, error: '설명할 코드 선택 영역이 없습니다.' };
  }
  const file = relativeWorkspacePath(ctx.activeFile, ctx.workspaceRoot) || 'active editor';
  const lang = ctx.languageId ? ` language=${ctx.languageId}` : '';
  return {
    ok: true,
    prompt: [
      '아래 선택 코드를 설명하세요.',
      '파일을 수정하지 마세요. 실행 계획이나 워커를 만들지 마세요.',
      `File: ${file}${lang}`,
      '```',
      selected,
      '```',
    ].join('\n'),
  };
}

export function buildPlanFixPrompt(ctx: EditorContext): { ok: true; prompt: string } | { ok: false; error: string } {
  const selected = ctx.selectedText?.trim();
  if (!selected) {
    return { ok: false, error: '수정 계획을 세울 코드 선택 영역이 없습니다.' };
  }
  const file = relativeWorkspacePath(ctx.activeFile, ctx.workspaceRoot) || 'active editor';
  const lang = ctx.languageId ? ` language=${ctx.languageId}` : '';
  const diagnosticLines = (ctx.diagnostics || [])
    .filter(item => item.file === ctx.activeFile || item.file === file)
    .slice(0, 8)
    .map(item => `- [${item.severity}] ${item.message}`);
  const extra = diagnosticLines.length > 0 ? `\nProblems:\n${diagnosticLines.join('\n')}` : '';
  const diff =
    ctx.gitDiffSummary && ctx.gitDiffSummary.trim()
      ? `\nGit diff (stat):\n\`\`\`\n${ctx.gitDiffSummary.trim()}\n\`\`\``
      : '';
  const tests =
    ctx.testFailures && ctx.testFailures.length > 0
      ? `\nSelected test failures:\n${ctx.testFailures.slice(0, 8).map(line => `- ${line}`).join('\n')}`
      : '';
  return {
    ok: true,
    prompt: [
      '아래 선택 코드의 수정 계획을 세우세요.',
      '승인 전에는 파일을 변경하지 마세요.',
      `File: ${file}${lang}`,
      extra,
      tests,
      diff,
      '```',
      selected,
      '```',
    ].join('\n'),
  };
}

export function formatUsageLine(input: {
  remainingPercent?: number | null;
  failed?: boolean;
}): string {
  if (input.failed) return '다시 조회';
  if (input.remainingPercent == null || Number.isNaN(Number(input.remainingPercent))) {
    return '다시 조회';
  }
  return `${Math.round(Number(input.remainingPercent))}% 남음`;
}

export interface UsageWindow {
  label: string;
  remainingPercent?: number | null;
  /** Epoch seconds, epoch milliseconds, or an ISO string. */
  resetsAt?: number | string | null;
}

function toResetDate(raw: UsageWindow['resetsAt']): Date | undefined {
  if (raw == null || raw === '') return undefined;
  const date =
    typeof raw === 'number' ? new Date(raw < 10_000_000_000 ? raw * 1000 : raw) : new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const pad = (value: number) => String(value).padStart(2, '0');

function formatResetClock(date: Date, now: Date): string {
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function formatRemaining(date: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((date.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간 ${minutes % 60}분 남음` : `${Math.floor(hours / 24)}일 ${hours % 24}시간 남음`;
}

/**
 * `line` is the short text beside the usage button (first window only);
 * `detail` is the hover/focus tooltip with every window, reset time, and time left.
 */
export function formatUsageDetail(
  windows: UsageWindow[],
  now = new Date()
): { line: string; detail?: string } {
  const [primary] = windows;
  if (!primary) return { line: formatUsageLine({ failed: true }) };
  const primaryReset = toResetDate(primary.resetsAt);
  const line = [
    formatUsageLine({ remainingPercent: primary.remainingPercent }),
    primaryReset ? `${formatResetClock(primaryReset, now)} 초기화` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const detail = windows
    .map(window => {
      const reset = toResetDate(window.resetsAt);
      return [
        `${window.label} ${formatUsageLine({ remainingPercent: window.remainingPercent })}`,
        reset ? `${formatResetClock(reset, now)} 초기화 (${formatRemaining(reset, now)})` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    })
    .join('\n');
  return { line, detail };
}

export function summarizeRunStatus(input: {
  hasPendingApproval?: boolean;
  status?: string;
  requiresUserAction?: boolean;
  activeWorkers?: number;
}): string {
  if (input.hasPendingApproval) return 'awaiting approval';
  if (input.requiresUserAction) return 'action required';
  switch (input.status) {
    case 'planning':
      return 'planning';
    case 'running':
      return input.activeWorkers && input.activeWorkers > 0 ? 'running' : 'running';
    case 'retrying':
      return 'retrying';
    case 'awaiting_review':
      return 'awaiting review';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
    case 'escalated':
      return 'failed';
    default:
      return 'idle';
  }
}

export async function readGitIdentity(
  workspaceRoot: string,
  runner: GitRunner
): Promise<{ branch?: string; head?: string }> {
  const branch = await runner(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot);
  const head = await runner(['rev-parse', '--short', 'HEAD'], workspaceRoot);
  return {
    branch: branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined,
    head: head.exitCode === 0 ? head.stdout.trim() || undefined : undefined,
  };
}

/**
 * True when the branch tip is already reachable from the default branch. Only a
 * merged result may later count as a golden patch, so unknown stays false.
 */
export async function isBranchMerged(
  workspaceRoot: string,
  branch: string,
  runner: GitRunner
): Promise<boolean> {
  // The name reaches git as argv; refuse anything that could read as an option.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
  for (const base of ['main', 'master']) {
    const exists = await runner(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], workspaceRoot);
    if (exists.exitCode !== 0) continue;
    const merged = await runner(['merge-base', '--is-ancestor', branch, base], workspaceRoot);
    return merged.exitCode === 0;
  }
  return false;
}

export function selectedTestFailures(ctx: EditorContext): string[] {
  const file = (ctx.activeFile || '').replace(/\\/g, '/');
  const isTestFile =
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /\/(__tests__|tests)\//.test(file);
  if (!isTestFile) return [];
  return (ctx.diagnostics || [])
    .filter(item => item.file === ctx.activeFile && /error/i.test(item.severity))
    .map(item => item.message);
}

export async function readGitDiffSummary(
  workspaceRoot: string,
  runner: GitRunner,
  range?: string
): Promise<string | undefined> {
  const attempts = range
    ? [
        ['diff', '--stat', range],
        ['diff', '--stat'],
      ]
    : [['diff', '--stat']];
  for (const args of attempts) {
    const result = await runner(args, workspaceRoot);
    if (result.exitCode !== 0) continue;
    const text = result.stdout.trim();
    return text || '변경 없음';
  }
  return undefined;
}

/**
 * Stage policy for `codex exec --model`: explain-only calls (no worker can be
 * created) may use a cheaper chat model; anything that can produce a plan uses
 * the main model. Empty values fall through to the saved settings file.
 */
export function pickCodexModel(input: {
  forbidWorkers: boolean;
  codexModel?: string;
  codexChatModel?: string;
}): string | undefined {
  const main = input.codexModel?.trim() || undefined;
  const chat = input.codexChatModel?.trim() || undefined;
  return input.forbidWorkers ? chat || main : main;
}

/** `git status --porcelain` lines; empty when clean or when git is unavailable. */
export async function readGitDirtyFiles(workspaceRoot: string, runner: GitRunner): Promise<string[]> {
  const result = await runner(['status', '--porcelain'], workspaceRoot);
  if (result.exitCode !== 0) return [];
  return result.stdout.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
}

/** Merges `branch` into the checked-out branch; git's own message explains a refusal or conflict. */
export async function mergeBranch(
  workspaceRoot: string,
  runner: GitRunner,
  branch: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runner(['merge', '--no-edit', branch], workspaceRoot);
  if (result.exitCode === 0) return { ok: true };
  const detail = (result.stderr || result.stdout).trim();
  return { ok: false, error: `${branch} merge 실패${detail ? `: ${detail}` : ''}` };
}

/** True while a merge is stopped on conflicts (MERGE_HEAD exists). */
export async function isMergeInProgress(workspaceRoot: string, runner: GitRunner): Promise<boolean> {
  const result = await runner(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], workspaceRoot);
  return result.exitCode === 0;
}

/** Korean explanation of why the router refuses a dirty tree and how to fix it. */
export function formatDirtyWorktreeMessage(dirtyLines: string[], limit = 8): string {
  const shown = dirtyLines.slice(0, limit).map(line => `- ${line}`);
  const more = dirtyLines.length > limit ? [`- … 외 ${dirtyLines.length - limit}개`] : [];
  const lines = [
    '커밋되지 않은 변경이 있어 Run을 시작하지 않았습니다. 라우터는 깨끗한 작업 트리에서만 실행됩니다.',
    `변경 파일 (${dirtyLines.length}):`,
    ...shown,
    ...more,
    '해결: 소스 제어에서 commit 또는 stash 한 뒤 다시 승인하세요.',
  ];
  if (dirtyLines.some(line => line.includes('.agent/'))) {
    lines.push('힌트: .agent/ 는 실행 상태 폴더입니다. .gitignore 에 `.agent/dashboard-state/` 를 추가하면 매번 걸리지 않습니다.');
  }
  return lines.join('\n');
}
