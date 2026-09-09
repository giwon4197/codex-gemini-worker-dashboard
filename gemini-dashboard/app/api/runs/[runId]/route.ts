// @ts-expect-error TS5097 allowed for test runner
import { validateRunId, getRunDetails } from '../../../../lib/workspace-store.ts';

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> | { runId: string } }
): Promise<Response> {
  try {
    const params = await Promise.resolve(context.params);
    const runId = params?.runId;

    if (!validateRunId(runId)) {
      return Response.json(
        { ok: false, error: '유효하지 않은 run ID 형식입니다.' },
        { status: 400 }
      );
    }

    const run = await getRunDetails(runId);
    if (!run) {
      return Response.json(
        { ok: false, error: '요청한 작업을 찾을 수 없습니다.' },
        { status: 404 }
      );
    }

    return Response.json({ ok: true, run });
  } catch {
    return Response.json(
      { ok: false, error: '작업 세부 정보를 조회하지 못했습니다.' },
      { status: 500 }
    );
  }
}