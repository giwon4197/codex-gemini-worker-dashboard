import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MANIFEST_TIMEOUT_MS, GRAPH_LAYOUT_CONFIG, normalizeRunStatus, STALE_PROCESS_MISMATCH_REASON, validateRunId } from './index.ts';

void test('orchestrator-core barrel exports contract, graph, liveness, and store symbols', () => {
  assert.equal(normalizeRunStatus('running'), 'running');
  assert.ok(GRAPH_LAYOUT_CONFIG.rowHeight > 0);
  assert.ok(STALE_PROCESS_MISMATCH_REASON.length > 0);
  assert.equal(DEFAULT_MANIFEST_TIMEOUT_MS, 30_000);
  assert.equal(validateRunId('run-1'), true);
});
