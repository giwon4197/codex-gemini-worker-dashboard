import fs from 'node:fs';
import path from 'node:path';

import { TIER_MAP, DEFAULT_TIER, CODEX_DEFAULT_MODEL } from './model-tiers.ts';
import { validatePersistentPreferenceValue } from './workspace-sanitize.ts';

export const RESPONSE_LANGUAGES = ['auto', 'ko', 'en'] as const;
export const EXPLANATION_DETAILS = [
  'concise',
  'balanced',
  'detailed',
] as const;
export const PLAN_PRESENTATIONS = [
  'concise',
  'step_by_step',
  'risk_focused',
] as const;

export type ResponseLanguage = (typeof RESPONSE_LANGUAGES)[number];
export type ExplanationDetail = (typeof EXPLANATION_DETAILS)[number];
export type PlanPresentation = (typeof PLAN_PRESENTATIONS)[number];
export type WorkerPreferenceKey =
  | 'responseLanguage'
  | 'explanationDetail'
  | 'planPresentation'
  | 'preferTargetedTests'
  | 'completionNotifications';

export interface WorkerPreferenceValueByKey {
  responseLanguage: ResponseLanguage;
  explanationDetail: ExplanationDetail;
  planPresentation: PlanPresentation;
  preferTargetedTests: boolean;
  completionNotifications: boolean;
}

export interface ExplicitPreferenceRecord<T> {
  value: T;
  provenance: 'explicit_user';
  confidence: 'confirmed';
  updatedAt: string;
}

export type WorkerPreferences = {
  [K in WorkerPreferenceKey]?: ExplicitPreferenceRecord<
    WorkerPreferenceValueByKey[K]
  >;
};

export interface WorkerMemorySettings {
  schemaVersion: 1;
  enabled: boolean;
  preferences: WorkerPreferences;
}

export interface WorkerSettingsFile {
  tier?: string;
  model?: string;
  codexModel?: string;
  updatedAt?: string | null;
  memory?: WorkerMemorySettings;
  [key: string]: unknown;
}

const CODEX_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const PREFERENCE_KEYS = new Set<WorkerPreferenceKey>([
  'responseLanguage',
  'explanationDetail',
  'planPresentation',
  'preferTargetedTests',
  'completionNotifications',
]);

function getSettingsPath(): string {
  return path.join(
    process.env.CODEX_GEMINI_INSTALL_ROOT || path.resolve(process.cwd(), '..'),
    'worker-settings.json'
  );
}

function defaultMemory(): WorkerMemorySettings {
  return { schemaVersion: 1, enabled: true, preferences: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isValidCodexModel(value: unknown): value is string {
  return typeof value === 'string' && CODEX_MODEL_PATTERN.test(value);
}

export function isWorkerPreferenceKey(
  value: unknown
): value is WorkerPreferenceKey {
  return typeof value === 'string' && PREFERENCE_KEYS.has(value as WorkerPreferenceKey);
}

export function isValidWorkerPreferenceValue<K extends WorkerPreferenceKey>(
  key: K,
  value: unknown
): value is WorkerPreferenceValueByKey[K] {
  if (!validatePersistentPreferenceValue(value).safe) return false;
  switch (key) {
    case 'responseLanguage':
      return RESPONSE_LANGUAGES.includes(value as ResponseLanguage);
    case 'explanationDetail':
      return EXPLANATION_DETAILS.includes(value as ExplanationDetail);
    case 'planPresentation':
      return PLAN_PRESENTATIONS.includes(value as PlanPresentation);
    case 'preferTargetedTests':
    case 'completionNotifications':
      return typeof value === 'boolean';
  }
}

function parseMemory(value: unknown): WorkerMemorySettings | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') {
    return undefined;
  }
  if (!isRecord(value.preferences)) return undefined;

  const preferences: WorkerPreferences = {};
  for (const [key, rawRecord] of Object.entries(value.preferences)) {
    if (!isWorkerPreferenceKey(key) || !isRecord(rawRecord)) return undefined;
    if (
      rawRecord.provenance !== 'explicit_user' ||
      rawRecord.confidence !== 'confirmed' ||
      typeof rawRecord.updatedAt !== 'string' ||
      Number.isNaN(Date.parse(rawRecord.updatedAt)) ||
      !isValidWorkerPreferenceValue(key, rawRecord.value)
    ) {
      return undefined;
    }
    preferences[key] = {
      value: rawRecord.value,
      provenance: 'explicit_user',
      confidence: 'confirmed',
      updatedAt: rawRecord.updatedAt,
    } as never;
  }

  return { schemaVersion: 1, enabled: value.enabled, preferences };
}

export function readWorkerSettings(): WorkerSettingsFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(getSettingsPath(), 'utf-8')
    ) as unknown;
    return isRecord(parsed) ? (parsed as WorkerSettingsFile) : {};
  } catch {
    return {};
  }
}

export function readWorkerMemory(): WorkerMemorySettings {
  return parseMemory(readWorkerSettings().memory) ?? defaultMemory();
}

