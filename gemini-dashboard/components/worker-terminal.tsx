'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Terminal, Clock, Cpu, ArrowDown, Shield } from 'lucide-react';
import type { LiveWorkerData, LiveWorkerLog } from '../lib/workspace-contract';
import { formatDuration } from '../lib/workspace-contract';

interface WorkerTerminalProps {
  worker: LiveWorkerData;
}

export function WorkerTerminal({ worker }: WorkerTerminalProps) {
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const logs = worker.recentLogs || [];

  useEffect(() => {
    if (autoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, autoScroll]);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-cyan-500/30 bg-[#070a0f] shadow-lg shadow-black/50">
      {/* Terminal Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-[#0c121c] px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 animate-pulse" />
            <Terminal className="h-4 w-4 text-cyan-400" aria-hidden="true" />
          </div>
          <span className="font-semibold text-xs text-slate-200">
            {worker.task || worker.taskId || '활성 워커 CLI'}
          </span>
          {worker.taskId && (
            <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-[11px] font-mono text-cyan-300">
              {worker.taskId}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 text-slate-400">
            <Cpu className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <span className="font-mono text-[11px] text-slate-300">{worker.model}</span>
          </div>

          <div className="flex items-center gap-1 text-slate-400">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="font-mono text-[11px] text-slate-200">
              {formatDuration(worker.elapsedSeconds || 0)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              autoScroll
                ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/30'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            aria-pressed={autoScroll}
          >
            <ArrowDown className="h-3 w-3" aria-hidden="true" />
            {autoScroll ? '자동 스크롤 켜짐' : '스크롤 고정'}
          </button>
        </div>
      </div>

      {/* Terminal Body */}
      <div
        role="log"
        aria-live="polite"
        aria-label="워커 터미널 실시간 로그"
        className="h-80 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-slate-300 focus:outline-hidden focus:ring-1 focus:ring-cyan-400"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            <span className="animate-pulse">워커 초기화 중... 로그를 대기하고 있습니다.</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {logs.map((item, idx) => {
              const log: LiveWorkerLog =
                typeof item === 'string'
                  ? { timestamp: '', message: item, type: 'log' }
                  : item;

              const isTool = log.message.includes('tool') || log.type === 'tool';
              const isAgent = log.message.includes('agent_response') || log.type === 'agent_response';
              const isError = log.type === 'error' || log.message.includes('오류');

              let badgeColor = 'text-slate-500';
              if (isTool) badgeColor = 'text-amber-400';
              if (isAgent) badgeColor = 'text-cyan-400';
              if (isError) badgeColor = 'text-rose-400 font-semibold';

              return (
                <div key={idx} className="flex items-start gap-2 break-all">
                  {log.timestamp && (
                    <span className="shrink-0 text-[11px] text-slate-600 select-none">
                      [{log.timestamp}]
                    </span>
                  )}
                  {log.type && (
                    <span className={`shrink-0 text-[11px] ${badgeColor} select-none`}>
                      [{log.type}]
                    </span>
                  )}
                  <span className={isError ? 'text-rose-300' : 'text-slate-300'}>
                    {log.message}
                  </span>
                </div>
              );
            })}
            <div ref={terminalEndRef} />
          </div>
        )}
      </div>

      {/* Terminal Read-only Status Notice */}
      <div className="flex items-center justify-between border-t border-border/50 bg-[#090d14] px-4 py-1.5 text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <Shield className="h-3 w-3 text-cyan-400" aria-hidden="true" />
          읽기 전용 관제 터미널 (정제된 이벤트만 안전하게 표시됩니다)
        </span>
        <span className="font-mono text-[10px] text-slate-400">
          PID: {worker.runId.slice(-8)}
        </span>
      </div>
    </div>
  );
}