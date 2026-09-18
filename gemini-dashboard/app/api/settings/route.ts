import { handleWorkspaceBridgeRequest } from '../../../lib/workspace-node-bridge.ts';

export async function GET(request?: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(
    request || new Request('http://localhost:3000/api/settings')
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}

export async function PUT(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}
