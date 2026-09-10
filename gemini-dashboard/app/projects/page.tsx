'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { WorkspaceShell } from '../../components/workspace-shell';
import { ProjectControl } from '../../components/project-control';
import type {
  LiveWorkerData,
  CompactRunState,
} from '../../lib/workspace-contract';
import type { ProjectWorkGraphData } from '../../lib/project-event-graph';
import { getSharedRunTracker, RunLifecycleCoordinator } from '../../lib/run-tracking';

const STORAGE_KEY_RUN = 'gemini_dashboard_selected_project_run';
const STORAGE_KEY_NODE = 'gemini_dashboard_selected_graph_node';

export default function ProjectsPage() {
  const [activeWorkers, setActiveWorkers] = useState<LiveWorkerData[]>([]);
  const [historyWorkers, setHistoryWorkers] = useState<LiveWorkerData[]>([]);
  const [graph, setGraph] = useState<ProjectWorkGraphData | null>(null);
  const [runs, setRuns] = useState<CompactRunState[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(() => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        return window.sessionStorage.getItem(STORAGE_KEY_RUN) || undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(() => {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        return window.sessionStorage.getItem(STORAGE_KEY_NODE) || undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [pendingNewRun, setPendingNewRun] = useState<CompactRunState | null>(null);

  const trackerRef = useRef(getSharedRunTracker());
  const lifecycleRef = useRef(new RunLifecycleCoordinator());

  const selectedRunIdRef = useRef(selectedRunId);
  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const fetchWorkers = useCallback(async (runIdToFetch?: string) => {
    const activeRunId = runIdToFetch !== undefined ? runIdToFetch : selectedRunIdRef.current;
    const handle = lifecycleRef.current.startLifecycle(activeRunId || 'all');

    try {
      const url = activeRunId
        ? `/api/projects/current/workers?runId=${encodeURIComponent(activeRunId)}&t=${Date.now()}`
        : `/api/projects/current/workers?t=${Date.now()}`;

      const res = await fetch(url, { signal: handle.signal });
      if (!res.ok) return;
      const data = await res.json() as {
        ok: boolean;
        activeWorkers?: LiveWorkerData[];
        historyWorkers?: LiveWorkerData[];
        graph?: ProjectWorkGraphData | null;
        runs?: CompactRunState[];
      };

      // Race prevention: drop slower responses for an old run
      if (!handle.isValid()) return;

      if (data.ok) {
        if (Array.isArray(data.runs)) {
          trackerRef.current.processSnapshot(data.runs);
          setRuns(trackerRef.current.getAllRuns());
        }
        if (Array.isArray(data.activeWorkers)) {
          setActiveWorkers(data.activeWorkers);
        }
        if (Array.isArray(data.historyWorkers)) {
          setHistoryWorkers(data.historyWorkers);
        }
        if (data.graph) {
          setGraph(data.graph);

          // Validate and choose deterministic fallback for selectedNodeId
          setSelectedNodeId(prev => {
            if (prev && data.graph?.nodes.some(n => n.id === prev)) {
              return prev;
            }
            const fallback = data.graph?.tips[0]?.id || data.graph?.nodes[data.graph.nodes.length - 1]?.id;
            try {
              if (fallback && typeof window !== 'undefined' && window.sessionStorage) {
                window.sessionStorage.setItem(STORAGE_KEY_NODE, fallback);
              }
            } catch {}
            return fallback;
          });
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      // Background poll failure handled gracefully
    }
  }, []);

  const handleManualRefresh = async () => {
    setIsLoading(true);
    await fetchWorkers();
    setIsLoading(false);
  };

  const handleSelectRun = (newRunId: string) => {
    const tracker = trackerRef.current;
    const latestRun = tracker.getLatestRun();
    const isLatest = !latestRun || latestRun.runId === newRunId;
    tracker.selectRun(newRunId, isLatest ? 'latest' : 'historical');

    setSelectedRunId(newRunId);
    setSelectedNodeId(undefined);
    setPendingNewRun(null);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(STORAGE_KEY_RUN, newRunId);
        window.sessionStorage.removeItem(STORAGE_KEY_NODE);
      }
    } catch {}
    void fetchWorkers(newRunId);
  };

  const handleSwitchToNewRun = () => {
    const tracker = trackerRef.current;
    const target = tracker.switchToLatestRun();
    if (target) {
      handleSelectRun(target.runId);
    }
  };

  const handleDismissNewRun = () => {
    trackerRef.current.dismissPendingNewRun();
    setPendingNewRun(null);
  };

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(STORAGE_KEY_NODE, nodeId);
      }
    } catch {}
  };

  // Run invalidation coordinator subscription
  useEffect(() => {
    const tracker = trackerRef.current;
    const unsubscribe = tracker.subscribe(event => {
      if (event.autoSwitched) {
        const newRunId = event.newRun.runId;
        setSelectedRunId(newRunId);
        setSelectedNodeId(undefined);
        try {
          if (typeof window !== 'undefined' && window.sessionStorage) {
            window.sessionStorage.setItem(STORAGE_KEY_RUN, newRunId);
            window.sessionStorage.removeItem(STORAGE_KEY_NODE);
          }
        } catch {}
        setPendingNewRun(null);
        void fetchWorkers(newRunId);
      } else {
        setPendingNewRun(event.newRun);
      }
    });

    const lifecycle = lifecycleRef.current;

    return () => {
      unsubscribe();
      lifecycle.dispose();
    };
  }, [fetchWorkers]);

  // Poll loop
  useEffect(() => {
    let isCancelled = false;
    const lifecycle = lifecycleRef.current;

    const poll = async () => {
      if (isCancelled) return;
      await fetchWorkers();
    };

    void poll();
    const interval = setInterval(() => {
      void poll();
    }, 2500);

    return () => {
      isCancelled = true;
      clearInterval(interval);
      lifecycle.dispose();
    };
  }, [fetchWorkers]);

  return (
    <WorkspaceShell
      activeTab="projects"
      activeWorkersCount={activeWorkers.length}
    >
      <ProjectControl
        activeWorkers={activeWorkers}
        historyWorkers={historyWorkers}
        graph={graph}
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={handleSelectRun}
        selectedNodeId={selectedNodeId}
        onSelectNode={handleSelectNode}
        onRefresh={handleManualRefresh}
        isLoading={isLoading}
        pendingNewRun={pendingNewRun}
        onSwitchToNewRun={handleSwitchToNewRun}
        onDismissNewRun={handleDismissNewRun}
      />
    </WorkspaceShell>
  );
}