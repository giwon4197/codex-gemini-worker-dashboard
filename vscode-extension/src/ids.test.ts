import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COMMANDS, CONVERSATION_VIEW_ID, VIEW_CONTAINER_ID } from './ids.ts';

void test('package.json command and view ids match the extension constants', () => {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    contributes: {
      viewsContainers: { secondarySidebar: Array<{ id: string }> };
      views: Record<string, Array<{ id: string }>>;
      commands: Array<{ command: string }>;
    };
  };
  assert.equal(pkg.contributes.viewsContainers.secondarySidebar[0].id, VIEW_CONTAINER_ID);
  const viewIds = pkg.contributes.views[VIEW_CONTAINER_ID].map(view => view.id);
  assert.deepEqual(viewIds, [CONVERSATION_VIEW_ID]);
  const commands = pkg.contributes.commands.map(item => item.command);
  assert.deepEqual(commands.sort(), Object.values(COMMANDS).slice().sort());
});
