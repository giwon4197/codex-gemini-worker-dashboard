// @ts-expect-error TS5097 allowed for test runner
import { getProjectWorkers } from '../../../../../lib/workspace-store.ts';

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> | { projectId: string } }
): Promise<Response> {
  try {
    const params = await Promise.resolve(context.params);
    const projectId = params?.projectId;

    if (!projectId || typeof projectId !== 'string' || projectId.includes('..') || projectId.includes('/') || projectId.includes('\\')) {
      return Response.json(
        { ok: false, error: '유효하지 않은 프로젝트 식별자입니다.' },
        { status: 400 }
      );
    }

    const { activeWorkers, historyWorkers } = await getProjectWorkers();

    return Response.json({
      ok: true,
      projectId,
      activeWorkers,
      historyWorkers,
    });
  } catch {
    return Response.json(
      { ok: false, error: '워커 상태를 조회하지 못했습니다.' },
      { status: 500 }
    );
  }
}