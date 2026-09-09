'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { WorkspaceShell } from '../../components/workspace-shell';
import { ProjectControl } from '../../components/project-control';
import type { LiveWorkerData } from '../../lib/workspace-contract';

export default function ProjectsPage() {
  const [activeWorkers, setActiveWorkers] = useState<LiveWorkerData[]>([]);
  const [historyWorkers, setHistoryWorkers] = useState<LiveWorkerData[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchWorkers = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/current/workers?t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json() as {
        ok: boolean;
        activeWorkers?: LiveWorkerData[];
        historyWorkers?: LiveWorkerData[];
      };
      if (data.ok) {
        if (Array.isArray(data.activeWorkers)) {
          setActiveWorkers(data.activeWorkers);
        }
        if (Array.isArray(data.historyWorkers)) {
          setHistoryWorkers(data.historyWorkers);
        }
      }
    } catch {
      // Background poll failure handled gracefully
    }
  }, []);

  const handleManualRefresh = async () => {
    setIsLoading(true);
    await fetchWorkers();
    setIsLoading(false);
  };

  useEffect(() => {
    let isCancelled = false;

    const loadWorkers = async () => {
      try {
        const res = await fetch(`/api/projects/current/workers?t=${Date.now()}`);
        if (!res.ok || isCancelled) return;
        const data = await res.json() as {
          ok: boolean;
          activeWorkers?: LiveWorkerData[];
          historyWorkers?: LiveWorkerData[];
        };
        if (data.ok && !isCancelled) {
          if (Array.isArray(data.activeWorkers)) {
            setActiveWorkers(data.activeWorkers);
          }
          if (Array.isArray(data.historyWorkers)) {
            setHistoryWorkers(data.historyWorkers);
          }
        }
      } catch {
        // Background poll failure handled gracefully
      }
    };

    void loadWorkers();
    const interval = setInterval(() => {
      void loadWorkers();
    }, 2500);
    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <WorkspaceShell
      activeTab="projects"
      activeWorkersCount={activeWorkers.length}
    >
      <ProjectControl
        activeWorkers={activeWorkers}
        historyWorkers={historyWorkers}
        onRefresh={handleManualRefresh}
        isLoading={isLoading}
      />
    </WorkspaceShell>
  );
}