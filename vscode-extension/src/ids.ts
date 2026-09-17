export const VIEW_CONTAINER_ID = 'codexGemini';
export const CONVERSATION_VIEW_ID = 'codexGemini.conversation';

export const COMMANDS = {
  openWorkspace: 'codexGemini.openWorkspace',
  explainSelection: 'codexGemini.explainSelection',
  planFixForSelection: 'codexGemini.planFixForSelection',
  showActiveRun: 'codexGemini.showActiveRun',
  reviewChanges: 'codexGemini.reviewChanges',
  refreshUsage: 'codexGemini.refreshUsage',
  refreshTaskTree: 'codexGemini.refreshTaskTree',
} as const;

export const SESSION_STATE_KEY = 'codexGemini.sessionId';
export const TRACKED_RUN_KEY = 'codexGemini.trackedRunId';
export const USAGE_CACHE_KEY = 'codexGemini.usageCache';

export interface UsageCache {
  codex?: { line: string; detail?: string; at: string };
  gemini?: { line: string; detail?: string; at: string };
}
