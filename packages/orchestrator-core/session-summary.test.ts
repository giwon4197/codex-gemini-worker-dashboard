import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatSessionSummary,
  scoreSessionSummary,
  selectRelatedSessions,
  summarizeSession,
} from './session-summary.ts';
import { createEmptyConversationSession } from './workspace-contract.ts';
import type { ConversationApproval, ConversationSession } from './workspace-contract.ts';

function approval(overrides: Partial<ConversationApproval> = {}): ConversationApproval {
  return {
    approvalId: 'appr-1',
    sessionId: 's',
    status: 'approved',
    plan: {
      title: '로그인 버튼 오류 수정',
      explanation: 'e',
      steps: ['s'],
      affectedFiles: ['src/login/button.ts', 'src/login/form.ts'],
    },
    idempotencyKey: 'idemp-appr-1',
    prompt: 'p',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function session(goal: string, extra: Partial<ConversationSession> = {}): ConversationSession {
  const base = createEmptyConversationSession();
  base.updatedAt = '2026-01-02T00:00:00.000Z';
  base.messages.push(
    { id: 'u1', sender: 'user', text: goal, timestamp: '2026-01-01T00:00:00.000Z' },
    { id: 'c1', sender: 'codex', text: '계획을 세웠습니다.', timestamp: '2026-01-01T00:00:01.000Z' }
  );
  return { ...base, ...extra };
}

void describe('Session summary', () => {
  void test('is computed from the plan card, run note and pending approval', () => {
    const done = session('로그인 버튼이 안 눌려요\n두 번째 줄은 무시', {
      lastApproval: approval(),
      linkedRunIds: ['20260101-120000-abcdef12'],
    });
    done.messages.push({
      id: 'run-summary-20260101-120000-abcdef12',
      sender: 'codex',
      text: '✅ Run 완료 · 20260101-120000-abcdef12 · agent/run-1\n- TASK-1 · completed',
      timestamp: '2026-01-01T00:10:00.000Z',
    });

    const summary = summarizeSession(done);
    assert.equal(summary.goal, '로그인 버튼이 안 눌려요');
    assert.equal(summary.plan, '로그인 버튼 오류 수정 (approved)');
    assert.deepEqual(summary.files, ['src/login/button.ts', 'src/login/form.ts']);
    assert.equal(summary.outcome, '✅ Run 완료 · 20260101-120000-abcdef12 · agent/run-1');
    assert.equal(summary.open, undefined);

    const waiting = session('결제 화면 고쳐줘', { pendingApproval: approval({ status: 'pending' }) });
    assert.equal(summarizeSession(waiting).open, '승인 대기: 로그인 버튼 오류 수정');

    const line = formatSessionSummary(summary);
    assert.match(line, /^- [a-z0-9-]+ 2026-01-02 goal="로그인 버튼이 안 눌려요" plan="로그인 버튼 오류 수정 \(approved\)" files=src\/login\/button\.ts,src\/login\/form\.ts outcome="✅ Run 완료/);
    assert.equal(line.includes('\n'), false, 'one summary is one line');
  });

  void test('a request that names the same file or words ranks that session first', () => {
    const login = summarizeSession(session('로그인 버튼 오류', { lastApproval: approval() }));
    const payment = summarizeSession(
      session('결제 실패 재현', {
        lastApproval: approval({
          plan: { title: '결제 재시도', explanation: 'e', steps: ['s'], affectedFiles: ['src/pay/retry.ts'] },
        }),
      })
    );
    const chat = summarizeSession(session('안녕'));

    assert.ok(scoreSessionSummary(login, 'button.ts 쪽 로그인 다시 봐줘') > scoreSessionSummary(payment, 'button.ts 쪽 로그인 다시 봐줘'));
    assert.deepEqual(
      selectRelatedSessions([chat, payment, login], '로그인 버튼 이어서').map(s => s.sessionId),
      [login.sessionId]
    );
    assert.deepEqual(selectRelatedSessions([chat, payment, login], '전혀 다른 요청'), []);
    assert.deepEqual(
      selectRelatedSessions([login], '로그인', { excludeSessionId: login.sessionId }),
      [],
      'the current session is never retrieved as related'
    );
  });
});
