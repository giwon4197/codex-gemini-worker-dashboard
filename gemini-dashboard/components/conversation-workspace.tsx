'use client';

import React, { useState, useRef, useEffect } from 'react';
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
  Sparkles,
  Check,
  RotateCcw,
  MessageSquare,
  FileCode2,
  Layers,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type {
  RunDetail,
  CompactRunState,
  ConversationSession,
  ConversationApproval,
} from '../lib/workspace-contract';
import {
  getRunStatusMeta,
  getDeliveryFailureDisplayName,
} from '../lib/workspace-contract';

export interface ConversationWorkspaceProps {
  session?: ConversationSession | null;
  sessions?: ConversationSession[];
  currentRun?: RunDetail | null;
  recentRuns?: CompactRunState[];
  onSelectRun?: (runId: string) => void;
  onSelectSession?: (sessionId: string) => void;
  onNewSession?: () => void;
  onSendMessage?: (message: string) => Promise<void>;
  onApprovePlan?: (sessionId: string, approvalId: string) => Promise<void>;
  isSending?: boolean;
  isApproving?: boolean;
  sendError?: string | null;
  approvalError?: string | null;
  onRefresh?: () => void;
  pendingNewRun?: CompactRunState | null;
  onSwitchToNewRun?: () => void;
  onDismissNewRun?: () => void;
}

