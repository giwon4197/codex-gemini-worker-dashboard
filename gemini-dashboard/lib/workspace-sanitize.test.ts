import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizePath, sanitizeCommand, sanitizeText, sanitizeWorkerLog, sanitizeWorkerData } from './workspace-sanitize.ts';
import type { LiveWorkerData } from './workspace-contract.ts';

void describe('Workspace Sanitization (Non-disclosure & Path Protection)', () => {
  const mockRepoRoot = 'C:/Users/developer/projects/repo';

  void describe('sanitizePath', () => {
    void test('strips absolute repoRoot and returns repository-relative path', () => {
      const absPath = 'C:\\Users\\developer\\projects\\repo\\gemini-dashboard\\app\\page.tsx';
      const result = sanitizePath(absPath, mockRepoRoot);
      assert.strictEqual(result, 'gemini-dashboard/app/page.tsx');
    });

    void test('neutralizes path traversal attempts', () => {
      const traversal = '../../../../etc/passwd';
      const result = sanitizePath(traversal, mockRepoRoot);
      assert.strictEqual(result, 'etc/passwd');
      assert.ok(!result.includes('..'));
    });

    void test('redacts user home directory when path is outside repository', () => {
      const outside = 'C:\\Users\\admin\\Desktop\\sensitive-keys.json';
      const result = sanitizePath(outside, mockRepoRoot);
      assert.strictEqual(result, '~/Desktop/sensitive-keys.json');
      assert.ok(!result.includes('admin'));
    });

    void test('preserves clean relative paths and handles falsy inputs', () => {
      assert.strictEqual(sanitizePath('lib/workspace.ts'), 'lib/workspace.ts');
      assert.strictEqual(sanitizePath(''), '');
      assert.strictEqual(sanitizePath(null), '');
      assert.strictEqual(sanitizePath(undefined), '');
    });
  });

  void describe('sanitizeCommand', () => {
    void test('redacts CLI flags containing keys, tokens, and passwords', () => {
      const cmd = 'gemini-cli --api-key AIzaSyD9876543210123456789012345678901 --task "run"';
      const result = sanitizeCommand(cmd);
      assert.ok(!result.includes('AIzaSyD9876543210123456789012345678901'));
      assert.ok(result.includes('--api-key [REDACTED]'));
    });

    void test('redacts bearer tokens and secret environment assignments', () => {
      const cmd = 'env GEMINI_API_KEY=secret_val_123 node script.js';
      const result = sanitizeCommand(cmd);
      assert.ok(!result.includes('secret_val_123'));
      assert.ok(result.includes('KEY=[REDACTED]'));
    });

    void test('normalizes absolute paths to standard executables', () => {
      const cmd = 'C:\\Program Files\\nodejs\\npm.cmd --prefix gemini-dashboard test';
      const result = sanitizeCommand(cmd);
      assert.strictEqual(result, 'npm --prefix gemini-dashboard test');
    });

    void test('replaces repo root in command arguments with relative path', () => {
      const cmd = `node runner.js -Repository ${mockRepoRoot}`;
      const result = sanitizeCommand(cmd, mockRepoRoot);
      assert.strictEqual(result, 'node runner.js -Repository .');
    });
  });

  void describe('sanitizeText', () => {
    void test('redacts Google API keys and OpenAI tokens from log text', () => {
      const text = 'Failed calling API: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q and sk-abcdefghijklmnopqrstuvwxyz123456';
      const result = sanitizeText(text);
      assert.ok(!result.includes('AIzaSy'));
      assert.ok(!result.includes('sk-abcdef'));
      assert.ok(result.includes('[API_KEY_REDACTED]'));
      assert.ok(result.includes('[TOKEN_REDACTED]'));
    });

    void test('redacts repo root and user profile paths in stack traces', () => {
      const trace = `Error at ${mockRepoRoot}/lib/store.ts:45\n   at C:\\Users\\developer\\index.js`;
      const result = sanitizeText(trace, mockRepoRoot);
      assert.ok(!result.includes('developer'));
      assert.ok(!result.includes('C:/Users/developer/projects/repo'));
    });
  });

  void describe('sanitizeWorkerLog', () => {
    void test('sanitizes both string and object log entries', () => {
      const stringLog = sanitizeWorkerLog('Init with AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q');
      assert.ok(!stringLog.message.includes('AIzaSy'));
      assert.strictEqual(stringLog.type, 'log');

      const objectLog = sanitizeWorkerLog({
        timestamp: '12:00:00',
        message: 'Running at C:\\Users\\developer\\projects\\repo\\app.js',
        type: 'step',
      }, mockRepoRoot);
      assert.strictEqual(objectLog.timestamp, '12:00:00');
      assert.ok(!objectLog.message.includes('C:/Users/developer'));
    });
  });

  void describe('sanitizeWorkerData', () => {
    void test('completely strips absolute paths, secrets, and raw shell paths across all worker fields', () => {
      const rawWorker: LiveWorkerData = {
        runId: '20260909-test-01',
        taskId: 'TASK-001',
        task: `Fix bug at ${mockRepoRoot}/app/page.tsx`,
        model: 'gemini-3.8-flash-high',
        status: 'running',
        startedAt: '2026-09-09T12:00:00Z',
        updatedAt: '2026-09-09T12:01:00Z',
        elapsedSeconds: 60,
        changedFiles: [
          'C:\\Users\\developer\\projects\\repo\\gemini-dashboard\\app\\page.tsx',
          'C:\\Users\\developer\\projects\\repo\\gemini-dashboard\\package.json',
        ],
        recentLogs: [
          {
            timestamp: '12:00:30',
            message: 'Executing: npm --api-key supersecret123 test',
            type: 'step',
          },
        ],
        verification: {
          decision: 'PASS',
          commands: [
            {
              command: 'C:\\Program Files\\nodejs\\npm.cmd --prefix gemini-dashboard test',
              exitCode: 0,
              status: 'PASS',
              output: `All passed at ${mockRepoRoot}/tests`,
            },
          ],
        },
        policy: {
          allowedFiles: [
            'C:\\Users\\developer\\projects\\repo\\gemini-dashboard\\app\\page.tsx',
          ],
          violations: [],
          status: 'PASS',
        },
        finalResponse: 'All done. Secret: AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q',
        error: `Error at ${mockRepoRoot}\\index.ts`,
      };

      const sanitized = sanitizeWorkerData(rawWorker, mockRepoRoot);

      // Verify changedFiles are relative
      assert.deepStrictEqual(sanitized.changedFiles, [
        'gemini-dashboard/app/page.tsx',
        'gemini-dashboard/package.json',
      ]);

      // Verify task text is sanitized
      assert.ok(!sanitized.task.includes('developer'));

      // Verify logs redacted secret
      const firstLog = sanitized.recentLogs[0];
      const msg = typeof firstLog === 'string' ? firstLog : firstLog?.message || '';
      assert.ok(!msg.includes('supersecret123'));

      // Verify verification command is normalized
      assert.strictEqual(
        sanitized.verification?.commands?.[0].command,
        'npm --prefix gemini-dashboard test'
      );
      assert.ok(!sanitized.verification?.commands?.[0].output?.includes(mockRepoRoot));

      // Verify policy allowed files are relative
      assert.deepStrictEqual(sanitized.policy?.allowedFiles, [
        'gemini-dashboard/app/page.tsx',
      ]);

      // Verify finalResponse and error are redacted
      assert.ok(!sanitized.finalResponse?.includes('AIzaSy'));
      assert.ok(!sanitized.error?.includes(mockRepoRoot));
    });
  });
});