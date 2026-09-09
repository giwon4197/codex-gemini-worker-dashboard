// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest } from '../../../lib/workspace-node-bridge.ts';

export async function GET(request?: Request): Promise<Response> {
  const req = request || new Request('http://localhost:3000/api/projects', { method: 'GET' });
  return handleWorkspaceBridgeRequest(req);
}