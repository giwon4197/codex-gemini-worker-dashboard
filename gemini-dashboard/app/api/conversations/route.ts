// @ts-expect-error TS5097 allowed for test runner
import { handleWorkspaceBridgeRequest } from '../../../lib/workspace-node-bridge.ts';

export async function GET(request?: Request): Promise<Response> {
  const req = request || new Request('http://localhost:3000/api/conversations', { method: 'GET' });
  return handleWorkspaceBridgeRequest(req);
}

export async function POST(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}
