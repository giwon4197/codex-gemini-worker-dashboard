import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { deriveWorkspaceResumeCandidate } from './workspace-store.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-candidate-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeJson(relativePath: string, value: unknown) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort();
}

test('returns none without creating workspace state', async () => {
  const before = filesUnder(root);
  const candidate = await deriveWorkspaceResumeCandidate(root);
  assert.equal(candidate.authoritative, false);
  assert.equal(candidate.reason, 'none');
  assert.deepEqual(filesUnder(root), before);
  assert.equal(
    fs.existsSync(path.join(root, '.agent', 'dashboard-state', 'workspace')),
    false
  );
});

test('prefers the latest session and its linked run', async () => {
  writeJson('.agent/dashboard-state/conversations/session-a.json', {
    sessionId: 'session-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    messages: [
      {
        id: 'message-a',
        sender: 'user',
        text: 'continue',
        timestamp: '2026-01-02T00:00:00.000Z',
      },
    ],
    linkedRunIds: ['run-a'],
  });
  writeJson('.agent/dashboard-state/compact/run-a.json', {
    runId: 'run-a',
    prompt: 'task',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    status: 'awaiting_review',
    requiresUserAction: true,
    tasksCount: 1,
    activeWorkersCount: 0,
    completedTasksCount: 1,
  });

  const before = filesUnder(root);
  const candidate = await deriveWorkspaceResumeCandidate(root);
  assert.equal(candidate.reason, 'latest_session_with_linked_run');
  assert.equal(candidate.session?.sessionId, 'session-a');
  assert.equal(candidate.session?.lastMessageId, 'message-a');
  assert.equal(candidate.run?.runId, 'run-a');
  assert.equal(candidate.run?.status, 'awaiting_review');
  assert.deepEqual(filesUnder(root), before);
});

test('reports an unlinked run only as a non-authoritative run candidate', async () => {
  writeJson('.agent/runs/external-run/run.json', {
    runId: 'external-run',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });

  const candidate = await deriveWorkspaceResumeCandidate(root);
  assert.equal(candidate.reason, 'latest_run');
  assert.equal(candidate.session, undefined);
  assert.equal(candidate.run?.runId, 'external-run');
  assert.equal(candidate.authoritative, false);
});
