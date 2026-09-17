import * as vscode from 'vscode';
import { COMMANDS } from './ids';
import { statusBarLabel } from './restore-state';

export class RunStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
    this.item.command = COMMANDS.openWorkspace;
    this.setStatus('idle');
    this.item.show();
  }

  setStatus(status: string, unlinkedActiveRuns = 0): void {
    this.item.text = statusBarLabel(status, unlinkedActiveRuns);
    // An unlinked in-flight run is one click away instead of hidden behind the palette.
    this.item.command = unlinkedActiveRuns > 0 ? COMMANDS.showActiveRun : COMMANDS.openWorkspace;
    this.item.tooltip =
      unlinkedActiveRuns > 0
        ? `Codex × Gemini · Run: ${status} · 다른 창에서 시작한 Run ${unlinkedActiveRuns}개 진행 중 (클릭하여 표시)`
        : `Codex × Gemini · Run: ${status}`;
    this.item.accessibilityInformation = {
      label: `Codex × Gemini run status ${status}`,
      role: 'button',
    };
  }

  dispose(): void {
    this.item.dispose();
  }
}
