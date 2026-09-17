import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ConversationIntentType,
  ConversationSession,
  ConversationMessage,
  ConversationApproval,
  PlanDetails,
} from './workspace-contract.ts';
import { createEmptyConversationSession, validateSessionId } from './workspace-contract.ts';
import { validatePrompt, validateRepository, listCompactRuns, getProjectWorkers, getConversationSession, saveConversationSession } from './workspace-store.ts';
import { sanitizeText } from './workspace-sanitize.ts';
import { sanitizeSpawnEnv } from './spawn-env.ts';
import { isValidCodexModel, readWorkerSettings } from './worker-settings.ts';
import { CODEX_DEFAULT_MODEL } from './model-tiers.ts';

export { sanitizeSpawnEnv };

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
  stdinText?: string;
  /** Receives raw CLI output as it arrives so a UI can show live progress. */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Aborting kills the CLI process and rejects with a user-facing message. */
  signal?: AbortSignal;
}

export interface CodexRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CodexRunnerFn = (params: CodexRunnerParams) => Promise<CodexRunnerResult>;

export const CODEX_ABORTED_MESSAGE = '사용자가 요청을 중단했습니다.';

function resolveCodexExecutable(options: EvaluateConversationOptions): string | null {
  const env = options.env || process.env;
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    if (value) candidates.push(value);
  };

  add(options.toolOverrides?.codex);
  add(env.CODEX_PATH);

  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    // Windows Node 20.12+ throws spawn EINVAL for .cmd/.bat unless shell:true.
    // Spawn the real .exe only.
    add(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }

  // The npm global install only puts .cmd/.ps1 shims on PATH, which spawn()
  // cannot run with shell:false. Reach its real binary, and prefer it over the
  // desktop app bundle below: it is what the user's own `codex` actually runs.
  if (process.platform === 'win32' && env.APPDATA) {
    add(
      path.join(
        env.APPDATA,
        'npm',
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex.exe'
      )
    );
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
 * Picks the model for `codex exec`. Explicit call wins so a workflow stage can
 * override it, then the environment, then the saved settings file. Unset means
 * the Codex CLI keeps using the model from ~/.codex/config.toml.
 */
function resolveCodexModel(options: EvaluateConversationOptions): string | undefined {
  const env = options.env || process.env;
  const candidates = [
    options.codexModel,
    env.CODEX_MODEL,
    readWorkerSettings().codexModel,
    CODEX_DEFAULT_MODEL,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
    if (!trimmed) continue;
    if (!isValidCodexModel(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

/**
 * Default child process execution for Codex CLI.
 * Strictly uses argument array (NO shell string concatenation, shell: false).
 * Enforces explicit timeout and kills the process on timeout.
 * Prompt text is written to stdin because a multiline argv on Windows
 * VS Code/Electron throws `spawn EINVAL`.
 */
export async function defaultCodexRunner(params: CodexRunnerParams): Promise<CodexRunnerResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = params.timeoutMs || 120000;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(params.executable, params.args, {
        cwd: params.cwd,
        env: sanitizeSpawnEnv(params.env),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      return reject(err);
    }

    child.stdin?.on('error', () => {
      // The child may close stdin before we finish writing.
    });
    if (params.stdinText) {
      child.stdin?.write(params.stdinText, 'utf8');
    }
    child.stdin?.end();

    let stdout = '';
    let stderr = '';

    const killAndReject = (message: string) => {
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
      reject(new Error(message));
    };
    const timer = setTimeout(() => killAndReject('Codex CLI 실행 시간이 초과되었습니다.'), timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      killAndReject(CODEX_ABORTED_MESSAGE);
    };
    if (params.signal?.aborted) return onAbort();
    params.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', chunk => {
      const text = chunk.toString('utf8');
      stdout += text;
      params.onOutput?.(text, 'stdout');
      if (stdout.length > 2 * 1024 * 1024) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
    });

    child.stderr?.on('data', chunk => {
      const text = chunk.toString('utf8');
      stderr += text;
      params.onOutput?.(text, 'stderr');
    });

    child.on('error', err => {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
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
    "affectedFiles": ["relative/path/to/file.ext"]
  }
}
"affectedFiles" must be repository-relative file paths with forward slashes (e.g. "src/app.ts"), never descriptions like "the test file". Omit an entry you cannot name as a path.`;
}

export function buildCodexExecArgs(options: {
  prompt: string;
  cwd: string;
  lastMessagePath?: string;
  model?: string;
}): string[] {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--cd',
    options.cwd,
  ];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.lastMessagePath) {
    args.push('--output-last-message', options.lastMessagePath);
  }
  // Prompt is sent on stdin. A multiline argv triggers spawn EINVAL on Windows.
  args.push('-');
  return args;
}

function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return values;
  try {
    values.push(JSON.parse(trimmed));
  } catch {
    // Mixed CLI banners are expected.
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try {
      values.push(JSON.parse(fence[1].trim()));
    } catch {
      // Ignore a malformed fenced block and keep scanning.
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      values.push(JSON.parse(candidate));
    } catch {
      // Continue scanning other lines.
    }
  }
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < trimmed.length; j++) {
      const char = trimmed[j];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            values.push(JSON.parse(trimmed.slice(i, j + 1)));
          } catch {
            // Keep looking for a later object.
          }
          i = j;
          break;
        }
      }
    }
  }
  return values;
}

/**
 * Parses and validates structured JSON output from Codex.
 */
/**
 * Keeps only entries shaped like repository-relative paths. Codex sometimes
 * answers with descriptions ("경로 비교 구현 파일") which the UI would try to open.
 */
export function normalizeAffectedFiles(values: string[]): string[] {
  return values
    .map(value => value.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(value => value && !/\s/.test(value) && !path.isAbsolute(value) && /[/.]/.test(value));
}

export function parseAndValidateCodexDecision(
  rawOutput: string,
  root: string
): { ok: boolean; decision?: StructuredCodexDecision; error?: string } {
  const candidates = extractJsonValues(rawOutput).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  );
  const parsed = [...candidates].reverse().find(obj =>
    obj.intent === 'chat' || obj.intent === 'status' || obj.intent === 'action_plan'
  );
  if (!parsed) {
    return { ok: false, error: 'Codex 응답 형식이 유효한 JSON이 아닙니다.' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Codex 응답 객체가 올바르지 않습니다.' };
  }

  const obj = parsed;

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
      ? normalizeAffectedFiles(planObj.affectedFiles.map(f => sanitizeText(String(f), root)))
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
  /**
   * Full prompt sent to Codex and stored on the approval card. Defaults to
   * `message`. Use this so Explain/Plan Fix can keep a short visible bubble.
   */
  executionPrompt?: string;
  sessionId?: string;
  repoRoot?: string;
  codexRunner?: CodexRunnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
  /**
   * Model passed to `codex exec --model`. Leaving it unset inherits whatever
   * the user configured in ~/.codex/config.toml, which is the old behaviour.
   */
  codexModel?: string;
  timeoutMs?: number;
  /**
   * When true, never create a plan approval or worker. Explain/chat commands
   * use this so a misclassified action_plan cannot spawn a run.
   */
  forbidWorkers?: boolean;
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
  let executionPrompt = userPrompt;
  if (options.executionPrompt !== undefined) {
    const executionValidation = validatePrompt(options.executionPrompt);
    if (!executionValidation.ok) {
      return {
        ok: false,
        error: executionValidation.error || '작업 요청 내용을 입력해주세요.',
      };
    }
    executionPrompt = executionValidation.prompt;
  }

  // 3. Resolve Codex runner or tool
  let runner = options.codexRunner;
  let executable = 'codex';

  const resolvedCodex = resolveCodexExecutable(options);
  if (!runner) {
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
    runner = defaultCodexRunner;
  }
  // An injected runner (the VS Code view streams CLI output through one) still
  // spawns a real process, so it needs the resolved path too: on Windows a bare
  // 'codex' fails with ENOENT because only .cmd/.ps1 shims sit on PATH.
  if (resolvedCodex) executable = resolvedCodex;

  // 4. Execute Codex runner with safe argument array and timeout
  const promptText = buildPromptForCodex(executionPrompt);
  const lastMessagePath = path.join(
    os.tmpdir(),
    `codex-last-${crypto.randomBytes(8).toString('hex')}.txt`
  );
  const args = buildCodexExecArgs({
    prompt: promptText,
    cwd: root,
    lastMessagePath,
    model: resolveCodexModel(options),
  });

  let rawOutput = '';
  try {
    const result = await runner({
      executable,
      args,
      cwd: root,
      env: sanitizeSpawnEnv({
        ...process.env,
        ...options.env,
      }),
      timeoutMs: options.timeoutMs || 120000,
      stdinText: promptText,
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
    try {
      if (fs.existsSync(lastMessagePath)) {
        const lastMessage = fs.readFileSync(lastMessagePath, 'utf8');
        if (lastMessage.trim()) rawOutput = `${lastMessage}\n${rawOutput}`;
      }
    } catch {
      // Last-message file is optional; stdout parsing still applies.
    }
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const sanitized = sanitizeText(rawMsg, root);
    return {
      ok: false,
      error: sanitized,
    };
  } finally {
    try {
      fs.unlinkSync(lastMessagePath);
    } catch {
      // Temp last-message files are best-effort.
    }
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
  } else if (decision.intent === 'action_plan' && options.forbidWorkers) {
    decision.intent = 'chat';
    decision.plan = undefined;
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
      prompt: executionPrompt,
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
