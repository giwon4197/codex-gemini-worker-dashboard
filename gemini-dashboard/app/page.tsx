'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { WorkspaceShell } from '../components/workspace-shell';
import { ConversationWorkspace } from '../components/conversation-workspace';
import type {
  RunDetail,
  CompactRunState,
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

  // Fetch runs list
  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs?t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; runs?: CompactRunState[] };
      if (data.ok && Array.isArray(data.runs)) {
        setRuns(data.runs);
        // Auto-select latest run if none selected
        if (data.runs.length > 0) {
          setSelectedRunId(prev => (prev ? prev : data.runs![0].runId));
        }
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
      const data = await res.json() as { ok: boolean; run?: RunDetail };
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
      const data = await res.json() as { ok: boolean; activeWorkers?: unknown[] };
      if (data.ok && Array.isArray(data.activeWorkers)) {
        setActiveWorkersCount(data.activeWorkers.length);
      }
    } catch {
      // Ignore
    }
  }, []);

  // Initial load and periodic polling
  useEffect(() => {
    let isCancelled = false;

    const pollRunsAndWorkers = async () => {
      try {
        const [runsRes, workersRes] = await Promise.all([
          fetch(`/api/runs?t=${Date.now()}`),
          fetch(`/api/projects/current/workers?t=${Date.now()}`),
        ]);
        if (isCancelled) return;

        if (runsRes.ok) {
          const runsData = await runsRes.json() as { ok: boolean; runs?: CompactRunState[] };
          if (runsData.ok && Array.isArray(runsData.runs) && !isCancelled) {
            setRuns(runsData.runs);
            if (runsData.runs.length > 0) {
              setSelectedRunId(prev => (prev ? prev : runsData.runs![0].runId));
            }
          }
        }

        if (workersRes.ok && !isCancelled) {
          const workersData = await workersRes.json() as { ok: boolean; activeWorkers?: unknown[] };
          if (workersData.ok && Array.isArray(workersData.activeWorkers)) {
            setActiveWorkersCount(workersData.activeWorkers.length);
          }
        }
      } catch {
        // Ignore background poll errors
      }
    };

    void pollRunsAndWorkers();
    const interval = setInterval(() => {
      void pollRunsAndWorkers();
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
        const data = await res.json() as { ok: boolean; run?: RunDetail };
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
    await fetchActiveWorkersCount();
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
        currentRun={currentRun}
        recentRuns={runs}
        onSelectRun={runId => {
          setSelectedRunId(runId);
          void fetchRunDetail(runId);
        }}
        onRefresh={handleRefresh}
      />
    </WorkspaceShell>
  );
}