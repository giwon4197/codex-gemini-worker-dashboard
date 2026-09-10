// Single shared run-created detection, selection tracking, invalidation coordinator, and lifecycle manager.

import type { CompactRunState } from './workspace-contract';

export type SelectionMode = 'latest' | 'historical';

export interface BaseRunItem {
  runId: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
}

export interface RunSnapshotDiff<T extends BaseRunItem = CompactRunState> {
  isInitial: boolean;
  hasNewRuns: boolean;
  newRuns: T[];
  latestNewRun: T | null;
  allRuns: T[];
}

export interface RunInvalidationEvent<T extends BaseRunItem = CompactRunState> {
  generation: number;
  newRun: T;
  allNewRuns: T[];
  selectedRunId: string | null;
  previousSelectedRunId: string | null;
  selectionMode: SelectionMode;
  autoSwitched: boolean;
  bypassCache: boolean;
  timestamp: number;
}

export type InvalidationListener<T extends BaseRunItem = CompactRunState> = (
  event: RunInvalidationEvent<T>
) => void | Promise<void>;

/**
 * Deterministically compares two runs newest first:
 * 1. createdAt ISO timestamp descending
 * 2. runId reverse lexicographical descending (run IDs are timestamped YYYYMMDD-HHmmss-...)
 */
export function compareRunsNewestFirst<T extends BaseRunItem>(a: T, b: T): number {
  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : NaN;

  if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
    return timeB - timeA;
  }
  return b.runId.localeCompare(a.runId);
}

/**
 * Deterministic snapshot diffing and duplicate prevention.
 * Initial hydration populates known runs without emitting invalidation.
 * Subsequent polls emit exactly once per genuinely new run.
 * Preserves all historical runs across polls.
 */
export class RunDetector<T extends BaseRunItem = CompactRunState> {
  private knownRunIds: Set<string> = new Set();
  private runsMap: Map<string, T> = new Map();
  private isHydrated: boolean = false;

  constructor(initialRuns?: T[]) {
    if (initialRuns && initialRuns.length > 0) {
      this.hydrate(initialRuns);
    }
  }

  public hydrate(runs: T[]): void {
    for (const run of runs) {
      if (run && typeof run.runId === 'string' && run.runId.trim().length > 0) {
        this.knownRunIds.add(run.runId);
        this.runsMap.set(run.runId, run);
      }
    }
    this.isHydrated = true;
  }

  public getKnownRunIds(): Set<string> {
    return new Set(this.knownRunIds);
  }

  public getAllRuns(): T[] {
    return Array.from(this.runsMap.values()).sort(compareRunsNewestFirst);
  }

  public processSnapshot(incomingRuns: T[]): RunSnapshotDiff<T> {
    const validIncoming = (incomingRuns || []).filter(
      r => r && typeof r.runId === 'string' && r.runId.trim().length > 0
    );

    if (!this.isHydrated) {
      this.hydrate(validIncoming);
      return {
        isInitial: true,
        hasNewRuns: false,
        newRuns: [],
        latestNewRun: null,
        allRuns: this.getAllRuns(),
      };
    }

    const newRuns: T[] = [];
    for (const run of validIncoming) {
      if (!this.knownRunIds.has(run.runId)) {
        newRuns.push(run);
        this.knownRunIds.add(run.runId);
      }
      // Always update stored record with latest payload data while preserving history
      this.runsMap.set(run.runId, run);
    }

    newRuns.sort(compareRunsNewestFirst);

    return {
      isInitial: false,
      hasNewRuns: newRuns.length > 0,
      newRuns,
      latestNewRun: newRuns[0] || null,
      allRuns: this.getAllRuns(),
    };
  }

  public reset(): void {
    this.knownRunIds.clear();
    this.runsMap.clear();
    this.isHydrated = false;
  }
}

export interface RunTrackerOptions<T extends BaseRunItem = CompactRunState> {
  initialRuns?: T[];
  initialSelectedRunId?: string | null;
  initialSelectionMode?: SelectionMode;
}

