// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest } from '../../../../../lib/workspace-node-bridge.ts';

export async function GET(
  request: Request,
  context?: { params: Promise<{ projectId: string }> | { projectId: string } }
): Promise<Response> {
  let projectId = '';
  if (context?.params) {
    const params = await Promise.resolve(context.params);
    projectId = params?.projectId || '';
  } else {
    try {
      const url = new URL(request.url);
      const match = url.pathname.match(/\/api\/projects\/([^/]+)\/workers/);
      projectId = match ? match[1] : '';
    } catch {
      // Ignore
    }
  }

  let search = '';
  try {
    const parsed = new URL(request.url);
    search = parsed.search;
  } catch {
    // Ignore
  }

  const encodedProjectId = encodeURIComponent(projectId);
  const req = new Request(
    `http://localhost:3000/api/projects/${encodedProjectId}/workers${search}`,
    {
      method: 'GET',
      headers: request.headers,
    }
  );

  return handleWorkspaceBridgeRequest(req);
}