export function ConversationWorkspace({
  session,
  sessions = [],
  currentRun,
  recentRuns = [],
  onSelectRun,
  onSelectSession,
  onNewSession,
  onSendMessage,
  onApprovePlan,
  isSending = false,
  isApproving = false,
  sendError = null,
  approvalError = null,
  onRefresh,
  pendingNewRun = null,
  onSwitchToNewRun,
  onDismissNewRun,
}: ConversationWorkspaceProps) {
  const [inputMessage, setInputMessage] = useState('');
  const [internalSending, setInternalSending] = useState(false);
  const [internalApprovingId, setInternalApprovingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showRunPanel, setShowRunPanel] = useState<boolean>(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom of conversation
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [session?.messages, session?.messages?.length]);

  const sending = isSending || internalSending;
  const approving = isApproving || internalApprovingId !== null;

  const handleSend = async (e?: React.SyntheticEvent) => {
    if (e) e.preventDefault();
    const trimmed = inputMessage.trim();
    if (!trimmed || sending) return;

    setLocalError(null);

    if (onSendMessage) {
      await onSendMessage(trimmed);
      setInputMessage('');
      return;
    }

    // Default internal fetch if onSendMessage not provided
    setInternalSending(true);
    try {
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: session?.sessionId,
          message: trimmed,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setLocalError(data.error || '메시지 전송에 실패했습니다.');
      } else {
        setInputMessage('');
        if (onRefresh) onRefresh();
      }
    } catch {
      setLocalError('서버와 통신할 수 없습니다. 대시보드 서버 상태를 확인하세요.');
    } finally {
      setInternalSending(false);
    }
  };

  const handleApprove = async (approval: ConversationApproval) => {
    if (approving || approval.status === 'approved') return;

    setLocalError(null);
    const sid = session?.sessionId || approval.sessionId;

    if (onApprovePlan) {
      await onApprovePlan(sid, approval.approvalId);
      return;
    }

    // Default internal approve fetch
    setInternalApprovingId(approval.approvalId);
    try {
      const res = await fetch(`/api/conversations/${sid}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: approval.approvalId }),
      });
      const data = (await res.json()) as { ok: boolean; runId?: string; error?: string };
      if (!res.ok || !data.ok) {
        setLocalError(data.error || '작업 승인 처리에 실패했습니다.');
      } else {
        if (data.runId && onSelectRun) {
          onSelectRun(data.runId);
        }
        if (onRefresh) onRefresh();
      }
    } catch {
      setLocalError('승인 요청 처리 중 네트워크 오류가 발생했습니다.');
    } finally {
      setInternalApprovingId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const activeStatusMeta = currentRun ? getRunStatusMeta(currentRun.status) : null;
  const messages = session?.messages || [];
  const currentError = sendError || approvalError || localError;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Top Bar / Subheader */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 bg-card/40 px-6 py-3 backdrop-blur-xs">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400">
            <Bot className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">Codex 대화형 작업 공간</h1>
            <p className="text-[11px] text-slate-400">
              대화 세션과 작업 Run이 분리된 환경에서 자연어로 질문하거나 실행 계획을 승인합니다
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Conversation Session Selector */}
          {sessions.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="session-select" className="sr-only">
                대화 세션 선택
              </label>
              <select
                id="session-select"
                aria-label="대화 세션 선택"
                value={session?.sessionId || ''}
                onChange={e => onSelectSession && onSelectSession(e.target.value)}
                className="h-8 rounded-md border border-border bg-slate-900/90 px-2.5 text-xs text-slate-300 focus:outline-hidden focus:ring-1 focus:ring-cyan-400"
              >
                {sessions.map((s, idx) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    대화 #{idx + 1} ({new Date(s.createdAt).toLocaleTimeString('ko-KR', { hour12: false })})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* New Session Button */}
          {onNewSession && (
            <button
              type="button"
              onClick={onNewSession}
              aria-label="새 대화 시작"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-slate-900/80 px-2.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
            >
              <MessageSquare className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
              <span>새 대화</span>
            </button>
          )}

          {/* Recent Runs Selector */}
          {recentRuns.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="runs-select" className="sr-only">
                작업 Run 내역 선택
              </label>
              <select
                id="runs-select"
                aria-label="작업 Run 내역 선택"
                value={currentRun?.runId || ''}
                onChange={e => onSelectRun && onSelectRun(e.target.value)}
                className="h-8 rounded-md border border-border bg-slate-900/90 px-2.5 text-xs text-slate-300 focus:outline-hidden focus:ring-1 focus:ring-cyan-400"
              >
                <option value="">-- 작업 Run 선택 --</option>
                {recentRuns.map(r => (
                  <option key={r.runId} value={r.runId}>
                    Run: {r.prompt ? r.prompt.slice(0, 24) : r.runId} ({r.status})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Refresh Button */}
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
            <span>프로젝트 관제</span>
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </header>

      {/* Accessible New-Run Notification Banner (when historical run is deliberately selected) */}
      {pendingNewRun && (
        <output
          aria-live="polite"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/40 bg-cyan-950/80 px-6 py-2.5 text-xs text-cyan-200 backdrop-blur-xs"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-cyan-400 shrink-0" aria-hidden="true" />
            <span>
              새로운 작업 Run(ID: <strong className="font-mono text-white">{pendingNewRun.runId}</strong>)이 감지되었습니다.
            </span>
          </div>
          <div className="flex items-center gap-2">
            {onSwitchToNewRun && (
              <button
                type="button"
                onClick={onSwitchToNewRun}
                className="rounded-md bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-cyan-400 focus:outline-hidden focus:ring-1 focus:ring-cyan-400 transition-colors"
              >
                새 Run으로 전환
              </button>
            )}
            {onDismissNewRun && (
              <button
                type="button"
                onClick={onDismissNewRun}
                className="text-slate-400 hover:text-white text-xs px-1.5 py-0.5"
                aria-label="알림 닫기"
              >
                닫기
              </button>
            )}
          </div>
        </output>
      )}

      {/* Main Split Body: Conversation Area and Connected Run Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left / Primary: Conversation Chat Stream */}
        <main
          aria-label="대화 메시지 내역"
          className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4"
        >
          <div className="mx-auto max-w-3xl space-y-4">
            {/* Empty Welcome Card */}
            {messages.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/80 p-8 text-center bg-card/20">
                <Sparkles className="mx-auto h-8 w-8 text-cyan-400/80 mb-2" aria-hidden="true" />
                <h2 className="text-base font-semibold text-white">Codex 작업 공간에 오신 것을 환영합니다</h2>
                <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                  자연어로 질문하거나 일반 대화를 나누실 수 있습니다. 코드 변경이 필요한 요청 시에는
                  Codex가 먼저 실행 계획을 수립하고, 사용자가 승인 버튼을 누를 때만 워커가 실행됩니다.
                </p>
              </div>
            )}

            {/* Conversation Messages */}
            {messages.map(msg => {
              const isUser = msg.sender === 'user';
              return (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}
                >
                  {!isUser && (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
                      <Bot className="h-4 w-4" aria-hidden="true" />
                    </div>
                  )}

                  <div className={`space-y-2 max-w-2xl ${isUser ? 'items-end' : 'items-start'}`}>
                    {/* Message Bubble */}
                    <div
                      className={`rounded-2xl px-4 py-3 text-xs leading-relaxed shadow-xs ${
                        isUser
                          ? 'bg-cyan-600/90 text-white rounded-tr-xs'
                          : 'bg-slate-900/90 text-slate-200 border border-border/80 rounded-tl-xs'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{msg.text}</div>
                      <div
                        className={`mt-1 text-[10px] ${
                          isUser ? 'text-cyan-200/70 text-right' : 'text-slate-500 text-left'
                        }`}
                      >
                        {new Date(msg.timestamp).toLocaleTimeString('ko-KR', { hour12: false })}
                      </div>
                    </div>

                    {/* Status Summary Widget (if intentType === 'status') */}
                    {msg.statusSummary && (
                      <div className="rounded-xl border border-border/70 bg-card/60 p-3.5 text-xs text-slate-300 space-y-2">
                        <div className="flex items-center gap-2 font-medium text-white border-b border-border/60 pb-2">
                          <Layers className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
                          <span>프로젝트 저장 상태 요약</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded bg-slate-950/40 p-2 border border-border/40">
                            <span className="text-slate-400">전체 등록 Run:</span>{' '}
                            <span className="font-semibold text-white">{msg.statusSummary.totalRuns}건</span>
                          </div>
                          <div className="rounded bg-slate-950/40 p-2 border border-border/40">
                            <span className="text-slate-400">활성 워커:</span>{' '}
                            <span className="font-semibold text-cyan-300">{msg.statusSummary.activeWorkers}개</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Plan Approval Card (if approval exists) */}
                    {msg.approval && (
                      <div
                        aria-label="작업 실행 계획 및 승인 카드"
                        className="rounded-xl border-2 border-cyan-500/40 bg-slate-900/95 p-4 shadow-md space-y-3"
                      >
                        {/* Approval Card Header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-2.5">
                          <div className="flex items-center gap-2">
                            <FileCode2 className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                            <span className="text-xs font-semibold text-white">
                              {msg.approval.plan?.title || '작업 실행 계획'}
                            </span>
                          </div>

                          {msg.approval.status === 'pending' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 border border-amber-500/30">
                              <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                              승인 대기 (워커 미생성)
                            </span>
                          )}

                          {msg.approval.status === 'approved' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 border border-emerald-500/30">
                              <Check className="h-3 w-3" aria-hidden="true" />
                              승인 완료 (Run 시작됨)
                            </span>
                          )}

                          {msg.approval.status === 'failed' && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-2.5 py-0.5 text-[11px] font-medium text-rose-300 border border-rose-500/30">
                              <AlertCircle className="h-3 w-3" aria-hidden="true" />
                              승인 실행 실패
                            </span>
                          )}
                        </div>

                        {/* Plan Explanation */}
                        {msg.approval.plan?.explanation && (
                          <p className="text-xs text-slate-300 leading-relaxed">
                            {msg.approval.plan.explanation}
                          </p>
                        )}

                        {/* Plan Steps */}
                        {msg.approval.plan?.steps && msg.approval.plan.steps.length > 0 && (
                          <div className="space-y-1.5 rounded-lg bg-slate-950/50 p-3 border border-border/50">
                            <div className="text-[11px] font-medium text-slate-400">실행 예정 단계:</div>
                            <ol className="space-y-1 text-xs text-slate-200 list-decimal list-inside">
                              {msg.approval.plan.steps.map((step, sIdx) => (
                                <li key={sIdx} className="leading-relaxed">
                                  {step}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {/* Affected Files List */}
                        {msg.approval.plan?.affectedFiles && msg.approval.plan.affectedFiles.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span className="text-slate-400">대상 파일:</span>
                            {msg.approval.plan.affectedFiles.map((file, fIdx) => (
                              <code
                                key={fIdx}
                                className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300 border border-slate-700"
                              >
                                {file}
                              </code>
                            ))}
                          </div>
                        )}

                        {/* Card Footer / Action Button */}
                        <div className="pt-1 flex flex-wrap items-center justify-between gap-3 border-t border-border/50">
                          {msg.approval.status === 'pending' && (
                            <div className="flex items-center gap-2 w-full justify-between">
                              <span className="text-[11px] text-slate-400">
                                승인 시 라우터가 단 1회 실행됩니다.
                              </span>
                              <button
                                type="button"
                                disabled={approving}
                                onClick={() => msg.approval && handleApprove(msg.approval)}
                                aria-label="작업 계획 승인 및 실행"
                                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 shadow-sm transition-all hover:bg-cyan-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                              >
                                {approving && internalApprovingId === msg.approval.approvalId ? (
                                  <>
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                    <span>승인 처리 중...</span>
                                  </>
                                ) : (
                                  <>
                                    <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                    <span>승인 및 작업 실행</span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}

                          {msg.approval.status === 'approved' && (
                            <div className="flex items-center justify-between w-full text-xs">
                              <div className="flex items-center gap-2 text-emerald-300">
                                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                                <span>연결된 작업 Run: <code className="font-mono text-white">{msg.approval.runId}</code></span>
                              </div>
                              {msg.approval.runId && onSelectRun && (
                                <button
                                  type="button"
                                  onClick={() => msg.approval?.runId && onSelectRun(msg.approval.runId)}
                                  className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 text-xs font-medium underline underline-offset-2"
                                >
                                  <span>Run 상세 보기</span>
                                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          )}

                          {msg.approval.status === 'failed' && (
                            <div className="flex items-center justify-between w-full text-xs">
                              <span className="text-rose-300">
                                오류: {msg.approval.error || '승인 실행에 실패했습니다.'}
                              </span>
                              <button
                                type="button"
                                disabled={approving}
                                onClick={() => msg.approval && handleApprove(msg.approval)}
                                className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
                              >
                                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                                <span>다시 시도</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {isUser && (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-cyan-300 border border-border/80">
                      <User className="h-4 w-4" aria-hidden="true" />
                    </div>
                  )}
                </div>
              );
            })}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Right / Secondary Panel: Selected Run Details (when selected) */}
        {currentRun && (
          <aside
            aria-label="선택된 작업 Run 상태 및 타임라인"
            className="hidden lg:flex w-88 flex-col border-l border-border/80 bg-[#090d14] overflow-y-auto"
          >
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-border/60 p-3.5 bg-card/30">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-white">작업 Run 상태</span>
                {currentRun.errorCategory === 'launcher_error' ? (
                  <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium bg-rose-500/20 text-rose-300 border-rose-400/50">
                    {currentRun.errorDisplayName || '실행기 오류'}
                  </span>
                ) : activeStatusMeta ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${activeStatusMeta.badgeClass}`}>
                    {activeStatusMeta.label}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setShowRunPanel(!showRunPanel)}
                aria-label={showRunPanel ? '패널 접기' : '패널 펼치기'}
                className="text-slate-400 hover:text-white"
              >
                {showRunPanel ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
            </div>

            {showRunPanel && (
              <div className="p-4 space-y-4">
                {/* Run Metadata Card */}
                <div className="rounded-lg border border-border/70 bg-card/50 p-3 space-y-2 text-xs">
                  <div className="flex justify-between items-center text-slate-400">
                    <span>Run ID:</span>
                    <span className="font-mono text-slate-200 truncate max-w-[170px]">
                      {currentRun.runId}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-slate-400">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      시작:
                    </span>
                    <span>{new Date(currentRun.createdAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>
                  </div>
                  {currentRun.failureLogPath && (
                    <div className="flex justify-between items-center text-slate-400">
                      <span>로그:</span>
                      <span className="font-mono text-slate-200 truncate max-w-[170px]" title={currentRun.failureLogPath}>
                        {currentRun.failureLogPath}
                      </span>
                    </div>
                  )}
                  {typeof currentRun.exitCode === 'number' && (
                    <div className="flex justify-between items-center text-slate-400">
                      <span>종료 코드:</span>
                      <span className="font-mono text-slate-200">{currentRun.exitCode}</span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-border/40 text-[11px] text-slate-300">
                    <span className="text-slate-500">요청:</span> {currentRun.prompt}
                  </div>
                </div>

                {/* Launcher Error Alert (Criterion 6 & 7) */}
                {(currentRun.errorCategory === 'launcher_error' || (!currentRun.requiresUserAction && (currentRun.status === 'failed' || Boolean(currentRun.failureReason)))) && (
                  <div
                    role="alert"
                    className="rounded-lg border border-rose-500/60 bg-rose-500/10 p-3 text-rose-200 text-xs space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 font-semibold text-rose-300">
                        <AlertCircle className="h-4 w-4 text-rose-400 shrink-0" aria-hidden="true" />
                        <span>{currentRun.errorDisplayName || '실행기 오류'}</span>
                      </div>
                      {typeof currentRun.exitCode === 'number' && (
                        <span className="font-mono text-[10px] bg-rose-950/60 text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30">
                          종료 코드: {currentRun.exitCode}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-rose-100/90">
                      {currentRun.failureReason || currentRun.error || '실행기 초기화 또는 프로세스 조기 종료로 인해 실행에 실패했습니다.'}
                    </p>
                    {currentRun.retryable && (
                      <p className="text-[10px] text-rose-300/80">
                        재시도 가능: 일시적 환경 또는 프로세스 문제인 경우 다시 시도할 수 있습니다.
                      </p>
                    )}
                    {currentRun.failureLogPath && (
                      <div className="text-[10px] text-slate-300 pt-1 border-t border-rose-500/20">
                        <span className="text-slate-400">실패 로그:</span>{' '}
                        <code className="font-mono text-slate-200">{currentRun.failureLogPath}</code>
                      </div>
                    )}
                  </div>
                )}

                {/* Automatic Delivery In Progress Banner */}
                {currentRun.delivery && (currentRun.delivery.status === 'in_progress' || currentRun.delivery.status === 'delivering') && (
                  <section
                    aria-label="자동 전달 진행 상태"
                    className="rounded-lg border border-cyan-500/60 bg-cyan-500/10 p-3 text-cyan-200 text-xs space-y-1.5"
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-cyan-300">
                      <Loader2 className="h-4 w-4 text-cyan-400 shrink-0 animate-spin" aria-hidden="true" />
                      <span>자동 전달 진행 중 ({currentRun.delivery.currentStage || currentRun.status})</span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-cyan-100/90">
                      {currentRun.delivery.targetBranch
                        ? `${currentRun.delivery.targetBranch} 브랜치로 자동 반영(통합 및 푸시) 단계가 진행 중입니다.`
                        : '자동 반영 단계가 진행 중입니다.'}
                    </p>
                  </section>
                )}

                {/* Automatic Delivery Completed Banner */}
                {currentRun.delivery && currentRun.delivery.status === 'delivered' && (
                  <section
                    aria-label="자동 전달 완료 상태"
                    className="rounded-lg border border-emerald-500/60 bg-emerald-500/10 p-3 text-emerald-200 text-xs space-y-1.5"
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-emerald-300">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
                      <span>자동 전달 완료</span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-emerald-100/90">
                      대상 브랜치({currentRun.delivery.targetBranch || 'main'})로 변경 사항 반영 및 푸시가 완료되었습니다.
                    </p>
                    {currentRun.delivery.deliveredCommit && (
                      <div className="font-mono text-[10px] text-emerald-300 bg-emerald-950/40 p-1.5 rounded border border-emerald-500/30">
                        전달 커밋: {currentRun.delivery.deliveredCommit}
                      </div>
                    )}
                  </section>
                )}

                {/* User Action Required Alert */}
                {currentRun.requiresUserAction && (
                  <div
                    role="alert"
                    className="rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 text-amber-200 text-xs space-y-1.5"
                  >
                    <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                      <span>
                        {currentRun.status === 'awaiting_review'
                          ? '통합 검토 및 승인 필요'
                          : currentRun.delivery?.status === 'failed'
                          ? `자동 전달 실패 (${getDeliveryFailureDisplayName(currentRun.delivery.failureCategory)})`
                          : '사용자 조치 필요'}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-amber-100/90">
                      {currentRun.userActionReason ||
                        currentRun.delivery?.actionGuidance ||
                        '오케스트레이터가 작업을 완료했습니다.'}
                    </p>
                    {currentRun.delivery?.diagnosticArtifact && (
                      <div className="font-mono text-[10px] text-amber-300 bg-amber-950/40 p-1.5 rounded border border-amber-500/30">
                        진단 아티팩트: {currentRun.delivery.diagnosticArtifact}
                      </div>
                    )}
                    {currentRun.status === 'awaiting_review' && (
                      <div className="font-mono text-[10px] text-amber-300 bg-amber-950/40 p-1.5 rounded border border-amber-500/30">
                        브랜치: integration/{currentRun.runId}
                      </div>
                    )}
                  </div>
                )}

                {/* Evidenced Timeline (Criterion 8: Only if events exist) */}
                {currentRun.timeline && currentRun.timeline.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      실행 타임라인
                    </h3>
                    <ol className="relative space-y-3 border-l border-border/70 pl-4 ml-2">
                      {currentRun.timeline.map((event, idx) => (
                        <li key={event.id || idx} className="relative text-xs">
                          <span className="absolute -left-[21px] top-1 flex h-2.5 w-2.5 rounded-full bg-cyan-400" />
                          <div className="font-medium text-white">{event.title}</div>
                          <div className="text-[11px] text-slate-400">{event.description}</div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-xs text-slate-500">
                    아직 발생한 실행 이벤트가 없습니다.
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Natural Language Prompt Input Bar (Codex First) */}
      <footer className="border-t border-border bg-[#0b0f17] p-4 md:p-5">
        <div className="mx-auto max-w-3xl space-y-2">
          {currentError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-xs text-rose-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" aria-hidden="true" />
              <span className="flex-1">{currentError}</span>
              <button
                type="button"
                onClick={() => setLocalError(null)}
                className="text-[11px] text-rose-400 underline hover:text-rose-200"
              >
                닫기
              </button>
            </div>
          )}

          <form onSubmit={handleSend} className="relative">
            <label htmlFor="conversation-input" className="sr-only">
              Codex 대화 및 작업 지시 입력
            </label>
            <textarea
              id="conversation-input"
              ref={textareaRef}
              rows={3}
              value={inputMessage}
              onChange={e => setInputMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={sending}
              placeholder="Codex에게 일반 대화, 상태 질문, 또는 작업 지시를 입력하세요. (예: '아아 들려?', '현재 상태 어때?', '버튼 오류를 수정해줘')"
              className="w-full resize-none rounded-xl border border-border bg-slate-900/90 p-3.5 pr-28 text-sm leading-relaxed text-white placeholder-slate-500 shadow-inner focus:border-cyan-400 focus:outline-hidden focus:ring-1 focus:ring-cyan-400 disabled:opacity-60"
            />

            <div className="absolute right-3 bottom-3.5 flex items-center gap-2">
              <button
                type="submit"
                disabled={sending || !inputMessage.trim()}
                aria-label="메시지 전송"
                className="flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 shadow-sm transition-all hover:bg-cyan-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    <span>생각 중...</span>
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>전송</span>
                  </>
                )}
              </button>
            </div>
          </form>

          <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
            <span>
              안전한 Codex 대화 중심: 모든 입력은 판단 후 승인 시에만 워커를 실행합니다.
            </span>
            <span className="hidden sm:inline font-mono text-[10px]">
              Enter: 전송 / Shift + Enter: 줄바꿈
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}