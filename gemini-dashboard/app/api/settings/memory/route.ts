import { handleWorkspaceBridgeRequest } from '../../../../lib/workspace-node-bridge.ts';

export async function GET(request?: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(
    request || new Request('http://localhost:3000/api/settings/memory')
  );
}

export async function PATCH(request: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(request);
}

export async function DELETE(request?: Request): Promise<Response> {
  return handleWorkspaceBridgeRequest(
    request ||
      new Request('http://localhost:3000/api/settings/memory', {
        method: 'DELETE',
      })
  );
}