/**
 * Coordinates run-created detection, latest vs historical selection decision,
 * generation counters, and invalidation event broadcast.
 */
export class RunTracker<T extends BaseRunItem = CompactRunState> {
  private detector: RunDetector<T>;
  private selectionMode: SelectionMode;
  private selectedRunId: string | null;
  private pendingNewRun: T | null = null;
  private generation: number = 0;
  private listeners: Set<InvalidationListener<T>> = new Set();

  constructor(options: RunTrackerOptions<T> = {}) {
    this.detector = new RunDetector<T>(options.initialRuns);
    this.selectionMode = options.initialSelectionMode || 'latest';
    this.selectedRunId = options.initialSelectedRunId || null;
  }

  public getGeneration(): number {
    return this.generation;
  }

  public getSelectionMode(): SelectionMode {
    return this.selectionMode;
  }

  public isViewingLatest(): boolean {
    return this.selectionMode === 'latest';
  }

  public getSelectedRunId(): string | null {
    return this.selectedRunId;
  }

  public getPendingNewRun(): T | null {
    return this.pendingNewRun;
  }

  public getAllRuns(): T[] {
    return this.detector.getAllRuns();
  }

  public getLatestRun(): T | null {
    const runs = this.getAllRuns();
    return runs[0] || null;
  }

  /**
   * Select a run. If selecting the latest run, remains/switches to 'latest' mode.
   * If selecting an older run, switches to 'historical' mode.
   */
  public selectRun(runId: string | null, forceMode?: SelectionMode): void {
    if (!runId) {
      this.selectedRunId = null;
      this.selectionMode = forceMode || 'latest';
      this.pendingNewRun = null;
      return;
    }

    this.selectedRunId = runId;
    const latest = this.getLatestRun();

    if (forceMode) {
      this.selectionMode = forceMode;
    } else if (latest && runId === latest.runId) {
      this.selectionMode = 'latest';
    } else {
      this.selectionMode = 'historical';
    }

    if (this.pendingNewRun && this.pendingNewRun.runId === runId) {
      this.pendingNewRun = null;
    }
  }

  /**
   * Switches to latest run, clearing pending new-run notification and restoring 'latest' mode.
   */
  public switchToLatestRun(): T | null {
    const target = this.pendingNewRun || this.getLatestRun();
    this.pendingNewRun = null;
    this.selectionMode = 'latest';
    if (target) {
      this.selectedRunId = target.runId;
    }
    return target;
  }

  public dismissPendingNewRun(): void {
    this.pendingNewRun = null;
  }

  /**
   * Ingests ordered snapshot from /api/runs or /api/projects/:id/workers.
   * Decides whether to auto-select new run (latest mode) or retain historical choice and set pending notification.
   */
  public processSnapshot(runs: T[]): RunSnapshotDiff<T> {
    const diff = this.detector.processSnapshot(runs);

    // Initial hydration auto-select if in latest mode and no run selected yet
    if (diff.isInitial && !this.selectedRunId && this.selectionMode === 'latest') {
      const latest = this.getLatestRun();
      if (latest) {
        this.selectedRunId = latest.runId;
      }
    }

    if (!diff.hasNewRuns || !diff.latestNewRun) {
      return diff;
    }

    const newRun = diff.latestNewRun;
    const previousSelected = this.selectedRunId;
    let autoSwitched = false;

    if (this.selectionMode === 'latest') {
      this.selectedRunId = newRun.runId;
      this.pendingNewRun = null;
      autoSwitched = true;
    } else {
      this.pendingNewRun = newRun;
      autoSwitched = false;
    }

    this.generation += 1;

    const event: RunInvalidationEvent<T> = {
      generation: this.generation,
      newRun,
      allNewRuns: diff.newRuns,
      selectedRunId: this.selectedRunId,
      previousSelectedRunId: previousSelected,
      selectionMode: this.selectionMode,
      autoSwitched,
      bypassCache: true,
      timestamp: Date.now(),
    };

    this.emit(event);

    return diff;
  }

