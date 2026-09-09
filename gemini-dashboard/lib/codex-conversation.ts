import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConversationIntentType,
  ConversationSession,
  ConversationMessage,
  ConversationApproval,
  PlanDetails,
} from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { createEmptyConversationSession, validateSessionId } from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { validatePrompt, validateRepository, listCompactRuns, getProjectWorkers, getConversationSession, saveConversationSession } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeText } from './workspace-sanitize.ts';

export interface StructuredCodexDecision {
  intent: ConversationIntentType;
  reply: string;
  plan?: PlanDetails;
}

export interface CodexRunnerParams {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CodexRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CodexRunnerFn = (params: CodexRunnerParams) => Promise<CodexRunnerResult>;

function resolveCodexExecutable(options: EvaluateConversationOptions): string | null {
  const env = options.env || process.env;
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value) candidates.push(value);
  };

  add(options.toolOverrides?.codex);
  add(env.CODEX_PATH);

  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32'
      ? ['codex.exe', 'codex.cmd', 'codex']
      : ['codex']) {
      add(path.join(directory, name));
    }
  }

  const localAppData = env.LOCALAPPDATA || '';
  if (process.platform === 'win32' && localAppData) {
    const codexBinRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      for (const child of fs.readdirSync(codexBinRoot)) {
        add(path.join(codexBinRoot, child, 'codex.exe'));
      }
    } catch {
      // The packaged Codex directory is optional.
    }
    add(path.join(localAppData, 'Programs', 'Codex', 'codex.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue with the next known-safe candidate.
    }
  }
  return null;
}

/**
 * Default child process execution for Codex CLI.
 * Strictly uses argument array (NO shell string concatenation, shell: false).
 * Enforces explicit timeout and kills the process on timeout.
 */
export async function defaultCodexRunner(params: CodexRunnerParams): Promise<CodexRunnerResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = params.timeoutMs || 120000;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(params.executable, params.args, {
        cwd: params.cwd,
        env: params.env || process.env,
        shell: false,
        windowsHide: true,
        // The prompt is supplied as an argument. Keeping stdin as a pipe makes
        // `codex exec` wait for an additional stdin EOF before it can finish.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }, 500);
      } catch {
        // Ignore
      }
      reject(new Error('Codex CLI 실행 시간이 초과되었습니다.'));
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 2 * 1024 * 1024) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
  });
}

/**
 * Builds the structured classification prompt for Codex CLI.
 */
export function buildPromptForCodex(userMessage: string): string {
  return `You are a Codex assistant for the repository. Analyze the user's input:
User input: "${userMessage}"

Classify into one of 3 categories:
1. "chat": general conversation, greetings, casual talk, questions about who you are (e.g. "아아 들려?", "안녕", "반가워").
2. "status": questions about current status, progress, running tasks, workers, or recent jobs (e.g. "현재 상태 어때?", "진행 상황", "워커 상태").
3. "action_plan": requests to implement code, modify code, fix bugs, add features, run builds/tests, or refactor repository code (e.g. "버튼 오류를 수정해", "로그인 UI 구현", "테스트 고쳐줘").

Respond ONLY with a JSON object:
{
  "intent": "chat" | "status" | "action_plan",
  "reply": "Clear, friendly Korean reply explaining the answer or plan",
  "plan": {
    "title": "Title of the task",
    "explanation": "Summary of proposed changes",
    "steps": ["Step 1", "Step 2", ...],
    "affectedFiles": ["relative/path/to/file"]
  }
}`;
}

/**
 * Parses and validates structured JSON output from Codex.
 */
