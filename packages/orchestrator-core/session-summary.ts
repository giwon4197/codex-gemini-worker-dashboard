// Session summaries are computed from the stored conversation, never written:
// the plan card, approval status and run summary already hold the decisions,
// so no model call and no second store are needed to recall a past session.

import type { ConversationSession } from './workspace-contract.ts';

export interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  /** First user request, first line. */
  goal?: string;
  /** Approved or pending plan title with its approval status. */
  plan?: string;
  files: string[];
  /** Head line of the run completion note, or the linked run id. */
  outcome?: string;
  /** Something still waiting on the user. */
  open?: string;
}

const GOAL_LIMIT = 120;
const FILE_LIMIT = 8;

function firstLine(text: string, limit: number): string {
  const line = text.trim().split(/\r?\n/)[0] || '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export function summarizeSession(session: ConversationSession): SessionSummary {
  const approval = session.pendingApproval || session.lastApproval;
  const goal = session.messages.find(message => message.sender === 'user')?.text;
  const runNote = [...session.messages]
    .reverse()
    .find(message => message.id.startsWith('run-summary-'))?.text;
  const runId = session.linkedRunIds.at(-1);
  return {
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    goal: goal ? firstLine(goal, GOAL_LIMIT) : undefined,
    plan: approval ? `${firstLine(approval.plan.title, 80)} (${approval.status})` : undefined,
    files: (approval?.plan.affectedFiles || []).slice(0, FILE_LIMIT),
    outcome: runNote ? firstLine(runNote, 80) : runId ? `run ${runId}` : undefined,
    open: session.pendingApproval
      ? `승인 대기: ${firstLine(session.pendingApproval.plan.title, 60)}`
      : undefined,
  };
}

/** One line per session; the block that carries several stays small. */
export function formatSessionSummary(summary: SessionSummary): string {
  const fields = [
    `${summary.sessionId} ${summary.updatedAt.slice(0, 10)}`,
    summary.goal && `goal="${summary.goal}"`,
    summary.plan && `plan="${summary.plan}"`,
    summary.files.length > 0 && `files=${summary.files.join(',')}`,
    summary.outcome && `outcome="${summary.outcome}"`,
    summary.open && `open="${summary.open}"`,
  ];
  return `- ${fields.filter(Boolean).join(' ')}`;
}

// Korean words are often two syllables, so only ASCII tokens need three characters.
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./-]+/u)
      .filter(token => token.length >= (/^[\x00-\x7f]+$/.test(token) ? 3 : 2))
  );
}

/** Overlap between the request and a summary; a shared file path counts double. */
export function scoreSessionSummary(summary: SessionSummary, message: string): number {
  const request = tokens(message);
  if (request.size === 0) return 0;
  let score = 0;
  for (const token of tokens([summary.goal, summary.plan, summary.outcome].filter(Boolean).join(' '))) {
    if (request.has(token)) score += 1;
  }
  const lowerMessage = message.toLowerCase();
  for (const file of summary.files) {
    const base = file.split('/').pop() || file;
    if (lowerMessage.includes(base.toLowerCase())) score += 2;
  }
  return score;
}

/**
 * Picks the past sessions worth showing for this request: those that overlap
 * with it, best first, limited. Without any overlap nothing is returned; the
 * caller decides whether the previous session goes in regardless.
 */
export function selectRelatedSessions(
  summaries: SessionSummary[],
  message: string,
  options: { excludeSessionId?: string; limit?: number } = {}
): SessionSummary[] {
  const limit = options.limit ?? 3;
  return summaries
    .filter(summary => summary.sessionId !== options.excludeSessionId)
    .map(summary => ({ summary, score: scoreSessionSummary(summary, message) }))
    .filter(entry => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.summary.updatedAt).getTime() - new Date(a.summary.updatedAt).getTime()
    )
    .slice(0, limit)
    .map(entry => entry.summary);
}
