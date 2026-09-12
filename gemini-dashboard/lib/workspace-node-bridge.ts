import type http from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { SpawnerFn } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { validateSessionId, createEmptyConversationSession } from './workspace-contract.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getAllowedRepoRoot, validateRunId, validateRepository, validatePrompt, spawnRouterRun, retryRun, listCompactRuns, getRunDetails, getProjectWorkers, getConversationSession, listConversationSessions, saveConversationSession, approveConversationPlan } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeText } from './workspace-sanitize.ts';
// @ts-expect-error TS5097 allowed for test runner
import { evaluateCodexConversation } from './codex-conversation.ts';
import type { CodexRunnerFn } from './codex-conversation.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getCodexDailyUsage } from './codex-usage.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getGeminiQuota } from './gemini-quota.ts';

export interface WorkspaceBridgeOptions {
  repoRoot?: string;
  spawner?: SpawnerFn;
  codexRunner?: CodexRunnerFn;
  env?: Record<string, string | undefined>;
  toolOverrides?: Partial<Record<'pwsh' | 'codex' | 'rg' | 'agy', string>>;
  maxBodySizeBytes?: number;
}

let defaultBridgeOptions: WorkspaceBridgeOptions = {};

export function setWorkspaceBridgeOptions(options: WorkspaceBridgeOptions): void {
  defaultBridgeOptions = { ...options };
}

export function getWorkspaceBridgeOptions(): WorkspaceBridgeOptions {
  return { ...defaultBridgeOptions };
}

export function resetWorkspaceBridgeOptions(): void {
  defaultBridgeOptions = {};
}

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
};

/**
 * Handles Web standard Request objects for workspace endpoints.
 * Consumed by both App Route handlers and Node Connect middleware.
 */
