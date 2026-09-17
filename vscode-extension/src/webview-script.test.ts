import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const VIEWS = ['src/webview/conversation-view.ts'];

/**
 * The webview HTML lives in a template literal, so TypeScript resolves escapes
 * at build time: a bare '\n' reaches the browser as a real newline and breaks
 * the whole inline script, leaving every button silently unwired.
 */
void test('webview inline scripts still parse after template-literal escaping', () => {
  for (const view of VIEWS) {
    const source = fs.readFileSync(path.join(process.cwd(), view), 'utf8');
    const body = source.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(body, `${view}: inline script not found`);
    const emitted = new Function(`return \`${body}\`;`)() as string;
    assert.doesNotThrow(
      () => new Function(emitted),
      `${view}: emitted webview script does not parse`
    );
  }
});
