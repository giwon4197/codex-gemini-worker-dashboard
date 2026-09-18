import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCodexExecArgs,
  buildPresentationPreferenceProjection,
  buildPromptForCodex,
} from './codex-conversation.ts';
import type { WorkerMemorySettings } from './worker-settings.ts';

const memory: WorkerMemorySettings = {
  schemaVersion: 1,
  enabled: true,
  preferences: {
    responseLanguage: {
      value: 'ko',
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    explanationDetail: {
      value: 'detailed',
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    planPresentation: {
      value: 'risk_focused',
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    preferTargetedTests: {
      value: true,
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    completionNotifications: {
      value: false,
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
};

test('projects only closed presentation preferences', () => {
  const projection = buildPresentationPreferenceProjection(memory);
  assert.match(projection, /response_language=ko/);
  assert.match(projection, /explanation_detail=detailed/);
  assert.match(projection, /plan_presentation=risk_focused/);
  assert.doesNotMatch(projection, /preferTargetedTests/);
  assert.doesNotMatch(projection, /completionNotifications/);
});

test('omits disabled or empty preference blocks', () => {
  assert.equal(
    buildPresentationPreferenceProjection({ ...memory, enabled: false }),
    ''
  );
  assert.equal(
    buildPresentationPreferenceProjection({
      schemaVersion: 1,
      enabled: true,
      preferences: {},
    }),
    ''
  );
});

test('keeps classification, file policy, and argv safeguards unchanged', () => {
  const prompt = buildPromptForCodex('fix the bug', memory);
  assert.match(prompt, /Classify into one of 3 categories/);
  assert.match(prompt, /affectedFiles/);
  assert.match(prompt, /must not change intent classification/);

  const args = buildCodexExecArgs({ prompt, cwd: 'C:/repo' });
  assert.deepEqual(args.slice(0, 8), [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--cd',
  ]);
});
