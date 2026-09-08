// @ts-expect-error TS5097 allowed for test runner
import { getGeminiQuota } from '../../../lib/gemini-quota.ts';

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

    const quotaResponse = await getGeminiQuota({ bypassCache });

    return Response.json(quotaResponse, {
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
        quota: null,
        lastSyncedAt: new Date().toISOString(),
        message: 'Gemini 쿼터 조회 중 오류가 발생했습니다.',
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
