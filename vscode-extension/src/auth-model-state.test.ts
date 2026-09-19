import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isModelSelectionLocked,
  isValidGeminiTier,
  parseAgyModels,
  probeAuthModelState,
  type CliProbeRunner,
  type CliProbeResult,
} from './auth-model-state.ts';

const result = (stdout = '', stderr = '', exitCode = 0): CliProbeResult => ({ stdout, stderr, exitCode });

function runnerFor(responses: Record<string, CliProbeResult>, calls: string[] = []): CliProbeRunner {
  return async (_executable, args) => {
    const key = args.join(' ');
    calls.push(key);
    return responses[key] || result('', '', 1);
  };
}

void describe('sanitized CLI auth/model discovery', () => {
  void test('reports each missing CLI independently', async () => {
    const state = await probeAuthModelState({}, {
      resolveCodex: () => null,
      resolveGemini: () => null,
    });
    assert.equal(state.codex.authState, 'not_installed');
    assert.equal(state.gemini.authState, 'not_installed');
  });

  void test('uses supported codex login status and recognizes ChatGPT auth', async () => {
    const calls: string[] = [];
    const state = await probeAuthModelState({}, {
      resolveCodex: () => 'codex',
      resolveGemini: () => null,
      run: runnerFor({
        'login --help': result('Commands:\n  status  Show login status'),
        'login status': result('Logged in using ChatGPT'),
      }, calls),
    });
    assert.equal(state.codex.authState, 'authenticated');
    assert.equal(state.codex.authMethod, 'ChatGPT');
    assert.deepEqual(calls, ['login --help', 'login status']);
  });

  void test('maps explicit codex unauthenticated and ambiguous results safely', async () => {
    const help = result('Commands:\n  status  Show login status');
    const unauthenticated = await probeAuthModelState({}, {
      resolveCodex: () => 'codex', resolveGemini: () => null,
      run: runnerFor({ 'login --help': help, 'login status': result('', 'Not logged in', 1) }),
    });
    assert.equal(unauthenticated.codex.authState, 'unauthenticated');

    const unknown = await probeAuthModelState({}, {
      resolveCodex: () => 'codex', resolveGemini: () => null,
      run: runnerFor({ 'login --help': help, 'login status': result('unexpected response') }),
    });
    assert.equal(unknown.codex.authState, 'unknown');
  });

  void test('never forwards token-like raw Codex output into webview state', async () => {
    const secret = 'sk-secret-token-value';
    const state = await probeAuthModelState({}, {
      resolveCodex: () => 'codex', resolveGemini: () => null,
      run: runnerFor({
        'login --help': result('Commands:\n  status  Show login status'),
        'login status': result(`Logged in using API key ${secret}`),
      }),
    });
    assert.equal(state.codex.authState, 'authenticated');
    assert.equal(state.codex.authMethod, 'API key');
    assert.equal(JSON.stringify(state).includes(secret), false);
  });

  void test('uses the supported agy models command and extracts only model slugs', async () => {
    const calls: string[] = [];
    const state = await probeAuthModelState({ selectedGeminiTier: 'advanced' }, {
      resolveCodex: () => null,
      resolveGemini: () => 'agy',
      run: runnerFor({
        '--help': result('Available subcommands:\n  models  List available models'),
        models: result('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)'),
      }, calls),
    });
    assert.equal(state.gemini.authState, 'authenticated');
    assert.deepEqual(state.gemini.availableModels, ['gemini-3.8-flash-high', 'gemini-3.1-pro-high']);
    assert.equal(state.gemini.selectedModel, 'gemini-3.8-flash-high');
    assert.deepEqual(calls, ['--help', 'models']);
  });

  void test('agy model failure returns safe state without any credential lookup path', async () => {
    const calls: string[] = [];
    const state = await probeAuthModelState({}, {
      resolveCodex: () => null,
      resolveGemini: () => 'agy',
      run: runnerFor({
        '--help': result('Available subcommands:\n  models  List available models'),
        models: result('', 'network unavailable', 1),
      }, calls),
      readGeminiQuota: async () => { throw new Error('quota fallback must not run when models is supported'); },
    });
    assert.equal(state.gemini.authState, 'unknown');
    assert.deepEqual(calls, ['--help', 'models']);
    assert.deepEqual(parseAgyModels(result('noise\ngemini-ok\tGemini OK')), ['gemini-ok']);
  });
});

void test('model selector policy locks only in-flight run states', () => {
  for (const status of ['planning', 'running', 'retrying']) assert.equal(isModelSelectionLocked(status), true);
  for (const status of ['idle', 'awaiting_review', 'awaiting_human_approval', 'changes_requested', 'completed']) {
    assert.equal(isModelSelectionLocked(status), false);
  }
});

void test('Gemini tier validation comes from model-tiers.json', () => {
  assert.equal(isValidGeminiTier('fast'), true);
  assert.equal(isValidGeminiTier('reasoning'), true);
  assert.equal(isValidGeminiTier('invalid-tier'), false);
});

void test('auth/model state contract contains no credential fields', async () => {
  const state = await probeAuthModelState({}, { resolveCodex: () => null, resolveGemini: () => null });
  const keys: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key.toLowerCase());
      visit(child);
    }
  };
  visit(state);
  for (const forbidden of ['accesstoken', 'refreshtoken', 'token', 'apikey', 'api_key', 'password', 'cookie', 'authorization', 'credentials']) {
    assert.equal(keys.includes(forbidden), false, forbidden);
  }
});
