'use client';

import { PreferencesPanel } from '../../components/settings/preferences-panel';
import { WorkspaceShell } from '../../components/workspace-shell';

export default function SettingsPage() {
  return (
    <WorkspaceShell activeTab="settings">
      <PreferencesPanel />
    </WorkspaceShell>
  );
}
