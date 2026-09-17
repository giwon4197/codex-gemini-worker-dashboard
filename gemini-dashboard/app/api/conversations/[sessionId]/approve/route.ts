import { handleWorkspaceBridgeRequest } from '../../../../../lib/workspace-node-bridge.ts';

export async function POST(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}
