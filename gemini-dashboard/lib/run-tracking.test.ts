import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { RunDetector, RunTracker, RunLifecycleCoordinator, compareRunsNewestFirst, executeGuarded, getSharedRunTracker, resetSharedRunTracker, type BaseRunItem, type RunInvalidationEvent } from './run-tracking.ts';

void describe('Run Tracking & Invalidation Orchestration', () => {
  beforeEach(() => {
    resetSharedRunTracker();
  });

  void describe('compareRunsNewestFirst', () => {
    void test('orders runs by createdAt timestamp descending', () => {
      const runOlder: BaseRunItem = { runId: '20260910-100000-aaaa', createdAt: '2026-09-10T10:00:00Z' };
      const runNewer: BaseRunItem = { runId: '20260910-110000-bbbb', createdAt: '2026-09-10T11:00:00Z' };
      const list = [runOlder, runNewer].sort(compareRunsNewestFirst);
      assert.strictEqual(list[0].runId, '20260910-110000-bbbb');
      assert.strictEqual(list[1].runId, '20260910-100000-aaaa');
    });

    void test('falls back to reverse runId order when createdAt is missing or identical', () => {
      const run1: BaseRunItem = { runId: '20260910-120000-aaaa' };
      const run2: BaseRunItem = { runId: '20260910-120000-bbbb' };
      const list = [run1, run2].sort(compareRunsNewestFirst);
      assert.strictEqual(list[0].runId, '20260910-120000-bbbb');
      assert.strictEqual(list[1].runId, '20260910-120000-aaaa');
    });
  });

  void describe('Initial Snapshot Behavior (Criterion 1)', () => {
    void test('initial empty hydration produces no new runs and does not emit invalidations', () => {
      const detector = new RunDetector<BaseRunItem>([]);
      const diff = detector.processSnapshot([]);

      assert.strictEqual(diff.isInitial, true);
      assert.strictEqual(diff.hasNewRuns, false);
      assert.strictEqual(diff.newRuns.length, 0);
      assert.strictEqual(diff.latestNewRun, null);
    });

    void test('initial snapshot with existing runs hydrates known runs without emitting new-run invalidations', () => {
      const tracker = new RunTracker<BaseRunItem>();
      let invalidationCount = 0;
      tracker.subscribe(() => {
        invalidationCount++;
      });

      const initialRuns: BaseRunItem[] = [
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z', status: 'completed' },
        { runId: '20260910-093000-2222', createdAt: '2026-09-10T09:30:00Z', status: 'completed' },
      ];

      const diff = tracker.processSnapshot(initialRuns);

      assert.strictEqual(diff.isInitial, true);
      assert.strictEqual(diff.hasNewRuns, false);
      assert.strictEqual(diff.newRuns.length, 0);
      assert.strictEqual(diff.latestNewRun, null);
      assert.strictEqual(invalidationCount, 0, 'Initial hydration must not emit invalidations');
      assert.strictEqual(tracker.getGeneration(), 0);
      // Auto-selected latest on initial hydration when in latest mode
      assert.strictEqual(tracker.getSelectedRunId(), '20260910-093000-2222');
    });
  });

  void describe('New-Run and Duplicate Detection (Criterion 1 & 2)', () => {
    void test('emits exactly one invalidation per genuinely new run', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [{ runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z' }],
      });

      const receivedEvents: RunInvalidationEvent<BaseRunItem>[] = [];
      tracker.subscribe(event => {
        receivedEvents.push(event);
      });

      // Poll with same runs
      const poll1 = tracker.processSnapshot([
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z', status: 'completed' },
      ]);
      assert.strictEqual(poll1.hasNewRuns, false);
      assert.strictEqual(receivedEvents.length, 0);

      // New run arrives (created outside current page or by router)
      const poll2 = tracker.processSnapshot([
        { runId: '20260910-100000-3333', createdAt: '2026-09-10T10:00:00Z', status: 'running' },
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z', status: 'completed' },
      ]);

      assert.strictEqual(poll2.hasNewRuns, true);
      assert.strictEqual(poll2.latestNewRun?.runId, '20260910-100000-3333');
      assert.strictEqual(receivedEvents.length, 1);
      assert.strictEqual(receivedEvents[0].generation, 1);
      assert.strictEqual(receivedEvents[0].newRun.runId, '20260910-100000-3333');
      assert.strictEqual(receivedEvents[0].bypassCache, true);

      // Subsequent repeated polls with the same new run must NOT emit duplicate invalidations
      const poll3 = tracker.processSnapshot([
        { runId: '20260910-100000-3333', createdAt: '2026-09-10T10:00:00Z', status: 'running' },
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z', status: 'completed' },
      ]);
      assert.strictEqual(poll3.hasNewRuns, false);
      assert.strictEqual(receivedEvents.length, 1, 'Repeated polls must not emit duplicates');
    });

    void test('handles multiple new runs arriving together and orders them deterministically', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [{ runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z' }],
      });

      const events: RunInvalidationEvent<BaseRunItem>[] = [];
      tracker.subscribe(e => {
        events.push(e);
      });

      const poll = tracker.processSnapshot([
        { runId: '20260910-100000-aaaa', createdAt: '2026-09-10T10:00:00Z' },
        { runId: '20260910-103000-bbbb', createdAt: '2026-09-10T10:30:00Z' },
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z' },
      ]);

      assert.strictEqual(poll.hasNewRuns, true);
      assert.strictEqual(poll.newRuns.length, 2);
      assert.strictEqual(poll.latestNewRun?.runId, '20260910-103000-bbbb');
      assert.strictEqual(events.length, 1, 'Single invalidation emitted for poll');
      assert.strictEqual(events[0].allNewRuns.length, 2);
      assert.strictEqual(events[0].newRun.runId, '20260910-103000-bbbb');
    });

    void test('preserves every historical run in getAllRuns even if subsequent snapshots omit them', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [
          { runId: '20260910-080000-old1', createdAt: '2026-09-10T08:00:00Z' },
          { runId: '20260910-083000-old2', createdAt: '2026-09-10T08:30:00Z' },
        ],
      });

      // Partial / windowed snapshot that only returns the newest run
      tracker.processSnapshot([
        { runId: '20260910-090000-new3', createdAt: '2026-09-10T09:00:00Z' },
      ]);

      const all = tracker.getAllRuns();
      assert.strictEqual(all.length, 3);
      assert.deepStrictEqual(
        all.map(r => r.runId),
        ['20260910-090000-new3', '20260910-083000-old2', '20260910-080000-old1']
      );
    });
  });

  void describe('Latest-Follow vs Historical-Retain Decisions (Criterion 3)', () => {
    void test('when latest is being viewed, automatically selects new run and updates lifecycles', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [{ runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z' }],
        initialSelectedRunId: '20260910-090000-1111',
        initialSelectionMode: 'latest',
      });

      assert.strictEqual(tracker.isViewingLatest(), true);

      const capturedEvents: RunInvalidationEvent<BaseRunItem>[] = [];
      tracker.subscribe(e => {
        capturedEvents.push(e);
      });

      tracker.processSnapshot([
        { runId: '20260910-100000-2222', createdAt: '2026-09-10T10:00:00Z' },
        { runId: '20260910-090000-1111', createdAt: '2026-09-10T09:00:00Z' },
      ]);

      assert.strictEqual(tracker.getSelectedRunId(), '20260910-100000-2222');
      assert.strictEqual(tracker.getPendingNewRun(), null);
      assert.strictEqual(capturedEvents[0]?.autoSwitched, true);
      assert.strictEqual(capturedEvents[0]?.selectedRunId, '20260910-100000-2222');
      assert.strictEqual(capturedEvents[0]?.previousSelectedRunId, '20260910-090000-1111');
    });

    void test('when historical run is deliberately selected, retains historical selection and exposes pending notification', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [
          { runId: '20260910-080000-hist1', createdAt: '2026-09-10T08:00:00Z' },
          { runId: '20260910-090000-hist2', createdAt: '2026-09-10T09:00:00Z' },
        ],
      });

      // User deliberately selects historical run
      tracker.selectRun('20260910-080000-hist1');
      assert.strictEqual(tracker.getSelectionMode(), 'historical');
      assert.strictEqual(tracker.isViewingLatest(), false);
      assert.strictEqual(tracker.getSelectedRunId(), '20260910-080000-hist1');

      const capturedEvents: RunInvalidationEvent<BaseRunItem>[] = [];
      tracker.subscribe(e => {
        capturedEvents.push(e);
      });

      // New run arrives
      tracker.processSnapshot([
        { runId: '20260910-100000-new3', createdAt: '2026-09-10T10:00:00Z' },
        { runId: '20260910-090000-hist2', createdAt: '2026-09-10T09:00:00Z' },
        { runId: '20260910-080000-hist1', createdAt: '2026-09-10T08:00:00Z' },
      ]);

      // Retains historical selection!
      assert.strictEqual(tracker.getSelectedRunId(), '20260910-080000-hist1');
      assert.strictEqual(capturedEvents[0]?.autoSwitched, false);
      assert.strictEqual(capturedEvents[0]?.selectedRunId, '20260910-080000-hist1');

      // Exposes pending new run notification
      assert.notStrictEqual(tracker.getPendingNewRun(), null);
      assert.strictEqual(tracker.getPendingNewRun()?.runId, '20260910-100000-new3');

      // User triggers notification action to switch to the new run
      const switched = tracker.switchToLatestRun();
      assert.strictEqual(switched?.runId, '20260910-100000-new3');
      assert.strictEqual(tracker.getSelectedRunId(), '20260910-100000-new3');
      assert.strictEqual(tracker.getSelectionMode(), 'latest');
      assert.strictEqual(tracker.getPendingNewRun(), null);
    });
  });

  void describe('Coordinated Invalidation & Refetch Callbacks (Criterion 4)', () => {
    void test('triggers coordinated refetch across multiple consumers together with server cache bypass', async () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [{ runId: '20260910-090000-init', createdAt: '2026-09-10T09:00:00Z' }],
      });

      let runDetailsRefetched: string | null = null;
      let projectGraphRefetched: string | null = null;
      let activeWorkersRefetched: string | null = null;
      let usageCacheBypassed = false;

      // Register multiple coordinated consumers
      tracker.subscribe(event => {
        if (event.autoSwitched && event.selectedRunId) {
          runDetailsRefetched = event.selectedRunId;
          projectGraphRefetched = event.selectedRunId;
          activeWorkersRefetched = event.selectedRunId;
        }
        if (event.bypassCache) {
          usageCacheBypassed = true;
        }
      });

      tracker.processSnapshot([
        { runId: '20260910-110000-new1', createdAt: '2026-09-10T11:00:00Z' },
        { runId: '20260910-090000-init', createdAt: '2026-09-10T09:00:00Z' },
      ]);

      assert.strictEqual(runDetailsRefetched, '20260910-110000-new1');
      assert.strictEqual(projectGraphRefetched, '20260910-110000-new1');
      assert.strictEqual(activeWorkersRefetched, '20260910-110000-new1');
      assert.strictEqual(usageCacheBypassed, true);
    });

    void test('unsubscribe cleanly removes listeners without leak', () => {
      const tracker = new RunTracker<BaseRunItem>({
        initialRuns: [{ runId: '20260910-090000-init', createdAt: '2026-09-10T09:00:00Z' }],
      });

      let count = 0;
      const unsubscribe = tracker.subscribe(() => {
        count++;
      });

      tracker.processSnapshot([
        { runId: '20260910-100000-new1', createdAt: '2026-09-10T10:00:00Z' },
        { runId: '20260910-090000-init', createdAt: '2026-09-10T09:00:00Z' },
      ]);
      assert.strictEqual(count, 1);

      unsubscribe();

      tracker.processSnapshot([
        { runId: '20260910-110000-new2', createdAt: '2026-09-10T11:00:00Z' },
        { runId: '20260910-100000-new1', createdAt: '2026-09-10T10:00:00Z' },
      ]);
      assert.strictEqual(count, 1, 'Unsubscribed listener must not be called');
    });

    void test('shared singleton tracker coordinates cross-component invalidation', () => {
      const tracker = getSharedRunTracker();
      tracker.reset();
      tracker.processSnapshot([{
        runId: '20260910-090000-init',
        createdAt: '2026-09-10T09:00:00Z',
        updatedAt: '2026-09-10T09:00:00Z',
        status: 'completed',
        prompt: 'init',
        requiresUserAction: false,
        tasksCount: 1,
        activeWorkersCount: 0,
        completedTasksCount: 1,
      }]);

      let sharedNotification = false;
      const unsub = tracker.subscribe(() => {
        sharedNotification = true;
      });

      getSharedRunTracker().processSnapshot([
        {
          runId: '20260910-120000-new1',
          createdAt: '2026-09-10T12:00:00Z',
          updatedAt: '2026-09-10T12:00:00Z',
          status: 'running',
          prompt: 'new1',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 1,
          completedTasksCount: 0,
        },
        {
          runId: '20260910-090000-init',
          createdAt: '2026-09-10T09:00:00Z',
          updatedAt: '2026-09-10T09:00:00Z',
          status: 'completed',
          prompt: 'init',
          requiresUserAction: false,
          tasksCount: 1,
          activeWorkersCount: 0,
          completedTasksCount: 1,
        },
      ]);

      assert.strictEqual(sharedNotification, true);
      unsub();
    });
  });

  void describe('Stream Teardown / Reconnection Ordering & Race Prevention (Criterion 5 & 6)', () => {
    void test('strictly orders teardown of old run BEFORE starting new lifecycle', () => {
      const executionOrder: string[] = [];
      const coordinator = new RunLifecycleCoordinator({ teardownLog: executionOrder });

      // Start lifecycle for Run A
      const handleA = coordinator.startLifecycle('run-A');
      coordinator.onTeardown(() => {
        executionOrder.push('teardown-subscriber:run-A');
      });

      assert.strictEqual(handleA.isValid(), true);
      assert.strictEqual(handleA.runId, 'run-A');

      // Start lifecycle for Run B
      executionOrder.push('before:startLifecycle:run-B');
      const handleB = coordinator.startLifecycle('run-B');
      executionOrder.push('after:startLifecycle:run-B');

      assert.strictEqual(handleA.isValid(), false, 'Handle A must be invalidated');
      assert.strictEqual(handleB.isValid(), true, 'Handle B must be valid');

      // Verify strict ordering: teardown of run-A happens BEFORE start of run-B completes
      assert.deepStrictEqual(executionOrder, [
        'before:startLifecycle:run-B',
        'teardown:run-A',
        'teardown-subscriber:run-A',
        'after:startLifecycle:run-B',
      ]);
    });

    void test('slower responses for old run are discarded and never overwrite new run state', async () => {
      const coordinator = new RunLifecycleCoordinator();
      let state = 'initial';

      // 1. Start fetch for Run 1
      const handle1 = coordinator.startLifecycle('run-1');

      // Simulated slow async fetch for Run 1
      const slowFetchRun1 = new Promise<string>(resolve => {
        setTimeout(() => resolve('data-from-run-1'), 30);
      });

      // 2. Before Run 1 resolves, switch to Run 2
      const handle2 = coordinator.startLifecycle('run-2');

      // Simulated faster async fetch for Run 2
      const fastFetchRun2 = new Promise<string>(resolve => {
        setTimeout(() => resolve('data-from-run-2'), 5);
      });

      // Execute Run 2 guarded
      const run2Promise = executeGuarded(
        handle2,
        () => fastFetchRun2,
        data => {
          state = data;
        }
      );

      // Execute Run 1 guarded
      const run1Promise = executeGuarded(
        handle1,
        () => slowFetchRun1,
        data => {
          state = data;
        }
      );

      const [run2Result, run1Result] = await Promise.all([run2Promise, run1Promise]);

      assert.strictEqual(run2Result, true, 'Run 2 must succeed');
      assert.strictEqual(run1Result, false, 'Slower Run 1 must be discarded');
      assert.strictEqual(state, 'data-from-run-2', 'State must not be overwritten by Run 1');
    });

    void test('aborts in-flight controller and cleans up on dispose', () => {
      const coordinator = new RunLifecycleCoordinator();
      const handle = coordinator.startLifecycle('run-cleanup');

      let cleanedUp = false;
      coordinator.onTeardown(() => {
        cleanedUp = true;
      });

      assert.strictEqual(handle.signal.aborted, false);
      assert.strictEqual(handle.isValid(), true);

      coordinator.dispose();

      assert.strictEqual(cleanedUp, true);
      assert.strictEqual(handle.signal.aborted, true);
      assert.strictEqual(handle.isValid(), false);
      assert.strictEqual(coordinator.getCurrentRunId(), null);
    });
  });
});
