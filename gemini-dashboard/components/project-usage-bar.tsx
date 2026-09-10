'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Gauge, RefreshCw, AlertCircle, Clock, Calendar } from 'lucide-react';
import type { CodexUsageResponse, CodexRateLimitsSnapshot } from '../lib/codex-usage';
import type { GeminiQuotaResponse, GeminiQuotaSnapshot } from '../lib/gemini-quota';
import { getSharedRunTracker, type RunTracker } from '../lib/run-tracking';

const STORAGE_KEY_CODEX = 'gemini_dashboard_codex_usage_cache_v1';
const STORAGE_KEY_GEMINI = 'gemini_dashboard_gemini_quota_cache_v1';

type ProviderStatus = 'idle' | 'loading' | 'success' | 'error';

interface CodexState {
  status: ProviderStatus;
  percent: number | null;
  lastSyncedAt: string | null;
  rateLimits: CodexRateLimitsSnapshot | null;
  error?: string | null;
}

interface GeminiState {
  status: ProviderStatus;
  percent: number | null;
  lastSyncedAt: string | null;
  quota: GeminiQuotaSnapshot | null;
  error?: string | null;
}

function sanitizeDisplayText(input?: string | null): string {
  if (!input) return '';
  return input
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/Bearer\s+[a-zA-Z0-9_.-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/ya29\.[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED_KEY]')
    .replace(/[A-Za-z]:\\[^:\n\r]+/g, '[REDACTED_PATH]');
}

function formatExactDateTime(input?: string | number | null): string {
  if (!input) return '확인 불가';
  let d: Date;
  if (typeof input === 'number') {
    const ms = input < 1e11 ? input * 1000 : input;
    d = new Date(ms);
  } else {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) return '확인 불가';

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

function formatRemainingDuration(input?: string | number | null, fallbackText?: string | null): string {
  if (fallbackText) return fallbackText;
  if (!input) return '확인 불가';
  let d: Date;
  if (typeof input === 'number') {
    const ms = input < 1e11 ? input * 1000 : input;
    d = new Date(ms);
  } else {
    d = new Date(input);
  }
  if (isNaN(d.getTime())) return '확인 불가';

  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return '0분 (초기화 완료됨)';

  const totalSec = Math.floor(diffMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHours = Math.floor(totalMin / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMin % 60;

  if (days > 0) {
    return hours > 0 ? `${days}일 ${hours}시간 남음` : `${days}일 남음`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}시간 ${mins}분 남음` : `${hours}시간 남음`;
  }
  return `${Math.max(1, mins)}분 남음`;
}

function saveCodexCache(state: CodexState): void {
  try {
    if (typeof window !== 'undefined' && state.status === 'success') {
      const payload = JSON.stringify(state);
      window.sessionStorage?.setItem(STORAGE_KEY_CODEX, payload);
      window.localStorage?.setItem(STORAGE_KEY_CODEX, payload);
    }
  } catch {}
}

function saveGeminiCache(state: GeminiState): void {
  try {
    if (typeof window !== 'undefined' && state.status === 'success') {
      const payload = JSON.stringify(state);
      window.sessionStorage?.setItem(STORAGE_KEY_GEMINI, payload);
      window.localStorage?.setItem(STORAGE_KEY_GEMINI, payload);
    }
  } catch {}
}

export interface ProjectUsageBarProps {
  tracker?: RunTracker;
}

export function ProjectUsageBar({ tracker }: ProjectUsageBarProps = {}) {
  const [codex, setCodex] = useState<CodexState>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage?.getItem(STORAGE_KEY_CODEX) || window.localStorage?.getItem(STORAGE_KEY_CODEX);
        if (raw) {
          const parsed = JSON.parse(raw) as CodexState;
          if (parsed && parsed.status === 'success' && parsed.percent !== null) {
            return parsed;
          }
        }
      } catch {}
    }
    return { status: 'idle', percent: null, lastSyncedAt: null, rateLimits: null };
  });

  const [gemini, setGemini] = useState<GeminiState>(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage?.getItem(STORAGE_KEY_GEMINI) || window.localStorage?.getItem(STORAGE_KEY_GEMINI);
        if (raw) {
          const parsed = JSON.parse(raw) as GeminiState;
          if (parsed && parsed.status === 'success' && parsed.percent !== null) {
            return parsed;
          }
        }
      } catch {}
    }
    return { status: 'idle', percent: null, lastSyncedAt: null, quota: null };
  });

  const [activeTooltip, setActiveTooltip] = useState<'codex' | 'gemini' | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const codexRef = useRef<HTMLDivElement>(null);
  const geminiRef = useRef<HTMLDivElement>(null);

  // Close tooltip on Esc and outside click
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveTooltip(null);
      }
    };

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setActiveTooltip(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  // Manual fetch only, bypassing server cache when refresh=true
  const fetchCodex = useCallback(async (refresh = false) => {
    setCodex(prev => ({ ...prev, status: 'loading', error: null }));
    try {
      const url = refresh ? '/api/codex-usage?refresh=true' : '/api/codex-usage';
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Codex 사용량을 조회하지 못했습니다.');
      }
      const data = (await res.json()) as CodexUsageResponse;

      let remainingPercent: number | null = null;
      if (data.rate_limits?.primary?.remaining_percent !== null && data.rate_limits?.primary?.remaining_percent !== undefined) {
        remainingPercent = Math.round(data.rate_limits.primary.remaining_percent);
      } else if (data.rate_limits?.secondary?.remaining_percent !== null && data.rate_limits?.secondary?.remaining_percent !== undefined) {
        remainingPercent = Math.round(data.rate_limits.secondary.remaining_percent);
      } else if (data.status === 'empty' || data.status === 'active') {
        remainingPercent = 100;
      }

      if (remainingPercent !== null) {
        const newState: CodexState = {
          status: 'success',
          percent: remainingPercent,
          lastSyncedAt: data.lastSyncedAt || new Date().toISOString(),
          rateLimits: data.rate_limits || null,
        };
        setCodex(newState);
        saveCodexCache(newState);
      } else {
        throw new Error(data.message || '유효한 한도 정보를 찾을 수 없습니다.');
      }
    } catch (err: unknown) {
      setCodex(prev => ({
        ...prev,
        status: 'error',
        error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
      }));
    }
  }, []);

  // Manual fetch only, bypassing server cache when refresh=true
  const fetchGemini = useCallback(async (refresh = false) => {
    setGemini(prev => ({ ...prev, status: 'loading', error: null }));
    try {
      const url = refresh ? '/api/gemini-quota?refresh=true' : '/api/gemini-quota';
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Gemini 사용량을 조회하지 못했습니다.');
      }
      const data = (await res.json()) as GeminiQuotaResponse;

      let remPercent: number | null = null;
      if (data.quota?.fiveHour?.remainingPercent !== null && data.quota?.fiveHour?.remainingPercent !== undefined) {
        remPercent = Math.round(data.quota.fiveHour.remainingPercent);
      } else if (data.quota?.weekly?.remainingPercent !== null && data.quota?.weekly?.remainingPercent !== undefined) {
        remPercent = Math.round(data.quota.weekly.remainingPercent);
      }

      if (data.ok && data.quota && remPercent !== null) {
        const newState: GeminiState = {
          status: 'success',
          percent: remPercent,
          lastSyncedAt: data.lastSyncedAt || new Date().toISOString(),
          quota: data.quota,
        };
        setGemini(newState);
        saveGeminiCache(newState);
      } else {
        throw new Error(data.message || '확인 가능한 쿼터 풀이 없습니다.');
      }
    } catch (err: unknown) {
      setGemini(prev => ({
        ...prev,
        status: 'error',
        error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
      }));
    }
  }, []);
 
  const activeTracker = tracker || getSharedRunTracker();

  useEffect(() => {
    const unsubscribe = activeTracker.subscribe(event => {
      if (event.bypassCache) {
        void fetchCodex(true);
        void fetchGemini(true);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [activeTracker, fetchCodex, fetchGemini]);

  return (
    <section
      ref={containerRef}
      aria-label="Codex 및 Gemini 사용량 관제 바"
      className="relative z-20 flex min-h-[34px] flex-wrap items-center justify-between gap-x-6 gap-y-1.5 border-b border-border/70 bg-[#070b12]/90 px-4 py-1.5 text-xs text-slate-300 backdrop-blur-xs"
    >
      {/* Left Item: Codex Usage */}
      <div ref={codexRef} className="relative flex items-center gap-2">
        <div className="flex items-center gap-1.5 font-medium text-slate-300">
          <Gauge className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
          <span>Codex 사용량</span>
        </div>

        {codex.status === 'idle' && (
          <button
            type="button"
            onClick={() => void fetchCodex(false)}
            aria-label="Codex 사용량 조회하기"
            className="rounded border border-border bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            조회하기
          </button>
        )}

        {codex.status === 'loading' && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <RefreshCw className="h-3 w-3 animate-spin text-sky-400" aria-hidden="true" />
            <span>조회 중…</span>
          </span>
        )}

        {codex.status === 'error' && (
          <button
            type="button"
            onClick={() => void fetchCodex(true)}
            aria-label="Codex 사용량 다시 조회"
            className="flex items-center gap-1 rounded border border-rose-500/40 bg-rose-950/30 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-900/40 hover:text-rose-200 transition-colors"
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            <span>다시 조회</span>
          </button>
        )}

        {codex.status === 'success' && codex.percent !== null && (
          <div className="relative">
            <button
              type="button"
              id="codex-usage-btn"
              aria-haspopup="dialog"
              aria-expanded={activeTooltip === 'codex'}
              aria-describedby="codex-usage-tooltip"
              onClick={() => setActiveTooltip(prev => (prev === 'codex' ? null : 'codex'))}
              onMouseEnter={() => setActiveTooltip('codex')}
              onFocus={() => setActiveTooltip('codex')}
              className="inline-flex items-center gap-1 rounded border border-sky-500/40 bg-sky-950/40 px-2 py-0.5 text-[11px] font-mono font-semibold text-sky-300 hover:bg-sky-900/50 hover:border-sky-400 transition-colors focus:outline-hidden focus:ring-1 focus:ring-sky-400"
            >
              <span>{codex.percent}% 남음</span>
            </button>

            {/* Codex Tooltip */}
            {activeTooltip === 'codex' && (
              <div
                id="codex-usage-tooltip"
                role="tooltip"
                tabIndex={-1}
                className="absolute left-0 top-full mt-2 w-72 sm:w-80 rounded-xl border border-sky-500/40 bg-[#0c121d] p-3 text-xs shadow-2xl shadow-black/80 z-50 animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="flex items-center justify-between border-b border-border/60 pb-2 mb-2">
                  <div className="flex items-center gap-1.5 font-semibold text-sky-300">
                    <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Codex 사용량 세부 정보</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void fetchCodex(true)}
                    aria-label="Codex 사용량 새로고침 (서버 캐시 우회)"
                    title="서버 캐시를 우회하여 최신 사용량 다시 조회"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    <span>재조회</span>
                  </button>
                </div>

                <div className="space-y-2 font-mono text-[11px] text-slate-300">
                  {codex.rateLimits?.primary && (
                    <div className="rounded-lg bg-black/40 p-2.5 space-y-1 border border-border/50">
                      <div className="flex items-center justify-between text-sky-200 font-semibold">
                        <span>기본 한도 ({codex.rateLimits.primary.window_minutes}분 창)</span>
                        <span>{codex.rateLimits.primary.remaining_percent}% 남음</span>
                      </div>
                      <div className="text-[10px] text-slate-400 flex items-center gap-1">
                        <Calendar className="h-3 w-3 text-slate-500" aria-hidden="true" />
                        <span>초기화: {formatExactDateTime(codex.rateLimits.primary.resets_at)}</span>
                      </div>
                      <div className="text-[10px] text-sky-300 flex items-center gap-1">
                        <Clock className="h-3 w-3 text-sky-400" aria-hidden="true" />
                        <span>남은 시간: {formatRemainingDuration(codex.rateLimits.primary.resets_at)}</span>
                      </div>
                    </div>
                  )}

                  {codex.rateLimits?.secondary && (
                    <div className="rounded-lg bg-black/40 p-2.5 space-y-1 border border-border/50">
                      <div className="flex items-center justify-between text-slate-300 font-semibold">
                        <span>보조/주간 한도 ({codex.rateLimits.secondary.window_minutes}분 창)</span>
                        <span>{codex.rateLimits.secondary.remaining_percent}% 남음</span>
                      </div>
                      <div className="text-[10px] text-slate-400 flex items-center gap-1">
                        <Calendar className="h-3 w-3 text-slate-500" aria-hidden="true" />
                        <span>초기화: {formatExactDateTime(codex.rateLimits.secondary.resets_at)}</span>
                      </div>
                      <div className="text-[10px] text-slate-300 flex items-center gap-1">
                        <Clock className="h-3 w-3 text-slate-400" aria-hidden="true" />
                        <span>남은 시간: {formatRemainingDuration(codex.rateLimits.secondary.resets_at)}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1 text-[10px] text-slate-500 border-t border-border/40">
                    {codex.rateLimits?.plan_type && <span>플랜: {codex.rateLimits.plan_type}</span>}
                    {codex.lastSyncedAt && <span>조회: {new Date(codex.lastSyncedAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right Item: Gemini Usage */}
      <div ref={geminiRef} className="relative flex items-center gap-2">
        <div className="flex items-center gap-1.5 font-medium text-slate-300">
          <Gauge className="h-3.5 w-3.5 text-purple-400" aria-hidden="true" />
          <span>Gemini 사용량</span>
        </div>

        {gemini.status === 'idle' && (
          <button
            type="button"
            onClick={() => void fetchGemini(false)}
            aria-label="Gemini 사용량 조회하기"
            className="rounded border border-border bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-purple-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            조회하기
          </button>
        )}

        {gemini.status === 'loading' && (
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <RefreshCw className="h-3 w-3 animate-spin text-purple-400" aria-hidden="true" />
            <span>조회 중…</span>
          </span>
        )}

        {gemini.status === 'error' && (
          <button
            type="button"
            onClick={() => void fetchGemini(true)}
            aria-label="Gemini 사용량 다시 조회"
            className="flex items-center gap-1 rounded border border-rose-500/40 bg-rose-950/30 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-900/40 hover:text-rose-200 transition-colors"
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            <span>다시 조회</span>
          </button>
        )}

        {gemini.status === 'success' && gemini.percent !== null && (
          <div className="relative">
            <button
              type="button"
              id="gemini-usage-btn"
              aria-haspopup="dialog"
              aria-expanded={activeTooltip === 'gemini'}
              aria-describedby="gemini-usage-tooltip"
              onClick={() => setActiveTooltip(prev => (prev === 'gemini' ? null : 'gemini'))}
              onMouseEnter={() => setActiveTooltip('gemini')}
              onFocus={() => setActiveTooltip('gemini')}
              className="inline-flex items-center gap-1 rounded border border-purple-500/40 bg-purple-950/40 px-2 py-0.5 text-[11px] font-mono font-semibold text-purple-300 hover:bg-purple-900/50 hover:border-purple-400 transition-colors focus:outline-hidden focus:ring-1 focus:ring-purple-400"
            >
              <span>{gemini.percent}% 남음</span>
            </button>

            {/* Gemini Tooltip (Distinguishes 5h and Weekly limits explicitly) */}
            {activeTooltip === 'gemini' && (
              <div
                id="gemini-usage-tooltip"
                role="tooltip"
                tabIndex={-1}
                className="absolute right-0 top-full mt-2 w-72 sm:w-80 rounded-xl border border-purple-500/40 bg-[#0c121d] p-3 text-xs shadow-2xl shadow-black/80 z-50 animate-in fade-in zoom-in-95 duration-100"
              >
                <div className="flex items-center justify-between border-b border-border/60 pb-2 mb-2">
                  <div className="flex items-center gap-1.5 font-semibold text-purple-300">
                    <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Gemini 사용량 세부 정보</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void fetchGemini(true)}
                    aria-label="Gemini 사용량 새로고침 (서버 캐시 우회)"
                    title="서버 캐시를 우회하여 최신 사용량 다시 조회"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-slate-800 hover:text-white"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    <span>재조회</span>
                  </button>
                </div>

                <div className="space-y-2 font-mono text-[11px] text-slate-300">
                  {/* 1. 5-Hour Limit Section */}
                  <div className="rounded-lg bg-black/40 p-2.5 space-y-1 border border-purple-500/30">
                    <div className="flex items-center justify-between text-purple-200 font-semibold">
                      <span>5시간 한도 (5-Hour Window)</span>
                      <span>
                        {gemini.quota?.fiveHour?.remainingPercent !== null && gemini.quota?.fiveHour?.remainingPercent !== undefined
                          ? `${gemini.quota.fiveHour.remainingPercent}% 남음`
                          : '확인 불가'}
                      </span>
                    </div>
                    {gemini.quota?.fiveHour?.usedPercent !== null && (
                      <div className="text-[10px] text-slate-400">
                        사용량: {gemini.quota?.fiveHour?.usedPercent}% 사용됨
                      </div>
                    )}
                    <div className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Calendar className="h-3 w-3 text-slate-500" aria-hidden="true" />
                      <span>초기화: {formatExactDateTime(gemini.quota?.fiveHour?.resetTime)}</span>
                    </div>
                    <div className="text-[10px] text-purple-300 flex items-center gap-1">
                      <Clock className="h-3 w-3 text-purple-400" aria-hidden="true" />
                      <span>
                        남은 시간: {formatRemainingDuration(gemini.quota?.fiveHour?.resetTime, gemini.quota?.fiveHour?.remainingDurationText)}
                      </span>
                    </div>
                  </div>

                  {/* 2. Weekly Limit Section */}
                  <div className="rounded-lg bg-black/40 p-2.5 space-y-1 border border-indigo-500/30">
                    <div className="flex items-center justify-between text-indigo-200 font-semibold">
                      <span>주간 한도 (Weekly Window)</span>
                      <span>
                        {gemini.quota?.weekly?.remainingPercent !== null && gemini.quota?.weekly?.remainingPercent !== undefined
                          ? `${gemini.quota.weekly.remainingPercent}% 남음`
                          : '확인 불가'}
                      </span>
                    </div>
                    {gemini.quota?.weekly?.usedPercent !== null && (
                      <div className="text-[10px] text-slate-400">
                        사용량: {gemini.quota?.weekly?.usedPercent}% 사용됨
                      </div>
                    )}
                    <div className="text-[10px] text-slate-400 flex items-center gap-1">
                      <Calendar className="h-3 w-3 text-slate-500" aria-hidden="true" />
                      <span>초기화: {formatExactDateTime(gemini.quota?.weekly?.resetTime)}</span>
                    </div>
                    <div className="text-[10px] text-indigo-300 flex items-center gap-1">
                      <Clock className="h-3 w-3 text-indigo-400" aria-hidden="true" />
                      <span>
                        남은 시간: {formatRemainingDuration(gemini.quota?.weekly?.resetTime, gemini.quota?.weekly?.remainingDurationText)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-1 text-[10px] text-slate-500 border-t border-border/40">
                    <span>구분: 5시간 vs 주간 한도 분리</span>
                    {gemini.lastSyncedAt && <span>조회: {new Date(gemini.lastSyncedAt).toLocaleTimeString('ko-KR', { hour12: false })}</span>}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