  public subscribe(listener: InvalidationListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public onInvalidation(listener: InvalidationListener<T>): () => void {
    return this.subscribe(listener);
  }

  private emit(event: RunInvalidationEvent<T>): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        void listener(event);
      } catch (err) {
        console.error('RunTracker listener error:', err);
      }
    }
  }

  public reset(): void {
    this.detector.reset();
    this.selectionMode = 'latest';
    this.selectedRunId = null;
    this.pendingNewRun = null;
    this.generation = 0;
    this.listeners.clear();
  }
}

export interface RunLifecycleHandle {
  runId: string;
  sequence: number;
  signal: AbortSignal;
  isValid: () => boolean;
}

/**
 * Manages run-scoped subscription/polling lifecycles, teardown ordering,
 * and race prevention to ensure slower responses for old runs never overwrite state.
 */
export class RunLifecycleCoordinator {
  private currentRunId: string | null = null;
  private sequence: number = 0;
  private activeAbortController: AbortController | null = null;
  private teardownFns: Array<() => void> = [];
  private teardownLog?: string[];

  constructor(options?: { teardownLog?: string[] }) {
    this.teardownLog = options?.teardownLog;
  }

  public getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  public getSequence(): number {
    return this.sequence;
  }

  /**
   * Begins a new lifecycle for the given runId.
   * Deterministically runs teardown for the PREVIOUS run BEFORE starting the new lifecycle.
   */
  public startLifecycle(runId: string): RunLifecycleHandle {
    this.teardownCurrent();

    this.currentRunId = runId;
    this.sequence += 1;
    const currentSeq = this.sequence;

    const controller = new AbortController();
    this.activeAbortController = controller;

    return {
      runId,
      sequence: currentSeq,
      signal: controller.signal,
      isValid: () => {
        return (
          this.currentRunId === runId &&
          this.sequence === currentSeq &&
          !controller.signal.aborted
        );
      },
    };
  }

  /**
   * Registers a cleanup callback for the currently active lifecycle.
   */
  public onTeardown(fn: () => void): () => void {
    this.teardownFns.push(fn);
    return () => {
      this.teardownFns = this.teardownFns.filter(f => f !== fn);
    };
  }

  /**
   * Executes teardown callbacks and aborts active controller.
   */
  public teardownCurrent(): void {
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {}
      this.activeAbortController = null;
    }

    if (this.currentRunId && this.teardownLog) {
      this.teardownLog.push(`teardown:${this.currentRunId}`);
    }

    const fns = [...this.teardownFns];
    this.teardownFns = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error('Lifecycle teardown error:', err);
      }
    }
  }

  /**
   * Disposes the coordinator completely (e.g. on component unmount).
   */
  public dispose(): void {
    this.teardownCurrent();
    this.currentRunId = null;
    this.sequence += 1;
  }
}

/**
 * Helper to execute an async fetch guarded against out-of-order race conditions.
 * Slower responses arriving after the run lifecycle changed are discarded.
 */
export async function executeGuarded<T>(
  handle: RunLifecycleHandle,
  fetchFn: (signal: AbortSignal) => Promise<T>,
  onSuccess: (data: T) => void
): Promise<boolean> {
  try {
    const data = await fetchFn(handle.signal);
    if (handle.isValid()) {
      onSuccess(data);
      return true;
    }
    return false;
  } catch (err: unknown) {
    if (handle.isValid() && !(err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }
    return false;
  }
}

let sharedRunTracker: RunTracker<CompactRunState> | null = null;

export function getSharedRunTracker(): RunTracker<CompactRunState> {
  if (!sharedRunTracker) {
    sharedRunTracker = new RunTracker<CompactRunState>();
  }
  return sharedRunTracker;
}

export function resetSharedRunTracker(): void {
  if (sharedRunTracker) {
    sharedRunTracker.reset();
  }
  sharedRunTracker = null;
}