export async function handleWorkspaceBridgeRequest(
  request: Request,
  options?: WorkspaceBridgeOptions
): Promise<Response> {
  const activeOptions: WorkspaceBridgeOptions = {
    ...defaultBridgeOptions,
    ...options,
  };

  const url = new URL(request.url, 'http://localhost:3000');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // 1. POST /api/runs (Create run)
  if (pathname === '/api/runs' && method === 'POST') {
    let body: {
      prompt?: unknown;
      idempotencyKey?: unknown;
      repository?: unknown;
    } = {};

    try {
      const text = await request.text();
      if (!text || !text.trim()) {
        return Response.json(
          { ok: false, error: '유효한 JSON 요청 본문이 필요합니다.' },
          { status: 400, headers: JSON_HEADERS }
        );
      }
      body = JSON.parse(text);
    } catch {
      return Response.json(
        { ok: false, error: '유효하지 않은 JSON 요청 본문이 필요합니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json(
        { ok: false, error: '유효한 JSON 요청 본문이 필요합니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    // Repository Confinement Check
    const repoValidation = validateRepository(body.repository, activeOptions.repoRoot);
    if (!repoValidation.ok) {
      return Response.json(
        { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    // Prompt Validation
    const promptValidation = validatePrompt(body.prompt);
    if (!promptValidation.ok) {
      return Response.json(
        { ok: false, error: promptValidation.error || '작업 요청 내용을 입력해주세요.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    // Optional Idempotency Key validation
    let idempotencyKey: string | undefined;
    if (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) {
      idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    }

    try {
      const result = await spawnRouterRun({
        prompt: promptValidation.prompt,
        idempotencyKey,
        repoRoot: repoValidation.repoRoot,
        spawner: activeOptions.spawner,
        env: activeOptions.env,
        toolOverrides: activeOptions.toolOverrides,
      });

      return Response.json(
        {
          ok: true,
          runId: result.runId,
          isDuplicate: result.isDuplicate,
          status: result.status,
          message: result.isDuplicate
            ? '이전 요청과 동일하여 기존 작업을 반환합니다.'
            : '작업이 성공적으로 제출되었습니다.',
        },
        { status: result.isDuplicate ? 200 : 201, headers: JSON_HEADERS }
      );
    } catch (err: unknown) {
      const root = repoValidation.repoRoot;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = sanitizeText(rawMsg, root);
      const launcherError = err as Error & { runId?: string; errorCategory?: string };
      const publicReason = sanitizedMsg.trim() || '알 수 없는 실행기 오류';
      return Response.json(
        {
          ok: false,
          error: `실행기 오류: ${publicReason}`,
          errorCategory: launcherError.errorCategory || 'launcher_error',
          runId: launcherError.runId,
        },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 2. GET /api/runs (List compact runs)
  if (pathname === '/api/runs' && method === 'GET') {
    try {
      const runs = await listCompactRuns(activeOptions.repoRoot);
      return Response.json({ ok: true, runs }, { status: 200, headers: JSON_HEADERS });
    } catch {
      return Response.json(
        { ok: false, error: '작업 목록을 불러오지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 3a. POST /api/runs/:runId/retry (Safe Run Retry Flow)
  const retryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
  if (retryMatch) {
    if (method !== 'POST') {
      return Response.json(
        { ok: false, error: `지원하지 않는 HTTP 메서드입니다: ${method}` },
        { status: 405, headers: JSON_HEADERS }
      );
    }

    let rawRunId = retryMatch[1];
    try {
      rawRunId = decodeURIComponent(retryMatch[1]);
    } catch {
      rawRunId = retryMatch[1];
    }

    if (!validateRunId(rawRunId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 run ID 형식입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    let body: {
      idempotencyKey?: unknown;
      repository?: unknown;
    } = {};

    try {
      const text = await request.text();
      if (text && text.trim()) {
        body = JSON.parse(text);
      }
    } catch {
      return Response.json(
        { ok: false, error: '유효하지 않은 JSON 요청 본문입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const repoValidation = validateRepository(body.repository, activeOptions.repoRoot);
    if (!repoValidation.ok) {
      return Response.json(
        { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const idempotencyKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim().slice(0, 128)
        : undefined;

    try {
      const result = await retryRun({
        runId: rawRunId,
        idempotencyKey,
        repoRoot: repoValidation.repoRoot,
        spawner: activeOptions.spawner,
        env: activeOptions.env,
        toolOverrides: activeOptions.toolOverrides,
      });

      return Response.json(
        {
          ok: true,
          runId: result.runId,
          retryOf: result.originalRunId,
          originalRunId: result.originalRunId,
          retryCount: result.retryCount,
          isDuplicate: result.isDuplicate,
          status: result.status,
          message: result.isDuplicate
            ? '이미 진행된 동일 재시도 작업이 반환되었습니다.'
            : '안전 재시도 작업이 성공적으로 시작되었습니다.',
        },
        { status: result.isDuplicate ? 200 : 201, headers: JSON_HEADERS }
      );
    } catch (err: unknown) {
      const root = repoValidation.repoRoot;
      const rawMsg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = sanitizeText(rawMsg, root);
      const errCode = (err as { code?: string })?.code;

      const isNotFound = errCode === 'RUN_NOT_FOUND' || sanitizedMsg.includes('찾을 수 없습니다');
      const isClientReject =
        errCode === 'RETRY_NOT_PERMITTED' ||
        sanitizedMsg.includes('허용된 파일 범위') ||
        sanitizedMsg.includes('정책 위반') ||
        sanitizedMsg.includes('비밀정보') ||
        sanitizedMsg.includes('파괴적') ||
        sanitizedMsg.includes('에스컬레이션') ||
        sanitizedMsg.includes('사용자 조치') ||
        sanitizedMsg.includes('재시도') ||
        sanitizedMsg.includes('실패한 작업만') ||
        sanitizedMsg.includes('완료된 작업') ||
        sanitizedMsg.includes('진행 중') ||
        sanitizedMsg.includes('승인 대기') ||
        isNotFound;

      const code = isNotFound ? 'RUN_NOT_FOUND' : isClientReject ? 'RETRY_NOT_PERMITTED' : 'INTERNAL_ERROR';

      return Response.json(
        {
          ok: false,
          code,
          error: sanitizedMsg,
          retryable: false,
          requiresUserAction: true,
          userActionReason: sanitizedMsg,
        },
        { status: isNotFound ? 404 : isClientReject ? 400 : 500, headers: JSON_HEADERS }
      );
    }
  }

  // 3. GET /api/runs/:runId (Run details)
  if (pathname.startsWith('/api/runs/') && method === 'GET') {
    const rawRunId = pathname.slice('/api/runs/'.length);
    let runId = rawRunId;
    try {
      runId = decodeURIComponent(rawRunId);
    } catch {
      runId = rawRunId;
    }
    if (!validateRunId(runId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 run ID 형식입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    try {
      const run = await getRunDetails(runId, activeOptions.repoRoot);
      if (!run) {
        return Response.json(
          { ok: false, error: '요청한 작업을 찾을 수 없습니다.' },
          { status: 404, headers: JSON_HEADERS }
        );
      }
      return Response.json({ ok: true, run }, { status: 200, headers: JSON_HEADERS });
    } catch {
      return Response.json(
        { ok: false, error: '작업 세부 정보를 조회하지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 4. GET /api/projects (Project summary)
  if (pathname === '/api/projects' && method === 'GET') {
    try {
      const repoRoot = getAllowedRepoRoot(activeOptions.repoRoot);
      const repoName = path.basename(repoRoot) || 'codex-gemini-worker-dashboard';
      const runs = await listCompactRuns(repoRoot);

      const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'planning');
      const totalActiveWorkers = runs.reduce((sum, r) => sum + (r.activeWorkersCount || 0), 0);
      const lastRunAt = runs[0]?.createdAt;

      const projects = [
        {
          id: 'current',
          name: repoName,
          repositoryPath: repoName,
          activeRunsCount: activeRuns.length,
          activeWorkersCount: totalActiveWorkers,
          lastRunAt,
        },
      ];

      return Response.json({ ok: true, projects }, { status: 200, headers: JSON_HEADERS });
    } catch {
      return Response.json(
        { ok: false, error: '프로젝트 정보를 불러오지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 5. GET /api/projects/:projectId/workers (Project workers)
  const workersMatch = pathname.match(/^\/api\/projects\/([^/]+)\/workers$/);
  if (workersMatch && method === 'GET') {
    let projectId = workersMatch[1];
    try {
      projectId = decodeURIComponent(workersMatch[1]);
    } catch {
      projectId = workersMatch[1];
    }
    if (
      !projectId ||
      projectId.includes('..') ||
      projectId.includes('/') ||
      projectId.includes('\\')
    ) {
      return Response.json(
        { ok: false, error: '유효하지 않은 프로젝트 식별자입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    try {
      const selectedRunId = url.searchParams.get('runId') || undefined;
      const { activeWorkers, historyWorkers, graph, runs } = await getProjectWorkers(
        activeOptions.repoRoot,
        undefined,
        selectedRunId
      );
      return Response.json(
        { ok: true, projectId, activeWorkers, historyWorkers, graph, runs },
        { status: 200, headers: JSON_HEADERS }
      );
    } catch {
      return Response.json(
        { ok: false, error: '워커 상태를 조회하지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 6. POST /api/conversations (Codex conversation evaluation)
  if (pathname === '/api/conversations' && method === 'POST') {
    let body: {
      sessionId?: unknown;
      message?: unknown;
      repository?: unknown;
    } = {};

    try {
      const text = await request.text();
      if (!text || !text.trim()) {
        return Response.json(
          { ok: false, error: '유효한 JSON 요청 본문이 필요합니다.' },
          { status: 400, headers: JSON_HEADERS }
        );
      }
      body = JSON.parse(text);
    } catch {
      return Response.json(
        { ok: false, error: '유효하지 않은 JSON 요청 본문이 필요합니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return Response.json(
        { ok: false, error: '유효한 JSON 요청 본문이 필요합니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const repoValidation = validateRepository(body.repository, activeOptions.repoRoot);
    if (!repoValidation.ok) {
      return Response.json(
        { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const promptValidation = validatePrompt(body.message);
    if (!promptValidation.ok) {
      return Response.json(
        { ok: false, error: promptValidation.error || '메시지 내용을 입력해주세요.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : undefined;

    if (sessionId && !validateSessionId(sessionId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 대화 세션 식별자입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const result = await evaluateCodexConversation({
      message: promptValidation.prompt,
      sessionId,
      repoRoot: repoValidation.repoRoot,
      codexRunner: activeOptions.codexRunner,
      env: activeOptions.env,
      toolOverrides: activeOptions.toolOverrides,
    });

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error || 'Codex 대화 처리에 실패했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }

    return Response.json(
      {
        ok: true,
        session: result.session,
        message: result.message,
        approval: result.approval,
      },
      { status: 200, headers: JSON_HEADERS }
    );
  }

  // 7. GET /api/conversations (List conversation sessions)
  if (pathname === '/api/conversations' && method === 'GET') {
    try {
      const repoRoot = getAllowedRepoRoot(activeOptions.repoRoot);
      const sessions = await listConversationSessions(repoRoot);
      let activeSession = sessions[0];
      if (!activeSession) {
        activeSession = createEmptyConversationSession();
        await saveConversationSession(activeSession, repoRoot);
        sessions.push(activeSession);
      }
      return Response.json(
        { ok: true, sessions, session: activeSession },
        { status: 200, headers: JSON_HEADERS }
      );
    } catch {
      return Response.json(
        { ok: false, error: '대화 목록을 불러오지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // 8. POST /api/conversations/:sessionId/approve (Approve pending plan and execute run)
  const approveMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/approve$/);
  if (approveMatch && method === 'POST') {
    let rawSessionId = approveMatch[1];
    try {
      rawSessionId = decodeURIComponent(approveMatch[1]);
    } catch {
      rawSessionId = approveMatch[1];
    }
    if (!validateSessionId(rawSessionId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 대화 세션 식별자입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    let body: {
      approvalId?: unknown;
      idempotencyKey?: unknown;
      repository?: unknown;
    } = {};

    try {
      const text = await request.text();
      if (text && text.trim()) {
        body = JSON.parse(text);
      }
    } catch {
      return Response.json(
        { ok: false, error: '유효하지 않은 JSON 요청 본문입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const repoValidation = validateRepository(body.repository, activeOptions.repoRoot);
    if (!repoValidation.ok) {
      return Response.json(
        { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const approvalId =
      typeof body.approvalId === 'string' && body.approvalId.trim()
        ? body.approvalId.trim()
        : undefined;
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : undefined;

    const result = await approveConversationPlan({
      sessionId: rawSessionId,
      approvalId,
      idempotencyKey,
      repoRoot: repoValidation.repoRoot,
      spawner: activeOptions.spawner,
      env: activeOptions.env,
      toolOverrides: activeOptions.toolOverrides,
    });

    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.error || '작업 승인 처리에 실패했습니다.', approval: result.approval },
        { status: 500, headers: JSON_HEADERS }
      );
    }

    return Response.json(
      {
        ok: true,
        runId: result.runId,
        isDuplicate: result.isDuplicate,
        approval: result.approval,
        session: result.session,
      },
      { status: result.isDuplicate ? 200 : 201, headers: JSON_HEADERS }
    );
  }

  // 9. GET /api/conversations/:sessionId (Get single conversation session)
  const sessionMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (sessionMatch && method === 'GET') {
    let rawSessionId = sessionMatch[1];
    try {
      rawSessionId = decodeURIComponent(sessionMatch[1]);
    } catch {
      rawSessionId = sessionMatch[1];
    }
    if (!validateSessionId(rawSessionId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 대화 세션 식별자입니다.' },
        { status: 400, headers: JSON_HEADERS }
      );
    }

    const session = await getConversationSession(rawSessionId, activeOptions.repoRoot);
    if (!session) {
      return Response.json(
        { ok: false, error: '요청한 대화 세션을 찾을 수 없습니다.' },
        { status: 404, headers: JSON_HEADERS }
      );
    }

    return Response.json({ ok: true, session }, { status: 200, headers: JSON_HEADERS });
  }

  // 10. GET /api/codex-usage
  if (pathname === '/api/codex-usage') {
    if (method !== 'GET') {
      return Response.json(
        { ok: false, error: `지원하지 않는 HTTP 메서드입니다: ${method}` },
        { status: 405, headers: JSON_HEADERS }
      );
    }
    const bypassCache = url.searchParams.get('refresh') === 'true';
    const result = getCodexDailyUsage({ bypassCache });
    return Response.json(result, { status: 200, headers: JSON_HEADERS });
  }

  // 11. GET /api/gemini-quota
  if (pathname === '/api/gemini-quota') {
    if (method !== 'GET') {
      return Response.json(
        { ok: false, error: `지원하지 않는 HTTP 메서드입니다: ${method}` },
        { status: 405, headers: JSON_HEADERS }
      );
    }
    const bypassCache = url.searchParams.get('refresh') === 'true';
    const result = await getGeminiQuota({ bypassCache });
    return Response.json(result, { status: 200, headers: JSON_HEADERS });
  }

  // Check for known route prefixes with invalid method
  if (
    pathname === '/api/runs' ||
    pathname.startsWith('/api/runs/') ||
    pathname === '/api/projects' ||
    pathname.startsWith('/api/projects/') ||
    pathname === '/api/conversations' ||
    pathname.startsWith('/api/conversations/') ||
    pathname === '/api/codex-usage' ||
    pathname === '/api/gemini-quota'
  ) {
    if (method !== 'GET' && method !== 'POST') {
      return Response.json(
        { ok: false, error: `지원하지 않는 HTTP 메서드입니다: ${method}` },
        { status: 405, headers: JSON_HEADERS }
      );
    }
    return Response.json(
      { ok: false, error: '요청한 작업을 찾을 수 없습니다.' },
      { status: 404, headers: JSON_HEADERS }
    );
  }

  return Response.json(
    { ok: false, error: '요청한 엔드포인트를 찾을 수 없습니다.' },
    { status: 404, headers: JSON_HEADERS }
  );
}

/**
 * Creates a Node Connect-compatible middleware for Vite dev server.
 * Intercepts POST /api/runs and all filesystem-backed state endpoints in Node.js
 * before vinext/Cloudflare App Route runtime is invoked.
 */
export function createWorkspaceBridgeMiddleware(options?: WorkspaceBridgeOptions) {
  const maxBytes = options?.maxBodySizeBytes || 1024 * 1024;

  return (req: http.IncomingMessage, res: http.ServerResponse, next: () => void): void => {
    const rawUrl = req.url || '/';
    const [pathname] = rawUrl.split('?');

    // Only intercept workspace-specific routes; pass everything else to next()
    const isWorkspaceRoute =
      pathname === '/api/runs' ||
      pathname.startsWith('/api/runs/') ||
      pathname === '/api/projects' ||
      pathname.startsWith('/api/projects/') ||
      pathname === '/api/conversations' ||
      pathname.startsWith('/api/conversations/') ||
      pathname === '/api/codex-usage' ||
      pathname === '/api/gemini-quota';

    if (!isWorkspaceRoute) {
      return next();
    }

    const method = (req.method || 'GET').toUpperCase();
    const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

    const handleReq = async (bodyBuffer?: Buffer) => {
      try {
        const fullUrl = `http://${req.headers.host || 'localhost:3000'}${rawUrl}`;
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else {
            headers.set(key, value);
          }
        }

        const request = new Request(fullUrl, {
          method,
          headers,
          body: needsBody && bodyBuffer && bodyBuffer.length > 0 ? new Uint8Array(bodyBuffer) : undefined,
        });

        const response = await handleWorkspaceBridgeRequest(request, options);

        res.statusCode = response.status;
        response.headers.forEach((val, key) => {
          res.setHeader(key, val);
        });

        const text = await response.text();
        res.end(text);
      } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.end(JSON.stringify({ ok: false, error: '작업 요청 처리 중 오류가 발생했습니다.' }));
      }
    };

    if (needsBody) {
      const chunks: Buffer[] = [];
      let totalLength = 0;
      let exceeded = false;

      req.on('data', (chunk: Buffer) => {
        if (exceeded) return;
        totalLength += chunk.length;
        if (totalLength > maxBytes) {
          exceeded = true;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          res.end(
            JSON.stringify({
              ok: false,
              error: '요청 본문 크기가 제한(1MB)을 초과했습니다.',
            })
          );
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (exceeded) return;
        const bodyBuffer = Buffer.concat(chunks);
        void handleReq(bodyBuffer);
      });

      req.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              ok: false,
              error: '요청 본문 읽기 중 오류가 발생했습니다.',
            })
          );
        }
      });
    } else {
      void handleReq();
    }
  };
}

/**
 * Vite plugin registering the Node workspace bridge middleware into Vite dev server.
 */
export function workspaceBridgePlugin(options?: WorkspaceBridgeOptions): Plugin {
  return {
    name: 'workspace-bridge-api',
    configureServer(server) {
      server.middlewares.use(createWorkspaceBridgeMiddleware(options));
    },
  };
}
