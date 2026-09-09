'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { WorkspaceShell } from '../components/workspace-shell';
import { ConversationWorkspace } from '../components/conversation-workspace';
import type {
  RunDetail,
  CompactRunState,
  ConversationSession,
  LiveWorkerData,
  WorkerStatus,
  LiveWorkerLog,
  LiveWorkerPolicy,
  LiveWorkerVerificationCommand,
  LiveWorkerVerification,
  LiveWorkerEscalation,
  LiveWorkerRetryRecord,
} from '../lib/workspace-contract';
import {
  WORKER_STATUS_META,
  normalizeWorkerStatus,
  formatDuration,
} from '../lib/workspace-contract';

// Backward-compatible schema exports
export interface DailyActivity {
  date: string;
  completedJobs: number;
  tokens: number;
  estimatedSavingsPct: number;
  codexSharePct: number;
  geminiSharePct: number;
}

export interface CodexDailyEntry {
  date: string;
  totalTokens: number;
  cachedInputTokens: number;
  activeTokens: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexRateLimitWindow {
  usedPercent?: number | null;
  remainingPercent?: number | null;
  windowMinutes?: number | null;
  resetsAt?: string | number | null;
}

export interface CodexCreditsInfo {
  balance?: number | string | null;
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
}

export interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: CodexCreditsInfo | null;
  planType?: string | null;
}

export interface CodexAccountUsageState {
  status: 'idle' | 'loaded' | 'unavailable' | 'error';
  rateLimits: CodexRateLimits | null;
  errorMessage?: string | null;
  lastSyncedAt?: string | null;
}

export interface GeminiQuotaPool {
  id: string;
  name: string;
  window: '5h' | 'weekly';
  usedPercent: number | null;
  remainingPercent: number | null;
  resetTime: string | null;
  remainingDurationText: string | null;
  isAvailable: boolean;
}

export interface GeminiQuotaSnapshot {
  fiveHour: GeminiQuotaPool | null;
  weekly: GeminiQuotaPool | null;
  description: string | null;
}

export interface GeminiQuotaResponse {
  ok: boolean;
  status: 'available' | 'unavailable' | 'error';
  quota: GeminiQuotaSnapshot | null;
  lastSyncedAt: string;
  cached?: boolean;
  message?: string;
}

export interface GeminiQuotaState {
  status: 'idle' | 'loaded' | 'unavailable' | 'error';
  quota: GeminiQuotaSnapshot | null;
  errorMessage?: string | null;
  lastSyncedAt?: string | null;
}

export type LiveWorkerStatus = WorkerStatus;
export type {
  LiveWorkerData,
  LiveWorkerLog,
  LiveWorkerPolicy,
  LiveWorkerVerificationCommand,
  LiveWorkerVerification,
  LiveWorkerEscalation,
  LiveWorkerRetryRecord,
};

export const WORKER_STATUS_CONFIG = WORKER_STATUS_META;

export function getWorkerStatusConfig(status?: string) {
  const norm = normalizeWorkerStatus(status);
  return WORKER_STATUS_META[norm] || WORKER_STATUS_META.running;
}

export function formatDurationSeconds(seconds: number): string {
  return formatDuration(seconds);
}

