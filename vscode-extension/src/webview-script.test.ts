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

/**
 * The inline script and the HTML it drives sit in the same template literal, so a
 * renamed or removed element leaves a `getElementById` returning null and the
 * feature silently dead. Parsing alone does not catch that.
 */
void test('every element the webview script looks up exists in its markup', () => {
  for (const view of VIEWS) {
    const source = fs.readFileSync(path.join(process.cwd(), view), 'utf8');
    const declared = new Set(
      [...source.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map(match => match[1])
    );
    const looked = [...source.matchAll(/getElementById\('([^']+)'\)/g)].map(match => match[1]);
    assert.ok(looked.length > 0, `${view}: no getElementById calls found`);
    for (const id of looked) {
      assert.ok(declared.has(id), `${view}: getElementById('${id}') has no matching id in the markup`);
    }
  }
});

void test('auth onboarding and both model selectors keep their compact accessible contract', () => {
  const source = fs.readFileSync(path.join(process.cwd(), VIEWS[0]), 'utf8');
  for (const id of [
    'authOnboarding',
    'codexAuthText',
    'geminiAuthText',
    'authRefresh',
    'codexLogin',
    'geminiLogin',
    'codexModel',
    'geminiTier',
  ]) {
    assert.match(source, new RegExp(`id="${id}"`));
  }
  assert.match(source, /계획, 대화 및 검토에 사용하는 모델/);
  assert.match(source, /승인 후 실제 코드를 구현하는 Worker 모델/);
  assert.match(source, /현재 Run이 끝난 뒤 변경할 수 있습니다/);
  assert.match(source, /flex-wrap: wrap/);
});
