import type http from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import type { SpawnerFn } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { getAllowedRepoRoot, validateRunId, validateRepository, validatePrompt, spawnRouterRun, listCompactRuns, getRunDetails, getProjectWorkers } from './workspace-store.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeText } from './workspace-sanitize.ts';

export interface WorkspaceBridgeOptions {
  repoRoot?: string;
  spawner?: SpawnerFn;
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
      return Response.json(
        {
          ok: false,
          error: sanitizedMsg.includes('필수 실행 도구')
            ? sanitizedMsg
            : '작업 요청 처리 중 오류가 발생했습니다.',
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
      const { activeWorkers, historyWorkers } = await getProjectWorkers(activeOptions.repoRoot);
      return Response.json(
        { ok: true, projectId, activeWorkers, historyWorkers },
        { status: 200, headers: JSON_HEADERS }
      );
    } catch {
      return Response.json(
        { ok: false, error: '워커 상태를 조회하지 못했습니다.' },
        { status: 500, headers: JSON_HEADERS }
      );
    }
  }

  // Check for known route prefixes with invalid method
  if (
    pathname === '/api/runs' ||
    pathname.startsWith('/api/runs/') ||
    pathname === '/api/projects' ||
    pathname.startsWith('/api/projects/')
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
      pathname.startsWith('/api/projects/');

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
