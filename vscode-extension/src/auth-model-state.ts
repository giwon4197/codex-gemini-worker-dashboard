import { execFile } from 'node:child_process';

import { resolveCodexExecutable } from '../../packages/orchestrator-core/codex-conversation.ts';
import { findAntigravityCliExecutable, getGeminiQuota } from '../../packages/orchestrator-core/gemini-quota.ts';
import { loadModelTiers } from '../../packages/orchestrator-core/model-tiers.ts';
import { sanitizeSpawnEnv } from '../../packages/orchestrator-core/spawn-env.ts';
import type { CodexReasoningEffort } from '../../packages/orchestrator-core/worker-settings.ts';
import type { AuthModelState, AuthState, CodexModelPreset, GeminiTierOption } from './protocol.ts';

const OUTPUT_LIMIT = 64 * 1024;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCKED_RUN_STATUSES = new Set(['planning', 'running', 'retrying']);
const CODEX_MODEL_PRESETS: CodexModelPreset[] = [
  ...(['low', 'medium', 'high'] as const).map(reasoningEffort => ({
    model: 'gpt-5.6-sol',
    reasoningEffort,
    label: `GPT-5.6 Sol · ${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)}`,
  })),
  ...(['low', 'medium', 'high'] as const).map(reasoningEffort => ({
    model: 'gpt-6-astra',
    reasoningEffort,
    label: `GPT-6 Astra · ${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)}`,
  })),
];

export interface CliProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CliProbeRunner = (
  executable: string,
  args: string[],
  timeoutMs: number
) => Promise<CliProbeResult>;

export interface AuthModelProbeOptions {
  selectedCodexModel?: string;
  selectedCodexReasoningEffort?: CodexReasoningEffort;
  selectedGeminiTier?: string;
  runStatus?: string;
}

export interface AuthModelProbeDependencies {
  resolveCodex?: () => string | null;
  resolveGemini?: () => string | null;
  run?: CliProbeRunner;
  readGeminiQuota?: typeof getGeminiQuota;
}

/** Runs only fixed read-only argv with bounded output; raw output never leaves this module. */
export const defaultCliProbeRunner: CliProbeRunner = (executable, args, timeoutMs) =>
  new Promise(resolve => {
    try {
      execFile(
        executable,
        args,
        {
          encoding: 'utf8',
          env: sanitizeSpawnEnv(process.env),
          maxBuffer: OUTPUT_LIMIT,
          shell: false,
          timeout: timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: String(stdout || '').slice(0, OUTPUT_LIMIT),
            stderr: String(stderr || '').slice(0, OUTPUT_LIMIT),
            exitCode: error
              ? typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : 1
              : 0,
          });
        }
      );
    } catch {
      resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
  });

function combined(result: CliProbeResult): string {
  return `${result.stdout}\n${result.stderr}`.slice(0, OUTPUT_LIMIT);
}

function listsCommand(help: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}(?:\\s|$)`, 'im').test(help);
}

function unauthenticatedOutput(text: string): boolean {
  return /not\s+(?:logged|signed)\s+in|unauthenticated|authentication\s+(?:required|failed)|login\s+required|please\s+(?:log|sign)\s+in/i.test(text);
}

export function parseCodexAuthResult(result: CliProbeResult): {
  authState: AuthState;
  authMethod?: 'ChatGPT' | 'API key';
} {
  const text = combined(result);
  if (unauthenticatedOutput(text)) return { authState: 'unauthenticated' };
  if (result.exitCode !== 0 || !/logged\s+in|authenticated/i.test(text)) {
    return { authState: 'unknown' };
  }
  const authMethod = /api\s*key/i.test(text)
    ? 'API key' as const
    : /chatgpt/i.test(text)
      ? 'ChatGPT' as const
      : undefined;
  return { authState: 'authenticated', ...(authMethod ? { authMethod } : {}) };
}

export function parseAgyModels(result: CliProbeResult): string[] {
  if (result.exitCode !== 0) return [];
  const models: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const slug = line.trim().match(/^([A-Za-z0-9._:-]{1,128})\t+\S/)?.[1];
    if (slug && MODEL_ID_PATTERN.test(slug) && !models.includes(slug)) models.push(slug);
  }
  return models;
}

export function isModelSelectionLocked(status?: string): boolean {
  return LOCKED_RUN_STATUSES.has((status || '').trim().toLowerCase());
}

export function isValidGeminiTier(value: unknown): value is string {
  return typeof value === 'string' && loadModelTiers().tiers.some(entry => entry.tier === value);
}

export async function probeAuthModelState(
  options: AuthModelProbeOptions = {},
  dependencies: AuthModelProbeDependencies = {}
): Promise<AuthModelState> {
  const config = loadModelTiers();
  const tiers: GeminiTierOption[] = config.tiers.map(entry => ({ ...entry }));
  const selectedTier = tiers.some(entry => entry.tier === options.selectedGeminiTier)
    ? options.selectedGeminiTier as string
    : config.default_tier;
  const run = dependencies.run || defaultCliProbeRunner;
  const codexExecutable = (dependencies.resolveCodex || (() => resolveCodexExecutable()))();
  const geminiExecutable = (dependencies.resolveGemini || findAntigravityCliExecutable)();

  const codex = {
    installed: Boolean(codexExecutable),
    authState: (codexExecutable ? 'unknown' : 'not_installed') as AuthState,
    selectedModel: options.selectedCodexModel?.trim() || undefined,
    selectedReasoningEffort: options.selectedCodexReasoningEffort,
    modelOptions: Array.from(new Set([
      options.selectedCodexModel?.trim(),
      config.codex_default_model,
    ].filter((value): value is string => Boolean(value)))),
    presets: CODEX_MODEL_PRESETS.map(preset => ({ ...preset })),
  };
  if (codexExecutable) {
    const help = await run(codexExecutable, ['login', '--help'], 8_000);
    if (help.exitCode === 0 && listsCommand(combined(help), 'status')) {
      Object.assign(codex, parseCodexAuthResult(await run(codexExecutable, ['login', 'status'], 8_000)));
    }
  }

  const gemini = {
    installed: Boolean(geminiExecutable),
    authState: (geminiExecutable ? 'unknown' : 'not_installed') as AuthState,
    selectedTier,
    selectedModel: tiers.find(entry => entry.tier === selectedTier)?.model,
    availableModels: [] as string[],
    tiers,
  };
  if (geminiExecutable) {
    const help = await run(geminiExecutable, ['--help'], 8_000);
    if (help.exitCode === 0 && listsCommand(combined(help), 'models')) {
      const modelResult = await run(geminiExecutable, ['models'], 20_000);
      gemini.availableModels = parseAgyModels(modelResult);
      if (gemini.availableModels.length > 0) gemini.authState = 'authenticated';
      else if (unauthenticatedOutput(combined(modelResult))) gemini.authState = 'unauthenticated';
      gemini.tiers = tiers.map(entry => ({
        ...entry,
        available: gemini.availableModels.length > 0
          ? gemini.availableModels.includes(entry.model)
          : undefined,
      }));
    } else {
      const quota = await (dependencies.readGeminiQuota || getGeminiQuota)({ bypassCache: true });
      if (quota.ok && quota.status === 'available') gemini.authState = 'authenticated';
    }
  }

  return {
    codex,
    gemini,
    selectorsDisabled: isModelSelectionLocked(options.runStatus),
  };
}
