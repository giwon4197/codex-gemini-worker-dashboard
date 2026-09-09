'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import {
  Send,
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  PlayCircle,
  RefreshCw,
  ArrowRight,
  Bot,
  User,
  Clock,
  Sparkles
} from 'lucide-react';
import type {
  RunDetail,
  CompactRunState,
} from '../lib/workspace-contract';
import {
  RUN_STATUS_META,
} from '../lib/workspace-contract';

interface ConversationWorkspaceProps {
  currentRun?: RunDetail | null;
  recentRuns?: CompactRunState[];
  onSelectRun?: (runId: string) => void;
  onRefresh?: () => void;
}

export function ConversationWorkspace({
  currentRun,
  recentRuns = [],
  onSelectRun,
  onRefresh,
}: ConversationWorkspaceProps) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submissionSuccessMsg, setSubmissionSuccessMsg] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    if (e) e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setSubmissionError(null);
    setSubmissionSuccessMsg(null);

    // Client-generated idempotency key
    const idempotencyKey = `user-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          idempotencyKey,
        }),
      });

      const data = await res.json() as {
        ok: boolean;
        runId?: string;
        error?: string;
        isDuplicate?: boolean;
        message?: string;
      };

      if (!res.ok || !data.ok || !data.runId) {
        setSubmissionError(data.error || '작업 요청 제출에 실패했습니다.');
        setIsSubmitting(false);
        return;
      }

      setSubmissionSuccessMsg(
        data.isDuplicate
          ? '이전 요청과 동일하여 기존 작업을 불러왔습니다.'
          : '작업이 백그라운드 라우터에 정상 제출되었습니다.'
      );
      setPrompt('');

      if (onSelectRun && data.runId) {
        onSelectRun(data.runId);
      }
      if (onRefresh) {
        onRefresh();
      }
    } catch {
      setSubmissionError('서버와 통신할 수 없습니다. 대시보드 서버 상태를 확인하세요.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const activeStatusMeta = currentRun ? RUN_STATUS_META[currentRun.status] : null;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Workspace Subheader */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-card/40 px-6 py-3.5 backdrop-blur-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">
              대화형 작업 공간
            </h1>
            <p className="text-[11px] text-slate-400">
              자연어로 작업을 지시하고 계획, 실행, 검증 타임라인을 확인합니다
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Recent Runs Selector */}
          {recentRuns.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="runs-select" className="sr-only">작업 내역 선택</label>
              <select
                id="runs-select"
                aria-label="최근 작업 내역 선택"
                value={currentRun?.runId || ''}
                onChange={e => onSelectRun && onSelectRun(e.target.value)}
                className="h-8 rounded-md border border-border bg-slate-900/90 px-2.5 text-xs text-slate-300 focus:outline-hidden focus:ring-1 focus:ring-cyan-400"
              >
                {recentRuns.map(r => (
                  <option key={r.runId} value={r.runId}>
                    {r.prompt ? r.prompt.slice(0, 30) : r.runId} ({r.status})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Quick Refresh Button */}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              aria-label="상태 새로고침"
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-slate-900/80 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}

          {/* Link to Project Control */}
          <Link
            href="/projects"
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 transition-colors"
          >
            <span>프로젝트 관제 화면</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* Main Conversation & Timeline Body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Active Run Banner / Header */}
          {currentRun ? (
            <div className="rounded-xl border border-border bg-card/80 p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="text-xs font-mono text-slate-400">ID:</span>
                  <span className="font-mono text-xs font-semibold text-slate-200">
                    {currentRun.runId}
                  </span>
                  {activeStatusMeta && (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${activeStatusMeta.badgeClass}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                      {activeStatusMeta.label}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-4 text-xs text-slate-400">
                  <div className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>시작: {new Date(currentRun.createdAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>
                  </div>
                  {currentRun.tasksCount > 0 && (
                    <span>태스크: {currentRun.tasksCount}개</span>
                  )}
                </div>
              </div>

              {/* User Original Prompt Message */}
              <div className="mt-4 flex items-start gap-3 rounded-lg bg-slate-900/60 p-3.5 border border-border/50">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-300">
                  <User className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="text-[11px] font-medium text-slate-400">사용자 작업 지시</div>
                  <div className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">
                    {currentRun.prompt}
                  </div>
                </div>
              </div>

              {/* Prominent User Action Alert (when requiresUserAction is true) */}
              {currentRun.requiresUserAction && (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-4 text-amber-200 shadow-md"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" aria-hidden="true" />
                    <div className="space-y-1.5 flex-1">
                      <div className="text-sm font-semibold text-amber-300">
                        {currentRun.status === 'awaiting_review'
                          ? '사용자 검토 및 승인 필요 (Awaiting Review)'
                          : '사용자 조치 필요'}
                      </div>
                      <p className="text-xs leading-relaxed text-amber-100/90">
                        {currentRun.userActionReason ||
                          '오케스트레이터가 작업을 완료하고 통합 브랜치를 생성했습니다. 결과를 확인하고 승인하세요.'}
                      </p>
                      {currentRun.status === 'awaiting_review' && (
                        <div className="mt-2 text-xs text-amber-300/80 font-mono bg-amber-950/40 p-2 rounded border border-amber-500/30">
                          통합 브랜치: integration/{currentRun.runId} (main에 자동 병합되지 않음)
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border/80 p-8 text-center bg-card/20">
              <Sparkles className="mx-auto h-8 w-8 text-cyan-400/80 mb-2" aria-hidden="true" />
              <h2 className="text-base font-semibold text-white">새로운 작업을 시작하세요</h2>
              <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
                아래 입력창에 한국어로 기능 개발, 버그 수정, 또는 코드 리팩토링 요청을 입력하면 Codex 라우터가 안전한 워커 계획을 수립하고 실행합니다.
              </p>
            </div>
          )}

          {/* Chronological Timeline Section */}
          {currentRun && currentRun.timeline && currentRun.timeline.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                작업 진행 타임라인
              </h2>
              <ol
                aria-label="작업 단계별 시간순 타임라인"
                className="relative space-y-4 border-l border-border/70 pl-6 ml-3"
              >
                {currentRun.timeline.map((event, idx) => {
                  let statusColor = 'bg-cyan-500 border-cyan-400 text-white';
                  let icon = <PlayCircle className="h-3 w-3" aria-hidden="true" />;

                  if (event.status === 'passed') {
                    statusColor = 'bg-emerald-500 border-emerald-400 text-white';
                    icon = <CheckCircle2 className="h-3 w-3" aria-hidden="true" />;
                  } else if (event.status === 'failed') {
                    statusColor = 'bg-rose-500 border-rose-400 text-white';
                    icon = <AlertCircle className="h-3 w-3" aria-hidden="true" />;
                  } else if (event.status === 'warning') {
                    statusColor = 'bg-amber-500 border-amber-400 text-white';
                    icon = <AlertTriangle className="h-3 w-3" aria-hidden="true" />;
                  } else if (event.status === 'in_progress') {
                    statusColor = 'bg-cyan-500 border-cyan-400 text-white animate-pulse';
                    icon = <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />;
                  }

                  return (
                    <li key={event.id || idx} className="relative group">
                      {/* Timeline Dot Icon */}
                      <span
                        className={`absolute -left-[31px] flex h-5 w-5 items-center justify-center rounded-full border-2 ${statusColor} shadow-sm`}
                        aria-hidden="true"
                      >
                        {icon}
                      </span>

                      <div className="rounded-lg border border-border/60 bg-card/70 p-3.5 shadow-xs transition-colors hover:border-cyan-500/40">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-white">
                              {event.title}
                            </span>
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
                              {event.stage}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 font-mono">
                            {new Date(event.timestamp).toLocaleTimeString('ko-KR', { hour12: false })}
                          </span>
                        </div>

                        <p className="mt-1 text-xs text-slate-300 leading-relaxed">
                          {event.description}
                        </p>

                        {event.detail && (
                          <div className="mt-2 rounded bg-slate-900/80 p-2 text-xs font-mono text-slate-300 whitespace-pre-wrap break-all border border-border/40">
                            {event.detail}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* Agent Response Card (Summary & Modified Files) */}
          {currentRun && currentRun.agentMessage && (
            <div className="rounded-xl border border-cyan-500/40 bg-slate-900/90 p-5 shadow-md">
              <div className="flex items-center gap-2.5 border-b border-border/60 pb-3 mb-3 text-cyan-400">
                <Bot className="h-5 w-5" aria-hidden="true" />
                <h3 className="text-sm font-semibold text-white">에이전트 응답 및 변경 사항</h3>
              </div>
              <div className="prose prose-invert prose-xs max-w-none text-xs leading-relaxed text-slate-200 whitespace-pre-wrap">
                {currentRun.agentMessage}
              </div>
            </div>
          )}

          <div ref={timelineEndRef} />
        </div>
      </div>

      {/* Natural Language Prompt Input Bar (Codex Style) */}
      <div className="border-t border-border bg-[#0b0f17] p-4 md:p-5">
        <div className="mx-auto max-w-4xl space-y-2">
          {submissionError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-xs text-rose-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <span>{submissionError}</span>
            </div>
          )}

          {submissionSuccessMsg && (
            <output
              className="flex items-center gap-2 rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-xs text-emerald-300"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
              <span>{submissionSuccessMsg}</span>
            </output>
          )}

          <form onSubmit={handleSubmit} className="relative">
            <label htmlFor="task-prompt-input" className="sr-only">
              자연어 작업 요청 입력
            </label>
            <textarea
              id="task-prompt-input"
              ref={textareaRef}
              rows={3}
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
              placeholder="자연어로 수행할 작업 지시를 입력하세요. (예: 대시보드 관제 화면에 활성 워커 터미널 추가하고 테스트 실행해줘)"
              className="w-full resize-none rounded-xl border border-border bg-slate-900/90 p-3.5 pr-28 text-sm leading-relaxed text-white placeholder-slate-500 shadow-inner focus:border-cyan-400 focus:outline-hidden focus:ring-1 focus:ring-cyan-400 disabled:opacity-60"
            />

            <div className="absolute right-3 bottom-3.5 flex items-center gap-2">
              <button
                type="submit"
                disabled={isSubmitting || !prompt.trim()}
                aria-label="작업 요청 제출"
                className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 shadow-sm transition-all hover:bg-cyan-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    <span>제출 중...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>요청 전송</span>
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
            <span>
              안전한 비동기 실행: 인자 배열 기반 고정 라우터 호출
            </span>
            <span className="hidden sm:inline font-mono text-[10px]">
              Enter: 전송 / Shift + Enter: 줄바꿈
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}