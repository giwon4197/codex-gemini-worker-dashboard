// @ts-expect-error TS5097 allowed for test runner
import { validateRepository, validatePrompt, spawnRouterRun, listCompactRuns } from '../../../lib/workspace-store.ts';

export async function GET(): Promise<Response> {
  try {
    const runs = await listCompactRuns();
    return Response.json({ ok: true, runs });
  } catch {
    return Response.json(
      { ok: false, error: '작업 목록을 불러오지 못했습니다.' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    let body: {
      prompt?: unknown;
      idempotencyKey?: unknown;
      repository?: unknown;
    } = {};

    try {
      body = await request.json();
    } catch {
      return Response.json(
        { ok: false, error: '유효한 JSON 요청 본문이 필요합니다.' },
        { status: 400 }
      );
    }

    // 1. Repository Confinement Check (No arbitrary repository, no path traversal)
    const repoValidation = validateRepository(body.repository);
    if (!repoValidation.ok) {
      return Response.json(
        { ok: false, error: repoValidation.error || '허용되지 않은 저장소 경로입니다.' },
        { status: 400 }
      );
    }

    // 2. Prompt Validation
    const promptValidation = validatePrompt(body.prompt);
    if (!promptValidation.ok) {
      return Response.json(
        { ok: false, error: promptValidation.error || '작업 요청 내용을 입력해주세요.' },
        { status: 400 }
      );
    }

    // 3. Optional Idempotency Key validation
    let idempotencyKey: string | undefined = undefined;
    if (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) {
      idempotencyKey = body.idempotencyKey.trim().slice(0, 128);
    }

    // 4. Safe Asynchronous Router Execution
    const result = await spawnRouterRun({
      prompt: promptValidation.prompt,
      idempotencyKey,
      repoRoot: repoValidation.repoRoot,
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
      { status: result.isDuplicate ? 200 : 201 }
    );
  } catch {
    // Never leak stack traces, internal paths, or process errors to client
    return Response.json(
      { ok: false, error: '작업 요청 처리 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}