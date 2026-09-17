import * as vscode from 'vscode';
import path from 'node:path';
import type { DiagnosticContext, EditorContext, GitRunner } from './workspace-context';
import { isMergeInProgress, mergeBranch, readGitDiffSummary } from './workspace-context';
import type { RunEvidenceExtras } from './graph-tree';

export function getWorkspaceRoot(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function collectEditorContext(
  workspaceRoot?: string,
  git?: { branch?: string; head?: string }
): EditorContext {
  const editor = vscode.window.activeTextEditor;
  const diagnostics = editor
    ? vscode.languages.getDiagnostics(editor.document.uri).map(item => ({
        file: editor.document.uri.fsPath,
        message: item.message,
        severity: vscode.DiagnosticSeverity[item.severity] || 'Error',
      }))
    : [];

  return {
    workspaceRoot,
    branch: git?.branch,
    head: git?.head,
    activeFile: editor?.document.uri.fsPath,
    selectedText: editor ? editor.document.getText(editor.selection) : undefined,
    selectionRange:
      editor && !editor.selection.isEmpty
        ? { start: editor.selection.start.line + 1, end: editor.selection.end.line + 1 }
        : undefined,
    languageId: editor?.document.languageId,
    openFiles: vscode.workspace.textDocuments
      .filter(document => !document.isUntitled && document.uri.scheme === 'file')
      .map(document => document.uri.fsPath)
      .slice(0, 20),
    diagnostics,
  };
}

export function collectWorkspaceProblems(limit = 30): DiagnosticContext[] {
  const items: DiagnosticContext[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue;
    for (const item of diagnostics) {
      items.push({
        file: uri.fsPath,
        message: item.message,
        severity: vscode.DiagnosticSeverity[item.severity] || 'Error',
      });
    }
  }
  const rank = (severity: string) => (severity === 'Error' ? 0 : severity === 'Warning' ? 1 : 2);
  return items.sort((left, right) => rank(left.severity) - rank(right.severity)).slice(0, limit);
}

export async function gatherReviewExtras(options: {
  workspaceRoot: string;
  gitRunner: GitRunner;
  integrationBranch?: string;
  baseCommit?: string;
}): Promise<RunEvidenceExtras> {
  const range = options.integrationBranch
    ? `${options.baseCommit || 'HEAD'}...${options.integrationBranch}`
    : undefined;
  return {
    integrationBranch: options.integrationBranch,
    diffSummary: await readGitDiffSummary(options.workspaceRoot, options.gitRunner, range),
    problems: collectWorkspaceProblems(),
  };
}

/** A `git:` URI the built-in Git extension resolves to `git show <ref>:<file>`; same shape as its own toGitUri. */
function gitUri(fsPath: string, ref: string): vscode.Uri {
  const file = vscode.Uri.file(fsPath);
  return file.with({ scheme: 'git', query: JSON.stringify({ path: file.fsPath, ref }) });
}

/** Opens the run's change to `file` in VS Code's diff editor: base commit vs integration branch. */
export async function openFileDiff(
  workspaceRoot: string,
  file: string,
  refs: { baseCommit?: string; integrationBranch?: string },
  gitRunner: GitRunner
): Promise<void> {
  const fsPath = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
  const baseRef = refs.baseCommit || 'HEAD';
  // Without an integration branch the change is only in the working tree.
  const head = refs.integrationBranch ? gitUri(fsPath, refs.integrationBranch) : vscode.Uri.file(fsPath);
  // A file the run added has no base side; the Git extension itself opens such files plainly.
  const relative = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
  const atBase = await gitRunner(['cat-file', '-e', `${baseRef}:${relative}`], workspaceRoot);
  if (atBase.exitCode !== 0) {
    await vscode.commands.executeCommand('vscode.open', head, { preview: true });
    return;
  }
  const title = `${path.basename(fsPath)} (${baseRef.slice(0, 7)} ↔ ${refs.integrationBranch || 'working tree'})`;
  await vscode.commands.executeCommand('vscode.diff', gitUri(fsPath, baseRef), head, title, { preview: true });
}

/** Opens `file` (workspace-relative or absolute) in an editor tab. */
export async function openWorkspaceFile(workspaceRoot: string, file: string): Promise<void> {
  const fsPath = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
  await vscode.window.showTextDocument(vscode.Uri.file(fsPath), { preview: true });
}

/**
 * End of the review Gate: merge the integration branch into the checked-out branch.
 * Checkout is not an option because the branch already lives in its `.agent/integration` worktree.
 */
export async function mergeBranchIntoCurrent(
  workspaceRoot: string,
  branch: string,
  gitRunner: GitRunner
): Promise<void> {
  const result = await mergeBranch(workspaceRoot, gitRunner, branch);
  if (!result.ok) {
    // A conflict leaves git mid-merge on purpose: the user resolves it in VS Code or backs out.
    if (!(await isMergeInProgress(workspaceRoot, gitRunner))) throw new Error(result.error);
    const pick = await vscode.window.showWarningMessage(
      `${branch} merge 중 충돌이 났습니다. 충돌을 해결한 뒤 commit 하거나 merge를 취소하세요.`,
      { detail: result.error, modal: false },
      'Source Control에서 해결',
      'merge 취소'
    );
    if (pick === 'merge 취소') await gitRunner(['merge', '--abort'], workspaceRoot);
    else if (pick) await vscode.commands.executeCommand('workbench.view.scm');
    return;
  }
  void vscode.window.showInformationMessage(`${branch} 를 현재 브랜치에 merge 했습니다.`);
  await vscode.commands.executeCommand('workbench.view.scm');
}
