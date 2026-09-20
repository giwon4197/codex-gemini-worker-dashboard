import * as vscode from 'vscode';
import { COMMANDS, CONVERSATION_VIEW_ID } from './ids';
import { ConversationViewProvider } from './webview/conversation-view';
import { RunStatusBar } from './status-bar';
import { registerTaskGraph } from './task-graph-view';
import { sanitizeUiError, syncWorkerSettings } from './core-host';
import { getWorkspaceRoot } from './vscode-context';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexReasoningEffort } from '../../packages/orchestrator-core/worker-settings.ts';

/** Pushes VS Code settings into the workspace state shared with the web UI. */
async function pushWorkerSettings(runtimeRoot: string): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;
  if (!fs.existsSync(path.join(runtimeRoot, 'codex-router.ps1'))) {
    void vscode.window.showWarningMessage('Extension에 bundled orchestration runtime이 없어 워커 설정을 저장하지 않았습니다.');
    return;
  }
  const config = vscode.workspace.getConfiguration('coxgem');
  const result = await syncWorkerSettings(root, {
    tier: config.get<string>('workerTier') || 'normal',
    codexModel: config.get<string>('codexModel'),
    codexReasoningEffort: config.get<CodexReasoningEffort>('codexReasoningEffort'),
  });
  if (!result.ok) throw new Error(result.error);
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    const runtimeRoot = vscode.Uri.joinPath(context.extensionUri, 'runtime').fsPath;
    const statusBar = new RunStatusBar();
    const provider = new ConversationViewProvider(context, statusBar);
    const taskGraph = registerTaskGraph(context, statusBar);
    provider.setRunFollowUp(taskGraph);
    taskGraph.onGraph = graph => provider.showRunProgress(graph);

    const run = (action: () => Promise<void>) => () =>
      action().catch(error => {
        void vscode.window.showErrorMessage(sanitizeUiError(error, getWorkspaceRoot()));
      });

    context.subscriptions.push(
      statusBar,
      vscode.window.registerWebviewViewProvider(CONVERSATION_VIEW_ID, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void provider.startFreshWindow();
      }),
      // Keeps the context line (and what the attach chip would send) current.
      vscode.window.onDidChangeActiveTextEditor(() => {
        void provider.postContext();
      }),
      // Only a user edit writes the file; activation never overwrites what the web UI saved.
      vscode.workspace.onDidChangeConfiguration(event => {
        if (
          event.affectsConfiguration('coxgem.workerTier') ||
          event.affectsConfiguration('coxgem.codexModel') ||
          event.affectsConfiguration('coxgem.codexReasoningEffort')
        ) {
          run(() => pushWorkerSettings(runtimeRoot))();
          void provider.refreshAuthModelState(false);
        }
      }),
      vscode.commands.registerCommand(COMMANDS.openWorkspace, run(() => provider.openWorkspace())),
      vscode.commands.registerCommand(COMMANDS.explainSelection, run(() => provider.explainSelection())),
      vscode.commands.registerCommand(COMMANDS.planFixForSelection, run(() => provider.planFixForSelection())),
      vscode.commands.registerCommand(COMMANDS.showActiveRun, run(() => provider.showActiveRun())),
      vscode.commands.registerCommand(COMMANDS.reviewChanges, run(() => provider.reviewChanges())),
      vscode.commands.registerCommand(COMMANDS.refreshUsage, run(() => provider.refreshUsage()))
    );

    void provider.restoreWindow();
  } catch (error) {
    void vscode.window.showErrorMessage(sanitizeUiError(error, getWorkspaceRoot()));
  }
}

export function deactivate(): void {}