function atomicWriteSettings(data: WorkerSettingsFile): void {
  const filePath = getSettingsPath();
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.worker-settings.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizedSettings(current = readWorkerSettings()): WorkerSettingsFile {
  const tier =
    typeof current.tier === 'string' && Object.hasOwn(TIER_MAP, current.tier)
      ? current.tier
      : DEFAULT_TIER;
  const memory = parseMemory(current.memory);
  return {
    ...current,
    tier,
    model: TIER_MAP[tier],
    codexModel: isValidCodexModel(current.codexModel)
      ? current.codexModel
      : current.codexModel === undefined
        ? undefined
        : CODEX_DEFAULT_MODEL,
    updatedAt: current.updatedAt ?? null,
    ...(memory ? { memory } : { memory: defaultMemory() }),
  };
}

function persistMemory(memory: WorkerMemorySettings): WorkerSettingsFile {
  const current = readWorkerSettings();
  const tier =
    typeof current.tier === 'string' && Object.hasOwn(TIER_MAP, current.tier)
      ? current.tier
      : DEFAULT_TIER;
  const data: WorkerSettingsFile = {
    ...current,
    tier,
    model: TIER_MAP[tier],
    codexModel: isValidCodexModel(current.codexModel)
      ? current.codexModel
      : current.codexModel === undefined
        ? undefined
        : CODEX_DEFAULT_MODEL,
    memory,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteSettings(data);
  return data;
}

export function setWorkerMemoryEnabled(enabled: boolean): WorkerMemorySettings {
  if (typeof enabled !== 'boolean') throw new Error('INVALID_MEMORY_MUTATION');
  const memory = readWorkerMemory();
  memory.enabled = enabled;
  return persistMemory(memory).memory as WorkerMemorySettings;
}

export function setWorkerPreference<K extends WorkerPreferenceKey>(
  key: K,
  value: WorkerPreferenceValueByKey[K]
): WorkerMemorySettings {
  if (!isWorkerPreferenceKey(key) || !isValidWorkerPreferenceValue(key, value)) {
    throw new Error('INVALID_MEMORY_MUTATION');
  }
  const memory = readWorkerMemory();
  memory.preferences[key] = {
    value,
    provenance: 'explicit_user',
    confidence: 'confirmed',
    updatedAt: new Date().toISOString(),
  } as never;
  return persistMemory(memory).memory as WorkerMemorySettings;
}

export function deleteWorkerPreference(
  key: WorkerPreferenceKey
): WorkerMemorySettings {
  if (!isWorkerPreferenceKey(key)) throw new Error('INVALID_MEMORY_MUTATION');
  const memory = readWorkerMemory();
  delete memory.preferences[key];
  return persistMemory(memory).memory as WorkerMemorySettings;
}

export function resetWorkerPreferences(): WorkerMemorySettings {
  const memory = readWorkerMemory();
  memory.preferences = {};
  return persistMemory(memory).memory as WorkerMemorySettings;
}

function recoverSettings(): WorkerSettingsFile {
  const current = readWorkerSettings();
  const memory = parseMemory(current.memory);
  const data: WorkerSettingsFile = {
    ...current,
    tier: DEFAULT_TIER,
    model: TIER_MAP[DEFAULT_TIER],
    codexModel: isValidCodexModel(current.codexModel)
      ? current.codexModel
      : CODEX_DEFAULT_MODEL,
    updatedAt: new Date().toISOString(),
  };
  if (memory) data.memory = memory;
  else delete data.memory;
  atomicWriteSettings(data);
  return { ...data, memory: memory ?? defaultMemory() };
}

export async function GET() {
  const current = readWorkerSettings();
  if (
    typeof current.tier !== 'string' ||
    !Object.hasOwn(TIER_MAP, current.tier)
  ) {
    return Response.json(recoverSettings());
  }
  return Response.json(normalizedSettings(current));
}

async function handleSave(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown> | null;
    const requestedTier = body?.tier;
    if (
      typeof requestedTier !== 'string' ||
      !Object.hasOwn(TIER_MAP, requestedTier)
    ) {
      return Response.json(
        {
          error: '유효하지 않은 모델 등급입니다.',
          allowedTiers: Object.keys(TIER_MAP),
          message: 'fast, normal, advanced, reasoning 중 하나를 선택해야 합니다.',
        },
        { status: 400 }
      );
    }

    const current = readWorkerSettings();
    let codexModel = isValidCodexModel(current.codexModel)
      ? current.codexModel
      : CODEX_DEFAULT_MODEL;
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

    const memory = parseMemory(current.memory);
    const data: WorkerSettingsFile = {
      ...current,
      tier: requestedTier,
      model: TIER_MAP[requestedTier],
      codexModel,
      updatedAt: new Date().toISOString(),
    };
    if (memory) data.memory = memory;
    else delete data.memory;
    atomicWriteSettings(data);
    return Response.json({ ...data, memory: memory ?? defaultMemory() });
  } catch (error: unknown) {
    const message = error instanceof SyntaxError
      ? error.message
      : '설정 저장 중 오류가 발생했습니다.';
    return Response.json(
      { error: `설정 저장 중 오류가 발생했습니다: ${message}` },
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

export async function MEMORY_GET() {
  return Response.json({ ok: true, memory: readWorkerMemory() });
}

export async function MEMORY_PATCH(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown> | null;
    let memory: WorkerMemorySettings;
    if (body?.operation === 'setEnabled') {
      memory = setWorkerMemoryEnabled(body.enabled as boolean);
    } else if (body?.operation === 'setPreference') {
      if (!isWorkerPreferenceKey(body.key)) throw new Error('INVALID_MEMORY_MUTATION');
      memory = setWorkerPreference(body.key, body.value as never);
    } else if (body?.operation === 'deletePreference') {
      if (!isWorkerPreferenceKey(body.key)) throw new Error('INVALID_MEMORY_MUTATION');
      memory = deleteWorkerPreference(body.key);
    } else {
      throw new Error('INVALID_MEMORY_MUTATION');
    }
    return Response.json({
      ok: true,
      memory,
      settingsUpdatedAt: readWorkerSettings().updatedAt,
    });
  } catch {
    return Response.json(
      {
        ok: false,
        code: 'INVALID_MEMORY_MUTATION',
        error: '유효하지 않은 메모리 설정 요청입니다.',
      },
      { status: 400 }
    );
  }
}

export async function MEMORY_DELETE() {
  return Response.json({ ok: true, memory: resetWorkerPreferences() });
}
