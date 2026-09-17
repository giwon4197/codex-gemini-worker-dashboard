import * as vscode from 'vscode';
import { CONVERSATION_VIEW_ID, SESSION_STATE_KEY, TRACKED_RUN_KEY, USAGE_CACHE_KEY, type UsageCache } from '../ids';
import { TERMINAL_RUN_STATUSES, busyStatusText, runProgressLines, tailProgressLines, type HostToWebview, type WebviewToHost } from '../protocol';
import type { ProjectWorkGraphData } from '../../../packages/orchestrator-core/project-event-graph.ts';
import type { ConversationSession } from '../../../packages/orchestrator-core/workspace-contract.ts';
import {
  appendRunCompletion,
  approvePlanWithCore,
  cancelRun,
  chatWithCore,
  createGitRunner,
  getActiveRunSummary,
  getReviewContext,
  getRunStatusText,
  listSessionSummaries,
  loadSession,
  refreshCodexUsageLine,
  refreshGeminiUsageLine,
  restoreWorkspaceBindings,
  sanitizeUiError,
  toWebviewMessages,
} from '../core-host';
import { collectEditorContext, getWorkspaceRoot, openWorkspaceFile } from '../vscode-context';
import {
  buildAttachedPrompt,
  buildExplainPrompt,
  buildPlanFixPrompt,
  formatDirtyWorktreeMessage,
  formatWorkspaceContextLine,
  pickCodexModel,
  readGitDiffSummary,
  readGitDirtyFiles,
  readGitIdentity,
  selectedTestFailures,
  shortSelectionLabel,
} from '../workspace-context';
import { ACTIVE_RUN_STATUSES } from '../graph-tree';
import type { RunStatusBar } from '../status-bar';

export interface RunFollowUp {
  /** Shares the conversation webview so the Task Graph panel can render inside it. */
  attach(webview: vscode.Webview): void;
  trackRun(runId?: string): Promise<void> | void;
  reset(): Promise<void> | void;
  /** Unfolds the Task Graph panel so its review section is on screen. */
  reveal(): Promise<void> | void;
}

