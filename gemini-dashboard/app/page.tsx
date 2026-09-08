'use client';

import { useEffect, useState, useMemo, useRef, Fragment } from 'react';
import { 
  Activity, 
  Bot, 
  CheckCircle2, 
  Clock3, 
  Cpu, 
  Zap, 
  Search, 
  X, 
  ChevronDown, 
  ChevronUp, 
  Play, 
  Pause, 
  RefreshCw, 
  Copy, 
  Check, 
  Terminal, 
  AlertCircle, 
  XCircle, 
  Info, 
  Layers, 
  Flame,
  Calendar,
  Sparkles,
  TrendingDown
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Define TS Interfaces for our enriched schema
export interface DailyActivity {
  date: string; // 'YYYY-MM-DD'
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

export interface CellData {
  date: string;
  dayOfWeek: number;
  completedJobs: number;
  tokens: number;              // Gemini total tokens
  geminiActiveTokens: number;  // Gemini active tokens (실질 토큰)
  geminiCachedTokens: number;  // Gemini cached tokens
  codexTokens: number;         // Codex total tokens
  codexActiveTokens: number;   // Codex active tokens (실질 토큰)
  codexCachedTokens: number;   // Codex cached tokens
  codexCacheRatePct: number;   // Codex cache hit rate (%)
  combinedActiveTokens: number; // Codex active + Gemini active
  codexSharePct: number;       // Codex share (%) based on active tokens
  geminiSharePct: number;      // Gemini share (%) based on active tokens
  codexGeminiRatioText: string; // Ratio display string e.g. "3.00 : 1"
  estimatedSavingsPct: number;
  workVolume: number;
  isFuture: boolean;
  intensity?: number;
}

interface JobStats {
  prompt: number;
  candidates: number;
  cached: number;
  thoughts: number;
  requests: number;
  latency: number;
}

interface Job {
  name: string;
  model: string;
  status: string; // '완료' | '실패'
  tokens: string; // Pre-formatted or number string
  duration: string;
  time: string;
  timestamp?: string; // New enriched field: ISO timestamp
  snippet?: string;   // New enriched field: Response snippet or Error details
  stats?: JobStats;   // New enriched field: Detailed token breakdown for this job
}

interface DashboardData {
  updatedAt: string;
  summary: {
    tokens: number;
    requests: number;
    completed: number;
    failed: number;
    averageLatencyMs: number;
  };
  tokens: {
    prompt: number;
    candidates: number;
    cached: number;
    thoughts: number;
  };
  activityDaily?: DailyActivity[];
  codexDaily?: CodexDailyEntry[];
  jobs: Job[];
}

export interface LiveWorkerLog {
  timestamp: string;
  message: string;
  type: string;
}

export interface LiveWorkerData {
  runId: string;
  taskId?: string;
  task: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  recentLogs: (LiveWorkerLog | string)[];
  partialUsage?: {
    prompt: number;
    candidates: number;
    cached: number;
    thoughts: number;
    total: number;
  };
  finalResponse?: string | null;
  error?: string | null;
}

const initialJobs: Job[] = [
  { 
    name: '대시보드 로깅 검증', 
    model: 'gemini-3.1-pro-preview-customtools, gemini-3-flash-preview', 
    status: '완료', 
    tokens: '11,092', 
    duration: '2.4초', 
    time: '오후 3:41',
    timestamp: '2026-09-08T15:41:13.130Z',
    snippet: 'Gemini 워커가 대시보드 구조에 맞춰 정상적으로 데이터를 전송 및 기록하였습니다.\n작업 유형: 대시보드 로깅 검증\n상태: 정상 처리 완료\n데이터 구조:\n{\n  "updatedAt": "2026-09-08T15:41:13.130Z",\n  "summary": {\n    "tokens": 20375,\n    "requests": 4\n  }\n}',
    stats: {
      prompt: 10670,
      candidates: 8,
      cached: 0,
      thoughts: 414,
      requests: 2,
      latency: 2400
    }
  },
  { 
    name: '연결 상태 확인', 
    model: 'Gemini 3 Flash Preview', 
    status: '완료', 
    tokens: '9,283', 
    duration: '1.75초', 
    time: '오후 3:32',
    timestamp: '2026-09-08T15:32:00.000Z',
    snippet: 'Successfully established secure connection with Google Gemini API endpoint.\nLatency: 1750ms\nAPI Version: v1beta\nAuthentication: Active NPM Global Key',
    stats: {
      prompt: 9282,
      candidates: 1,
      cached: 0,
      thoughts: 0,
      requests: 1,
      latency: 1750
    }
  },
  { 
    name: '워크스페이스 편집 검증', 
    model: '자동 선택', 
    status: '완료', 
    tokens: '기록 전', 
    duration: '26.6초', 
    time: '오후 3:30',
    timestamp: '2026-09-08T15:30:00.000Z',
    snippet: '편집된 워크스페이스 구조 검증 결과:\n- run-gemini-worker.ps1: 정상 수정됨\n- gemini-dashboard/: Next.js 프로젝트 설정 및 패키지 정상 감지됨'
  }
];

const initialData: DashboardData = { 
  updatedAt: '2026-09-08T16:14:47+09:00', 
  summary: { 
    tokens: 550480, 
    requests: 23, 
    completed: 4, 
    failed: 3, 
    averageLatencyMs: 7509.0 
  }, 
  tokens: { 
    prompt: 516947, 
    candidates: 18400, 
    cached: 399363, 
    thoughts: 15133 
  },
  codexDaily: [
    {
      date: '2026-09-08',
      totalTokens: 23269580,
      cachedInputTokens: 22816512,
      activeTokens: 453068
    }
  ],
  jobs: initialJobs 
};

export type WorkerTier = 'fast' | 'normal' | 'advanced' | 'reasoning';

export interface TierInfo {
  id: WorkerTier;
  label: string;
  tag: string;
  model: string;
  desc: string;
}

export const TIERS: Record<WorkerTier, TierInfo> = {
  fast: {
    id: 'fast',
    label: '빠름',
    tag: 'Fast',
    model: 'gemini-3.8-flash-low',
    desc: '신속한 응답 및 경량 작업',
  },
  normal: {
    id: 'normal',
    label: '보통',
    tag: 'Normal',
    model: 'gemini-3.8-flash-medium',
    desc: '표준 개발 및 균형 작업 (기본값)',
  },
  advanced: {
    id: 'advanced',
    label: '고급',
    tag: 'Advanced',
    model: 'gemini-3.8-flash-high',
    desc: '복잡한 리팩터링 및 정밀 수정',
  },
  reasoning: {
    id: 'reasoning',
    label: '강한추론',
    tag: 'Reasoning',
    model: 'gemini-3.1-pro-high',
    desc: '심층 추론 및 고난도 알고리즘',
  },
};

export default function Home() {
  const [data, setData] = useState<DashboardData>(initialData);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(10);

  // Model Tier state & API integration
  const [currentTier, setCurrentTier] = useState<WorkerTier>('normal');
  const [currentModel, setCurrentModel] = useState<string>('gemini-3.8-flash-medium');
  const [isSavingTier, setIsSavingTier] = useState(false);
  const [tierSaveStatus, setTierSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [tierErrorMessage, setTierErrorMessage] = useState('');

  // Codex Usage Auto-Tracking State
  const [codexSyncStatus, setCodexSyncStatus] = useState<{
    isTracking: boolean;
    lastSyncedAt: string | null;
    error: string | null;
  }>({
    isTracking: false,
    lastSyncedAt: null,
    error: null,
  });
  const latestCodexDailyRef = useRef<CodexDailyEntry[] | null>(null);

  const formatSyncTime = (isoString: string | null) => {
    if (!isoString) return '';
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '';
    }
  };

  const mergeCodexDaily = (fallback: CodexDailyEntry[] = [], live: CodexDailyEntry[] = []): CodexDailyEntry[] => {
    const map = new Map<string, CodexDailyEntry>();
    for (const item of fallback) {
      if (item?.date) {
        map.set(item.date, item);
      }
    }
    for (const item of live) {
      if (item?.date) {
        map.set(item.date, item);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  };

  const fetchCodexUsage = async () => {
    try {
      const res = await fetch(`/api/codex-usage?t=${Date.now()}`);
      if (!res.ok) {
        throw new Error(`API 응답 오류 (${res.status})`);
      }
      const json = (await res.json()) as
        | { codexDaily?: CodexDailyEntry[]; data?: CodexDailyEntry[]; lastSyncedAt?: string }
        | CodexDailyEntry[];

      const entries: CodexDailyEntry[] = Array.isArray(json)
        ? json
        : (json?.codexDaily || json?.data || []);

      const lastSyncedAt = (!Array.isArray(json) && json?.lastSyncedAt) ? json.lastSyncedAt : new Date().toISOString();

      if (entries.length > 0) {
        latestCodexDailyRef.current = entries;
        setData(prev => ({
          ...prev,
          codexDaily: mergeCodexDaily(prev.codexDaily, entries),
        }));
        setCodexSyncStatus({
          isTracking: true,
          lastSyncedAt,
          error: null,
        });
      } else {
        setCodexSyncStatus(prev => ({
          ...prev,
          isTracking: false,
          lastSyncedAt,
          error: null,
        }));
      }
    } catch (err: unknown) {
      console.error('Failed to fetch /api/codex-usage:', err);
      setCodexSyncStatus(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Codex 사용량 동기화 지연',
      }));
    }
  };

  const fetchSettings = () => {
    void fetch('/api/settings')
      .then(res => (res.ok ? (res.json() as Promise<{ tier?: string; model?: string }>) : null))
      .then(json => {
        if (json && json.tier && TIERS[json.tier as WorkerTier]) {
          setCurrentTier(json.tier as WorkerTier);
          setCurrentModel(json.model || TIERS[json.tier as WorkerTier].model);
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load /api/settings:', err);
      });
  };

  const handleTierChange = async (tier: WorkerTier) => {
    if (tier === currentTier && tierSaveStatus !== 'error') return;
    setIsSavingTier(true);
    setTierSaveStatus('idle');
    setTierErrorMessage('');

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      });

      const json = (await res.json()) as { tier?: string; model?: string; error?: string };
      if (!res.ok) {
        throw new Error(json.error || '설정 저장에 실패했습니다.');
      }

      if (json.tier && TIERS[json.tier as WorkerTier]) {
        setCurrentTier(json.tier as WorkerTier);
        setCurrentModel(json.model || TIERS[tier].model);
      }
      setTierSaveStatus('success');
      setTimeout(() => {
        setTierSaveStatus(prev => (prev === 'success' ? 'idle' : prev));
      }, 3000);
    } catch (err: unknown) {
      console.error('Save tier error:', err);
      setTierSaveStatus('error');
      const msg = err instanceof Error ? err.message : String(err);
      setTierErrorMessage(msg || '설정 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSavingTier(false);
    }
  };

  // Initial load & Polling setup
  useEffect(() => {
    fetchSettings();
  }, []);

  // Manual & Polling Fetch handler
  const fetchDashboardData = (showLoading = false) => {
    if (showLoading) {
      setIsRefreshing(true);
    }
    fetch(`/data/dashboard.json?t=${Date.now()}`)
      .then(res => {
        if (res.ok) {
          return res.json() as Promise<DashboardData>;
        }
        throw new Error('데이터 로드 실패');
      })
      .then((json: DashboardData) => {
        setData(prev => {
          const mergedCodex = latestCodexDailyRef.current && latestCodexDailyRef.current.length > 0
            ? mergeCodexDaily(json.codexDaily, latestCodexDailyRef.current)
            : (json.codexDaily || prev.codexDaily);
          return {
            ...json,
            codexDaily: mergedCodex,
          };
        });
        if (showLoading) {
          setIsRefreshing(false);
        }
      })
      .catch((err: unknown) => {
        console.error('dashboard.json polling error:', err);
        if (showLoading) {
          setIsRefreshing(false);
        }
      });
  };

  // Initial load & Polling setup
  useEffect(() => {
    fetchDashboardData(false);
    void fetchCodexUsage();
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const dashTimer = setInterval(fetchDashboardData, 3000);
    const codexTimer = setInterval(() => {
      void fetchCodexUsage();
    }, 2500);
    return () => {
      clearInterval(dashTimer);
      clearInterval(codexTimer);
    };
  }, [autoRefresh]);

  // Live Worker 1-second polling
  const [liveWorkers, setLiveWorkers] = useState<LiveWorkerData[]>([]);

  useEffect(() => {
    let mounted = true;
    const fetchLiveWorker = async () => {
      try {
        const multiRes = await fetch(`/data/live-workers.json?t=${Date.now()}`);
        if (multiRes.ok) {
          const multiText = await multiRes.text();
          if (multiText.trim()) {
            const multi = JSON.parse(multiText) as { workers?: LiveWorkerData[] };
            if (mounted && Array.isArray(multi.workers) && multi.workers.length > 0) {
              setLiveWorkers(multi.workers);
              return;
            }
          }
        }
        const res = await fetch(`/data/live-worker.json?t=${Date.now()}`);
        if (!res.ok) return;
        const text = await res.text();
        if (!text || text.trim() === '') return;
        const json = JSON.parse(text) as LiveWorkerData;
        if (mounted && json && json.runId) {
          setLiveWorkers([json]);
        }
      } catch {
        // Ignore read/JSON-parse collisions during atomic file replacement
      }
    };

    void fetchLiveWorker();
    const liveTimer = setInterval(() => {
      void fetchLiveWorker();
    }, 1000);
    return () => {
      mounted = false;
      clearInterval(liveTimer);
    };
  }, []);

  // Copy to clipboard helper
  const handleCopy = (jobId: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedJobId(jobId);
    setTimeout(() => {
      setCopiedJobId(null);
    }, 2000);
  };

  // Toggle Row Expansion
  const toggleRow = (jobId: string) => {
    setExpandedJobId(expandedJobId === jobId ? null : jobId);
  };

  // Analytics Calculations
  const metrics = useMemo(() => {
    const total = data.summary.completed + data.summary.failed;
    const successRate = total > 0 ? (data.summary.completed / total) * 100 : 0;
    
    // Gemini 전체 처리량(캐시 포함) = 실질 토큰(summary.tokens) + 캐시 토큰(tokens.cached)
    // prompt, candidates, cached, thoughts의 분모로 Gemini 전체 처리량을 사용하여 비율 100% 비정상 초과 방지
    const geminiActive = Math.max(0, data.summary?.tokens ?? 0);
    const geminiCached = Math.max(0, data.tokens?.cached ?? 0);
    const geminiTotalThroughput = Math.max(1, geminiActive + geminiCached);

    const promptPercent = (data.tokens.prompt / geminiTotalThroughput) * 100;
    const candidatePercent = (data.tokens.candidates / geminiTotalThroughput) * 100;
    const cachedPercent = (data.tokens.cached / geminiTotalThroughput) * 100;
    const thoughtsPercent = (data.tokens.thoughts / geminiTotalThroughput) * 100;
    
    return {
      successRate: Math.round(successRate),
      promptPercent,
      candidatePercent,
      cachedPercent,
      thoughtsPercent
    };
  }, [data]);

  // Cumulative Codex & Gemini Real Active Token Stats & Estimated Savings
  const cumulativeStats = useMemo(() => {
    // 1. Codex cumulative totals from codexDaily
    // Codex: totalTokens는 캐시 포함 총량, cachedInputTokens는 캐시, activeTokens는 캐시 제외 실질 토큰
    const codexTotals = (data.codexDaily ?? []).reduce(
      (acc, cur) => {
        const total = Math.max(0, cur.totalTokens ?? cur.tokens ?? 0);
        const cached = Math.max(0, cur.cachedInputTokens ?? 0);
        const active = Math.max(0, cur.activeTokens ?? (total - cached));
        return {
          totalTokens: acc.totalTokens + total,
          cachedInputTokens: acc.cachedInputTokens + cached,
          activeTokens: acc.activeTokens + active,
        };
      },
      { totalTokens: 0, cachedInputTokens: 0, activeTokens: 0 }
    );

    // 2. Real data based active tokens:
    // Codex: activeTokens (캐시 제외)
    // Gemini: summary.tokens (Antigravity usage.total_tokens 누적 = 캐시 제외 실질 토큰)
    // Gemini 캐시: tokens.cached (Antigravity usage.cache_read_tokens 누적)
    // Gemini 캐시 포함 전체 처리량: geminiActiveTokens + geminiCachedTokens
    const codexActiveTokens = codexTotals.activeTokens;
    const geminiActiveTokens = Math.max(0, data.summary?.tokens ?? 0);
    const geminiCachedTokens = Math.max(0, data.tokens?.cached ?? 0);
    const geminiTotalTokens = geminiActiveTokens + geminiCachedTokens;

    // 3. Proportion within total active tokens
    const totalActiveTokens = codexActiveTokens + geminiActiveTokens;
    const codexActiveRatio = totalActiveTokens > 0 ? (codexActiveTokens / totalActiveTokens) * 100 : 0;
    const geminiActiveRatio = totalActiveTokens > 0 ? (geminiActiveTokens / totalActiveTokens) * 100 : 0;

    // 4. Estimated Codex Savings (1:1 Proxy):
    // Gemini 처리 실질 토큰(캐시 제외)을 Codex 동일 작업 처리 시 1:1 예상 토큰 프록시로 간주
    const estimatedCodexSavedTokens = geminiActiveTokens;
    const estimatedTotalWork = codexActiveTokens + estimatedCodexSavedTokens;
    const estimatedCodexSavingsRatio = estimatedTotalWork > 0 
      ? (estimatedCodexSavedTokens / estimatedTotalWork) * 100 
      : 0;

    const totalCachedTokens = codexTotals.cachedInputTokens + geminiCachedTokens;
    const grandTotalTokens = codexTotals.totalTokens + geminiTotalTokens;

    return {
      codexActiveTokens,
      geminiActiveTokens,
      totalActiveTokens,
      codexActiveRatio,
      geminiActiveRatio,
      codexTotals,
      geminiTotalTokens,
      geminiCachedTokens,
      totalCachedTokens,
      grandTotalTokens,
      estimatedCodexSavedTokens,
      estimatedCodexSavingsRatio,
    };
  }, [data.codexDaily, data.summary, data.tokens]);

  // Filter & Search Jobs
  const filteredJobs = useMemo(() => {
    return data.jobs.filter(job => {
      // 1. Search term
      const nameMatch = job.name.toLowerCase().includes(searchTerm.toLowerCase());
      const modelMatch = job.model.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesSearch = nameMatch || modelMatch;

      // 2. Status filter
      let matchesStatus = true;
      if (statusFilter === 'success') {
        matchesStatus = job.status === '완료';
      } else if (statusFilter === 'failed') {
        matchesStatus = job.status === '실패';
      }

      return matchesSearch && matchesStatus;
    });
  }, [data.jobs, searchTerm, statusFilter]);

  // Derive Daily Activity Grid (recent 10 weeks = 70 days)
  const activityData = useMemo(() => {
    // Historical cells must come from real job logs only. Never render sample data.
    const explicitDailyMap = new Map<string, DailyActivity>();

    // 2. Derive jobs by local date YYYY-MM-DD
    const jobsByDate = new Map<string, { completedCount: number; tokens: number; cachedTokens: number }>();
    data.jobs.forEach(job => {
      if (job.timestamp) {
        try {
          const d = new Date(job.timestamp);
          if (!isNaN(d.getTime())) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const dateKey = `${yyyy}-${mm}-${dd}`;
            const numTokens = parseInt(String(job.tokens).replace(/[^0-9]/g, ''), 10) || 0;
            const numCached = job.stats?.cached || 0;
            const current = jobsByDate.get(dateKey) || { completedCount: 0, tokens: 0, cachedTokens: 0 };
            jobsByDate.set(dateKey, {
              completedCount: current.completedCount + 1,
              tokens: current.tokens + numTokens,
              cachedTokens: current.cachedTokens + numCached
            });
          }
        } catch {
          // ignore parsing error
        }
      }
    });

    const codexByDate = new Map<string, CodexDailyEntry>();
    (data.codexDaily ?? []).forEach(entry => {
      codexByDate.set(entry.date, entry);
    });

    const updatedDate = (() => {
      const d = new Date(data.updatedAt);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    // Reference today date
    const today = new Date();
    // Build 10 full weeks ending at the end of the current week (Saturday)
    const currentDayOfWeek = today.getDay(); // 0: Sun, ..., 6: Sat
    const daysUntilEndOfWeek = 6 - currentDayOfWeek;
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + daysUntilEndOfWeek);
    endDate.setHours(23, 59, 59, 999);

    const totalDays = 70; // 10 weeks
    const startDate = new Date(endDate);
    startDate.setDate(endDate.getDate() - totalDays + 1);
    startDate.setHours(0, 0, 0, 0);

    const cells = [];
    let maxWorkVolume = 1;

    for (let i = 0; i < totalDays; i++) {
      const cur = new Date(startDate);
      cur.setDate(startDate.getDate() + i);
      const yyyy = cur.getFullYear();
      const mm = String(cur.getMonth() + 1).padStart(2, '0');
      const dd = String(cur.getDate()).padStart(2, '0');
      const dateKey = `${yyyy}-${mm}-${dd}`;
      const dayOfWeek = cur.getDay();

      const explicit = explicitDailyMap.get(dateKey);
      const fromJobs = jobsByDate.get(dateKey);

      let completedJobs = 0;
      let tokens = 0;
      let estimatedSavingsPct = 0;
      let codexSharePct = 0;
      let geminiSharePct = 0;
      const codexEntry = codexByDate.get(dateKey);
      const codexTokens = Math.max(0, codexEntry?.totalTokens ?? codexEntry?.tokens ?? 0);
      const codexCachedTokens = Math.min(codexTokens, Math.max(0, codexEntry?.cachedInputTokens ?? 0));
      const codexActiveTokens = Math.max(0, codexEntry?.activeTokens ?? (codexTokens - codexCachedTokens));

      if (explicit) {
        completedJobs = explicit.completedJobs ?? 0;
        tokens = explicit.tokens ?? 0;
        estimatedSavingsPct = explicit.estimatedSavingsPct ?? 0;
        codexSharePct = explicit.codexSharePct ?? 0;
        geminiSharePct = explicit.geminiSharePct ?? 0;
      }

      // If jobs exist for this date, enrich or fill
      if (fromJobs) {
        completedJobs = Math.max(completedJobs, fromJobs.completedCount);
        tokens = Math.max(tokens, fromJobs.tokens);
      }

      // Gemini tokens: job.tokens는 이미 캐시 제외 실질 토큰(usage.total_tokens)임
      const geminiActiveTokens = Math.max(0, tokens);
      const geminiCachedTokens = fromJobs?.cachedTokens ?? (dateKey === updatedDate ? Math.max(0, data.tokens.cached) : 0);
      const combinedActiveTokens = codexActiveTokens + geminiActiveTokens;
      const codexCacheRatePct = codexTokens > 0 ? (codexCachedTokens / codexTokens) * 100 : 0;
      if (!explicit && combinedActiveTokens > 0) {
        estimatedSavingsPct = 0;
        codexSharePct = (codexActiveTokens / combinedActiveTokens) * 100;
        geminiSharePct = (geminiActiveTokens / combinedActiveTokens) * 100;
      }

      // Heat intensity follows newly processed work, excluding cached input.
      const workVolume = combinedActiveTokens + completedJobs * 25000;
      if (workVolume > maxWorkVolume) {
        maxWorkVolume = workVolume;
      }

      const isFuture = cur.getTime() > today.getTime() && dateKey !== `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      cells.push({
        date: dateKey,
        dayOfWeek,
        completedJobs,
        tokens,
        geminiActiveTokens,
        geminiCachedTokens,
        codexTokens,
        codexActiveTokens,
        codexCachedTokens,
        codexCacheRatePct,
        combinedActiveTokens,
        codexGeminiRatioText: geminiActiveTokens > 0
          ? `${(codexActiveTokens / geminiActiveTokens).toFixed(2)} : 1`
          : codexActiveTokens > 0 ? 'Codex only' : '기록 없음',
        estimatedSavingsPct,
        codexSharePct,
        geminiSharePct,
        workVolume,
        isFuture
      });
    }

    // Assign intensity 0 - 4
    const weeks = [];
    for (let w = 0; w < 10; w++) {
      const weekDays = cells.slice(w * 7, (w + 1) * 7).map(c => {
        let intensity = 0;
        if (c.workVolume > 0 && !c.isFuture) {
          const ratio = c.workVolume / maxWorkVolume;
          if (ratio > 0.65) intensity = 4;
          else if (ratio > 0.35) intensity = 3;
          else if (ratio > 0.12) intensity = 2;
          else intensity = 1;
        }
        return { ...c, intensity };
      });
      weeks.push(weekDays);
    }

    const totalTrackedTokens = cells.reduce((sum, c) => sum + c.tokens, 0);
    const totalCompletedJobs = cells.reduce((sum, c) => sum + c.completedJobs, 0);

    return { weeks, totalTrackedTokens, totalCompletedJobs };
  }, [data.codexDaily, data.jobs, data.tokens.cached, data.updatedAt]);

  // Active hover/focused cell for tooltip/popover
  const [activeCell, setActiveCell] = useState<CellData | null>(null);

  // Get job identifier
  const getJobId = (job: Job, idx: number) => {
    return job.timestamp || `${job.name}-${job.time}-${idx}`;
  };

  return (
    <main className="min-h-screen bg-background text-foreground transition-all duration-300">
      <div className="mx-auto max-w-[1440px] px-5 py-6 lg:px-10 lg:py-9">
        
        {/* HEADER */}
        <header className="mb-8 flex flex-col justify-between gap-6 border-b border-border/70 pb-7 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-cyan-300">
              <span className="status-dot" />
              <span>LIVE · 로컬 워커</span>
              {autoRefresh ? (
                <span className="text-[11px] text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full ml-1">
                  자동 갱신 중 (3초)
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
                  자동 갱신 정지됨
                </span>
              )}
            </div>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl bg-gradient-to-r from-white via-slate-100 to-cyan-100 bg-clip-text text-transparent">
              Gemini 워커 관제실
            </h1>
            <p className="mt-2 text-base text-muted-foreground">
              Codex가 맡긴 작업과 모델 사용량을 실시간으로 모니터링합니다.
            </p>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            {/* Top row: Auto-refresh controls & Codex tracking indicator */}
            <div className="flex flex-wrap items-center gap-2 self-start lg:self-end">
              {codexSyncStatus.isTracking ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/40 px-2 py-1 text-[11px] font-medium text-emerald-300 shadow-sm" title={`마지막 동기화: ${codexSyncStatus.lastSyncedAt || ''}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Codex 실시간 추적</span>
                  <span className="font-mono text-emerald-400">({formatSyncTime(codexSyncStatus.lastSyncedAt)})</span>
                </div>
              ) : codexSyncStatus.error ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-950/40 px-2 py-1 text-[11px] font-medium text-rose-300 shadow-sm" title={codexSyncStatus.error}>
                  <AlertCircle className="h-3 w-3 text-rose-400" />
                  <span>Codex 동기화 지연 (마지막 정상값 유지)</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1 text-[11px] font-medium text-slate-400 shadow-sm">
                  <span>Codex 초기 스냅샷</span>
                </div>
              )}

              <div className="flex items-center gap-1 rounded-lg border border-border bg-card/60 p-1">
                <button
                  type="button"
                  onClick={() => setAutoRefresh(!autoRefresh)}
                  title={autoRefresh ? "자동 갱신 일시정지" : "자동 갱신 시작"}
                  aria-label={autoRefresh ? "자동 갱신 일시정지" : "자동 갱신 시작"}
                  className={`p-1.5 rounded-md hover:bg-secondary transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none ${autoRefresh ? 'text-cyan-400' : 'text-muted-foreground'}`}
                >
                  {autoRefresh ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    fetchDashboardData(true);
                    void fetchCodexUsage();
                  }}
                  disabled={isRefreshing}
                  title="수동 새로고침"
                  aria-label="수동 새로고침"
                  className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                >
                  <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
                </button>
              </div>
            </div>

            {/* Model Tier Selector Panel */}
            <section 
              className="w-full sm:w-auto rounded-xl border border-border/80 bg-card/70 p-2.5 backdrop-blur-sm shadow-sm"
              aria-label="워커 모델 등급 설정 및 모니터링"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-border/50">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-cyan-400 shrink-0" />
                  <span className="text-xs font-semibold text-slate-200">모델 등급:</span>
                  <span className="font-mono text-xs font-semibold text-cyan-300 bg-cyan-950/70 px-2 py-0.5 rounded border border-cyan-500/30">
                    {currentModel}
                  </span>
                </div>

                <div className="flex items-center gap-2 text-xs" aria-live="polite">
                  {isSavingTier ? (
                    <span className="flex items-center gap-1.5 text-cyan-300 text-[11px] font-medium animate-pulse">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>적용 중...</span>
                    </span>
                  ) : tierSaveStatus === 'success' ? (
                    <span className="flex items-center gap-1.5 text-emerald-400 text-[11px] font-medium">
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span>설정 저장됨</span>
                    </span>
                  ) : tierSaveStatus === 'error' ? (
                    <span className="flex items-center gap-1.5 text-rose-400 text-[11px] font-medium" title={tierErrorMessage}>
                      <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
                      <span>저장 실패</span>
                    </span>
                  ) : (
                    <Badge variant="secondary" className="bg-emerald-400/10 text-emerald-300 border border-emerald-400/25 py-0 px-2 text-[10px]">
                      연결됨
                    </Badge>
                  )}
                </div>
              </div>

              {/* 4 Tier Selector Group */}
              <div 
                className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-2" 
                role="radiogroup" 
                aria-label="워커 모델 등급 선택 (빠름, 보통, 고급, 강한추론)"
              >
                {(Object.keys(TIERS) as WorkerTier[]).map((tierKey) => {
                  const tier = TIERS[tierKey];
                  const isSelected = currentTier === tierKey;
                  return (
                    <label
                      key={tier.id}
                      className={`group relative flex flex-col items-start rounded-lg px-2.5 py-1.5 text-left transition-all cursor-pointer select-none outline-none focus-within:ring-2 focus-within:ring-cyan-400 ${
                        isSavingTier ? 'opacity-60 cursor-not-allowed' : ''
                      } ${
                        isSelected
                          ? 'bg-cyan-500/15 border border-cyan-400/70 shadow-sm shadow-cyan-950/40 text-white ring-1 ring-cyan-400/30'
                          : 'bg-secondary/40 border border-transparent hover:bg-secondary/80 text-muted-foreground hover:text-slate-200'
                      }`}
                      title={`${tier.label} (${tier.model}): ${tier.desc}`}
                    >
                      <input
                        type="radio"
                        name="workerTier"
                        value={tier.id}
                        checked={isSelected}
                        disabled={isSavingTier}
                        onChange={() => { void handleTierChange(tier.id); }}
                        className="sr-only"
                      />
                      <div className="flex w-full items-center justify-between gap-1">
                        <span className={`text-xs font-semibold ${isSelected ? 'text-cyan-300' : 'text-slate-300'}`}>
                          {tier.label}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">
                          {tier.tag}
                        </span>
                      </div>
                      <span className={`mt-0.5 font-mono text-[10px] truncate max-w-full ${
                        isSelected ? 'text-cyan-200/90 font-medium' : 'text-slate-400'
                      }`}>
                        {tier.model}
                      </span>
                    </label>
                  );
                })}
              </div>

              {tierSaveStatus === 'error' && (
                <div className="flex items-center justify-between gap-2 px-1 pt-1.5 text-[11px] text-rose-400" role="alert">
                  <span className="truncate">{tierErrorMessage || '설정 저장 중 문제가 발생했습니다.'}</span>
                  <button 
                    type="button"
                    onClick={() => { void handleTierChange(currentTier); }} 
                    className="underline hover:text-rose-300 shrink-0 font-medium"
                  >
                    재시도
                  </button>
                </div>
              )}
            </section>
          </div>
        </header>

        {/* 1. TOP STATS: 3 CIRCULAR DONUT CHARTS (Codex active, Gemini active, Cumulative savings) */}
        <section className="grid gap-5 grid-cols-1 md:grid-cols-3" aria-label="3대 누적 통계 원형 그래프">
          {/* Donut 1: Codex 누적 실질 사용량 */}
          <DonutStatCard
            title="Codex 누적 실질 사용량"
            subtitle="캐시 제외 실질 토큰 사용 현황"
            icon={<Cpu className="h-5 w-5" />}
            accent="violet"
            percent={cumulativeStats.codexActiveRatio}
            centerValue={`${cumulativeStats.codexActiveRatio.toFixed(1)}%`}
            centerTokenValue={`${cumulativeStats.codexActiveTokens.toLocaleString()} 토큰`}
            centerLabel="실질 점유율"
            badge={
              <div className="flex flex-col items-end gap-1">
                <Badge variant="secondary" className="text-violet-300 border border-violet-400/20 bg-black/20">
                  점유율 {cumulativeStats.codexActiveRatio.toFixed(1)}%
                </Badge>
                {codexSyncStatus.isTracking ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-mono" title={`마지막 동기화: ${codexSyncStatus.lastSyncedAt || ''}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    자동 추적 ({formatSyncTime(codexSyncStatus.lastSyncedAt)})
                  </span>
                ) : codexSyncStatus.error ? (
                  <span className="inline-flex items-center gap-1 text-[10px] text-rose-400" title={codexSyncStatus.error}>
                    <AlertCircle className="h-2.5 w-2.5" />
                    동기화 지연 (마지막 정상값)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                    스냅샷 기준
                  </span>
                )}
              </div>
            }
            tokenCountLabel="캐시 제외 실질 토큰"
            tokenCountValue={`${cumulativeStats.codexActiveTokens.toLocaleString()} 토큰`}
            basisText={`총 입력 ${cumulativeStats.codexTotals.totalTokens.toLocaleString()} 중 캐시 ${cumulativeStats.codexTotals.cachedInputTokens.toLocaleString()} 제외 (${codexSyncStatus.isTracking ? '세션 자동 추적 실시간 반영' : '초기 스냅샷'})`}
            ariaLabel={`Codex 누적 실질 사용량: ${cumulativeStats.codexActiveTokens.toLocaleString()} 토큰, 전체 실질 토큰 대비 ${cumulativeStats.codexActiveRatio.toFixed(1)}%`}
          />

          {/* Donut 2: Gemini 누적 실질 사용량 */}
          <DonutStatCard
            title="Gemini 누적 실질 사용량"
            subtitle="캐시 제외 실질 토큰 사용 현황"
            icon={<Zap className="h-5 w-5" />}
            accent="cyan"
            percent={cumulativeStats.geminiActiveRatio}
            centerValue={`${cumulativeStats.geminiActiveRatio.toFixed(1)}%`}
            centerTokenValue={`${cumulativeStats.geminiActiveTokens.toLocaleString()} 토큰`}
            centerLabel="실질 점유율"
            badge={`점유율 ${cumulativeStats.geminiActiveRatio.toFixed(1)}%`}
            tokenCountLabel="캐시 제외 실질 토큰"
            tokenCountValue={`${cumulativeStats.geminiActiveTokens.toLocaleString()} 토큰`}
            basisText={`실질 ${cumulativeStats.geminiActiveTokens.toLocaleString()} + 캐시 ${cumulativeStats.geminiCachedTokens.toLocaleString()} = 전체 처리 ${cumulativeStats.geminiTotalTokens.toLocaleString()}`}
            ariaLabel={`Gemini 누적 실질 사용량: ${cumulativeStats.geminiActiveTokens.toLocaleString()} 토큰 (실질 ${cumulativeStats.geminiActiveTokens.toLocaleString()} + 캐시 ${cumulativeStats.geminiCachedTokens.toLocaleString()} = 전체 처리 ${cumulativeStats.geminiTotalTokens.toLocaleString()}), 전체 실질 토큰 대비 ${cumulativeStats.geminiActiveRatio.toFixed(1)}%`}
          />

          {/* Donut 3: 추정 Codex 절감량 */}
          <DonutStatCard
            title="추정 Codex 절감량"
            subtitle="1:1 토큰 환산 추정 (실측 비용 절감액 아님)"
            icon={<TrendingDown className="h-5 w-5" />}
            accent="emerald"
            percent={cumulativeStats.estimatedCodexSavingsRatio}
            centerValue={cumulativeStats.estimatedCodexSavedTokens.toLocaleString()}
            centerTokenValue={`비중 ${cumulativeStats.estimatedCodexSavingsRatio.toFixed(1)}%`}
            centerLabel="추정 절감 토큰"
            badge={
              <div className="flex items-center gap-1.5 flex-wrap justify-end">
                <Badge variant="secondary" className="text-amber-300 border border-amber-500/30 bg-amber-500/10 text-[10px] px-1.5 py-0.5 font-normal">
                  신뢰도: 낮음
                </Badge>
                <Badge variant="secondary" className="text-emerald-300 border border-emerald-400/20 bg-black/20 text-[10px] px-1.5 py-0.5">
                  {`비중 ${cumulativeStats.estimatedCodexSavingsRatio.toFixed(1)}%`}
                </Badge>
              </div>
            }
            tokenCountLabel="추정 절감 토큰 (1:1)"
            tokenCountValue={`${cumulativeStats.estimatedCodexSavedTokens.toLocaleString()} 토큰`}
            basisText={`전체 실질 작업 중 추정 절감분의 비중이며 비용 절감률이 아닙니다. 1:1 토큰 환산 추정 · 실측 비용 절감액 아님 · 신뢰도: 낮음 (Gemini 실질 ${cumulativeStats.geminiActiveTokens.toLocaleString()} / 전체 실질 ${(cumulativeStats.codexActiveTokens + cumulativeStats.estimatedCodexSavedTokens).toLocaleString()})`}
            ariaLabel={`추정 Codex 절감량: ${cumulativeStats.estimatedCodexSavedTokens.toLocaleString()} 토큰, 전체 실질 작업 중 추정 비중 ${cumulativeStats.estimatedCodexSavingsRatio.toFixed(1)}% (1:1 토큰 환산 추정, 실측 비용 절감액 아님, 신뢰도: 낮음)`}
          />
        </section>

        {/* 2. DAILY ACTIVITY HEATMAP SECTION */}
        <section className="mt-6 panel p-5">
          <div className="flex flex-col gap-2 pb-4 border-b border-border/60 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <span className="icon-box cyan">
                <Calendar className="h-4 w-4" />
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  일별 작업 기여 잔디 (최근 10주 활동)
                  <span className="text-[11px] font-normal text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded-full border border-border/40">
                    GitHub 기여도 잔디 스타일
                  </span>
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  각 셀의 색상 강도는 성공·실패를 포함한 작업량과 토큰 수를 나타냅니다.
                </p>
              </div>
            </div>

            {/* Quick summary stats */}
            <div className="flex items-center gap-4 text-xs font-mono text-slate-300">
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-sans">최근 10주 작업:</span>
                <strong className="text-cyan-300">{activityData.totalCompletedJobs}건</strong>
              </span>
              <span className="hidden sm:inline text-border">|</span>
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-sans">추적 토큰:</span>
                <strong className="text-violet-300">{activityData.totalTrackedTokens.toLocaleString()}</strong>
              </span>
            </div>
          </div>

          {/* Heatmap Grid Container with Horizontal Scroll */}
          <div className="mt-5 overflow-x-auto pb-2 focus:outline-none" aria-label="일별 작업 활동 잔디 스크롤 영역">
            <div className="min-w-[620px] flex items-start gap-3">
              
              {/* Day of Week Labels */}
              <div className="flex flex-col gap-1.5 pt-6 text-[10px] font-mono text-muted-foreground select-none w-6 text-right">
                <span className="h-3 leading-3">일</span>
                <span className="h-3 leading-3">월</span>
                <span className="h-3 leading-3">화</span>
                <span className="h-3 leading-3">수</span>
                <span className="h-3 leading-3">목</span>
                <span className="h-3 leading-3">금</span>
                <span className="h-3 leading-3">토</span>
              </div>

              {/* Weeks Columns */}
              <div className="flex-1 flex flex-col gap-1">
                {/* Month labels header row */}
                <div className="flex gap-1.5 text-[10px] font-mono text-muted-foreground h-5 items-center">
                  {activityData.weeks.map((week, wIdx) => {
                    const firstDay = week[0];
                    const isFirstWeekOfMonth = firstDay.date.endsWith('-01') || 
                      parseInt(firstDay.date.slice(8), 10) <= 7 || 
                      wIdx === 0;
                    const monthLabel = `${parseInt(firstDay.date.slice(5, 7), 10)}월`;
                    return (
                      <div key={`month-${wIdx}`} className="w-3.5 text-center truncate">
                        {isFirstWeekOfMonth ? monthLabel : ''}
                      </div>
                    );
                  })}
                </div>

                {/* 7 rows x 10 weeks grid */}
                <div className="flex gap-1.5">
                  {activityData.weeks.map((week, wIdx) => (
                    <div key={`week-${wIdx}`} className="flex flex-col gap-1.5">
                      {week.map((day) => {
                        const isFocused = activeCell?.date === day.date;
                        
                        // Intensity to color map
                        const intensityClass = 
                          day.isFuture
                            ? 'bg-secondary/15 border-border/10 cursor-not-allowed opacity-30'
                            : day.intensity === 0
                            ? 'bg-slate-900/60 border-slate-800/80 hover:border-slate-600'
                            : day.intensity === 1
                            ? 'bg-emerald-950/70 border-emerald-800/60 hover:border-emerald-500'
                            : day.intensity === 2
                            ? 'bg-emerald-700/80 border-emerald-600/70 hover:border-emerald-400'
                            : day.intensity === 3
                            ? 'bg-emerald-500 border-emerald-400 hover:border-emerald-300'
                            : 'bg-cyan-400 border-cyan-300 hover:border-white shadow-[0_0_8px_rgba(34,211,238,0.4)]';

                        return (
                          <button
                            key={day.date}
                            type="button"
                            onMouseEnter={() => setActiveCell(day)}
                            onMouseLeave={() => setActiveCell(prev => prev?.date === day.date ? null : prev)}
                            onFocus={() => setActiveCell(day)}
                            onBlur={() => setActiveCell(null)}
                            onClick={() => setActiveCell(day)}
                            aria-label={`${day.date}: 작업 ${day.completedJobs}건, 추적 토큰 ${day.tokens.toLocaleString()}`}
                            className={`h-3.5 w-3.5 rounded-[3px] border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-1 focus:ring-offset-background ${intensityClass} ${isFocused ? 'ring-2 ring-cyan-400 ring-offset-1 ring-offset-background scale-110 z-10' : ''}`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              {/* Intensity Legend */}
              <div className="flex flex-col justify-end pt-5 pl-3 border-l border-border/40 text-[11px] text-muted-foreground gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px]">적음</span>
                  <div className="flex gap-1">
                    <span className="h-3 w-3 rounded-[2px] bg-slate-900/60 border border-slate-800/80" title="활동 없음" />
                    <span className="h-3 w-3 rounded-[2px] bg-emerald-950/70 border border-emerald-800/60" title="1단계" />
                    <span className="h-3 w-3 rounded-[2px] bg-emerald-700/80 border border-emerald-600/70" title="2단계" />
                    <span className="h-3 w-3 rounded-[2px] bg-emerald-500 border border-emerald-400" title="3단계" />
                    <span className="h-3 w-3 rounded-[2px] bg-cyan-400 border border-cyan-300" title="4단계 (최대 활동)" />
                  </div>
                  <span className="text-[10px]">많음</span>
                </div>
                <div className="text-[10px] text-slate-400 font-sans">
                  * 셀 선택 시 상세 팝오버 확인
                </div>
              </div>

            </div>
          </div>

          {/* Accessible Tooltip / Popover for Selected or Hovered Cell */}
          <section 
            className="mt-4 rounded-xl border border-border/70 bg-gradient-to-r from-card/90 via-card/60 to-background p-4 text-xs transition-all shadow-md"
            aria-live="polite"
            aria-label="선택된 일자 작업 상세 정보"
          >
            {activeCell ? (
              <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr_1fr] items-center">
                {/* Left: Date & Completed count */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-3.5 w-3.5 text-cyan-400" />
                    <span className="font-semibold text-sm text-slate-100 font-mono">
                      {activeCell.date}
                    </span>
                    {activeCell.isFuture && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground border-border/50 py-0">미래 일정</Badge>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    작업 건수: <strong className="text-emerald-300 font-mono text-sm">{activeCell.completedJobs}건</strong>
                  </div>
                  <div className="text-muted-foreground">
                    Gemini 실질 토큰: <strong className="text-cyan-300 font-mono text-sm">{activeCell.geminiActiveTokens.toLocaleString()}</strong>
                  </div>
                  <div className="text-muted-foreground">
                    Codex 실질 토큰: <strong className="text-violet-300 font-mono text-sm">{activeCell.codexActiveTokens.toLocaleString()}</strong>
                  </div>
                  <div className="text-muted-foreground">
                    Codex 캐시 사용률: <strong className="text-amber-300 font-mono text-sm">{activeCell.codexCacheRatePct.toFixed(1)}%</strong>
                  </div>
                </div>

                {/* Middle: Work Volume & Savings proxy */}
                <div className="space-y-1.5 sm:border-l sm:border-border/50 sm:pl-4">
                  <div className="flex items-center gap-1.5 text-slate-300 font-medium">
                    <Sparkles className="h-3.5 w-3.5 text-amber-400" />
                    <span>추정 절감 비율 (지표 프록시)</span>
                  </div>
                  <div className="text-lg font-bold font-mono text-amber-300">
                    {activeCell.estimatedSavingsPct.toFixed(1)}%
                  </div>
                  <div className="text-[10px] text-slate-400 leading-tight">
                    ※ 실제 결제 금액 또는 토큰 소모량이 아니며, 워커 자동화 및 캐싱 효과를 가늠하는 <span className="text-amber-200/90 font-medium">추정 지표(Proxy)</span>입니다.
                  </div>
                </div>

                {/* Right: Model Share Breakdown */}
                <div className="space-y-2 sm:border-l sm:border-border/50 sm:pl-4">
                  <div className="text-slate-300 font-medium flex items-center justify-between">
                    <span>토큰 사용 비율</span>
                    <span className="text-[10px] text-muted-foreground font-mono">캐시 제외 실질 토큰</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-muted-foreground">Codex 점유율</span>
                      <span className="font-mono text-slate-300">{activeCell.codexSharePct.toFixed(1)}%</span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-cyan-400 font-medium">Gemini / Antigravity 점유율</span>
                      <span className="font-mono text-cyan-300 font-semibold">{activeCell.geminiSharePct.toFixed(1)}%</span>
                    </div>
                    {/* Visual split progress bar */}
                    <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden flex border border-border/30 mt-1">
                      <div 
                        style={{ width: `${activeCell.codexSharePct}%` }} 
                        className="bg-slate-400 h-full transition-all"
                        title={`Codex: ${activeCell.codexSharePct}%`}
                      />
                      <div 
                        style={{ width: `${activeCell.geminiSharePct}%` }} 
                        className="bg-cyan-400 h-full transition-all"
                        title={`Gemini/Antigravity: ${activeCell.geminiSharePct}%`}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-muted-foreground py-1">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-cyan-400 shrink-0" />
                  <span>잔디 셀 위에 마우스를 올리거나 키보드(Tab / 방향키)로 포커스하면 상세 작업 및 추정 절감율 정보가 표시됩니다.</span>
                </div>
                <span className="text-[11px] text-slate-400">
                  절감 비율은 고정 지표 프록시 모델을 기준으로 산출됩니다.
                </span>
              </div>
            )}
          </section>
        </section>

        {/* 3. CORE METRIC CARDS (누적 토큰, 모델 요청, 평균 응답 속도, 성공률 순서) */}
        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="핵심 통계 카드">
          <Metric 
            icon={<Zap />} 
            label="누적 토큰" 
            value={cumulativeStats.grandTotalTokens.toLocaleString()} 
            note="Codex + Gemini 캐시 포함 합산" 
            accent="cyan" 
          />
          <Metric 
            icon={<Activity />} 
            label="모델 요청" 
            value={String(data.summary.requests)} 
            note="전체 API 호출 횟수" 
            accent="violet" 
          />
          <Metric 
            icon={<Clock3 />} 
            label="평균 응답 속도" 
            value={`${(data.summary.averageLatencyMs / 1000).toFixed(2)}초`} 
            note="요청 건별 지연시간 평균" 
            accent="amber" 
          />
          <Metric 
            icon={<CheckCircle2 />} 
            label="성공률 / 성공 작업" 
            value={`${metrics.successRate}%`} 
            note={`완료 ${data.summary.completed}건 / 실패 ${data.summary.failed}건`} 
            accent="green" 
          />
        </section>

        {/* 3.5. REAL-TIME LIVE WORKER STREAM PANEL */}
        <section className="space-y-4" aria-label="실시간 병렬 워커 목록">
          {(liveWorkers.length > 0 ? liveWorkers : [null]).map((worker, index) => (
            <LiveWorkerPanel
              key={worker?.taskId || worker?.runId || `idle-${index}`}
              live={worker}
              onCopy={handleCopy}
              copiedJobId={copiedJobId}
            />
          ))}
        </section>

        {/* 4. MAIN PANEL LAYOUT */}
        <section className="mt-6 grid gap-6 xl:grid-cols-[1.55fr_0.85fr]">
          
          {/* LEFT: JOB FLOW PANEL */}
          <div className="panel overflow-hidden flex flex-col">
            
            {/* PANEL HEADER WITH FILTERS */}
            <div className="border-b border-border/70 px-5 py-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Layers className="h-4 w-4 text-cyan-400" /> 작업 흐름 (Job Flow)
                </h2>
                <p className="text-sm text-muted-foreground">최근 Codex → Gemini 호출 이력</p>
              </div>
              
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
                {/* Search Bar */}
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="작업명 또는 모델명 검색"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="h-8.5 w-full rounded-md border border-border bg-black/35 pl-9 pr-8 text-xs outline-none focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30 transition-all sm:w-48 lg:w-56"
                  />
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Status Filter Tabs */}
                <div className="flex rounded-md border border-border bg-black/20 p-0.5 text-xs">
                  <button
                    onClick={() => setStatusFilter('all')}
                    className={`px-3 py-1 rounded-sm transition-all ${statusFilter === 'all' ? 'bg-secondary text-foreground font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    전체
                  </button>
                  <button
                    onClick={() => setStatusFilter('success')}
                    className={`px-3 py-1 rounded-sm transition-all ${statusFilter === 'success' ? 'bg-secondary text-emerald-300 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    완료
                  </button>
                  <button
                    onClick={() => setStatusFilter('failed')}
                    className={`px-3 py-1 rounded-sm transition-all ${statusFilter === 'failed' ? 'bg-secondary text-rose-300 font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    실패
                  </button>
                </div>
              </div>
            </div>

            {/* JOBS TABLE */}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-b border-border/50 bg-black/10">
                    <TableHead className="w-[12px]"></TableHead> {/* Chevron toggle column */}
                    <TableHead className="py-3.5">작업</TableHead>
                    <TableHead>모델</TableHead>
                    <TableHead>상태</TableHead>
                    <TableHead>토큰</TableHead>
                    <TableHead>소요시간</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredJobs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="h-44 text-center text-muted-foreground py-10">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <Search className="h-8 w-8 text-slate-600 animate-pulse" />
                          <p className="text-sm font-medium mt-1">일치하는 작업이 없습니다.</p>
                          <p className="text-xs text-slate-500">필터 조건이나 검색어를 변경해 보세요.</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredJobs.slice(0, visibleCount).map((job, index) => {
                      const jobId = getJobId(job, index);
                      const isExpanded = expandedJobId === jobId;
                      const isFailed = job.status === '실패';
                      
                      return (
                        <Fragment key={jobId}>
                          {/* Main Row */}
                          <TableRow 
                            onClick={() => toggleRow(jobId)}
                            className={`group cursor-pointer transition-all border-b border-border/40 ${isExpanded ? 'bg-secondary/40' : 'hover:bg-secondary/20'}`}
                          >
                            <TableCell className="w-[12px] text-center px-2 py-3.5">
                              {isExpanded ? (
                                <ChevronUp className="h-4 w-4 text-cyan-400 transition-transform duration-250" />
                              ) : (
                                <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-transform duration-250" />
                              )}
                            </TableCell>
                            <TableCell className="py-3.5">
                              <div className="font-semibold text-slate-200 group-hover:text-cyan-300 transition-colors">
                                {job.name}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono mt-0.5">
                                {job.time}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={job.model}>
                              {job.model}
                            </TableCell>
                            <TableCell>
                              {isFailed ? (
                                <span className="inline-flex items-center gap-1.5 text-xs text-rose-400 font-medium bg-rose-400/5 px-2.5 py-1 rounded-full border border-rose-400/10">
                                  <XCircle className="h-3 w-3" /> 실패
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300 font-medium bg-emerald-400/5 px-2.5 py-1 rounded-full border border-emerald-400/10">
                                  <CheckCircle2 className="h-3 w-3" /> 완료
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-slate-300">
                              {job.tokens}
                            </TableCell>
                            <TableCell className="text-xs text-slate-300 font-mono">
                              {job.duration || '-'}
                            </TableCell>
                          </TableRow>

                          {/* Expanded Detail Panel */}
                          {isExpanded && (
                            <TableRow className="bg-black/25 border-b border-border/40 hover:bg-transparent">
                              <TableCell colSpan={6} className="p-0 border-t-0">
                                <div className="px-5 py-5 border-y border-border/30 grid gap-5 lg:grid-cols-[1.1fr_0.9fr] text-sm animate-fade-in">
                                  
                                  {/* Left subpanel: Output/Error Preview */}
                                  <div className="flex flex-col rounded-xl border border-border/70 bg-[#070a0e]/95 shadow-lg overflow-hidden h-[340px]">
                                    {/* Subpanel header */}
                                    <div className="bg-black/40 border-b border-border/50 px-4 py-2.5 flex items-center justify-between">
                                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                                        <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                                        <span>{isFailed ? '실패 디버그 정보' : '생성물 미리보기'}</span>
                                      </div>
                                      {job.snippet && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleCopy(jobId, job.snippet || '');
                                          }}
                                          className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1 bg-black/35 px-2 py-1 rounded border border-border/60 transition-colors"
                                        >
                                          {copiedJobId === jobId ? (
                                            <>
                                              <Check className="h-3 w-3 text-emerald-400" />
                                              <span className="text-emerald-400">복사 완료!</span>
                                            </>
                                          ) : (
                                            <>
                                              <Copy className="h-3 w-3" />
                                              <span>복사</span>
                                            </>
                                          )}
                                        </button>
                                      )}
                                    </div>
                                    
                                    {/* Snippet terminal output */}
                                    <div className="p-4 overflow-y-auto flex-1 font-mono text-[11px] leading-relaxed select-text">
                                      {job.snippet ? (
                                        <pre className={`whitespace-pre-wrap ${isFailed ? 'text-rose-300/95' : 'text-slate-300'}`}>
                                          {job.snippet}
                                        </pre>
                                      ) : (
                                        <div className="text-center text-muted-foreground mt-16">
                                          <p className="italic">스니펫 로그가 남지 않은 작업입니다.</p>
                                          <p className="text-[10px] text-slate-500 mt-1">(구버전 이력 혹은 단순 연결 테스트)</p>
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Right subpanel: Token Breakdown & Performance analysis */}
                                  <div className="flex flex-col justify-between bg-card/45 rounded-xl border border-border/50 p-5 h-[340px]">
                                    <div>
                                      <h3 className="font-semibold text-slate-200 flex items-center gap-1.5 border-b border-border/50 pb-2.5">
                                        <Cpu className="h-4 w-4 text-violet-400" />
                                        <span>작업 분석 리포트</span>
                                      </h3>

                                      {/* Per-job Statistics */}
                                      {job.stats ? (
                                        <div className="mt-4 space-y-4">
                                          {/* Mini metrics bar row */}
                                          <div className="grid grid-cols-2 gap-3 mb-1">
                                            <div className="bg-black/20 p-2.5 rounded-lg border border-border/40">
                                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">요청 횟수</div>
                                              <div className="text-base font-semibold font-mono text-cyan-200 mt-0.5">{job.stats.requests}회</div>
                                            </div>
                                            <div className="bg-black/20 p-2.5 rounded-lg border border-border/40">
                                              <div className="text-[10px] text-muted-foreground uppercase tracking-wider">작업 지연</div>
                                              <div className="text-base font-semibold font-mono text-amber-200 mt-0.5">{(job.stats.latency / 1000).toFixed(2)}초</div>
                                            </div>
                                          </div>

                                          {/* Token allocations progress */}
                                          <div className="space-y-2.5 mt-2">
                                            <div className="text-xs font-semibold text-slate-300">토큰 비중 분석</div>
                                            
                                            <JobUsageBar 
                                              label="입력 프롬프트" 
                                              value={job.stats.prompt} 
                                              total={job.stats.prompt + job.stats.candidates + job.stats.cached + job.stats.thoughts} 
                                              colorClass="bg-cyan-500"
                                            />
                                            <JobUsageBar 
                                              label="출력 후보" 
                                              value={job.stats.candidates} 
                                              total={job.stats.prompt + job.stats.candidates + job.stats.cached + job.stats.thoughts} 
                                              colorClass="bg-violet-400"
                                            />
                                            <JobUsageBar 
                                              label="사고 토큰 (Thinking)" 
                                              value={job.stats.thoughts} 
                                              total={job.stats.prompt + job.stats.candidates + job.stats.cached + job.stats.thoughts} 
                                              colorClass="bg-amber-400"
                                            />
                                            <JobUsageBar 
                                              label="캐시 토큰 (Context Cache)" 
                                              value={job.stats.cached} 
                                              total={job.stats.prompt + job.stats.candidates + job.stats.cached + job.stats.thoughts} 
                                              colorClass="bg-emerald-400"
                                            />
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="mt-12 text-center text-muted-foreground flex flex-col items-center gap-2">
                                          <Info className="h-6 w-6 text-slate-500" />
                                          <p className="text-xs">상세 통계 분석 정보가 존재하지 않습니다.</p>
                                          <p className="text-[10px] text-slate-500 max-w-[240px] leading-relaxed">
                                            이 작업은 수동 로깅되었거나 통계 정보가 없는 구버전 wrapper로 처리되었습니다.
                                          </p>
                                        </div>
                                      )}
                                    </div>

                                    {/* Action info banner */}
                                    <div className="rounded-lg bg-black/15 border border-border/40 p-3 text-[11px] text-muted-foreground leading-relaxed">
                                      <span className="font-semibold text-slate-300">Tip:</span> 이 관제실은 Gemini가 뱉어내는 <code>thoughts</code>(사고 영역)와 지연 속도를 파싱해 지능 상태를 밀착 감시합니다.
                                    </div>
                                  </div>

                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* SHOW MORE BUTTON */}
            {filteredJobs.length > visibleCount && (
              <div className="border-t border-border/50 p-4 text-center">
                <button
                  onClick={() => setVisibleCount(prev => prev + 10)}
                  className="px-4 py-2 text-xs font-semibold text-slate-300 hover:text-cyan-300 bg-secondary/30 hover:bg-secondary/60 rounded-md border border-border/70 transition-all shadow-sm"
                >
                  작업 내역 더 보기 ({filteredJobs.length - visibleCount}건 남음)
                </button>
              </div>
            )}
          </div>

          {/* RIGHT: SIDEBAR - MODEL ANALYTICS */}
          <aside className="space-y-6">
            
            {/* CUMULATIVE ALLOCATION */}
            <div className="panel p-5 flex flex-col">
              <div className="flex items-center gap-3 border-b border-border/50 pb-4">
                <span className="icon-box violet">
                  <Cpu className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-semibold text-slate-200">전체 모델 사용량</h2>
                  <p className="text-sm text-muted-foreground">누적 토큰 점유도 분석</p>
                </div>
              </div>

              {/* Progress bars */}
              <div className="mt-6 space-y-5">
                <Usage 
                  label="입력 프롬프트" 
                  value={data.tokens.prompt.toLocaleString()} 
                  percent={metrics.promptPercent} 
                  color="bg-cyan-400"
                />
                <Usage 
                  label="출력 후보" 
                  value={data.tokens.candidates.toLocaleString()} 
                  percent={metrics.candidatePercent} 
                  color="bg-violet-400"
                />
                <Usage 
                  label="캐시 사용 (Cached)" 
                  value={data.tokens.cached.toLocaleString()} 
                  percent={metrics.cachedPercent} 
                  color="bg-emerald-400"
                />
                <Usage 
                  label="사고 토큰 (Thoughts)" 
                  value={data.tokens.thoughts.toLocaleString()} 
                  percent={metrics.thoughtsPercent} 
                  color="bg-amber-400"
                  hasTooltip={true}
                />
              </div>

              {/* System summary info */}
              <div className="mt-8 rounded-xl border border-border/70 bg-black/15 p-4 text-sm text-muted-foreground">
                <p className="font-semibold text-slate-200 flex items-center gap-1.5">
                  <Info className="h-3.5 w-3.5 text-cyan-300" />
                  <span>데이터 기준 범위</span>
                </p>
                <p className="mt-2 text-xs leading-5">
                  로컬 및 원격 Gemini CLI가 보고한 사용 통계입니다. Google Cloud Console 전체 한도는 제공되지 않으며 본 PC에서 처리한 작업만 적산됩니다.
                </p>
              </div>
            </div>

            {/* PERFORMANCE INSIGHT CARD */}
            <div className="panel p-5 flex flex-col bg-gradient-to-br from-card/90 to-background">
              <div className="flex items-center gap-3 border-b border-border/50 pb-4">
                <span className="icon-box cyan">
                  <Flame className="h-5 w-5" />
                </span>
                <div>
                  <h2 className="font-semibold text-slate-200">성능 효율 인사이트</h2>
                  <p className="text-sm text-muted-foreground">모델 작동 품질 진단</p>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                {/* Latency efficiency */}
                <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg border border-border/30">
                  <span className="text-xs text-muted-foreground">평균 응답 속도</span>
                  <span className="text-sm font-semibold font-mono text-amber-200">
                    {(data.summary.averageLatencyMs / 1000).toFixed(2)}초
                  </span>
                </div>

                {/* Tokens per Request */}
                <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg border border-border/30">
                  <span className="text-xs text-muted-foreground">요청당 평균 토큰</span>
                  <span className="text-sm font-semibold font-mono text-cyan-200">
                    {data.summary.requests > 0 
                      ? Math.round(data.summary.tokens / data.summary.requests).toLocaleString() 
                      : 0}
                  </span>
                </div>

                {/* Thoughts overhead ratio */}
                <div className="flex items-center justify-between p-3 bg-black/20 rounded-lg border border-border/30">
                  <span className="text-xs text-muted-foreground">추론(Thinking) 비율</span>
                  <span className="text-sm font-semibold font-mono text-violet-300">
                    {metrics.thoughtsPercent.toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="mt-5 text-[11px] text-slate-400 border-t border-border/40 pt-4 leading-relaxed">
                <span className="font-semibold text-cyan-400">인사이트:</span> 추론 비율이 20%를 초과하는 경우, 코딩 가치 판단이나 리팩토링 설계가 개입되었음을 지시합니다.
              </div>
            </div>

          </aside>

        </section>

      </div>
    </main>
  );
}

type DonutAccent = 'violet' | 'cyan' | 'emerald';

function DonutStatCard({
  title, subtitle, icon, accent, percent, centerValue, centerTokenValue,
  centerLabel, badge, tokenCountLabel, tokenCountValue, basisText, ariaLabel
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accent: DonutAccent;
  percent: number;
  centerValue: string;
  centerTokenValue: string;
  centerLabel: string;
  badge: React.ReactNode;
  tokenCountLabel: string;
  tokenCountValue: string;
  basisText: string;
  ariaLabel: string;
}) {
  const safePercent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const stroke = {
    violet: 'stroke-violet-400',
    cyan: 'stroke-cyan-400',
    emerald: 'stroke-emerald-400'
  }[accent];
  const text = {
    violet: 'text-violet-300',
    cyan: 'text-cyan-300',
    emerald: 'text-emerald-300'
  }[accent];

  return (
    <article className="panel p-5" aria-label={ariaLabel}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`icon-box ${accent}`}>{icon}</span>
          <div>
            <h2 className="font-semibold text-slate-100">{title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {typeof badge === 'string' ? (
          <Badge variant="secondary" className={`${text} border border-current/20 bg-black/20`}>{badge}</Badge>
        ) : (
          badge
        )}
      </div>

      <div className="mt-5 flex flex-col items-center">
        <figure className="relative h-40 w-40" aria-label={`${centerLabel} ${centerValue}`}>
          <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r={radius} fill="none" className="stroke-slate-800" strokeWidth="10" />
            <circle cx="60" cy="60" r={radius} fill="none" className={`${stroke} transition-all duration-700`} strokeWidth="10" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - safePercent / 100)} />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
            <span className={`font-bold font-mono ${text} ${centerValue.length > 9 ? 'text-lg' : centerValue.length > 7 ? 'text-xl' : 'text-2xl'}`}>{centerValue}</span>
            <span className="mt-1 max-w-[120px] truncate text-[11px] text-slate-300">{centerTokenValue}</span>
            <span className="text-[10px] text-muted-foreground">{centerLabel}</span>
          </div>
        </figure>
        <div className="mt-4 w-full rounded-lg border border-border/50 bg-black/15 p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{tokenCountLabel}</span>
            <strong className="font-mono text-slate-200">{tokenCountValue}</strong>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{basisText}</p>
        </div>
      </div>
    </article>
  );
}

// 4 main metric card layout
function Metric({ icon, label, value, note, accent }: { icon: React.ReactNode; label: string; value: string; note: string; accent: string }) { 
  return (
    <article className="panel metric-card hover:border-border/100 transition-colors group flex flex-col justify-between p-5 min-h-[175px]">
      <div className="flex items-start justify-between">
        <span className={`icon-box ${accent} shadow-md group-hover:scale-105 transition-all`}>
          {icon}
        </span>
        <span className="text-[10px] text-slate-500 font-mono">09-08 LIVE</span>
      </div>
      <div>
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</div>
        <div className="mt-1.5 text-3xl font-bold tracking-tight text-white group-hover:text-cyan-100 transition-colors">
          {value}
        </div>
        <div className="mt-2 text-xs text-muted-foreground/80 flex items-center gap-1">
          <span>{note}</span>
        </div>
      </div>
    </article>
  ); 
}

// Sidebar Usage bar indicator
function Usage({ label, value, percent, color, hasTooltip = false }: { label: string; value: string; percent: number; color: string; hasTooltip?: boolean }) { 
  const safePercent = isNaN(percent) ? 0 : Math.min(100, percent);
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs font-medium">
        <span className="text-muted-foreground flex items-center gap-1">
          {label}
          {hasTooltip && (
            <span className="cursor-help text-[10px] text-amber-300/80 bg-amber-300/10 px-1 rounded hover:bg-amber-300/20" title="Gemini 2.0 Thinking 모델 등에서 사용하는 고차원 사고용 토큰">
              Thinking
            </span>
          )}
        </span>
        <span className="font-mono text-slate-300">
          {value} <span className="text-muted-foreground text-[10px] ml-1">({safePercent.toFixed(1)}%)</span>
        </span>
      </div>
      
      {/* Custom Bar for absolute control over color and styling */}
      <div className="h-1.5 bg-black/35 rounded-full overflow-hidden w-full border border-border/30">
        <div 
          style={{ width: `${safePercent}%` }} 
          className={`h-full ${color} rounded-full transition-all duration-500`}
        />
      </div>
    </div>
  ); 
}

// Per-job micro-usage bar
function JobUsageBar({ label, value, total, colorClass }: { label: string; value: number; total: number; colorClass: string }) {
  const percent = total > 0 ? (value / total) * 100 : 0;
  
  return (
    <div className="grid grid-cols-[110px_1fr_60px] items-center gap-3 text-xs">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <div className="h-1 bg-black/40 rounded-full overflow-hidden border border-border/20">
        <div 
          style={{ width: `${percent}%` }} 
          className={`h-full ${colorClass} transition-all duration-300`}
        />
      </div>
      <span className="font-mono text-right text-slate-300 text-[11px] truncate">
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function LiveWorkerPanel({
  live,
  onCopy,
  copiedJobId,
}: {
  live: LiveWorkerData | null;
  onCopy: (id: string, text: string) => void;
  copiedJobId: string | null;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!live || !live.runId) {
    return (
      <section 
        className="mt-6 rounded-2xl border border-border/60 bg-card/40 p-4 text-xs backdrop-blur-sm shadow-sm"
        aria-label="실시간 워커 상태"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-muted-foreground">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-500/50" />
            </span>
            <span className="font-semibold text-slate-300">실시간 워커 모니터</span>
            <span className="text-slate-600 hidden sm:inline">|</span>
            <span className="text-slate-400 text-[11px]">현재 실행 중인 백그라운드 스트리밍 작업이 없습니다. (1초 주기 대기 중)</span>
          </div>
          <Badge variant="outline" className="text-[10px] text-slate-400 border-border/60 self-start sm:self-auto">
            IDLE
          </Badge>
        </div>
      </section>
    );
  }

  const isRunning = live.status === 'running';
  const isCompleted = live.status === 'completed';
  const isFailed = live.status === 'failed';

  const logs = Array.isArray(live.recentLogs) ? live.recentLogs : [];
  const partial = live.partialUsage || { prompt: 0, candidates: 0, cached: 0, thoughts: 0, total: 0 };
  const partialTotal = partial.total || (partial.prompt + partial.candidates + partial.thoughts);

  return (
    <section 
      className={`mt-6 rounded-2xl border transition-all duration-300 overflow-hidden shadow-lg ${
        isRunning 
          ? 'border-cyan-500/50 bg-gradient-to-b from-cyan-950/25 via-card/90 to-background shadow-cyan-950/30 ring-1 ring-cyan-400/30' 
          : isCompleted
          ? 'border-emerald-500/40 bg-gradient-to-b from-emerald-950/20 via-card/85 to-background shadow-emerald-950/20'
          : 'border-rose-500/40 bg-gradient-to-b from-rose-950/20 via-card/85 to-background shadow-rose-950/20'
      }`}
      role="region"
      aria-label="실시간 워커 스트리밍 모니터링 패널"
      aria-live="polite"
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          {isRunning ? (
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-400" />
            </span>
          ) : isCompleted ? (
            <span className="inline-flex rounded-full h-3 w-3 bg-emerald-400" />
          ) : (
            <span className="inline-flex rounded-full h-3 w-3 bg-rose-400" />
          )}

          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm text-slate-100 flex items-center gap-1.5">
                <Terminal className="h-4 w-4 text-cyan-400" />
                {live.task || '무제 작업'}
              </span>
              <Badge 
                variant="secondary" 
                className={`text-[10px] font-medium uppercase px-2 py-0.5 ${
                  isRunning 
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 animate-pulse' 
                    : isCompleted
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-400/30'
                }`}
              >
                {isRunning ? '● 실시간 스트리밍 중 (LIVE)' : isCompleted ? '✓ 최근 실행 완료' : '✕ 실행 실패'}
              </Badge>
              {isCompleted && (
                <span className="text-[11px] text-muted-foreground hidden sm:inline">
                  (※ 하단 작업 흐름 표 및 누적 통계에 확정 반영됨)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 sm:gap-3 text-xs text-muted-foreground mt-1 font-mono flex-wrap">
              <span>모델: <strong className="text-cyan-300">{live.model || '기본 모델'}</strong></span>
              <span>•</span>
              <span>경과: <strong className="text-amber-300">{live.elapsedSeconds}초</strong></span>
              <span>•</span>
              <span>시작: {live.startedAt ? new Date(live.startedAt).toLocaleTimeString('ko-KR') : '-'}</span>
              <span>•</span>
              <span>갱신: {live.updatedAt ? new Date(live.updatedAt).toLocaleTimeString('ko-KR') : '-'}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 px-2.5 py-1.5 rounded-lg border border-border/60 bg-secondary/30 hover:bg-secondary/60 transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? '라이브 패널 접기' : '라이브 패널 펼치기'}
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3.5 w-3.5" />
                <span>접기</span>
              </>
            ) : (
              <>
                <ChevronDown className="h-3.5 w-3.5" />
                <span>상세 보기 ({logs.length}건 로그)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <div className="p-4 space-y-4 animate-fade-in">
          {/* Live partial token usage bar */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
            <div className="bg-black/35 rounded-xl p-2.5 border border-border/40">
              <div className="text-[10px] text-muted-foreground">현재 총 토큰</div>
              <div className="text-base font-bold font-mono text-cyan-200 mt-0.5">
                {partialTotal.toLocaleString()}
              </div>
            </div>
            <div className="bg-black/35 rounded-xl p-2.5 border border-border/40">
              <div className="text-[10px] text-muted-foreground">프롬프트 (입력)</div>
              <div className="text-sm font-semibold font-mono text-slate-200 mt-0.5">
                {partial.prompt.toLocaleString()}
              </div>
            </div>
            <div className="bg-black/35 rounded-xl p-2.5 border border-border/40">
              <div className="text-[10px] text-muted-foreground">후보 (출력)</div>
              <div className="text-sm font-semibold font-mono text-violet-300 mt-0.5">
                {partial.candidates.toLocaleString()}
              </div>
            </div>
            <div className="bg-black/35 rounded-xl p-2.5 border border-border/40">
              <div className="text-[10px] text-muted-foreground">사고 (Thoughts)</div>
              <div className="text-sm font-semibold font-mono text-amber-300 mt-0.5">
                {partial.thoughts.toLocaleString()}
              </div>
            </div>
            <div className="bg-black/35 rounded-xl p-2.5 border border-border/40 col-span-2 sm:col-span-1">
              <div className="text-[10px] text-muted-foreground">캐시 (Cached)</div>
              <div className="text-sm font-semibold font-mono text-emerald-300 mt-0.5">
                {partial.cached.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Terminal Logs & Output */}
          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            {/* Live streaming logs */}
            <div className="rounded-xl border border-border/70 bg-[#05080c] overflow-hidden flex flex-col h-[260px]">
              <div className="bg-black/60 border-b border-border/40 px-3.5 py-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                  실시간 스트리밍 로그 (Live NDJSON Events)
                </span>
                <span className="text-[10px] font-mono text-muted-foreground">
                  최근 {logs.length}건
                </span>
              </div>

              <div className="p-3 overflow-y-auto flex-1 font-mono text-[11px] space-y-1.5 select-text">
                {logs.length === 0 ? (
                  <div className="text-muted-foreground text-center py-10 italic">
                    대기 중... 이벤트 수신 시 실시간 표시됩니다.
                  </div>
                ) : (
                  logs.map((item, idx) => {
                    const isStr = typeof item === 'string';
                    const time = isStr ? '' : item.timestamp;
                    const msg = isStr ? item : item.message;
                    const type = isStr ? 'info' : item.type;

                    const colorClass = 
                      type === 'error' || type === 'stderr' ? 'text-rose-400' :
                      type === 'result' ? 'text-emerald-300 font-semibold' :
                      type === 'stream' ? 'text-cyan-300' :
                      type === 'tool' ? 'text-amber-300' :
                      type === 'system' ? 'text-violet-300' :
                      'text-slate-300';

                    return (
                      <div key={idx} className="flex items-start gap-2 leading-relaxed break-all">
                        {time && <span className="text-slate-500 shrink-0 text-[10px]">{time}</span>}
                        <span className={`inline-block px-1 py-0 rounded text-[9px] uppercase tracking-wide border shrink-0 ${
                          type === 'error' || type === 'stderr' ? 'border-rose-500/40 bg-rose-950/30 text-rose-300' :
                          type === 'result' ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300' :
                          type === 'stream' ? 'border-cyan-500/40 bg-cyan-950/30 text-cyan-300' :
                          type === 'tool' ? 'border-amber-500/40 bg-amber-950/30 text-amber-300' :
                          'border-slate-700 bg-slate-900/50 text-slate-400'
                        }`}>
                          {type}
                        </span>
                        <span className={colorClass}>{msg}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Response Preview or Error Box */}
            <div className="rounded-xl border border-border/70 bg-[#070a0e] overflow-hidden flex flex-col h-[260px]">
              <div className="bg-black/60 border-b border-border/40 px-3.5 py-2 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-cyan-400" />
                  {isFailed ? '오류 메시지 (Error)' : '응답 결과 미리보기 (Preview)'}
                </span>
                {live.finalResponse && (
                  <button
                    type="button"
                    onClick={() => onCopy(live.runId, live.finalResponse || '')}
                    className="text-[11px] text-slate-400 hover:text-cyan-300 flex items-center gap-1 bg-black/40 px-2 py-0.5 rounded border border-border/60 transition-colors focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
                  >
                    {copiedJobId === live.runId ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        <span className="text-emerald-400">복사됨</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>복사</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="p-3 overflow-y-auto flex-1 font-mono text-[11px] select-text">
                {live.error ? (
                  <pre className="text-rose-400 whitespace-pre-wrap leading-relaxed">
                    {live.error}
                  </pre>
                ) : live.finalResponse ? (
                  <pre className="text-slate-200 whitespace-pre-wrap leading-relaxed">
                    {live.finalResponse}
                  </pre>
                ) : isRunning ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <RefreshCw className="h-5 w-5 animate-spin text-cyan-400" />
                    <span className="text-xs">Antigravity 스트리밍 생성 중...</span>
                    <span className="text-[10px] text-slate-500">완료 시 결과 전문이 표시됩니다.</span>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs italic">
                    기록된 응답 결과가 없습니다.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
