export const VIEW_CONTAINER_ID = 'coxgem';
export const CONVERSATION_VIEW_ID = 'coxgem.conversation';

export const COMMANDS = {
  openWorkspace: 'coxgem.openWorkspace',
  explainSelection: 'coxgem.explainSelection',
  planFixForSelection: 'coxgem.planFixForSelection',
  showActiveRun: 'coxgem.showActiveRun',
  reviewChanges: 'coxgem.reviewChanges',
  refreshUsage: 'coxgem.refreshUsage',
  refreshTaskTree: 'coxgem.refreshTaskTree',
} as const;

export const SESSION_STATE_KEY = 'coxgem.sessionId';
export const TRACKED_RUN_KEY = 'coxgem.trackedRunId';
export const USAGE_CACHE_KEY = 'coxgem.usageCache';

export interface UsageCache {
  codex?: { line: string; detail?: string; at: string };
  gemini?: { line: string; detail?: string; at: string };
}
