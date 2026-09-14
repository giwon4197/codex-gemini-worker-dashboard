
import fs from 'node:fs';
import path from 'node:path';

// @ts-expect-error TS5097 allowed for test runner
import { TIER_MAP, DEFAULT_TIER } from './model-tiers.ts';

function getSettingsPath(): string {
  // worker-settings.json located in the project root (parent directory of gemini-dashboard)
  return path.join(process.env.CODEX_GEMINI_INSTALL_ROOT || path.resolve(process.cwd(), '..'), 'worker-settings.json');
}

function recoverSettings(filePath: string): { tier: string; model: string; updatedAt: string } {
  const data = {
    tier: DEFAULT_TIER,
    model: TIER_MAP[DEFAULT_TIER],
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write recovered worker-settings.json:', err);
  }
  return data;
}

export async function GET() {
  const filePath = getSettingsPath();
  let needRecover = false;
  let tier = DEFAULT_TIER;

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { tier?: string } | null;
      if (parsed && typeof parsed.tier === 'string' && Object.hasOwn(TIER_MAP, parsed.tier)) {
        tier = parsed.tier;
      } else {
        needRecover = true;
      }
    } else {
      needRecover = true;
    }
  } catch {
    needRecover = true;
  }

  if (needRecover) {
    const recovered = recoverSettings(filePath);
    return Response.json(recovered);
  }

  return Response.json({
    tier,
    model: TIER_MAP[tier],
    updatedAt: new Date().toISOString(),
  });
}

async function handleSave(req: Request) {
  try {
    const body = (await req.json()) as { tier?: string } | null;
    const requestedTier = body?.tier;

    if (!requestedTier || typeof requestedTier !== 'string' || !Object.hasOwn(TIER_MAP, requestedTier)) {
      return Response.json(
        {
          error: '유효하지 않은 모델 등급입니다.',
          allowedTiers: Object.keys(TIER_MAP),
          message: 'fast, normal, advanced, reasoning 중 하나를 선택해야 합니다.'
        },
        { status: 400 }
      );
    }

    const filePath = getSettingsPath();
    const data = {
      tier: requestedTier,
      model: TIER_MAP[requestedTier],
      updatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return Response.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: '설정 저장 중 오류가 발생했습니다: ' + message },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  return handleSave(req);
}

export async function PUT(req: Request) {
  return handleSave(req);
}
