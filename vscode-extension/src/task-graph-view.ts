import * as vscode from 'vscode';
import { COMMANDS, TRACKED_RUN_KEY } from './ids';
import { createGitRunner, getRunRefs, getRunWorkers, getWorkGraph, retryTrackedRun, sanitizeUiError, type RunWorkerView } from './core-host';
import { gatherReviewExtras, getWorkspaceRoot, mergeBranchIntoCurrent, openFileDiff } from './vscode-context';
import { buildGraphViewModel, formatReviewLines, formatRunEvidence, shouldPollRun, type GraphViewModel } from './graph-tree';
import { TERMINAL_RUN_STATUSES } from './protocol';
import { formatDirtyWorktreeMessage, readGitDirtyFiles } from './workspace-context';
import type { ProjectWorkGraphData } from '../../packages/orchestrator-core/project-event-graph.ts';
import type { RunStatusBar } from './status-bar';

type GraphToHost =
  | { type: 'retry'; nodeId?: string }
  | { type: 'openDiff'; file: string }
  | { type: 'mergeBranch' };

type WorkerLists = { active: RunWorkerView[]; history: RunWorkerView[]; failure?: string[] };

/** Review section shown once the run stops: summary lines, full evidence, branch to open. */
type ReviewSection = { lines: string[]; evidence: string; integrationBranch?: string };

type HostToGraph =
  | { type: 'graph'; model: GraphViewModel | null; message?: string }
  | ({ type: 'workers' } & WorkerLists)
  | { type: 'review'; review: ReviewSection | null }
  | { type: 'revealGraph' };

const NO_WORKERS: WorkerLists = { active: [], history: [] };
const GRAPH_MESSAGE_TYPES = new Set(['retry', 'openDiff', 'mergeBranch']);

