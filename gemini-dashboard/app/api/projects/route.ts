import path from 'node:path';
// @ts-expect-error TS5097 allowed for test runner
import { getAllowedRepoRoot, listCompactRuns } from '../../../lib/workspace-store.ts';

export async function GET(): Promise<Response> {
  try {
    const repoRoot = getAllowedRepoRoot();
    const repoName = path.basename(repoRoot) || 'codex-gemini-worker-dashboard';
    const runs = await listCompactRuns(repoRoot);

    const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'planning');
    const totalActiveWorkers = runs.reduce((sum, r) => sum + (r.activeWorkersCount || 0), 0);
    const lastRunAt = runs[0]?.createdAt;

    const projects = [
      {
        id: 'current',
        name: repoName,
        repositoryPath: repoName,
        activeRunsCount: activeRuns.length,
        activeWorkersCount: totalActiveWorkers,
        lastRunAt,
      },
    ];

    return Response.json({ ok: true, projects });
  } catch {
    return Response.json(
      { ok: false, error: '프로젝트 정보를 불러오지 못했습니다.' },
      { status: 500 }
    );
  }
}