export function parseAndValidateCodexDecision(
  rawOutput: string,
  root: string
): { ok: boolean; decision?: StructuredCodexDecision; error?: string } {
  let jsonStr = rawOutput.trim();
  const match = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) {
    jsonStr = match[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { ok: false, error: 'Codex 응답 형식이 유효한 JSON이 아닙니다.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Codex 응답 객체가 올바르지 않습니다.' };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.intent !== 'chat' && obj.intent !== 'status' && obj.intent !== 'action_plan') {
    return { ok: false, error: `유효하지 않은 intent 분류입니다: ${String(obj.intent)}` };
  }

  if (typeof obj.reply !== 'string' || !obj.reply.trim()) {
    return { ok: false, error: 'Codex 응답 reply가 누락되었습니다.' };
  }

  const decision: StructuredCodexDecision = {
    intent: obj.intent as ConversationIntentType,
    reply: sanitizeText(obj.reply.trim(), root),
  };

  if (decision.intent === 'action_plan') {
    if (!obj.plan || typeof obj.plan !== 'object' || Array.isArray(obj.plan)) {
      return { ok: false, error: '실행 계획(plan) 상세 내용이 누락되었습니다.' };
    }
    const planObj = obj.plan as Record<string, unknown>;
    const title =
      typeof planObj.title === 'string' && planObj.title.trim()
        ? planObj.title.trim()
        : '작업 실행 계획';
    const explanation =
      typeof planObj.explanation === 'string' && planObj.explanation.trim()
        ? planObj.explanation.trim()
        : decision.reply;
    const steps =
      Array.isArray(planObj.steps) && planObj.steps.length > 0
        ? planObj.steps.map(s => String(s).trim())
        : ['코드 분석 및 변경 사항 식별', '코드 수정 적용', '결정론적 검증 및 테스트 실행'];
    const affectedFiles = Array.isArray(planObj.affectedFiles)
      ? planObj.affectedFiles.map(f => sanitizeText(String(f), root))
      : undefined;

    decision.plan = {
      title: sanitizeText(title, root),
      explanation: sanitizeText(explanation, root),
      steps: steps.map(s => sanitizeText(s, root)),
      affectedFiles,
    };
  }

  return { ok: true, decision };
}

export interface EvaluateConversationOptions {
  message: string;
  sessionId?: string;
  repoRoot?: string;
  codexRunner?: CodexRunnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
  timeoutMs?: number;
}

export interface EvaluateConversationResult {
  ok: boolean;
  session?: ConversationSession;
  message?: ConversationMessage;
  approval?: ConversationApproval;
  error?: string;
}

/**
 * Evaluates a user message using Codex CLI, determines intent, updates conversation state,
 * and ensures that no worker or run is created before user approval.
 */
