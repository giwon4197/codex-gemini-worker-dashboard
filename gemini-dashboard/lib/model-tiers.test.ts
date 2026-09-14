import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error TS5097 allowed for test runner
import { ALLOWED_TIERS, DEFAULT_TIER, loadModelTiers, modelForTier, parseModelTiers } from './model-tiers.ts';

const valid = () => ({ default_tier: 'normal', tiers: [{ tier: 'normal', model: 'example', description: 'Example' }] });
void test('model tier configuration rejects malformed JSON', () => assert.throws(() => parseModelTiers('{')));
void test('model tier configuration rejects unknown default', () => assert.throws(() => parseModelTiers(JSON.stringify({ ...valid(), default_tier: 'missing' }))));
void test('model tier configuration rejects duplicate tier', () => {
  const config = valid(); config.tiers.push({ ...config.tiers[0] });
  assert.throws(() => parseModelTiers(JSON.stringify(config)));
});
for (const field of ['tier', 'model', 'description'] as const) {
  void test(`model tier configuration rejects empty ${field}`, () => {
    const config = valid(); config.tiers[0][field] = ' ';
    assert.throws(() => parseModelTiers(JSON.stringify(config)));
  });
  void test(`model tier configuration rejects missing ${field}`, () => {
    const config = valid(); delete (config.tiers[0] as Partial<typeof config.tiers[0]>)[field];
    assert.throws(() => parseModelTiers(JSON.stringify(config)));
  });
}
void test('root config, bundled config, settings example and README agree', () => {
  const root = new URL('../../', import.meta.url);
  const config = loadModelTiers(fileURLToPath(new URL('model-tiers.json', root)));
  assert.deepEqual(config, loadModelTiers());
  const settings = JSON.parse(fs.readFileSync(new URL('worker-settings.example.json', root), 'utf8'));
  assert.equal(settings.tier, DEFAULT_TIER);
  assert.equal(settings.model, modelForTier(settings.tier));
  const readme = fs.readFileSync(new URL('README.md', root), 'utf8');
  for (const entry of config.tiers) assert.ok(readme.split('\n').some(line => line.includes(entry.tier) && line.includes(entry.model)));
  assert.deepEqual(ALLOWED_TIERS, ['fast', 'normal', 'advanced', 'reasoning']);
  assert.throws(() => modelForTier('toString'));
});
