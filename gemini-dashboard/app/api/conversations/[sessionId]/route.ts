import { handleWorkspaceBridgeRequest } from '../../../../lib/workspace-node-bridge.ts';

export async function GET(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}