export async function evaluateCodexConversation(
  options: EvaluateConversationOptions
): Promise<EvaluateConversationResult> {
  // 1. Repository confinement check
  const repoValidation = validateRepository(options.repoRoot);
  if (!repoValidation.ok) {
    return {
      ok: false,
      error: repoValidation.error || '허용되지 않은 저장소 경로입니다.',
    };
  }
  const root = repoValidation.repoRoot;

  // 2. Prompt validation
  const promptValidation = validatePrompt(options.message);
  if (!promptValidation.ok) {
    return {
      ok: false,
      error: promptValidation.error || '메시지 내용을 입력해주세요.',
    };
  }
  const userPrompt = promptValidation.prompt;

  // 3. Resolve Codex runner or tool
  let runner = options.codexRunner;
  let executable = 'codex';

  if (!runner) {
    const resolvedCodex = resolveCodexExecutable(options);
    if (!resolvedCodex) {
      const sanitizedReason = sanitizeText(
        'Codex CLI 실행 도구를 찾을 수 없습니다: codex',
        root
      );
      return {
        ok: false,
        error: sanitizedReason,
      };
    }
    executable = resolvedCodex;
    runner = defaultCodexRunner;
  }

  // 4. Execute Codex runner with safe argument array and timeout
  const promptText = buildPromptForCodex(userPrompt);
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--color',
    'never',
    '--cd',
    root,
    promptText,
  ];

  let rawOutput = '';
  try {
    const result = await runner({
      executable,
      args,
      cwd: root,
      env: {
        ...process.env,
        ...options.env,
      },
      timeoutMs: options.timeoutMs || 120000,
    });

    if (result.exitCode !== 0) {
      const sanitizedErr = sanitizeText(
        result.stderr || result.stdout || `Codex CLI가 비정상 종료되었습니다 (코드: ${result.exitCode})`,
        root
      );
      return {
        ok: false,
        error: sanitizedErr,
      };
    }

    rawOutput = result.stdout;
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = sanitizeText(rawMsg, root);
    return {
      ok: false,
      error: sanitized,
    };
  }

  // 5. Parse and validate structured decision
  const parsed = parseAndValidateCodexDecision(rawOutput, root);
  if (!parsed.ok || !parsed.decision) {
    return {
      ok: false,
      error: sanitizeText(parsed.error || 'Codex 응답이 올바르지 않습니다.', root),
    };
  }
  const decision = parsed.decision;

  // 6. Handle session recovery / creation
  let session: ConversationSession | null = null;
  if (options.sessionId && validateSessionId(options.sessionId)) {
    session = await getConversationSession(options.sessionId, root);
  }
  if (!session) {
    session = createEmptyConversationSession(
      options.sessionId && validateSessionId(options.sessionId) ? options.sessionId : undefined
    );
  }

  const now = new Date().toISOString();

  // 7. Add user message
  const userMessageId = `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-u`;
  session.messages.push({
    id: userMessageId,
    sender: 'user',
    text: sanitizeText(userPrompt, root),
    timestamp: now,
  });

  // 8. Process based on intent
  let approval: ConversationApproval | undefined;
  let statusSummary: {
    totalRuns: number;
    activeRuns?: number;
    activeWorkers: number;
    latestRunStatus?: string;
    latestRunId?: string;
  } | undefined;

  if (decision.intent === 'status') {
    // Query stored project / run / worker state without spawning anything
    const runs = await listCompactRuns(root);
    const { activeWorkers } = await getProjectWorkers(root);
    const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'planning');

    statusSummary = {
      totalRuns: runs.length,
      activeRuns: activeRuns.length,
      activeWorkers: activeWorkers.length,
      latestRunStatus: runs[0]?.status,
      latestRunId: runs[0]?.runId,
    };

    let statusDetails = `\n\n[프로젝트 상태 안내]\n- 등록된 작업: 총 ${runs.length}건\n- 진행 중인 작업: ${activeRuns.length}건\n- 활성 워커: ${activeWorkers.length}개`;
    if (runs.length > 0) {
      statusDetails += `\n- 최근 작업: ${runs[0].runId} (${runs[0].status}) - ${runs[0].prompt}`;
    } else {
      statusDetails += `\n- 현재 등록된 작업이 없습니다.`;
    }

    decision.reply = sanitizeText(`${decision.reply}${statusDetails}`, root);
  } else if (decision.intent === 'action_plan') {
    // Generate explicit execution plan and approval card
    // Worker count is 0, no router / Gemini / /api/runs invoked
    const approvalId = `appr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const idempotencyKey = `idemp-${approvalId}`;

    approval = {
      approvalId,
      sessionId: session.sessionId,
      status: 'pending',
      plan: decision.plan!,
      idempotencyKey,
      prompt: userPrompt,
      createdAt: now,
    };

    session.pendingApproval = approval;
  }

  // 9. Add Codex response message
  const codexMessageId = `msg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-c`;
  const codexMessage: ConversationMessage = {
    id: codexMessageId,
    sender: 'codex',
    text: decision.reply,
    timestamp: now,
    intentType: decision.intent,
    approval,
    statusSummary,
  };
  session.messages.push(codexMessage);

  session.updatedAt = now;

  // 10. Atomically persist conversation session
  await saveConversationSession(session, root);

  return {
    ok: true,
    session,
    message: codexMessage,
    approval,
  };
}
