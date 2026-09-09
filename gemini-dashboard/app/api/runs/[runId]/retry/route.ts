// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest } from '../../../../../lib/workspace-node-bridge.ts';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context?: { params: Promise<{ runId: string }> | { runId: string } }
): Promise<Response> {
  let runId = '';
  if (context?.params) {
    const params = await Promise.resolve(context.params);
    runId = params?.runId || '';
  } else {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/runs\/([^/]+)\/retry/);
      if (match) {
        runId = match[1];
      }
    } catch {
      // Ignore
    }
  }

  const encodedRunId = encodeURIComponent(runId);
  const req = new Request(`http://localhost:3000/api/runs/${encodedRunId}/retry`, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    // @ts-expect-error duplex is required in Node 18+ for streaming request bodies
    duplex: 'half',
  });

  return handleWorkspaceBridgeRequest(req);
}

export async function GET(): Promise<Response> {
  return Response.json(
    { ok: false, error: '지원하지 않는 HTTP 메서드입니다: GET' },
    {
      status: 405,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );
}