/** Drives the Task Graph panel that lives inside the conversation webview. */
export class TaskGraphPanel {
  private webview?: vscode.Webview;
  private model: GraphViewModel | null = null;
  private graph: ProjectWorkGraphData | null = null;
  private workers: WorkerLists = NO_WORKERS;
  private review: ReviewSection | null = null;
  private poll?: ReturnType<typeof setInterval>;
  private retrying = false;
  /** Called with every refreshed graph so the conversation can show live progress. */
  onGraph?: (graph: ProjectWorkGraphData | null, failure?: string[]) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar: RunStatusBar
  ) {}

  /** Binds to the conversation webview; the panel shares its message channel. */
  attach(webview: vscode.Webview): void {
    this.webview = webview;
    webview.onDidReceiveMessage((message: GraphToHost) => {
      if (!GRAPH_MESSAGE_TYPES.has(message.type)) return;
      void this.onMessage(message).catch(error => {
        void vscode.window.showErrorMessage(sanitizeUiError(error, getWorkspaceRoot()));
      });
    });
    this.post({ type: 'graph', model: this.model });
    this.post({ type: 'workers', ...this.workers });
    this.post({ type: 'review', review: this.review });
  }

  async trackRun(runId?: string): Promise<void> {
    if (runId) await this.context.workspaceState.update(TRACKED_RUN_KEY, runId);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      this.setModel(null, null, '열려 있는 작업 폴더가 없습니다.');
      return;
    }
    const tracked = this.context.workspaceState.get<string>(TRACKED_RUN_KEY);
    if (!tracked) {
      this.setModel(null, null, '표시할 Run이 없습니다. 계획을 승인한 뒤에 나타납니다.');
      return;
    }
    try {
      const graph = await getWorkGraph(root, tracked);
      const model = buildGraphViewModel(graph);
      this.setModel(graph, model, model ? undefined : '표시할 Run이 없습니다. 계획을 승인한 뒤에 나타납니다.');
      if (graph) this.statusBar.setStatus(graph.status || 'idle');
      this.setWorkers(graph ? await getRunWorkers(root, graph.runId) : NO_WORKERS);
      this.setReview(graph && TERMINAL_RUN_STATUSES.has(graph.status) ? await this.buildReview(root, graph) : null);
    } catch (error) {
      this.setModel(null, null, sanitizeUiError(error, root));
      this.setWorkers(NO_WORKERS);
      this.setReview(null);
    }
  }

  private async buildReview(root: string, graph: ProjectWorkGraphData): Promise<ReviewSection> {
    const refs = await getRunRefs(root, graph.runId);
    const extras = await gatherReviewExtras({ workspaceRoot: root, gitRunner: createGitRunner(), ...refs });
    return {
      lines: formatReviewLines(graph, extras),
      evidence: formatRunEvidence(graph, extras),
      integrationBranch: refs.integrationBranch,
    };
  }

  private setReview(review: ReviewSection | null): void {
    this.review = review;
    this.post({ type: 'review', review });
  }

  private setWorkers(workers: WorkerLists): void {
    this.workers = workers;
    this.post({ type: 'workers', ...workers });
    // The chat mirrors the failure block so the user sees why without opening a node.
    if (workers.failure?.length) this.onGraph?.(this.graph, workers.failure);
  }

  /** Clears the tracked run so a new conversation starts with an empty graph. */
  async reset(): Promise<void> {
    await this.context.workspaceState.update(TRACKED_RUN_KEY, undefined);
    this.setModel(null, null, '표시할 Run이 없습니다. 계획을 승인한 뒤에 나타납니다.');
    this.setWorkers(NO_WORKERS);
    this.setReview(null);
  }

  /** Unfolds the panel so the graph (and its review section) is on screen. */
  reveal(): void {
    this.post({ type: 'revealGraph' });
  }

  dispose(): void {
    this.stopPolling();
  }

  private setModel(graph: ProjectWorkGraphData | null, model: GraphViewModel | null, message?: string): void {
    this.graph = graph;
    this.model = model;
    if (graph && shouldPollRun(graph.status)) this.startPolling();
    else this.stopPolling();
    this.post({ type: 'graph', model, message });
    this.onGraph?.(graph);
  }

  private async onMessage(message: GraphToHost): Promise<void> {
    if (message.type === 'mergeBranch') {
      const root = getWorkspaceRoot();
      if (root && this.review?.integrationBranch) {
        await mergeBranchIntoCurrent(root, this.review.integrationBranch, createGitRunner());
      }
      return;
    }
    if (message.type === 'retry') {
      await this.retry(message.nodeId);
      return;
    }
    if (message.type === 'openDiff') {
      const root = getWorkspaceRoot();
      if (!root || !this.graph) return;
      await openFileDiff(root, message.file, await getRunRefs(root, this.graph.runId), createGitRunner());
    }
  }

  private async retry(nodeId?: string): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root || !this.model || this.retrying) return;
    const retryable = nodeId
      ? this.model.rows.find(row => row.id === nodeId)?.retryable
      : this.model.retryable;
    if (!retryable) {
      void vscode.window.showWarningMessage('이 노드는 재시도할 수 없습니다.');
      return;
    }
    this.retrying = true;
    try {
      // Same gate as approval: the router refuses a dirty tree, so do not burn a retry on it.
      const dirty = await readGitDirtyFiles(root, createGitRunner());
      if (dirty.length > 0) {
        const pick = await vscode.window.showWarningMessage(
          `커밋되지 않은 변경 ${dirty.length}개가 있어 재시도하지 않았습니다. commit 또는 stash 후 다시 누르세요.`,
          { detail: formatDirtyWorktreeMessage(dirty), modal: false },
          '소스 제어 열기'
        );
        if (pick) await vscode.commands.executeCommand('workbench.view.scm');
        return;
      }
      const result = await retryTrackedRun({
        runId: this.model.runId,
        repoRoot: root,
        runtimeRoot: vscode.Uri.joinPath(this.context.extensionUri, 'runtime').fsPath,
      });
      if (!result.ok) {
        void vscode.window.showErrorMessage(sanitizeUiError(result.error || '재시도에 실패했습니다.', root));
        return;
      }
      await this.trackRun(result.runId);
    } finally {
      this.retrying = false;
    }
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => void this.refresh(), 2500);
  }

  private stopPolling(): void {
    if (!this.poll) return;
    clearInterval(this.poll);
    this.poll = undefined;
  }

  private post(message: HostToGraph): void {
    void this.webview?.postMessage(message);
  }
}

export function registerTaskGraph(
  context: vscode.ExtensionContext,
  statusBar: RunStatusBar
): TaskGraphPanel {
  const panel = new TaskGraphPanel(context, statusBar);
  context.subscriptions.push(
    panel,
    vscode.commands.registerCommand(COMMANDS.refreshTaskTree, () => panel.refresh())
  );
  return panel;
}
