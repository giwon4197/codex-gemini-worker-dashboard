import fs from 'node:fs';
import bundledConfig from '../../model-tiers.json' with { type: 'json' };

export interface ModelTierConfig {
  default_tier: string;
  /**
   * Model used for `codex exec` when nothing overrides it. Optional: leaving it
   * out inherits whatever ~/.codex/config.toml sets.
   */
  codex_default_model?: string;
  tiers: { tier: string; model: string; description: string }[];
}

// Model ids reach spawn() as an argv element, so keep them to a known-safe shape.
const CODEX_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export function parseModelTiers(json: string): ModelTierConfig {
  const config = JSON.parse(json) as ModelTierConfig;
  if (!config || typeof config.default_tier !== 'string' || !Array.isArray(config.tiers)) {
    throw new Error('Invalid model tier configuration: default_tier and tiers are required');
  }
  const seen = new Set<string>();
  for (const entry of config.tiers) {
    if (!entry || ['tier', 'model', 'description'].some(key => {
      const value = entry[key as keyof typeof entry];
      return typeof value !== 'string' || !value.trim();
    })) throw new Error('Invalid model tier configuration: tier, model and description are required');
    if (seen.has(entry.tier)) throw new Error(`Duplicate model tier: ${entry.tier}`);
    seen.add(entry.tier);
  }
  if (!seen.has(config.default_tier)) throw new Error('Unknown default_tier');
  if (
    config.codex_default_model !== undefined &&
    !CODEX_MODEL_PATTERN.test(config.codex_default_model)
  ) {
    throw new Error('Invalid codex_default_model');
  }
  return config;
}

// Bundling the same root JSON also supports the vinext/workerd runtime, where
// host filesystem paths are unavailable. Explicit files support install checks.
export function loadModelTiers(filePath?: string): ModelTierConfig {
  return parseModelTiers(filePath ? fs.readFileSync(filePath, 'utf8') : JSON.stringify(bundledConfig));
}

const config = loadModelTiers();
export const DEFAULT_TIER = config.default_tier;
export const CODEX_DEFAULT_MODEL = config.codex_default_model;
export const ALLOWED_TIERS = config.tiers.map(entry => entry.tier);
export const TIER_MAP: Record<string, string> = Object.fromEntries(config.tiers.map(entry => [entry.tier, entry.model]));
export function modelForTier(tier: string): string {
  if (!Object.hasOwn(TIER_MAP, tier)) throw new Error(`Unknown model tier: ${tier}`);
  return TIER_MAP[tier];
}
