// @ts-expect-error TS5097 allowed for test runner
import { getCodexDailyUsage } from '../../../lib/codex-usage.ts';

export const dynamic = 'force-dynamic';

export async function GET(request?: Request) {
  try {
    let bypassCache = false;
    if (request && request.url) {
      try {
        const url = new URL(request.url);
        bypassCache = url.searchParams.get('refresh') === 'true';
      } catch {
        // Ignore URL parse error
      }
    }

    const result = getCodexDailyUsage({ bypassCache });
    return Response.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  } catch {
    return Response.json(
      {
        ok: false,
        status: 'error',
        message: 'Codex 사용량 조회 중 오류가 발생했습니다.',
        codexDaily: [],
        data: [],
        lastSyncedAt: new Date().toISOString(),
        sessionCount: 0,
        rate_limits: null,
        rateLimits: null,
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Content-Type': 'application/json; charset=utf-8',
        },
      }
    );
  }
}
