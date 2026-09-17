
import fs from 'node:fs';
import path from 'node:path';

import { TIER_MAP, DEFAULT_TIER, CODEX_DEFAULT_MODEL } from './model-tiers.ts';

function getSettingsPath(): string {
  // worker-settings.json located in the project root (parent directory of gemini-dashboard)
  return path.join(process.env.CODEX_GEMINI_INSTALL_ROOT || path.resolve(process.cwd(), '..'), 'worker-settings.json');
}

export interface WorkerSettingsFile {
  tier?: string;
  model?: string;
  /** Model id passed to `codex exec --model`. Unset inherits ~/.codex/config.toml. */
  codexModel?: string;
  updatedAt?: string | null;
}

// Model ids reach spawn() as an argv element, so keep them to a known-safe shape.
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function isValidCodexModel(value: unknown): value is string {
  return typeof value === 'string' && CODEX_MODEL_PATTERN.test(value);
}

/** Reads the saved settings file. A missing or malformed file yields {}. */
export function readWorkerSettings(): WorkerSettingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as WorkerSettingsFile) : {};
  } catch {
    return {};
  }
}

function recoverSettings(filePath: string): WorkerSettingsFile & { updatedAt: string } {
  const data = {
    tier: DEFAULT_TIER,
    model: TIER_MAP[DEFAULT_TIER],
    codexModel: CODEX_DEFAULT_MODEL,
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
    codexModel: readWorkerSettings().codexModel ?? CODEX_DEFAULT_MODEL,
    updatedAt: new Date().toISOString(),
  });
}

async function handleSave(req: Request) {
  try {
    const body = (await req.json()) as { tier?: string; codexModel?: unknown } | null;
    const requestedTier = body?.tier;
    const current = readWorkerSettings();
    let codexModel = current.codexModel ?? CODEX_DEFAULT_MODEL;
    if (body && Object.hasOwn(body, 'codexModel')) {
      if (body.codexModel === null || body.codexModel === '') {
        codexModel = undefined;
      } else if (isValidCodexModel(body.codexModel)) {
        codexModel = body.codexModel;
      } else {
        return Response.json(
          { error: '유효하지 않은 Codex 모델 이름입니다.' },
          { status: 400 }
        );
      }
    }

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
      codexModel,
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