export default function Home() {
  const [runs, setRuns] = useState<CompactRunState[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<RunDetail | null>(null);
  const [activeWorkersCount, setActiveWorkersCount] = useState<number>(0);

  // Conversation session state
  const [session, setSession] = useState<ConversationSession | null>(null);
  const [sessions, setSessions] = useState<ConversationSession[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  // Fetch runs list
  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; runs?: CompactRunState[] };
      if (data.ok && Array.isArray(data.runs)) {
        setRuns(data.runs);
      }
    } catch {
      // Ignore background poll errors
    }
  }, []);

  // Fetch conversations list & active session
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        ok: boolean;
        sessions?: ConversationSession[];
        session?: ConversationSession;
      };
      if (data.ok) {
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions);
        }
        if (data.session) {
          setSession(prev => {
            if (!prev) return data.session!;
            // Only update if active session matches
            if (prev.sessionId === data.session!.sessionId) {
              return data.session!;
            }
            return prev;
          });
        }
      }
    } catch {
      // Ignore background poll errors
    }
  }, []);

  // Fetch specific session details
  const fetchSessionDetail = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/conversations/${sessionId}?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; session?: ConversationSession };
      if (data.ok && data.session) {
        setSession(data.session);
      }
    } catch {
      // Ignore background poll errors
    }
  }, []);

  // Fetch selected run details
  const fetchRunDetail = useCallback(async (runId: string) => {
    try {
      const res = await fetch(`/api/runs/${runId}?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; run?: RunDetail };
      if (data.ok && data.run) {
        setCurrentRun(data.run);
      }
    } catch {
      // Ignore background poll errors
    }
  }, []);

  // Fetch active worker count for sidebar badge
  const fetchActiveWorkersCount = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/current/workers?t=${Date.now()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { ok: boolean; activeWorkers?: unknown[] };
      if (data.ok && Array.isArray(data.activeWorkers)) {
        setActiveWorkersCount(data.activeWorkers.length);
      }
    } catch {
      // Ignore
    }
  }, []);

  // Handle sending message to Codex conversation
  const handleSendMessage = async (message: string) => {
    setIsSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session?.sessionId,
          message,
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        session?: ConversationSession;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.session) {
        setSendError(data.error || 'Codex 응답 생성에 실패했습니다.');
        return;
      }

      setSession(data.session);
      await fetchConversations();
      await fetchRuns();
      await fetchActiveWorkersCount();
    } catch {
      setSendError('서버와의 통신에 실패했습니다. 대시보드 상태를 확인하세요.');
    } finally {
      setIsSending(false);
    }
  };

  // Handle approving execution plan
  const handleApprovePlan = async (sessionId: string, approvalId: string) => {
    setIsApproving(true);
    setApprovalError(null);
    try {
      const res = await fetch(`/api/conversations/${sessionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        runId?: string;
        session?: ConversationSession;
        error?: string;
      };

      if (!res.ok || !data.ok) {
        setApprovalError(data.error || '작업 승인에 실패했습니다.');
        return;
      }

      if (data.session) {
        setSession(data.session);
      } else {
        await fetchSessionDetail(sessionId);
      }

      await fetchRuns();
      await fetchActiveWorkersCount();

      if (data.runId) {
        setSelectedRunId(data.runId);
        await fetchRunDetail(data.runId);
      }
    } catch {
      setApprovalError('승인 요청 처리 중 네트워크 오류가 발생했습니다.');
    } finally {
      setIsApproving(false);
    }
  };

  // Handle starting a new conversation session
  const handleNewSession = async () => {
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: '새로운 작업을 시작하겠습니다.',
        }),
      });
      const data = (await res.json()) as { ok: boolean; session?: ConversationSession };
      if (data.ok && data.session) {
        setSession(data.session);
        await fetchConversations();
      }
    } catch {
      // Ignore
    }
  };

  // Initial load and periodic polling
  useEffect(() => {
    let isCancelled = false;

    const pollAll = async () => {
      try {
        const [runsRes, workersRes, convRes] = await Promise.all([
          fetch(`/api/runs?t=${Date.now()}`),
          fetch(`/api/projects/current/workers?t=${Date.now()}`),
          fetch(`/api/conversations?t=${Date.now()}`),
        ]);
        if (isCancelled) return;

        if (runsRes.ok) {
          const runsData = (await runsRes.json()) as { ok: boolean; runs?: CompactRunState[] };
          if (runsData.ok && Array.isArray(runsData.runs) && !isCancelled) {
            setRuns(runsData.runs);
          }
        }

        if (workersRes.ok && !isCancelled) {
          const workersData = (await workersRes.json()) as { ok: boolean; activeWorkers?: unknown[] };
          if (workersData.ok && Array.isArray(workersData.activeWorkers)) {
            setActiveWorkersCount(workersData.activeWorkers.length);
          }
        }

        if (convRes.ok && !isCancelled) {
          const convData = (await convRes.json()) as {
            ok: boolean;
            sessions?: ConversationSession[];
            session?: ConversationSession;
          };
          if (convData.ok) {
            if (Array.isArray(convData.sessions)) {
              setSessions(convData.sessions);
            }
            if (convData.session) {
              setSession(prev => {
                if (!prev) return convData.session!;
                if (prev.sessionId === convData.session!.sessionId) {
                  return convData.session!;
                }
                return prev;
              });
            }
          }
        }
      } catch {
        // Ignore background poll errors
      }
    };

    void pollAll();
    const interval = setInterval(() => {
      void pollAll();
    }, 2500);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, []);

  // When selected run changes or periodically update active run
  useEffect(() => {
    if (!selectedRunId) return;
    let isCancelled = false;

    const pollCurrentRun = async () => {
      try {
        const res = await fetch(`/api/runs/${selectedRunId}?t=${Date.now()}`);
        if (!res.ok || isCancelled) return;
        const data = (await res.json()) as { ok: boolean; run?: RunDetail };
        if (data.ok && data.run && !isCancelled) {
          setCurrentRun(data.run);
        }
      } catch {
        // Ignore background poll errors
      }
    };

    void pollCurrentRun();
    const runInterval = setInterval(() => {
      void pollCurrentRun();
    }, 2500);

    return () => {
      isCancelled = true;
      clearInterval(runInterval);
    };
  }, [selectedRunId]);

  const handleRefresh = async () => {
    await fetchRuns();
    await fetchConversations();
    await fetchActiveWorkersCount();
    if (session) {
      await fetchSessionDetail(session.sessionId);
    }
    if (selectedRunId) {
      await fetchRunDetail(selectedRunId);
    }
  };

  return (
    <WorkspaceShell
      activeTab="workspace"
      activeWorkersCount={activeWorkersCount}
    >
      <ConversationWorkspace
        session={session}
        sessions={sessions}
        currentRun={currentRun}
        recentRuns={runs}
        onSelectSession={sessionId => {
          void fetchSessionDetail(sessionId);
        }}
        onNewSession={handleNewSession}
        onSendMessage={handleSendMessage}
        onApprovePlan={handleApprovePlan}
        isSending={isSending}
        isApproving={isApproving}
        sendError={sendError}
        approvalError={approvalError}
        onSelectRun={runId => {
          setSelectedRunId(runId);
          void fetchRunDetail(runId);
        }}
        onRefresh={handleRefresh}
      />
    </WorkspaceShell>
  );
}