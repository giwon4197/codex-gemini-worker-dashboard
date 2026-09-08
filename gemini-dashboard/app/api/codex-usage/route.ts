import { NextResponse } from 'next/server';
import { getCodexDailyUsage } from '@/lib/codex-usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const result = getCodexDailyUsage();
  return NextResponse.json(result, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}