export class ConversationViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CONVERSATION_VIEW_ID;
  private view?: vscode.WebviewView;
  private sessionId?: string;
  private runFollowUp?: RunFollowUp;
  private chatAbort?: AbortController;
  private lastGraph: ProjectWorkGraphData | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar: RunStatusBar
  ) {
    this.sessionId = context.workspaceState.get<string>(SESSION_STATE_KEY);
  }

  setRunFollowUp(followUp: RunFollowUp): void {
    this.runFollowUp = followUp;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = renderConversationHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewToHost) => {
      void this.onMessage(message).catch(error => this.reportError(error));
    });
    this.runFollowUp?.attach(webviewView.webview);
    // Decision 10: the Gate badge goes away the moment the user looks at the view.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) webviewView.badge = undefined;
    });
  }

  /** Marks a waiting Gate (plan approval or review) while the view is out of sight. */
  private setGateBadge(): void {
    if (!this.view || this.view.visible) return;
    this.view.badge = { value: 1, tooltip: '대기 중인 Gate 1' };
  }

  private runInProgress(): boolean {
    return Boolean(this.lastGraph && ACTIVE_RUN_STATUSES.has(this.lastGraph.status));
  }

  async openWorkspace(): Promise<void> {
    await vscode.commands.executeCommand(`${CONVERSATION_VIEW_ID}.focus`);
    await this.postContext();
    await this.refreshRunStatus();
  }

  async explainSelection(): Promise<void> {
    const ctx = await this.editorContext();
    const prompt = buildExplainPrompt(ctx);
    if (!prompt.ok) {
      void vscode.window.showWarningMessage(prompt.error);
      return;
    }
    await this.openWorkspace();
    await this.sendChat({
      message: shortSelectionLabel('explain', ctx),
      executionPrompt: prompt.prompt,
      forbidWorkers: true,
    });
  }

  async planFixForSelection(): Promise<void> {
    const ctx = await this.editorContext();
    const root = getWorkspaceRoot();
    const gitDiffSummary = root
      ? await readGitDiffSummary(root, createGitRunner())
      : undefined;
    const prompt = buildPlanFixPrompt({
      ...ctx,
      gitDiffSummary,
      testFailures: selectedTestFailures(ctx),
    });
    if (!prompt.ok) {
      void vscode.window.showWarningMessage(prompt.error);
      return;
    }
    await this.openWorkspace();
    await this.sendChat({
      message: shortSelectionLabel('plan', ctx),
      executionPrompt: prompt.prompt,
      forbidWorkers: false,
    });
  }

  async showActiveRun(): Promise<void> {
    const root = this.requireRoot();
    if (!root) return;
    await this.openWorkspace();
    const text = await getActiveRunSummary(root);
    this.post({ type: 'runStatus', text });
    await this.runFollowUp?.trackRun('current');
  }

  async reviewChanges(): Promise<void> {
    const root = this.requireRoot();
    if (!root) return;
    await this.openWorkspace();
    const review = await getReviewContext(root);
    if (!review.graph) {
      this.post({ type: 'runStatus', text: '검토할 변경이 없습니다.' });
      return;
    }
    this.post({
      type: 'runStatus',
      text: `Run ${review.runId} · ${review.status || review.graph.status}`,
    });
    if (review.runId) await this.runFollowUp?.trackRun(review.runId);
    await this.runFollowUp?.reveal();
  }

  async refreshUsage(): Promise<void> {
    await this.openWorkspace();
    await this.refreshProviderUsage('codex');
    await this.refreshProviderUsage('gemini');
  }

  private async onMessage(message: WebviewToHost): Promise<void> {
    try {
      if (message.type === 'ready') {
        await this.restoreFromDisk();
        await this.postContext();
        return;
      }
      if (message.type === 'chat') {
        const attached = message.attachContext
          ? buildAttachedPrompt(message.text, await this.editorContext())
          : { message: message.text };
        await this.sendChat({ ...attached, forbidWorkers: false });
        return;
      }
      if (message.type === 'openFile') {
        const root = this.requireRoot();
        if (root) await openWorkspaceFile(root, message.file);
        return;
      }
      if (message.type === 'refreshUsage') {
        await this.refreshProviderUsage(message.provider);
        return;
      }
      if (message.type === 'approvePlan') {
        await this.approvePlan();
        return;
      }
      if (message.type === 'newSession') {
        await this.startNewSession();
        return;
      }
      if (message.type === 'loadSession') {
        await this.switchSession(message.sessionId);
        return;
      }
      if (message.type === 'explainSelection') {
        await this.explainSelection();
        return;
      }
      if (message.type === 'planFixForSelection') {
        await this.planFixForSelection();
        return;
      }
      if (message.type === 'cancel') {
        await this.cancel();
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private async sendChat(options: {
    message: string;
    executionPrompt?: string;
    forbidWorkers: boolean;
  }): Promise<void> {
    const root = this.requireRoot();
    if (!root) return;
    // Decision 9: during a run every message is a question, so no second plan card appears.
    const forbidWorkers = options.forbidWorkers || this.runInProgress();
    this.setBusy(true, 'Codex에 요청하는 중 (Esc: 중단)');
    const config = vscode.workspace.getConfiguration('codexGemini');
    let liveOutput = '';
    const abort = new AbortController();
    this.chatAbort = abort;
    try {
      const result = await chatWithCore({
        message: options.message,
        executionPrompt: options.executionPrompt,
        repoRoot: root,
        sessionId: this.sessionId,
        forbidWorkers,
        codexModel: pickCodexModel({
          forbidWorkers,
          codexModel: config.get<string>('codexModel'),
          codexChatModel: config.get<string>('codexChatModel'),
        }),
        onOutput: text => {
          liveOutput = (liveOutput + text).slice(-4000);
          this.post({ type: 'progress', source: 'codex', lines: tailProgressLines(liveOutput) });
        },
        signal: abort.signal,
      });
      if (abort.signal.aborted) {
        this.post({ type: 'runStatus', text: '요청 중단됨 · 대기 중' });
        return;
      }
      if (!result.ok || !result.session) {
        this.post({
          type: 'error',
          message: sanitizeUiError(result.error || '대화 요청에 실패했습니다.', root),
        });
        return;
      }
      this.sessionId = result.session.sessionId;
      await this.context.workspaceState.update(SESSION_STATE_KEY, this.sessionId);
      this.post({
        type: 'session',
        sessionId: result.session.sessionId,
        messages: toWebviewMessages(result.session),
      });
      await this.refreshRunStatus(Boolean(result.session.pendingApproval));
      if (result.session.pendingApproval) this.setGateBadge();
      await this.keepGraphForSession(result.session);
      await this.postSessions();
    } finally {
      this.chatAbort = undefined;
      this.setBusy(false);
    }
    // A run that finished during the chat still gets its note, now that the pending bubble is gone.
    if (this.lastGraph && TERMINAL_RUN_STATUSES.has(this.lastGraph.status)) {
      await this.noteRunCompletion(this.lastGraph.runId);
    }
  }

  /** Esc: abort the in-flight Codex request, or stop the tracked run, then idle. */
  private async cancel(): Promise<void> {
    if (this.chatAbort) {
      this.chatAbort.abort();
      return;
    }
    const root = getWorkspaceRoot();
    const runId = this.context.workspaceState.get<string>(TRACKED_RUN_KEY);
    if (!root || !runId || !this.lastGraph || TERMINAL_RUN_STATUSES.has(this.lastGraph.status)) return;
    const stopped = await cancelRun(root, runId);
    this.post({ type: 'runStatus', text: stopped ? `Run ${runId} 중단 요청됨 · 대기 중` : '중단할 Run이 없습니다.' });
    await this.runFollowUp?.trackRun(runId);
  }

  private async startNewSession(): Promise<void> {
    this.sessionId = undefined;
    await this.context.workspaceState.update(SESSION_STATE_KEY, undefined);
    await this.runFollowUp?.reset();
    this.post({ type: 'session', sessionId: '', messages: [] });
    this.post({ type: 'progress', source: 'run', lines: [] });
    await this.refreshRunStatus(false);
    await this.postSessions();
  }

  /** A freshly opened window starts a new conversation instead of resuming the last one. */
  async startFreshWindow(): Promise<void> {
    await this.startNewSession();
    if (this.view) await this.restoreFromDisk();
    else await this.syncRunState();
  }

  private async switchSession(sessionId: string): Promise<void> {
    const root = this.requireRoot();
    if (!root) return;
    const session = await loadSession(sessionId, root);
    if (!session) {
      this.post({ type: 'error', message: '세션을 찾을 수 없습니다.' });
      return;
    }
    this.sessionId = session.sessionId;
    await this.context.workspaceState.update(SESSION_STATE_KEY, session.sessionId);
    this.post({ type: 'session', sessionId: session.sessionId, messages: toWebviewMessages(session) });
    await this.refreshRunStatus(Boolean(session.pendingApproval));
    await this.syncGraphToSession(session);
    await this.postSessions();
  }

  /** On session load the task graph mirrors the session: its latest linked run, or nothing. */
  private async syncGraphToSession(session?: ConversationSession | null): Promise<void> {
    const runId = session?.linkedRunIds[session.linkedRunIds.length - 1];
    if (runId) await this.runFollowUp?.trackRun(runId);
    else await this.runFollowUp?.reset();
  }

  /** Within a session the graph only moves when a newer run gets linked; chat alone keeps it. */
  private async keepGraphForSession(session: ConversationSession): Promise<void> {
    const runId = session.linkedRunIds[session.linkedRunIds.length - 1];
    if (runId && runId !== this.context.workspaceState.get<string>(TRACKED_RUN_KEY)) {
      await this.runFollowUp?.trackRun(runId);
    }
  }

  private async postSessions(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) return;
    const items = await listSessionSummaries(root);
    this.post({ type: 'sessions', items, activeSessionId: this.sessionId });
  }

  /** Mirrors the tracked run's newest activity into the chat while it is in flight. */
  showRunProgress(graph: ProjectWorkGraphData | null, failure?: string[]): void {
    this.lastGraph = graph;
    this.post({ type: 'inputMode', questionOnly: this.runInProgress() });
    const lines = runProgressLines(graph);
    if (failure?.length) {
      this.post({ type: 'progress', source: 'run', lines: [...lines, '', ...failure], tone: 'error' });
      this.setGateBadge();
      return;
    }
    this.post({ type: 'progress', source: 'run', lines });
    const finished = graph && !this.chatAbort && TERMINAL_RUN_STATUSES.has(graph.status);
    if (finished) void this.noteRunCompletion(graph.runId).catch(error => this.reportError(error));
    if (graph?.status === 'awaiting_review' || graph?.status === 'failed') this.setGateBadge();
  }

  /** Posts the "what ran, what changed" note once per run into the chat and the saved session. */
  private async noteRunCompletion(runId: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root || !this.sessionId) return;
    const session = await appendRunCompletion(root, this.sessionId, runId);
    if (!session) return;
    this.post({ type: 'session', sessionId: session.sessionId, messages: toWebviewMessages(session) });
    this.post({ type: 'progress', source: 'run', lines: [] });
  }

  private async approvePlan(): Promise<void> {
    const root = this.requireRoot();
    if (!root || !this.sessionId) return;
    // The router rejects a dirty tree, so check first and keep the approval pending.
    const dirty = await readGitDirtyFiles(root, createGitRunner());
    if (dirty.length > 0) {
      this.post({ type: 'error', message: formatDirtyWorktreeMessage(dirty) });
      const pick = await vscode.window.showWarningMessage(
        `커밋되지 않은 변경 ${dirty.length}개가 있어 Run을 시작하지 않았습니다. commit 또는 stash 후 다시 승인하세요.`,
        '소스 제어 열기'
      );
      if (pick) await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }
    this.setBusy(true, '계획을 승인하고 Run을 시작하는 중');
    try {
      const result = await approvePlanWithCore({
        sessionId: this.sessionId,
        repoRoot: root,
      });
      if (!result.ok) {
        this.post({
          type: 'error',
          message: sanitizeUiError(result.error || '계획 승인에 실패했습니다.', root),
        });
        return;
      }
      if (result.session) {
        this.post({
          type: 'session',
          sessionId: result.session.sessionId,
          messages: toWebviewMessages(result.session),
        });
      }
      const runId = result.runId ? `Run ${result.runId} 시작` : '승인 완료';
      this.post({ type: 'runStatus', text: runId });
      if (result.runId) await this.runFollowUp?.trackRun(result.runId);
      await this.runFollowUp?.reveal();
      await this.refreshRunStatus();
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(active: boolean, reason?: string): void {
    this.post({ type: 'busy', active, reason: active ? busyStatusText(reason) : undefined });
  }

  /** Status bar and tracked run come back from disk even before the webview exists. */
  private async syncRunState(): Promise<{ sessionId?: string; status: string } | undefined> {
    const root = getWorkspaceRoot();
    if (!root) {
      this.statusBar.setStatus('idle');
      return undefined;
    }
    const restored = await restoreWorkspaceBindings(root, {
      sessionId: this.sessionId,
      runId: this.context.workspaceState.get<string>(TRACKED_RUN_KEY),
    });
    if (restored.sessionId && restored.sessionId !== this.sessionId) {
      this.sessionId = restored.sessionId;
      await this.context.workspaceState.update(SESSION_STATE_KEY, restored.sessionId);
    }
    this.statusBar.setStatus(restored.status, restored.unlinkedActiveRuns);
    return restored;
  }

  /** Full restore for a ready webview: run state plus chat, usage cache, and session list. */
  async restoreFromDisk(): Promise<void> {
    const restored = await this.syncRunState();
    const root = getWorkspaceRoot();
    if (!restored || !root) {
      this.postCachedUsage();
      return;
    }
    const session = restored.sessionId ? await loadSession(restored.sessionId, root) : null;
    if (session) {
      this.post({
        type: 'session',
        sessionId: session.sessionId,
        messages: toWebviewMessages(session),
      });
    }
    await this.syncGraphToSession(session);
    this.post({ type: 'runStatus', text: restored.status });
    this.postCachedUsage();
    await this.postSessions();
  }

  private postCachedUsage(): void {
    const cache = this.context.workspaceState.get<UsageCache>(USAGE_CACHE_KEY) || {};
    if (cache.codex) {
      this.post({ type: 'usage', provider: 'codex', line: cache.codex.line, detail: cache.codex.detail });
    }
    if (cache.gemini) {
      this.post({ type: 'usage', provider: 'gemini', line: cache.gemini.line, detail: cache.gemini.detail });
    }
  }

  private async refreshProviderUsage(provider: 'codex' | 'gemini'): Promise<void> {
    const result = provider === 'codex' ? await refreshCodexUsageLine() : await refreshGeminiUsageLine();
    this.post({ type: 'usage', provider, line: result.line, detail: result.detail });
    const cache = this.context.workspaceState.get<UsageCache>(USAGE_CACHE_KEY) || {};
    cache[provider] = { line: result.line, detail: result.detail, at: new Date().toISOString() };
    await this.context.workspaceState.update(USAGE_CACHE_KEY, cache);
  }

  private async refreshRunStatus(hasPendingApproval?: boolean): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      this.statusBar.setStatus('idle');
      this.post({ type: 'runStatus', text: 'idle' });
      return;
    }
    const text = await getRunStatusText(root, hasPendingApproval, this.context.workspaceState.get<string>(TRACKED_RUN_KEY));
    this.statusBar.setStatus(text);
    this.post({ type: 'runStatus', text });
  }

  async postContext(): Promise<void> {
    const ctx = await this.editorContext();
    this.post({ type: 'context', text: formatWorkspaceContextLine(ctx) });
  }

  private async editorContext() {
    const root = getWorkspaceRoot();
    const git = root ? await readGitIdentity(root, createGitRunner()) : undefined;
    return collectEditorContext(root, git);
  }

  private requireRoot(): string | undefined {
    const root = getWorkspaceRoot();
    if (!root) {
      const message =
        '열려 있는 작업 폴더가 없습니다. 이 창에서 파일 > 폴더 열기를 하면 확장 개발 창이 종료됩니다. F5를 다시 누르거나, Run Extension in other folder 구성에 경로를 넣으세요.';
      this.post({ type: 'error', message });
      void vscode.window.showWarningMessage(message);
    }
    return root;
  }

  private reportError(error: unknown): void {
    this.post({ type: 'error', message: sanitizeUiError(error, getWorkspaceRoot()) });
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }
}

function renderConversationHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 8px;
      box-sizing: border-box;
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .meta, .usage { font-size: 11px; margin-bottom: 6px; }
    .meta { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta #status { color: var(--vscode-foreground); }
    .usage { margin: 6px 0 0; }
    .usage .row { display: flex; align-items: center; justify-content: flex-start; gap: 8px; margin-bottom: 2px; }
    .usage button { min-width: 64px; padding: 1px 6px; margin: 0; }
    .usageText { opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .messages {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-height: 120px;
      overflow: auto;
    }
    .msg {
      border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
      padding: 8px;
    }
    .msg.user { border-left: 3px solid var(--vscode-textLink-foreground); }
    .sender { font-weight: 600; margin-bottom: 4px; }
    textarea, button {
      font-family: inherit;
      font-size: inherit;
    }
    textarea {
      width: 100%;
      min-height: 64px;
      margin-top: 4px;
      box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
      padding: 4px 8px;
      margin: 4px 4px 0 0;
    }
    button:focus-visible, textarea:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .row { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .error { color: var(--vscode-errorForeground); min-height: 1.2em; white-space: pre-wrap; }
    .toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
    .toolbar select { flex: 1; min-width: 0; font: inherit; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); }
    .toolbar button { margin: 0; white-space: nowrap; }
    .msg.pending { opacity: 0.85; }
    .live, .runProgress {
      margin: 6px 0 0; padding: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px;
      white-space: pre-wrap; word-break: break-all; max-height: 140px; overflow: auto;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background, transparent);
    }
    .runProgress.failure {
      color: var(--vscode-errorForeground);
      border-left: 3px solid var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-textCodeBlock-background, transparent));
    }
    .thinking::after { content: ''; animation: dots 1.2s steps(1, end) infinite; }
    @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
    .plan { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); }
    .plan .files { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    .plan .files button {
      margin: 0; padding: 0 4px; font-family: var(--vscode-editor-font-family); font-size: 11px;
      background: none; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
      color: var(--vscode-textLink-foreground); cursor: pointer;
    }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 4px 0 0; }
    .chip { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; cursor: pointer; }
    .chip input { margin: 0; }
    .sendRow { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .sendRow button { margin: 4px 0 0; }
    #graphPanel { margin-bottom: 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; }
    #graphPanel > summary { cursor: pointer; padding: 4px 6px; font-weight: 600; user-select: none; }
    #graphPanel > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #graphPanel > summary .meta { display: inline; margin: 0 0 0 6px; font-weight: 400; }
    #graphPanel .body { padding: 4px 6px 6px; max-height: 45vh; overflow: auto; }
    #graphPanel button {
      margin: 0; padding: 2px 6px;
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    }
    #graphPanel .head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 6px; }
    #graphPanel .head .prompt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    #graphPanel .empty { color: var(--vscode-descriptionForeground); margin: 0; }
    #graphPanel .graph { position: relative; }
    #graphPanel svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    #graphPanel .rows { list-style: none; margin: 0; padding: 0; }
    #graphPanel .row {
      display: flex; align-items: center; gap: 6px;
      height: 52px; box-sizing: border-box; padding: 0 4px;
      cursor: pointer; border-radius: 3px;
    }
    #graphPanel .row:hover, #graphPanel .row:focus-within { background: var(--vscode-list-hoverBackground); }
    #graphPanel .row.open { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    #graphPanel .detail {
      margin: 0 0 6px; padding: 6px; max-height: 240px; overflow: auto;
      font-family: var(--vscode-editor-font-family); font-size: 11px;
      white-space: pre-wrap; word-break: break-all;
      background: var(--vscode-textCodeBlock-background, transparent);
    }
    #graphPanel .review { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); }
    #graphPanel .review h4 { margin: 0 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #graphPanel .review pre { margin: 0 0 6px; font-family: inherit; white-space: pre-wrap; }
    #graphPanel .review details pre {
      margin: 4px 0 0; padding: 6px; max-height: 240px; overflow: auto;
      font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all;
      color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background, transparent);
    }
    #graphPanel .review summary { cursor: pointer; font-size: 11px; }
    #graphPanel .row .text { flex: 1; min-width: 0; }
    #graphPanel .row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #graphPanel .row .meta { margin: 0; }
    #graphPanel .badge {
      font-size: 10px; padding: 0 5px; border-radius: 3px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
    }
    #graphPanel .badge.tip { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
    #graphPanel .badge.failed { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    #graphPanel .badge.running, #graphPanel .badge.retrying, #graphPanel .badge.pending { color: var(--vscode-charts-yellow, inherit); }
    #graphPanel .badge.completed { color: var(--vscode-charts-green, inherit); }
    @keyframes spin { to { transform: rotate(360deg); } }
    #graphPanel .spin { transform-origin: center; transform-box: fill-box; animation: spin 3s linear infinite; }
    #graphPanel .files { margin-top: 10px; }
    #graphPanel .files h4, #graphPanel .files h5 { margin: 0 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #graphPanel .files h5 { margin-top: 6px; }
    #graphPanel .files ul { list-style: none; margin: 0; padding: 0; }
    #graphPanel .files button {
      display: block; width: 100%; text-align: left; font-family: var(--vscode-editor-font-family);
      font-size: 11px; padding: 1px 4px; background: none; border: 0; color: var(--vscode-textLink-foreground);
      cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #graphPanel .files button:hover, #graphPanel .files button:focus-visible { background: var(--vscode-list-hoverBackground); outline: 1px solid var(--vscode-focusBorder); }
    #graphPanel .workers { margin-top: 10px; }
    #graphPanel .workers h4 { margin: 0 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    #graphPanel .worker summary { cursor: pointer; font-size: 11px; }
    #graphPanel .worker summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #graphPanel .worker pre {
      margin: 4px 0 8px; padding: 6px; max-height: 160px; overflow: auto;
      font-family: var(--vscode-editor-font-family); font-size: 11px;
      white-space: pre-wrap; word-break: break-all;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textCodeBlock-background, transparent);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <label for="sessions" class="hint">세션</label>
    <select id="sessions" aria-label="이전 세션"><option value="">새 세션</option></select>
    <button id="newSession" type="button">새 세션</button>
  </div>
  <details id="graphPanel">
    <summary>Task Graph<span id="graphSummary" class="meta"></span></summary>
    <div class="body">
      <div class="head">
        <div id="showRun" class="prompt" role="heading" aria-level="2"></div>
        <button id="retryRun" type="button" hidden>재시도</button>
      </div>
      <p id="graphEmpty" class="empty">표시할 Run이 없습니다.</p>
      <div id="graph" class="graph" hidden>
        <svg id="svg" aria-hidden="true"></svg>
        <ol id="rows" class="rows" aria-label="작업 그래프 (요청부터 아래로 진행)"></ol>
      </div>
      <section id="review" class="review" hidden aria-label="검토">
        <h4>검토</h4>
        <pre id="reviewLines"></pre>
        <button id="mergeBranch" type="button" hidden title="통합 브랜치를 현재 브랜치에 merge 하고 Source Control을 엽니다">현재 브랜치에 merge</button>
        <details><summary>Run 증거</summary><pre id="reviewEvidence"></pre></details>
      </section>
      <section id="files" class="files" hidden aria-label="변경 파일 (클릭하면 diff 열기)">
        <h4>변경 파일 (클릭 → diff)</h4>
        <div id="fileGroups"></div>
      </section>
      <section id="workers" class="workers" hidden aria-label="워커 CLI 출력 (읽기 전용, 정제됨)">
        <h4>워커 CLI</h4>
        <div id="activeWorkers"></div>
        <details id="historyWorkers" hidden>
          <summary>완료 워커 이력</summary>
          <div id="historyList"></div>
        </details>
      </section>
    </div>
  </details>
  <div class="meta"><span id="context">workspace 연결 대기</span> · <span id="status" role="status" aria-live="polite">idle</span></div>
  <div class="messages" id="messages" aria-live="polite" aria-label="대화"></div>
  <pre class="runProgress" id="runProgress" aria-label="Run 진행 상황" hidden></pre>
  <label class="hint chip"><input type="checkbox" id="attach" /> 현재 파일·선택 첨부</label>
  <textarea id="input" aria-label="메시지" placeholder="질문하거나 작업을 요청하세요" aria-describedby="sendHint"></textarea>
  <div class="sendRow">
    <p class="hint" id="sendHint">Ctrl+Enter 보내기 · Esc 중단</p>
    <button id="send" type="button">보내기</button>
  </div>
  <p class="error" id="error" role="alert" hidden></p>
  <div class="usage">
    <div class="row">
      <button id="codexUsage" type="button" aria-describedby="codexUsageText">Codex</button>
      <span id="codexUsageText" class="usageText" aria-live="polite"></span>
    </div>
    <div class="row">
      <button id="geminiUsage" type="button" aria-describedby="geminiUsageText">Gemini</button>
      <span id="geminiUsageText" class="usageText" aria-live="polite"></span>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const input = document.getElementById('input');
    const errorEl = document.getElementById('error');
    const statusEl = document.getElementById('status');
    const contextEl = document.getElementById('context');
    const codexBtn = document.getElementById('codexUsage');
    const geminiBtn = document.getElementById('geminiUsage');
    const codexText = document.getElementById('codexUsageText');
    const geminiText = document.getElementById('geminiUsageText');
    // Hover or keyboard focus on either the button or the text shows the full detail.
    const setUsage = (button, text, line, detail) => {
      text.textContent = line;
      button.title = detail || line;
      text.title = detail || line;
    };
    const sendBtn = document.getElementById('send');
    const sendHint = document.getElementById('sendHint');
    const attachEl = document.getElementById('attach');
    const sessionsEl = document.getElementById('sessions');
    const runProgressEl = document.getElementById('runProgress');
    let busy = false;
    let pendingEl = null;
    function bubble(sender, text, className) {
      const article = document.createElement('article');
      article.className = 'msg ' + className;
      article.setAttribute('aria-label', sender);
      const senderEl = document.createElement('div');
      senderEl.className = 'sender';
      senderEl.textContent = sender;
      const body = document.createElement('div');
      body.textContent = text;
      article.append(senderEl, body);
      return { article, body };
    }
    function showPending(userText) {
      clearPending();
      if (userText) messagesEl.append(bubble('User', userText, 'user').article);
      const pending = bubble('Codex', '생각 중', 'codex pending');
      pending.body.className = 'thinking';
      const live = document.createElement('pre');
      live.className = 'live';
      live.hidden = true;
      pending.article.append(live);
      pendingEl = { article: pending.article, live };
      messagesEl.append(pending.article);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function clearPending() {
      if (pendingEl) pendingEl.article.remove();
      pendingEl = null;
    }
    function renderSessions(items, activeId) {
      sessionsEl.replaceChildren();
      const fresh = document.createElement('option');
      fresh.value = '';
      fresh.textContent = '새 세션';
      sessionsEl.append(fresh);
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.sessionId;
        option.textContent = item.title + ' · ' + item.updatedAt.slice(0, 16).replace('T', ' ');
        sessionsEl.append(option);
      }
      sessionsEl.value = activeId || '';
    }
    let lastRunStatus = 'idle';
    function setError(text) {
      errorEl.hidden = !text;
      errorEl.textContent = text || '';
    }
    function setBusy(active, reason) {
      busy = active;
      if (active && !pendingEl && reason && reason.startsWith('Codex')) showPending(null);
      if (!active) clearPending();
      sendBtn.disabled = active;
      for (const button of messagesEl.querySelectorAll('button')) button.disabled = active;
      statusEl.textContent = active ? reason : lastRunStatus;
    }
    function render(messages) {
      pendingEl = null;
      messagesEl.replaceChildren();
      for (const message of messages) {
        const article = document.createElement('article');
        article.className = 'msg ' + message.sender;
        article.setAttribute('aria-label', message.sender === 'user' ? 'User' : 'Codex');
        const sender = document.createElement('div');
        sender.className = 'sender';
        sender.textContent = message.sender === 'user' ? 'User' : 'Codex';
        const body = document.createElement('div');
        body.textContent = message.text;
        article.append(sender, body);
        if (message.approval && message.approval.status === 'pending') {
          const plan = document.createElement('div');
          plan.className = 'plan';
          const title = document.createElement('strong');
          title.textContent = message.approval.title;
          const explanation = document.createElement('p');
          explanation.textContent = message.approval.explanation;
          plan.append(title, explanation);
          if (message.approval.steps && message.approval.steps.length) {
            const list = document.createElement('ol');
            for (const step of message.approval.steps) {
              const item = document.createElement('li');
              item.textContent = step;
              list.append(item);
            }
            plan.append(list);
          }
          if (message.approval.affectedFiles && message.approval.affectedFiles.length) {
            // Decision 7: each affected file opens in the editor.
            const files = document.createElement('div');
            files.className = 'files';
            for (const file of message.approval.affectedFiles) {
              const button = document.createElement('button');
              button.type = 'button';
              button.textContent = file;
              button.title = file + ' 열기';
              button.addEventListener('click', () => vscode.postMessage({ type: 'openFile', file }));
              files.append(button);
            }
            plan.append(files);
          }
          const approve = document.createElement('button');
          approve.type = 'button';
          approve.textContent = '승인 후 실행';
          approve.setAttribute('aria-label', '계획 승인 후 Run 실행');
          approve.disabled = busy;
          approve.addEventListener('click', () => vscode.postMessage({ type: 'approvePlan' }));
          article.append(plan, approve);
        }
        messagesEl.append(article);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    window.addEventListener('message', event => {
      const data = event.data;
      if (data.type === 'session') render(data.messages || []);
      if (data.type === 'sessions') renderSessions(data.items || [], data.activeSessionId);
      if (data.type === 'error') { clearPending(); setError(data.message); }
      if (data.type === 'progress') {
        if (data.source === 'codex' && pendingEl) {
          pendingEl.live.hidden = data.lines.length === 0;
          pendingEl.live.textContent = data.lines.join('\\n');
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        if (data.source === 'run') {
          runProgressEl.hidden = data.lines.length === 0;
          runProgressEl.textContent = data.lines.join('\\n');
          runProgressEl.classList.toggle('failure', data.tone === 'error');
          runProgressEl.setAttribute('role', data.tone === 'error' ? 'alert' : 'status');
        }
      }
      if (data.type === 'runStatus') {
        lastRunStatus = data.text;
        if (!busy) statusEl.textContent = data.text;
      }
      if (data.type === 'inputMode') {
        sendHint.textContent = data.questionOnly ? 'Run 진행 중 · 질문만 가능' : 'Ctrl+Enter 보내기 · Esc 중단';
        input.placeholder = data.questionOnly ? '진행 중인 Run에 대해 질문하세요' : '질문하거나 작업을 요청하세요';
      }
      if (data.type === 'busy') setBusy(data.active, data.reason);
      if (data.type === 'context') contextEl.textContent = data.text;
      if (data.type === 'usage') {
        if (data.provider === 'codex') setUsage(codexBtn, codexText, data.line, data.detail);
        else setUsage(geminiBtn, geminiText, data.line, data.detail);
      }
    });
    sendBtn.addEventListener('click', () => {
      const text = input.value.trim();
      if (!text || busy) return;
      setError('');
      showPending(text);
      vscode.postMessage({ type: 'chat', text, attachContext: attachEl.checked });
      input.value = '';
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        sendBtn.click();
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      vscode.postMessage({ type: 'cancel' });
    });
    codexBtn.addEventListener('click', () => {
      setUsage(codexBtn, codexText, '조회 중…');
      vscode.postMessage({ type: 'refreshUsage', provider: 'codex' });
    });
    geminiBtn.addEventListener('click', () => {
      setUsage(geminiBtn, geminiText, '조회 중…');
      vscode.postMessage({ type: 'refreshUsage', provider: 'gemini' });
    });
    document.getElementById('newSession').addEventListener('click', () => {
      if (busy) return;
      vscode.postMessage({ type: 'newSession' });
    });
    sessionsEl.addEventListener('change', () => {
      if (busy) { sessionsEl.value = ''; return; }
      if (sessionsEl.value) vscode.postMessage({ type: 'loadSession', sessionId: sessionsEl.value });
      else vscode.postMessage({ type: 'newSession' });
    });

    // Task Graph panel: folded into the header, fed by the same message channel.
    const NS = 'http://www.w3.org/2000/svg';
    const graphPanel = document.getElementById('graphPanel');
    const graphSummaryEl = document.getElementById('graphSummary');
    const graphEmptyEl = document.getElementById('graphEmpty');
    const graphEl = document.getElementById('graph');
    const svg = document.getElementById('svg');
    const rowsEl = document.getElementById('rows');
    const showRunBtn = document.getElementById('showRun');
    const retryRunBtn = document.getElementById('retryRun');
    const filesEl = document.getElementById('files');
    const fileGroupsEl = document.getElementById('fileGroups');
    const reviewEl = document.getElementById('review');
    const reviewLinesEl = document.getElementById('reviewLines');
    const reviewEvidenceEl = document.getElementById('reviewEvidence');
    const mergeBranchBtn = document.getElementById('mergeBranch');
    const workersEl = document.getElementById('workers');
    const activeWorkersEl = document.getElementById('activeWorkers');
    const historyWorkersEl = document.getElementById('historyWorkers');
    const historyListEl = document.getElementById('historyList');
    let openNodeId = null;
    function el(tag, attrs) {
      const node = document.createElementNS(NS, tag);
      for (const key in attrs) node.setAttribute(key, attrs[key]);
      return node;
    }
    function renderGraph(model, message) {
      if (!model) {
        graphEl.hidden = true;
        filesEl.hidden = true;
        graphEmptyEl.hidden = false;
        graphEmptyEl.textContent = message || '표시할 Run이 없습니다.';
        graphSummaryEl.textContent = '';
        showRunBtn.textContent = '';
        retryRunBtn.hidden = true;
        return;
      }
      graphEmptyEl.hidden = true;
      graphEl.hidden = false;
      graphSummaryEl.textContent = 'Run ' + model.runId + ' · ' + model.status;
      showRunBtn.textContent = 'Run ' + model.runId + ' · ' + model.status + ' · ' + model.prompt;
      showRunBtn.title = model.prompt;
      retryRunBtn.hidden = !model.retryable;
      const layout = model.layout;
      svg.replaceChildren();
      svg.setAttribute('width', layout.width);
      svg.setAttribute('height', layout.height);
      for (const seg of layout.passThroughSegments) {
        svg.append(el('line', { x1: seg.x, y1: seg.fromY, x2: seg.x, y2: seg.toY, stroke: seg.color, 'stroke-width': 2, 'stroke-opacity': 0.4 }));
      }
      for (const edge of layout.edges) {
        svg.append(el('path', { d: edge.pathD, stroke: edge.color, 'stroke-width': 2.5, fill: 'none' }));
      }
      for (const item of layout.nodes) {
        if (item.isTip) {
          const ring = el('circle', { cx: item.x, cy: item.y, r: 9, fill: 'none', stroke: item.color, 'stroke-width': 1.5, 'stroke-dasharray': '3 2' });
          ring.setAttribute('class', 'spin');
          svg.append(ring);
        }
        svg.append(el('circle', { cx: item.x, cy: item.y, r: 5, fill: item.node.type === 'merge' ? '#10b981' : item.color, stroke: 'var(--vscode-sideBar-background)', 'stroke-width': 2 }));
      }
      rowsEl.replaceChildren();
      rowsEl.style.paddingLeft = (layout.width + 6) + 'px';
      for (const row of model.rows) {
        const li = document.createElement('li');
        li.className = 'row';
        li.tabIndex = 0;
        li.title = row.tooltip;
        li.setAttribute('role', 'button');
        const text = document.createElement('div');
        text.className = 'text';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = row.label;
        const meta = document.createElement('div');
        meta.className = 'meta';
        const parts = [row.owner, row.status];
        if (row.activity) parts.push(row.activity);
        if (row.elapsedSeconds) parts.push(row.elapsedSeconds + 's');
        meta.textContent = parts.join(' · ');
        text.append(label, meta);
        li.append(text);
        if (row.isTip) {
          const tip = document.createElement('span');
          tip.className = 'badge tip';
          tip.textContent = 'tip';
          li.append(tip);
        }
        const status = document.createElement('span');
        status.className = 'badge ' + row.status;
        status.textContent = row.status;
        li.append(status);
        if (row.retryable) {
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = '이 Run 재시도';
          retry.title = 'Run 전체를 다시 실행합니다 (노드 단위 재실행 아님)';
          retry.addEventListener('click', event => {
            event.stopPropagation();
            vscode.postMessage({ type: 'retry', nodeId: row.id });
          });
          li.append(retry);
        }
        // Node detail unfolds inline; no separate document tab.
        const detail = document.createElement('pre');
        detail.className = 'detail';
        detail.hidden = row.id !== openNodeId;
        detail.textContent = row.detail;
        li.classList.toggle('open', !detail.hidden);
        li.setAttribute('aria-expanded', String(!detail.hidden));
        const open = () => {
          openNodeId = detail.hidden ? row.id : null;
          detail.hidden = !detail.hidden;
          li.classList.toggle('open', !detail.hidden);
          li.setAttribute('aria-expanded', String(!detail.hidden));
        };
        li.addEventListener('click', open);
        li.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
        rowsEl.append(li, detail);
      }
      renderFiles(model.rows);
    }
    // One group per node that changed files; each file opens VS Code's diff editor.
    function renderFiles(rows) {
      const groups = rows.filter(row => row.files && row.files.length > 0);
      filesEl.hidden = groups.length === 0;
      fileGroupsEl.replaceChildren();
      for (const row of groups) {
        const heading = document.createElement('h5');
        heading.textContent = row.label + ' · ' + row.owner;
        const list = document.createElement('ul');
        for (const file of row.files) {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = file;
          button.title = file + ' diff 열기';
          button.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', file }));
          li.append(button);
          list.append(li);
        }
        fileGroupsEl.append(heading, list);
      }
    }
    function renderReview(review) {
      reviewEl.hidden = !review;
      if (!review) return;
      reviewLinesEl.textContent = review.lines.join('\\n');
      reviewEvidenceEl.textContent = review.evidence;
      mergeBranchBtn.hidden = !review.integrationBranch;
    }
    function workerBlock(worker, open) {
      const details = document.createElement('details');
      details.className = 'worker';
      details.open = open;
      const summary = document.createElement('summary');
      summary.textContent = [worker.taskId, worker.task, worker.model, worker.status, worker.elapsedSeconds + 's']
        .filter(Boolean).join(' · ');
      const pre = document.createElement('pre');
      pre.setAttribute('role', 'log');
      pre.setAttribute('aria-live', 'polite');
      pre.textContent = worker.logs.length ? worker.logs.join('\\n') : '로그를 대기하고 있습니다.';
      details.append(summary, pre);
      return details;
    }
    function renderWorkers(active, history) {
      workersEl.hidden = active.length === 0 && history.length === 0;
      activeWorkersEl.replaceChildren(...active.map(worker => workerBlock(worker, true)));
      historyWorkersEl.hidden = history.length === 0;
      historyListEl.replaceChildren(...history.map(worker => workerBlock(worker, false)));
      for (const pre of activeWorkersEl.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight;
    }
    window.addEventListener('message', event => {
      const data = event.data;
      if (data.type === 'graph') renderGraph(data.model, data.message);
      if (data.type === 'workers') renderWorkers(data.active || [], data.history || []);
      if (data.type === 'review') renderReview(data.review);
      if (data.type === 'revealGraph') graphPanel.open = true;
    });
    mergeBranchBtn.addEventListener('click', () => vscode.postMessage({ type: 'mergeBranch' }));
    retryRunBtn.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
