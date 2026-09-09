import fs from 'node:fs';
import path from 'node:path';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, type Plugin } from 'vite';
import hostingConfig from './.openai/hosting.json';

import { getCodexDailyUsage } from './lib/codex-usage';
import { workspaceBridgePlugin } from './lib/workspace-node-bridge';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const TIER_MAP: Record<string, string> = {
  fast: 'gemini-3.8-flash-low',
  normal: 'gemini-3.8-flash-medium',
  advanced: 'gemini-3.8-flash-high',
  reasoning: 'gemini-3.1-pro-high',
};

const DEFAULT_TIER = 'normal';

function codexUsagePlugin(): Plugin {
  return {
    name: 'codex-usage-api',
    configureServer(server) {
      server.middlewares.use('/api/codex-usage', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            const result = getCodexDailyUsage();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.end(JSON.stringify(result));
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: false,
              status: 'error',
              error: 'Failed to retrieve Codex usage: ' + errorMsg,
              codexDaily: [],
              data: [],
            }));
          }
          return;
        }
        next();
      });
    },
  };
}

function workerSettingsPlugin(): Plugin {
  return {
    name: 'worker-settings-api',
    configureServer(server) {
      server.middlewares.use('/api/settings', (req, res, next) => {
        const rootPath = path.resolve(process.cwd(), '..', 'worker-settings.json');

        if (req.method === 'GET') {
          let tier = DEFAULT_TIER;
          let needRecover = false;
          try {
            if (fs.existsSync(rootPath)) {
              const content = fs.readFileSync(rootPath, 'utf-8');
              const parsed = JSON.parse(content);
              if (parsed && typeof parsed.tier === 'string' && TIER_MAP[parsed.tier]) {
                tier = parsed.tier;
              } else {
                needRecover = true;
              }
            } else {
              needRecover = true;
            }
          } catch {
            needRecover = true;
            tier = DEFAULT_TIER;
          }

          if (needRecover) {
            try {
              const data = {
                tier: DEFAULT_TIER,
                model: TIER_MAP[DEFAULT_TIER],
                updatedAt: new Date().toISOString(),
              };
              fs.writeFileSync(rootPath, JSON.stringify(data, null, 2), 'utf-8');
            } catch (err) {
              console.error('Failed to recover worker-settings.json:', err);
            }
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            tier,
            model: TIER_MAP[tier],
            updatedAt: new Date().toISOString()
          }));
          return;
        }

        if (req.method === 'POST' || req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body || '{}');
              const requestedTier = parsed.tier;
              if (!requestedTier || typeof requestedTier !== 'string' || !TIER_MAP[requestedTier]) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({
                  error: '유효하지 않은 등급입니다. (fast, normal, advanced, reasoning 중 선택)'
                }));
                return;
              }
              const data = {
                tier: requestedTier,
                model: TIER_MAP[requestedTier],
                updatedAt: new Date().toISOString()
              };
              fs.writeFileSync(rootPath, JSON.stringify(data, null, 2), 'utf-8');
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify(data));
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({
                error: '설정 저장 실패: ' + (err?.message || String(err))
              }));
            }
          });
          return;
        }

        next();
      });
    },
  };
}

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      workspaceBridgePlugin(),
      workerSettingsPlugin(),
      codexUsagePlugin(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
