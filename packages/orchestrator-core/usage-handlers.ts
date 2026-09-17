import { getCodexDailyUsage } from './codex-usage.ts';



export async function handleCodexUsage(request?: Request) {
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

import { getGeminiQuota } from './gemini-quota.ts';



export async function handleGeminiQuota(request?: Request) {
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
