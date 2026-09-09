import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { normalizeRunStatus, normalizeWorkerStatus, isWorkerActive, requiresUserAction, getUserActionReason, extractTimelineEvents, formatDuration, RUN_STATUS_META, WORKER_STATUS_META, validateSessionId, isLauncherError } from './workspace-contract.ts';

void describe('Workspace Contract & Pure State Transforms', () => {
  void describe('normalizeRunStatus', () => {
    void test('normalizes all standard and legacy run statuses', () => {
      assert.strictEqual(normalizeRunStatus('running'), 'running');
      assert.strictEqual(normalizeRunStatus('RUNNING'), 'running');
      assert.strictEqual(normalizeRunStatus('awaiting_review'), 'awaiting_review');
      assert.strictEqual(normalizeRunStatus('completed'), 'completed');
      assert.strictEqual(normalizeRunStatus('success'), 'completed');
      assert.strictEqual(normalizeRunStatus('done'), 'completed');
      assert.strictEqual(normalizeRunStatus('failed'), 'failed');
      assert.strictEqual(normalizeRunStatus('error'), 'failed');
      assert.strictEqual(normalizeRunStatus('cancelled'), 'cancelled');
      assert.strictEqual(normalizeRunStatus('canceled'), 'cancelled');
      assert.strictEqual(normalizeRunStatus('escalated'), 'escalated');
      assert.strictEqual(normalizeRunStatus('requiresCodex'), 'escalated');
      assert.strictEqual(normalizeRunStatus('planning'), 'planning');
      assert.strictEqual(normalizeRunStatus('pending'), 'pending');
      assert.strictEqual(normalizeRunStatus(null), 'running');
      assert.strictEqual(normalizeRunStatus(undefined), 'running');
      assert.strictEqual(normalizeRunStatus('unknown_status'), 'running');
    });
  });

  void describe('normalizeWorkerStatus', () => {
    void test('normalizes worker statuses correctly', () => {
      assert.strictEqual(normalizeWorkerStatus('planning'), 'planning');
      assert.strictEqual(normalizeWorkerStatus('running'), 'running');
      assert.strictEqual(normalizeWorkerStatus('retrying'), 'retrying');
      assert.strictEqual(normalizeWorkerStatus('retry'), 'retrying');
      assert.strictEqual(normalizeWorkerStatus('verifying'), 'verifying');
      assert.strictEqual(normalizeWorkerStatus('verification'), 'verifying');
      assert.strictEqual(normalizeWorkerStatus('completed'), 'completed');
      assert.strictEqual(normalizeWorkerStatus('policy_violation'), 'policy_violation');
      assert.strictEqual(normalizeWorkerStatus('test_failed'), 'test_failed');
      assert.strictEqual(normalizeWorkerStatus('timed_out'), 'timed_out');
      assert.strictEqual(normalizeWorkerStatus('timeout'), 'timed_out');
      assert.strictEqual(normalizeWorkerStatus('cancelled'), 'cancelled');
      assert.strictEqual(normalizeWorkerStatus('interrupted'), 'interrupted');
      assert.strictEqual(normalizeWorkerStatus('escalated'), 'escalated');
      assert.strictEqual(normalizeWorkerStatus('failed'), 'failed');
      assert.strictEqual(normalizeWorkerStatus(null), 'running');
    });
  });

  void describe('isWorkerActive (Active CLI Filtering)', () => {
    void test('identifies active workers that belong in live CLI terminal', () => {
      assert.strictEqual(isWorkerActive('planning'), true);
      assert.strictEqual(isWorkerActive('running'), true);
      assert.strictEqual(isWorkerActive('retrying'), true);
      assert.strictEqual(isWorkerActive('verifying'), true);
      assert.strictEqual(isWorkerActive('pending'), true);
    });

    void test('identifies terminated workers that must immediately drop out of live CLI terminal', () => {
      assert.strictEqual(isWorkerActive('completed'), false);
      assert.strictEqual(isWorkerActive('failed'), false);
      assert.strictEqual(isWorkerActive('policy_violation'), false);
      assert.strictEqual(isWorkerActive('test_failed'), false);
      assert.strictEqual(isWorkerActive('timed_out'), false);
      assert.strictEqual(isWorkerActive('cancelled'), false);
      assert.strictEqual(isWorkerActive('interrupted'), false);
      assert.strictEqual(isWorkerActive('escalated'), false);
      assert.strictEqual(isWorkerActive('awaiting_review'), false);
      assert.strictEqual(isWorkerActive(null), false);
      assert.strictEqual(isWorkerActive(undefined), false);
    });
  });

  void describe('requiresUserAction', () => {
    void test('detects states requiring user or Codex action', () => {
      assert.strictEqual(requiresUserAction('awaiting_review'), true);
      assert.strictEqual(requiresUserAction('escalated'), true);
      assert.strictEqual(requiresUserAction('policy_violation'), true);
      assert.strictEqual(requiresUserAction('test_failed'), true);
      assert.strictEqual(requiresUserAction('requiresCodex'), true);
      assert.strictEqual(
        requiresUserAction('running', { requiresCodex: true, reason: 'Escalation' }),
        true
      );
    });

    void test('returns false for normal or non-actionable states', () => {
      assert.strictEqual(requiresUserAction('running'), false);
      assert.strictEqual(requiresUserAction('completed'), false);
      assert.strictEqual(requiresUserAction('pending'), false);
      assert.strictEqual(requiresUserAction('cancelled'), false);
      assert.strictEqual(requiresUserAction(null), false);
    });
  });

  void describe('getUserActionReason', () => {
    void test('provides Korean user guidance for awaiting_review, policy_violation, and escalation', () => {
      const reviewReason = getUserActionReason('awaiting_review');
      assert.ok(reviewReason?.includes('통합 브랜치'));

      const policyReason = getUserActionReason('policy_violation');
      assert.ok(policyReason?.includes('allowed_files'));

      const testFailedReason = getUserActionReason('test_failed');
      assert.ok(testFailedReason?.includes('검증'));

      const escReason = getUserActionReason('escalated', { requiresCodex: true, reason: '사용자 개입 필요' });
      assert.strictEqual(escReason, '사용자 개입 필요');
    });
  });

  void describe('extractTimelineEvents', () => {
    void test('builds chronological timeline for in-progress run', () => {
      const events = extractTimelineEvents({
        runId: 'test-run-001',
        status: 'running',
        startedAt: '2026-09-09T10:00:00Z',
        changedFiles: ['app/page.tsx'],
      });

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0].stage, 'plan');
      assert.strictEqual(events[0].status, 'passed');
      assert.strictEqual(events[1].stage, 'execute');
      assert.strictEqual(events[1].status, 'in_progress');
    });

    void test('includes retry and verification stages when present', () => {
      const events = extractTimelineEvents({
        runId: 'test-run-002',
        status: 'completed',
        startedAt: '2026-09-09T10:00:00Z',
        retryHistory: [
          {
            attempt: 1,
            decision: '재시도 결정',
            verifiedAt: '2026-09-09T10:02:00Z',
          },
        ],
        verification: {
          decision: 'PASS',
          verifiedAt: '2026-09-09T10:04:00Z',
          commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }],
        },
        finalResponse: '구현 완료',
      });

      const stages = events.map(e => e.stage);
      assert.deepStrictEqual(stages, ['plan', 'execute', 'retry', 'verify', 'complete']);
      assert.strictEqual(events[events.length - 1].status, 'passed');
    });

    void test('adds action_required stage for awaiting_review run', () => {
      const events = extractTimelineEvents({
        runId: 'test-run-003',
        status: 'awaiting_review',
        startedAt: '2026-09-09T10:00:00Z',
        verification: {
          decision: 'PASS',
          commands: [{ command: 'npm test', exitCode: 0, status: 'PASS' }],
        },
      });

      const actionEvent = events.find(e => e.stage === 'action_required');
      assert.ok(actionEvent);
      assert.strictEqual(actionEvent.status, 'warning');
      assert.ok(actionEvent.title.includes('승인'));
    });

    void test('returns empty timeline when no actual execution evidence exists (Criterion 8)', () => {
      const events = extractTimelineEvents({
        runId: 'empty-test-run',
        status: 'pending',
      });

      assert.strictEqual(events.length, 0);
      assert.ok(!events.some(e => e.title.includes('도구 및 코드 수정 실행')));
      assert.ok(!events.some(e => e.title.includes('계획 수립')));
    });
  });

  void describe('validateSessionId', () => {
    void test('validates session ID formats correctly', () => {
      assert.strictEqual(validateSessionId('session-20260909-123456-abcdef12'), true);
      assert.strictEqual(validateSessionId('sess_123'), true);
      assert.strictEqual(validateSessionId(''), false);
      assert.strictEqual(validateSessionId('   '), false);
      assert.strictEqual(validateSessionId(null), false);
      assert.strictEqual(validateSessionId('../session'), false);
      assert.strictEqual(validateSessionId('session/123'), false);
      assert.strictEqual(validateSessionId('a'.repeat(65)), false);
    });
  });

  void describe('formatDuration', () => {
    void test('formats seconds, minutes, and hours accurately', () => {
      assert.strictEqual(formatDuration(0), '0초');
      assert.strictEqual(formatDuration(45), '45초');
      assert.strictEqual(formatDuration(75), '1분 15초');
      assert.strictEqual(formatDuration(3665), '1시간 1분 5초');
      assert.strictEqual(formatDuration(-10), '0초');
      assert.strictEqual(formatDuration(NaN), '0초');
    });
  });

  void describe('Status Metadata Consistency', () => {
    void test('all run statuses have metadata labels and classes', () => {
      const keys = Object.keys(RUN_STATUS_META);
      assert.ok(keys.includes('awaiting_review'));
      assert.ok(keys.includes('escalated'));
      for (const key of keys) {
        assert.ok(RUN_STATUS_META[key as keyof typeof RUN_STATUS_META].label);
      }
    });

    void test('all worker statuses have metadata labels and classes', () => {
      const keys = Object.keys(WORKER_STATUS_META);
      assert.ok(keys.includes('policy_violation'));
      assert.ok(keys.includes('test_failed'));
      for (const key of keys) {
        assert.ok(WORKER_STATUS_META[key as keyof typeof WORKER_STATUS_META].label);
      }
    });
  });

  void describe('Launcher Error Contract & Pure Transforms (Criteria 4 & 5)', () => {
    void test('isLauncherError identifies launcher failure patterns and error category', () => {
      assert.strictEqual(isLauncherError('실행기 프로세스가 비정상 종료되었습니다 (종료 코드: 1).', 'launcher_error'), true);
      assert.strictEqual(isLauncherError(undefined, 'launcher_error'), true);
      assert.strictEqual(isLauncherError('오케스트레이터 실행 제한 시간 내에 작업 매니페스트가 생성되지 않았습니다.'), true);
      assert.strictEqual(isLauncherError('필수 실행 도구 또는 PowerShell 7을 찾을 수 없습니다: pwsh'), true);
      assert.strictEqual(isLauncherError('워커 단위 테스트 실패'), false);
      assert.strictEqual(isLauncherError(undefined, undefined), false);
    });

    void test('requiresUserAction returns false for launcher errors', () => {
      assert.strictEqual(requiresUserAction('failed', null, 'launcher_error', '실행기 오류'), false);
      assert.strictEqual(requiresUserAction('policy_violation', null, 'launcher_error', '실행기 오류'), false);
      assert.strictEqual(requiresUserAction('test_failed', null, undefined, '오케스트레이터 실행 제한 시간 내에 작업 매니페스트가 생성되지 않았습니다.'), false);
      // Regular actionable states still require user action
      assert.strictEqual(requiresUserAction('policy_violation', null, undefined), true);
      assert.strictEqual(requiresUserAction('test_failed', null, undefined), true);
      assert.strictEqual(requiresUserAction('awaiting_review'), true);
    });

    void test('getUserActionReason returns undefined for launcher errors', () => {
      assert.strictEqual(getUserActionReason('failed', null, 'launcher_error', '실행기 오류'), undefined);
      assert.strictEqual(getUserActionReason('failed', null, undefined, '오케스트레이터 실행 제한 시간 내에 작업 매니페스트가 생성되지 않았습니다.'), undefined);
      assert.ok(getUserActionReason('awaiting_review')?.includes('통합 브랜치'));
    });

    void test('extractTimelineEvents suppresses timeline for launcher error runs without evidence', () => {
      const events = extractTimelineEvents({
        runId: 'launcher-failed-run',
        status: 'failed',
        errorCategory: 'launcher_error',
        error: '실행기 프로세스가 비정상 종료되었습니다 (종료 코드: 1).',
      });
      assert.strictEqual(events.length, 0);
    });
  });
});