// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest } from '../../../../lib/workspace-node-bridge.ts';

export async function GET(
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
      const parts = url.pathname.split('/');
      runId = parts[parts.length - 1] || '';
    } catch {
      // Ignore
    }
  }

  const encodedRunId = encodeURIComponent(runId);
  const req = new Request(`http://localhost:3000/api/runs/${encodedRunId}`, {
    method: 'GET',
    headers: request.headers,
  });

  return handleWorkspaceBridgeRequest(req);
}