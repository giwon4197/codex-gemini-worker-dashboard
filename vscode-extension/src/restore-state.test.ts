import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countUnlinkedActiveRuns, resolveSessionId, resolveTrackedRunId, statusBarLabel } from './restore-state.ts';

const runs = [
  { runId: 'old', status: 'completed', createdAt: '2026-01-01T00:00:00Z' },
  { runId: 'live', actualRunId: 'worker-live', status: 'running', createdAt: '2026-01-01T01:00:00Z' },
  { runId: 'review', status: 'awaiting_review', createdAt: '2026-01-01T02:00:00Z' },
];

void test('restore prefers the stored run when it still exists on disk', () => {
  assert.equal(resolveTrackedRunId('old', runs), 'old');
  assert.equal(resolveTrackedRunId('worker-live', runs), 'live');
});

void test('a fresh window never adopts a run it did not start, even an in-flight one', () => {
  assert.equal(resolveTrackedRunId('missing', runs), undefined);
  assert.equal(resolveTrackedRunId(undefined, runs), undefined);
  assert.equal(resolveTrackedRunId(undefined, []), undefined);
});

void test('restore prefers the stored conversation session when the file still exists', () => {
  const sessions = [
    { sessionId: 'newer', updatedAt: '2026-01-02T00:00:00Z' },
    { sessionId: 'stored', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(resolveSessionId('stored', sessions), 'stored');
  assert.equal(resolveSessionId('gone', sessions), undefined);
  assert.equal(resolveSessionId(undefined, sessions), undefined);
  assert.equal(resolveSessionId(undefined, []), undefined);
});

void test('a reopened window resumes the workspace selection, if it still exists', () => {
  const sessions = [
    { sessionId: 'newer', updatedAt: '2026-01-02T00:00:00Z' },
    { sessionId: 'resumed', updatedAt: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(resolveSessionId(undefined, sessions, 'resumed'), 'resumed');
  // The stored session of this window still wins over the workspace selection.
  assert.equal(resolveSessionId('newer', sessions, 'resumed'), 'newer');
  // A selection whose conversation file is gone resumes nothing.
  assert.equal(resolveSessionId(undefined, sessions, 'deleted'), undefined);
});

void test('resume adopts the run the resumed conversation linked, and no other', () => {
  assert.equal(resolveTrackedRunId(undefined, runs, 'review'), 'review');
  assert.equal(resolveTrackedRunId(undefined, runs, 'worker-live'), 'live');
  assert.equal(resolveTrackedRunId(undefined, runs, 'gone'), undefined);
  // An in-flight run that no resumed conversation links to is still not adopted.
  assert.equal(resolveTrackedRunId(undefined, runs, undefined), undefined);
});

void test('status bar label includes the run status for screen readers', () => {
  assert.equal(statusBarLabel('awaiting review'), '$(comment-discussion) awaiting review');
  assert.equal(
    statusBarLabel('idle', 2),
    '$(comment-discussion) idle · 진행 중 Run 2 (연결 안 됨)'
  );
});

void test('unlinked active runs exclude the tracked run and finished runs', () => {
  assert.equal(countUnlinkedActiveRuns(undefined, runs), 1);
  assert.equal(countUnlinkedActiveRuns('live', runs), 0);
  assert.equal(countUnlinkedActiveRuns('worker-live', runs), 0);
  assert.equal(countUnlinkedActiveRuns(undefined, []), 0);
});
