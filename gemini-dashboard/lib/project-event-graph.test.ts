import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { parseWorkerNDJSONLine, buildProjectWorkGraph, sortGraphNodesNewestFirst, sortGraphNodesOldestFirst } from './project-event-graph.ts';
// @ts-expect-error TS5097 allowed for test runner
import { sanitizeGraphData } from './workspace-sanitize.ts';

void describe('Project Work Graph & Defensive NDJSON Parser', () => {
  void describe('Defensive NDJSON Parsing (Criterion 4 & 5)', () => {
    void test('defensively parses explicit supported activities: LOAD, SEARCH, EDIT, SAVE, RUN, PASS, FAIL, DONE', () => {
      const activities = ['LOAD', 'SEARCH', 'EDIT', 'SAVE', 'RUN', 'PASS', 'FAIL', 'DONE'] as const;

      for (const act of activities) {
        const line = JSON.stringify({
          id: `evt-${act.toLowerCase()}`,
          parentId: 'evt-root',
          timestamp: '2026-09-10T02:00:00Z',
          activity: act,
          file: 'lib/workspace-store.ts',
          command: act === 'RUN' ? 'npm test' : undefined,
          message: `Testing ${act}`,
        });

        const parsed = parseWorkerNDJSONLine(line);
        assert.ok(parsed, `Expected ${act} to be parsed`);
        assert.strictEqual(parsed.activity, act);
        assert.strictEqual(parsed.id, `evt-${act.toLowerCase()}`);
        assert.strictEqual(parsed.parentId, 'evt-root');
        assert.strictEqual(parsed.file, 'lib/workspace-store.ts');
        if (act === 'RUN') {
          assert.strictEqual(parsed.command, 'npm test');
        }
      }
    });

    void test('maps tool calls defensively to supported activities', () => {
      // 1. view_file -> LOAD
      const loadLine = JSON.stringify({
        type: 'tool',
        message: '도구 호출: view_file',
        file: 'lib/workspace-contract.ts',
      });
      const parsedLoad = parseWorkerNDJSONLine(loadLine);
      assert.ok(parsedLoad);
      assert.strictEqual(parsedLoad.activity, 'LOAD');
      assert.strictEqual(parsedLoad.file, 'lib/workspace-contract.ts');

      // 2. grep_search -> SEARCH
      const searchLine = JSON.stringify({
        type: 'tool',
        message: '도구 호출: grep_search',
        SearchPath: 'lib/workspace-store.ts',
      });
      const parsedSearch = parseWorkerNDJSONLine(searchLine);
      assert.ok(parsedSearch);
      assert.strictEqual(parsedSearch.activity, 'SEARCH');
      assert.strictEqual(parsedSearch.file, 'lib/workspace-store.ts');

      // 3. replace_file_content -> EDIT
      const editLine = JSON.stringify({
        type: 'tool',
        message: '도구 호출: replace_file_content',
        TargetFile: 'components/project-work-graph.tsx',
      });
      const parsedEdit = parseWorkerNDJSONLine(editLine);
      assert.ok(parsedEdit);
      assert.strictEqual(parsedEdit.activity, 'EDIT');
      assert.strictEqual(parsedEdit.file, 'components/project-work-graph.tsx');

      // 4. write_to_file -> SAVE
      const saveLine = JSON.stringify({
        type: 'tool',
        message: '도구 호출: write_to_file',
        TargetFile: 'components/project-event-detail.tsx',
      });
      const parsedSave = parseWorkerNDJSONLine(saveLine);
      assert.ok(parsedSave);
      assert.strictEqual(parsedSave.activity, 'SAVE');
      assert.strictEqual(parsedSave.file, 'components/project-event-detail.tsx');

      // 5. run_command -> RUN
      const runLine = JSON.stringify({
        type: 'tool',
        message: '도구 호출: run_command',
        CommandLine: 'npm test',
      });
      const parsedRun = parseWorkerNDJSONLine(runLine);
      assert.ok(parsedRun);
      assert.strictEqual(parsedRun.activity, 'RUN');
      assert.strictEqual(parsedRun.command, 'npm test');
    });

    void test('maps verification and result outcomes to PASS, FAIL, DONE', () => {
      // PASS
      const passLine = JSON.stringify({
        type: 'verification',
        status: 'PASS',
        message: '검증 실행: PASS (npm test)',
      });
      assert.strictEqual(parseWorkerNDJSONLine(passLine)?.activity, 'PASS');

      // FAIL
      const failLine = JSON.stringify({
        type: 'verification',
        status: 'FAIL',
        message: '검증 실행: FAIL (npm test)',
      });
      assert.strictEqual(parseWorkerNDJSONLine(failLine)?.activity, 'FAIL');

      // DONE
      const doneLine = JSON.stringify({
        type: 'system',
        message: '작업 종료: 상태=completed, 소요시간=12초, 종료코드=0',
      });
      assert.strictEqual(parseWorkerNDJSONLine(doneLine)?.activity, 'DONE');
    });

    void test('file activity is shown only when a real record supplies it, never synthesized', () => {
      const lineWithoutFile = JSON.stringify({
        type: 'tool',
        message: '도구 호출: run_command',
        CommandLine: 'git status',
      });
      const parsed = parseWorkerNDJSONLine(lineWithoutFile);
      assert.ok(parsed);
      assert.strictEqual(parsed.file, undefined, 'Must not synthesize file activity when absent');
    });

    void test('safely ignores malformed JSON and unknown non-activity events', () => {
      // 1. Broken JSON strings
      assert.strictEqual(parseWorkerNDJSONLine(''), null);
      assert.strictEqual(parseWorkerNDJSONLine('   '), null);
      assert.strictEqual(parseWorkerNDJSONLine('not json'), null);
      assert.strictEqual(parseWorkerNDJSONLine('{ broken json'), null);
      assert.strictEqual(parseWorkerNDJSONLine('null'), null);

      // 2. Unknown / non-activity raw events (e.g. system heartbeat, unknown type)
      const unknownLine = JSON.stringify({
        type: 'heartbeat',
        message: 'ping',
      });
      assert.strictEqual(parseWorkerNDJSONLine(unknownLine), null);

      const arbitraryLine = JSON.stringify({
        event: 'random_telemetry',
        data: 123,
      });
      assert.strictEqual(parseWorkerNDJSONLine(arbitraryLine), null);
    });
  });

  void describe('Graph Construction & Visual Studio Git Graph Layout (Criterion 1, 2, 3, 7)', () => {
    void test('constructs deterministic DAG: request -> plan -> worker branches -> integration merge', () => {
      const runId = '20260910-test-run-01';
      const prompt = '실시간 프로젝트 작업 그래프 구현';

      const graph = buildProjectWorkGraph({
        runId,
        prompt,
        status: 'awaiting_review',
        createdAt: '2026-09-10T02:00:00Z',
        updatedAt: '2026-09-10T02:05:00Z',
        tasks: [
          {
            id: 'TASK-001',
            name: '작업 그래프 UI 및 파서 구현',
            prompt: '그래프 및 파서 작성',
            allowedFiles: ['lib/project-event-graph.ts'],
          },
          {
            id: 'TASK-002',
            name: '검증 테스트 작성',
            prompt: '단위 테스트 작성',
            allowedFiles: ['lib/project-event-graph.test.ts'],
          },
        ],
        workers: [
          {
            runId,
            taskId: 'TASK-001',
            task: '작업 그래프 UI 및 파서 구현',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:10Z',
            updatedAt: '2026-09-10T02:03:00Z',
            elapsedSeconds: 170,
            recentLogs: [],
            changedFiles: ['lib/project-event-graph.ts'],
          },
          {
            runId,
            taskId: 'TASK-002',
            task: '검증 테스트 작성',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:15Z',
            updatedAt: '2026-09-10T02:04:00Z',
            elapsedSeconds: 225,
            recentLogs: [],
            changedFiles: ['lib/project-event-graph.test.ts'],
          },
        ],
        eventsByTask: {
          'TASK-001': [
            JSON.stringify({
              id: `${runId}:TASK-001:act-1`,
              parentId: `${runId}:TASK-001:branch`,
              activity: 'LOAD',
              file: 'lib/workspace-contract.ts',
              timestamp: '2026-09-10T02:00:30Z',
            }),
            JSON.stringify({
              id: `${runId}:TASK-001:act-2`,
              parentId: `${runId}:TASK-001:act-1`,
              activity: 'EDIT',
              file: 'lib/project-event-graph.ts',
              timestamp: '2026-09-10T02:01:00Z',
            }),
            JSON.stringify({
              id: `${runId}:TASK-001:act-3`,
              parentId: `${runId}:TASK-001:act-2`,
              activity: 'DONE',
              timestamp: '2026-09-10T02:02:50Z',
            }),
          ],
          'TASK-002': [
            JSON.stringify({
              id: `${runId}:TASK-002:act-1`,
              parentId: `${runId}:TASK-002:branch`,
              activity: 'LOAD',
              file: 'lib/project-event-graph.ts',
              timestamp: '2026-09-10T02:00:45Z',
            }),
            JSON.stringify({
              id: `${runId}:TASK-002:act-2`,
              parentId: `${runId}:TASK-002:act-1`,
              activity: 'SAVE',
              file: 'lib/project-event-graph.test.ts',
              timestamp: '2026-09-10T02:01:30Z',
            }),
            JSON.stringify({
              id: `${runId}:TASK-002:act-3`,
              parentId: `${runId}:TASK-002:act-2`,
              activity: 'DONE',
              timestamp: '2026-09-10T02:03:50Z',
            }),
          ],
        },
        integration: {
          id: `${runId}:integration`,
          branch: `integration/${runId}`,
          decision: 'AWAITING_CODEX_REVIEW',
          changedFiles: ['lib/project-event-graph.ts', 'lib/project-event-graph.test.ts'],
          tests: [
            {
              command: 'npm test',
              status: 'PASS',
              exitCode: 0,
            },
          ],
          startedAt: '2026-09-10T02:04:10Z',
          updatedAt: '2026-09-10T02:05:00Z',
        },
      });

      // 1. Verify Request node
      const reqNode = graph.nodes.find(n => n.type === 'request');
      assert.ok(reqNode);
      assert.strictEqual(reqNode.owner, 'Codex');
      assert.strictEqual(reqNode.lane, 0);
      assert.strictEqual(reqNode.instruction, prompt);

      // 2. Verify Plan node
      const planNode = graph.nodes.find(n => n.type === 'plan');
      assert.ok(planNode);
      assert.strictEqual(planNode.owner, 'Codex');
      assert.strictEqual(planNode.lane, 0);
      assert.strictEqual(planNode.parentId, reqNode.id);

      // 3. Verify Worker branches (TASK-001 -> Lane 1, TASK-002 -> Lane 2)
      const branch1 = graph.nodes.find(n => n.id === `${runId}:TASK-001:branch`);
      const branch2 = graph.nodes.find(n => n.id === `${runId}:TASK-002:branch`);
      assert.ok(branch1);
      assert.ok(branch2);
      assert.strictEqual(branch1.lane, 1);
      assert.strictEqual(branch2.lane, 2);
      assert.strictEqual(branch1.owner, 'Gemini');
      assert.strictEqual(branch2.owner, 'Gemini');
      assert.strictEqual(branch1.parentId, planNode.id);
      assert.strictEqual(branch2.parentId, planNode.id);

      // 4. Verify Chained Activities
      const act1 = graph.nodes.find(n => n.id === `${runId}:TASK-001:act-1`);
      const act2 = graph.nodes.find(n => n.id === `${runId}:TASK-001:act-2`);
      const act3 = graph.nodes.find(n => n.id === `${runId}:TASK-001:act-3`);
      assert.ok(act1 && act2 && act3);
      assert.strictEqual(act1.activity, 'LOAD');
      assert.strictEqual(act2.activity, 'EDIT');
      assert.strictEqual(act3.activity, 'DONE');
      assert.strictEqual(act1.parentId, branch1.id);
      assert.strictEqual(act2.parentId, act1.id);
      assert.strictEqual(act3.parentId, act2.id);
      assert.strictEqual(act2.files?.[0], 'lib/project-event-graph.ts');

      // 5. Verify Integration Merge Node
      const mergeNode = graph.nodes.find(n => n.type === 'merge');
      assert.ok(mergeNode);
      assert.strictEqual(mergeNode.owner, 'Orchestrator');
      assert.strictEqual(mergeNode.lane, 0);
      assert.strictEqual(mergeNode.status, 'awaiting_review');
      assert.ok(mergeNode.parentIds?.includes(`${runId}:TASK-001:act-3`));
      assert.ok(mergeNode.parentIds?.includes(`${runId}:TASK-002:act-3`));
      assert.strictEqual(mergeNode.files?.length, 2);

      // 6. Verify Edges
      const mergeEdges = graph.edges.filter(e => e.type === 'merge');
      assert.strictEqual(mergeEdges.length, 2, 'Merge edges from both worker tips to Lane 0');
      assert.strictEqual(mergeEdges[0].to, mergeNode.id);
      assert.strictEqual(mergeEdges[0].toLane, 0);

      // 7. Verify Graph Tip
      assert.strictEqual(graph.tips.length, 1);
      assert.strictEqual(graph.tips[0].id, mergeNode.id);
      assert.strictEqual(graph.tips[0].owner, 'Orchestrator');
      assert.strictEqual(graph.tips[0].status, 'awaiting_review');
      assert.ok(graph.tips[0].startedAt);
      assert.ok(graph.tips[0].isTip);
    });

    void test('tracks separate active worker tips when integration has not yet occurred', () => {
      const runId = '20260910-active-workers-01';
      const graph = buildProjectWorkGraph({
        runId,
        prompt: '워커 진행 중',
        status: 'running',
        tasks: [
          { id: 'TASK-001', name: '작업 1' },
          { id: 'TASK-002', name: '작업 2' },
        ],
        workers: [
          {
            runId,
            taskId: 'TASK-001',
            task: '작업 1',
            model: 'gemini-3.8-flash-high',
            status: 'running',
            startedAt: '2026-09-10T02:00:00Z',
            updatedAt: '2026-09-10T02:01:00Z',
            elapsedSeconds: 60,
            recentLogs: [],
          },
          {
            runId,
            taskId: 'TASK-002',
            task: '작업 2',
            model: 'gemini-3.8-flash-high',
            status: 'running',
            startedAt: '2026-09-10T02:00:10Z',
            updatedAt: '2026-09-10T02:01:10Z',
            elapsedSeconds: 60,
            recentLogs: [],
          },
        ],
        // No integration review yet
        integration: null,
      });

      // Tips should be both active workers
      assert.strictEqual(graph.tips.length, 2);
      const tipOwners = graph.tips.map(t => t.owner);
      assert.deepStrictEqual(tipOwners, ['Gemini', 'Gemini']);
      for (const tip of graph.tips) {
        assert.strictEqual(tip.status, 'running');
        assert.strictEqual(tip.elapsedSeconds, 60);
        assert.ok(tip.startedAt);
        assert.strictEqual(tip.isTip, true);
      }
    });

    void test('sortGraphNodesNewestFirst orders newest events upward at the top', () => {
      const runId = '20260910-ordering-test';
      const graph = buildProjectWorkGraph({
        runId,
        prompt: '정렬 검증',
        status: 'completed',
        tasks: [{ id: 'TASK-001', name: '정렬 작업' }],
        workers: [
          {
            runId,
            taskId: 'TASK-001',
            task: '정렬 작업',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:00Z',
            updatedAt: '2026-09-10T02:01:00Z',
            elapsedSeconds: 60,
            recentLogs: [],
          },
        ],
        integration: {
          id: `${runId}:integration`,
          branch: 'integration/test',
          decision: 'PASS',
        },
      });

      const chronological = sortGraphNodesOldestFirst(graph.nodes);
      assert.strictEqual(chronological[0].type, 'request', 'Bottom / first is request');
      assert.strictEqual(chronological[chronological.length - 1].type, 'merge', 'Top / last is merge');

      const newestFirst = sortGraphNodesNewestFirst(graph.nodes);
      assert.strictEqual(newestFirst[0].type, 'merge', 'Visual top is newest event (merge)');
      assert.strictEqual(newestFirst[newestFirst.length - 1].type, 'request', 'Visual bottom is oldest event (request)');
    });

    void test('sanitizes secrets and user home paths in graph metadata, instructions, and command outputs', () => {
      const runId = '20260910-sanitize-test';
      const rawGraph = buildProjectWorkGraph({
        runId,
        prompt: 'API 키 AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q 및 sk-12345678901234567890abc 노출 검사',
        status: 'completed',
        tasks: [
          {
            id: 'TASK-001',
            name: 'C:\\Users\\giwon\\workspace\\secret.ts 수정',
            prompt: '비밀 토큰 Bearer eyJhbGciOiJIUzI1NiJ9.test 사용',
          },
        ],
        workers: [
          {
            runId,
            taskId: 'TASK-001',
            task: '작업',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:00Z',
            updatedAt: '2026-09-10T02:01:00Z',
            elapsedSeconds: 60,
            recentLogs: [],
            changedFiles: ['C:\\Users\\giwon\\workspace\\lib\\secret.ts'],
            verification: {
              commands: [
                {
                  command: 'powershell.exe --api-key my-secret-api-key -file run.ps1',
                  exitCode: 0,
                  output: 'Loaded C:/Users/giwon/workspace/lib/secret.ts with AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q',
                  status: 'PASS',
                },
              ],
            },
          },
        ],
      });

      const sanitized = sanitizeGraphData(rawGraph, 'C:/Users/giwon/workspace');

      // 1. Secrets masked in prompt
      assert.ok(!sanitized.prompt.includes('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'));
      assert.ok(!sanitized.prompt.includes('sk-12345678901234567890abc'));
      assert.ok(sanitized.prompt.includes('[API_KEY_REDACTED]'));
      assert.ok(sanitized.prompt.includes('[TOKEN_REDACTED]'));

      // 2. User home absolute path sanitized
      const workerNode = sanitized.nodes.find(n => n.taskId === 'TASK-001');
      assert.ok(workerNode);
      assert.ok(!workerNode.files?.[0].includes('C:/Users/giwon'));
      assert.ok(!workerNode.files?.[0].includes('C:\\Users\\giwon'));

      // 3. Command and output sanitized
      const vNode = sanitized.nodes.find(n => n.type === 'verification');
      assert.ok(vNode);
      const vCmd = vNode.verificationCommands?.[0];
      assert.ok(vCmd);
      assert.ok(!vCmd.command.includes('my-secret-api-key'));
      assert.ok(!vCmd.output?.includes('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'));
      assert.ok(!vCmd.output?.includes('C:/Users/giwon'));
    });
  });
});
