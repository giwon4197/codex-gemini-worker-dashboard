import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error TS5097 allowed for test runner
import { parseWorkerNDJSONLine, buildProjectWorkGraph, sortGraphNodesNewestFirst, sortGraphNodesOldestFirst, computeGraphLayoutGeometry, computeLaneX, computeNodeY, computeGraphSvgWidth, computeGraphSvgHeight, getLaneColor, GRAPH_LAYOUT_CONFIG, type ProjectGraphNode } from './project-event-graph.ts';
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

  void describe('Full-Graph Global Coordinate System & Continuity (Criteria 1, 2, 6)', () => {
    void test('computes global row coordinates and full canvas geometry without row boundary gaps', () => {
      const rowHeight = GRAPH_LAYOUT_CONFIG.rowHeight; // 52
      const laneWidth = GRAPH_LAYOUT_CONFIG.laneWidth; // 26
      const laneXOffset = GRAPH_LAYOUT_CONFIG.laneXOffset; // 14
      const nodeCenterYOffset = GRAPH_LAYOUT_CONFIG.nodeCenterYOffset; // 26

      const mockNodes: ProjectGraphNode[] = [
        { id: 'node-0', lane: 0, depth: 0, type: 'merge', owner: 'Orchestrator', label: 'Merge', status: 'completed' },
        { id: 'node-1', lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: 'Act 1', status: 'completed' },
        { id: 'node-2', lane: 2, depth: 2, type: 'activity', owner: 'Gemini', label: 'Act 2', status: 'completed' },
        { id: 'node-3', lane: 0, depth: 3, type: 'plan', owner: 'Codex', label: 'Plan', status: 'completed' },
        { id: 'node-4', lane: 0, depth: 4, type: 'request', owner: 'Codex', label: 'Request', status: 'completed' },
      ];

      const geometry = computeGraphLayoutGeometry(mockNodes);

      // 1. Total dimensions
      assert.strictEqual(geometry.nodes.length, 5);
      assert.strictEqual(geometry.height, computeGraphSvgHeight(5), 'Canvas height spans all rows exactly (5 * 52 = 260)');
      assert.strictEqual(geometry.width, computeGraphSvgWidth(3, laneWidth), 'Canvas width accounts for all lanes');

      // 2. Continuous row boundary coordinates without gaps
      for (let i = 0; i < mockNodes.length; i++) {
        const rowTop = i * rowHeight;
        const rowBottom = (i + 1) * rowHeight;
        const expectedCenterY = rowTop + nodeCenterYOffset;

        const layoutNode = geometry.nodes[i];
        assert.strictEqual(layoutNode.rowIndex, i);
        assert.strictEqual(layoutNode.y, expectedCenterY, `Node ${i} centerY must match rowIndex * 52 + 26`);
        assert.strictEqual(layoutNode.x, laneXOffset + layoutNode.lane * laneWidth);

        // Boundary continuity: bottom of row i equals top of row i+1
        if (i < mockNodes.length - 1) {
          const nextRowTop = (i + 1) * rowHeight;
          assert.strictEqual(rowBottom, nextRowTop, `Row ${i} bottom must equal Row ${i + 1} top (no gap)`);
        }
      }
    });

    void test('same-lane parent-child direct edges remain continuous across multiple intervening rows', () => {
      // Scenario: Worker 1 (Lane 1) has an activity at row 1, and its parent branch at row 4.
      // Rows 2 and 3 belong to Worker 2 (Lane 2).
      const mockNodes: ProjectGraphNode[] = [
        { id: 'node-top', lane: 0, depth: 0, type: 'merge', owner: 'Orchestrator', label: 'Merge', status: 'completed' },
        { id: 'w1-act', parentId: 'w1-branch', parentIds: ['w1-branch'], lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: 'W1 Act', status: 'completed' },
        { id: 'w2-act', lane: 2, depth: 2, type: 'activity', owner: 'Gemini', label: 'W2 Act', status: 'completed' },
        { id: 'w2-branch', lane: 2, depth: 3, type: 'worker_branch', owner: 'Gemini', label: 'W2 Branch', status: 'completed' },
        { id: 'w1-branch', lane: 1, depth: 4, type: 'worker_branch', owner: 'Gemini', label: 'W1 Branch', status: 'completed' },
        { id: 'plan', lane: 0, depth: 5, type: 'plan', owner: 'Codex', label: 'Plan', status: 'completed' },
      ];

      const geometry = computeGraphLayoutGeometry(mockNodes);

      // Find the direct edge from w1-branch (row 4) to w1-act (row 1)
      const directEdge = geometry.edges.find(e => e.fromNodeId === 'w1-branch' && e.toNodeId === 'w1-act');
      assert.ok(directEdge, 'Direct edge between same-lane parent and child across 2 intervening rows must exist');
      assert.strictEqual(directEdge.type, 'direct');
      assert.strictEqual(directEdge.fromLane, 1);
      assert.strictEqual(directEdge.toLane, 1);

      // Verify exact coordinates aligned with node centers
      const expectedX = computeLaneX(1); // 14 + 1 * 26 = 40
      const expectedFromY = computeNodeY(4); // 4 * 52 + 26 = 234
      const expectedToY = computeNodeY(1); // 1 * 52 + 26 = 78

      assert.strictEqual(directEdge.fromX, expectedX);
      assert.strictEqual(directEdge.toX, expectedX);
      assert.strictEqual(directEdge.fromY, expectedFromY);
      assert.strictEqual(directEdge.toY, expectedToY);

      // Single continuous vertical line spanning rows 1 through 4
      assert.strictEqual(directEdge.pathD, `M ${expectedX} ${expectedFromY} L ${expectedX} ${expectedToY}`);
      assert.strictEqual(directEdge.color, getLaneColor(1));

      // Verify that no duplicate pass-through segment is generated for Lane 1 between these connected nodes
      const duplicatePassThrough = geometry.passThroughSegments.find(
        p => p.lane === 1 && p.fromNodeId === 'w1-act' && p.toNodeId === 'w1-branch'
      );
      assert.strictEqual(duplicatePassThrough, undefined, 'Must not duplicate pass-through line underneath direct edge');
    });

    void test('cross-lane branch curves across multiple rows maintain continuous vertical tangents', () => {
      // Scenario: Plan (Lane 0) at row 5 branches to Worker 2 (Lane 2) at row 2.
      // Intervening rows 3 and 4 belong to other nodes.
      const mockNodes: ProjectGraphNode[] = [
        { id: 'merge', lane: 0, depth: 0, type: 'merge', owner: 'Orchestrator', label: 'Merge', status: 'completed' },
        { id: 'w1-tip', lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: 'W1 Tip', status: 'completed' },
        { id: 'w2-branch', parentId: 'plan', parentIds: ['plan'], lane: 2, depth: 2, type: 'worker_branch', owner: 'Gemini', label: 'W2 Branch', status: 'completed' },
        { id: 'w1-branch', parentId: 'plan', parentIds: ['plan'], lane: 1, depth: 3, type: 'worker_branch', owner: 'Gemini', label: 'W1 Branch', status: 'completed' },
        { id: 'intervening-node', lane: 1, depth: 4, type: 'activity', owner: 'Gemini', label: 'Intervening', status: 'completed' },
        { id: 'plan', lane: 0, depth: 5, type: 'plan', owner: 'Codex', label: 'Plan', status: 'completed' },
      ];

      const geometry = computeGraphLayoutGeometry(mockNodes);

      const branchEdge = geometry.edges.find(e => e.fromNodeId === 'plan' && e.toNodeId === 'w2-branch');
      assert.ok(branchEdge, 'Branch edge from plan to w2-branch across multiple rows must exist');
      assert.strictEqual(branchEdge.type, 'branch');
      assert.strictEqual(branchEdge.fromLane, 0);
      assert.strictEqual(branchEdge.toLane, 2);

      const expectedFromX = computeLaneX(0); // 14
      const expectedFromY = computeNodeY(5); // 5 * 52 + 26 = 286
      const expectedToX = computeLaneX(2); // 14 + 2 * 26 = 66
      const expectedToY = computeNodeY(2); // 2 * 52 + 26 = 130
      const expectedMidY = (expectedFromY + expectedToY) / 2; // (286 + 130) / 2 = 208

      assert.strictEqual(branchEdge.fromX, expectedFromX);
      assert.strictEqual(branchEdge.fromY, expectedFromY);
      assert.strictEqual(branchEdge.toX, expectedToX);
      assert.strictEqual(branchEdge.toY, expectedToY);

      // Smooth cubic bezier with vertical tangents at both endpoints
      assert.strictEqual(
        branchEdge.pathD,
        `M ${expectedFromX} ${expectedFromY} C ${expectedFromX} ${expectedMidY}, ${expectedToX} ${expectedMidY}, ${expectedToX} ${expectedToY}`
      );
      assert.strictEqual(branchEdge.color, getLaneColor(2), 'Branch curve takes worker lane color');
    });

    void test('cross-lane merge curves across multiple rows connect worker tips smoothly to Lane 0', () => {
      // Scenario: Merge node (Lane 0) at row 0 merges Worker 2 tip (Lane 2) at row 3.
      // Intervening rows 1 and 2 are present.
      const mockNodes: ProjectGraphNode[] = [
        {
          id: 'merge',
          parentIds: ['w1-tip', 'w2-tip'],
          lane: 0,
          depth: 0,
          type: 'merge',
          owner: 'Orchestrator',
          label: 'Merge',
          status: 'awaiting_review',
        },
        { id: 'w1-tip', lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: 'W1 Tip', status: 'completed' },
        { id: 'w1-prev', lane: 1, depth: 2, type: 'activity', owner: 'Gemini', label: 'W1 Prev', status: 'completed' },
        { id: 'w2-tip', lane: 2, depth: 3, type: 'activity', owner: 'Gemini', label: 'W2 Tip', status: 'completed' },
        { id: 'plan', lane: 0, depth: 4, type: 'plan', owner: 'Codex', label: 'Plan', status: 'completed' },
      ];

      const geometry = computeGraphLayoutGeometry(mockNodes);

      const mergeEdgeW2 = geometry.edges.find(e => e.fromNodeId === 'w2-tip' && e.toNodeId === 'merge');
      assert.ok(mergeEdgeW2, 'Merge edge from w2-tip to merge across 2 intervening rows must exist');
      assert.strictEqual(mergeEdgeW2.type, 'merge');
      assert.strictEqual(mergeEdgeW2.fromLane, 2);
      assert.strictEqual(mergeEdgeW2.toLane, 0);

      const expectedFromX = computeLaneX(2); // 66
      const expectedFromY = computeNodeY(3); // 3 * 52 + 26 = 182
      const expectedToX = computeLaneX(0); // 14
      const expectedToY = computeNodeY(0); // 0 * 52 + 26 = 26
      const expectedMidY = (expectedFromY + expectedToY) / 2; // (182 + 26) / 2 = 104

      assert.strictEqual(mergeEdgeW2.fromX, expectedFromX);
      assert.strictEqual(mergeEdgeW2.fromY, expectedFromY);
      assert.strictEqual(mergeEdgeW2.toX, expectedToX);
      assert.strictEqual(mergeEdgeW2.toY, expectedToY);

      // Smooth cubic bezier from worker tip up to merge node
      assert.strictEqual(
        mergeEdgeW2.pathD,
        `M ${expectedFromX} ${expectedFromY} C ${expectedFromX} ${expectedMidY}, ${expectedToX} ${expectedMidY}, ${expectedToX} ${expectedToY}`
      );
      assert.strictEqual(mergeEdgeW2.color, getLaneColor(2), 'Merge curve takes parent worker lane color');
    });

    void test('inactive-row pass-through lane segments connect node centers continuously across multiple rows', () => {
      // Scenario: Lane 0 has merge at row 0 and plan at row 5.
      // Rows 1..4 have worker nodes in lanes 1 and 2, but NO nodes in Lane 0.
      // Merge does NOT have plan as parent (its parents are worker tips).
      const mockNodes: ProjectGraphNode[] = [
        {
          id: 'merge',
          parentIds: ['w1-tip'],
          lane: 0,
          depth: 0,
          type: 'merge',
          owner: 'Orchestrator',
          label: 'Merge',
          status: 'awaiting_review',
        },
        { id: 'w1-tip', lane: 1, depth: 1, type: 'activity', owner: 'Gemini', label: 'W1 Tip', status: 'completed' },
        { id: 'w2-tip', lane: 2, depth: 2, type: 'activity', owner: 'Gemini', label: 'W2 Tip', status: 'completed' },
        { id: 'w1-branch', lane: 1, depth: 3, type: 'worker_branch', owner: 'Gemini', label: 'W1 Branch', status: 'completed' },
        { id: 'w2-branch', lane: 2, depth: 4, type: 'worker_branch', owner: 'Gemini', label: 'W2 Branch', status: 'completed' },
        { id: 'plan', parentIds: ['request'], lane: 0, depth: 5, type: 'plan', owner: 'Codex', label: 'Plan', status: 'completed' },
        { id: 'request', lane: 0, depth: 6, type: 'request', owner: 'Codex', label: 'Request', status: 'completed' },
      ];

      const geometry = computeGraphLayoutGeometry(mockNodes);

      // Verify pass-through segment on Lane 0
      const passSegmentLane0 = geometry.passThroughSegments.find(p => p.lane === 0);
      assert.ok(passSegmentLane0, 'Pass-through segment must exist for Lane 0 across inactive rows 1..4');
      assert.strictEqual(passSegmentLane0.fromNodeId, 'merge');
      assert.strictEqual(passSegmentLane0.toNodeId, 'plan');
      assert.strictEqual(passSegmentLane0.fromRowIndex, 0);
      assert.strictEqual(passSegmentLane0.toRowIndex, 5);

      // Verify exact alignment with node centers
      const expectedX = computeLaneX(0); // 14
      const expectedFromY = computeNodeY(0); // 26
      const expectedToY = computeNodeY(5); // 5 * 52 + 26 = 286

      assert.strictEqual(passSegmentLane0.x, expectedX);
      assert.strictEqual(passSegmentLane0.fromY, expectedFromY);
      assert.strictEqual(passSegmentLane0.toY, expectedToY);
      assert.strictEqual(passSegmentLane0.color, getLaneColor(0));

      // Verify that plan and request (connected by direct edge) do NOT have a duplicate pass-through segment
      const planRequestPass = geometry.passThroughSegments.find(
        p => p.lane === 0 && p.fromNodeId === 'plan' && p.toNodeId === 'request'
      );
      assert.strictEqual(planRequestPass, undefined, 'Plan and Request are connected by direct edge, no pass-through needed');
    });

    void test('computes layout geometry end-to-end from buildProjectWorkGraph output', () => {
      const runId = '20260910-layout-integration-01';
      const graph = buildProjectWorkGraph({
        runId,
        prompt: 'Full DAG layout geometry test',
        status: 'awaiting_review',
        tasks: [
          { id: 'TASK-001', name: 'Task 1' },
          { id: 'TASK-002', name: 'Task 2' },
        ],
        workers: [
          {
            runId,
            taskId: 'TASK-001',
            task: 'Task 1',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:00Z',
            updatedAt: '2026-09-10T02:02:00Z',
            elapsedSeconds: 120,
            recentLogs: [],
          },
          {
            runId,
            taskId: 'TASK-002',
            task: 'Task 2',
            model: 'gemini-3.8-flash-high',
            status: 'completed',
            startedAt: '2026-09-10T02:00:10Z',
            updatedAt: '2026-09-10T02:03:00Z',
            elapsedSeconds: 170,
            recentLogs: [],
          },
        ],
        eventsByTask: {
          'TASK-001': [
            JSON.stringify({ activity: 'LOAD', file: 'a.ts', timestamp: '2026-09-10T02:00:20Z' }),
            JSON.stringify({ activity: 'DONE', timestamp: '2026-09-10T02:01:50Z' }),
          ],
          'TASK-002': [
            JSON.stringify({ activity: 'EDIT', file: 'b.ts', timestamp: '2026-09-10T02:00:30Z' }),
            JSON.stringify({ activity: 'DONE', timestamp: '2026-09-10T02:02:50Z' }),
          ],
        },
        integration: {
          id: `${runId}:integration`,
          branch: `integration/${runId}`,
          decision: 'AWAITING_CODEX_REVIEW',
        },
      });

      // Compute layout geometry directly from the graph data contract
      const geometry = computeGraphLayoutGeometry(graph);

      assert.strictEqual(geometry.nodes.length, graph.nodes.length);
      assert.strictEqual(geometry.height, graph.nodes.length * GRAPH_LAYOUT_CONFIG.rowHeight);
      assert.ok(geometry.width > 0);
      assert.ok(geometry.edges.length > 0);

      // Verify all edges and pass-through segments have valid coordinates within canvas bounds
      for (const edge of geometry.edges) {
        assert.ok(edge.fromX >= 0 && edge.fromX <= geometry.width);
        assert.ok(edge.toX >= 0 && edge.toX <= geometry.width);
        assert.ok(edge.fromY >= 0 && edge.fromY <= geometry.height);
        assert.ok(edge.toY >= 0 && edge.toY <= geometry.height);
        assert.ok(edge.fromY >= edge.toY, 'In display order, parent Y must be >= child Y');
        assert.ok(edge.pathD.startsWith('M '));
      }

      for (const seg of geometry.passThroughSegments) {
        assert.ok(seg.x >= 0 && seg.x <= geometry.width);
        assert.ok(seg.fromY >= 0 && seg.fromY <= geometry.height);
        assert.ok(seg.toY >= 0 && seg.toY <= geometry.height);
        assert.ok(seg.toY > seg.fromY, 'Pass-through segment must span downward from upper to lower node');
      }

      // Verify graph tip is correctly positioned at row 0 (merge node)
      const tipNode = geometry.nodes.find(n => n.isTip);
      assert.ok(tipNode);
      assert.strictEqual(tipNode.rowIndex, 0);
      assert.strictEqual(tipNode.lane, 0);
      assert.strictEqual(tipNode.y, computeNodeY(0));
    });
  });
});
