import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyStatusText, runCompletionLines, runFailureLines, runProgressLines, sessionTitle, tailProgressLines } from './protocol.ts';

void test('busy status uses the provided reason and a default fallback', () => {
  assert.equal(busyStatusText('Codex에 요청하는 중'), 'Codex에 요청하는 중');
  assert.equal(busyStatusText('  '), '요청 처리 중…');
  assert.equal(busyStatusText(), '요청 처리 중…');
});

void test('session title is the first user line, truncated, or the id', () => {
  assert.equal(sessionTitle({ sessionId: 's1', messages: [] }), 's1');
  assert.equal(
    sessionTitle({ sessionId: 's1', messages: [{ sender: 'codex', text: 'x' }, { sender: 'user', text: '버튼 수정\n두번째 줄' }] }),
    '버튼 수정'
  );
  assert.equal(sessionTitle({ sessionId: 's1', messages: [{ sender: 'user', text: 'a'.repeat(50) }] }), `${'a'.repeat(40)}…`);
});

void test('tail progress keeps the last non-empty lines only', () => {
  assert.deepEqual(tailProgressLines('a\n\n  b  \r\nc\n', 2), ['b', 'c']);
});

void test('run progress is a single line with running workers and retries', () => {
  assert.deepEqual(runProgressLines(null), []);
  const lines = runProgressLines({
    runId: 'run-1',
    prompt: 'p',
    status: 'running',
    lanesCount: 2,
    tips: [],
    edges: [],
    nodes: [
      { id: 'req', lane: 0, depth: 0, type: 'request', owner: 'Codex', label: '요청', status: 'completed' },
      { id: 'e1', lane: 1, depth: 1, type: 'activity', activity: 'EDIT', file: 'a.ts', taskId: 'TASK-001', owner: 'Gemini', label: 'EDIT a.ts', status: 'completed', startedAt: '2026-01-01T00:00:01Z' },
      { id: 'e2', lane: 1, depth: 2, type: 'activity', activity: 'RUN', command: 'npm test', taskId: 'TASK-002', owner: 'Gemini', label: 'RUN npm test', status: 'running', startedAt: '2026-01-01T00:00:02Z', retryHistory: [{ attempt: 1, decision: 'retry' }] },
      { id: 'e3', lane: 2, depth: 2, type: 'activity', activity: 'EDIT', file: 'c.ts', taskId: 'TASK-002', owner: 'Gemini', label: 'EDIT c.ts', status: 'running' },
    ],
  });
  assert.deepEqual(lines, ['Run run-1 · running · 워커 1 · 재시도 1']);
});

void test('run failure lines explain the reason and next step in Korean', () => {
  assert.deepEqual(runFailureLines({ status: 'running' }), []);
  assert.deepEqual(
    runFailureLines({
      status: 'failed',
      errorDisplayName: '실행기 오류',
      failureReason: '라우팅 전 main 작업공간을 commit하거나 stash해야 합니다.',
      retryable: true,
      retryOf: 'run-0',
    }),
    [
      '⚠ Run 실패 · 실행기 오류',
      '사유: 라우팅 전 main 작업공간을 commit하거나 stash해야 합니다.',
      '조치: 원인을 해결한 뒤 Task Graph의 재시도 버튼을 누르세요.',
      '이전 시도: run-0',
    ]
  );
  const blocked = runFailureLines({ status: 'failed', requiresUserAction: true, userActionReason: '비밀정보 감지' });
  assert.equal(blocked[0], '⚠ Run 실패 · 사용자 조치 필요');
  assert.equal(blocked[1], '조치: 비밀정보 감지');
  assert.equal(runFailureLines({ status: 'failed', error: 'x', retryable: false })[2], '조치: 자동 재시도할 수 없는 실패입니다.');
});

void test('run completion lines list each worker with its changed files', () => {
  assert.deepEqual(
    runCompletionLines({
      runId: 'r1',
      status: 'completed',
      integrationBranch: 'agent/r1',
      workers: [
        { taskId: 't1', task: '버튼 수정', status: 'completed', changedFiles: ['src/a.ts', 'src/b.ts'] },
        { task: '테스트', status: 'failed', error: '테스트 실패' },
      ],
    }),
    ['✅ Run 완료 · r1 · agent/r1', '- t1 버튼 수정 · completed', '    src/a.ts', '    src/b.ts', '- 테스트 · failed', '    사유: 테스트 실패']
  );
  assert.deepEqual(runCompletionLines({ runId: 'r2', status: 'cancelled', workers: [] }), ['⏹ Run 중단됨 · r2', '- 실행된 워커가 없습니다.']);
});
