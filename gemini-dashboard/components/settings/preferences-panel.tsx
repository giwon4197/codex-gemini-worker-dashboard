'use client';

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';

import type {
  WorkerMemorySettings,
  WorkerPreferenceKey,
} from '../../lib/worker-settings';
import type { WorkspaceResumeCandidate } from '../../lib/workspace-contract';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Switch } from '../ui/switch';

const enumPreferences = [
  {
    key: 'responseLanguage',
    label: '응답 언어',
    options: [
      ['auto', '자동'],
      ['ko', '한국어'],
      ['en', '영어'],
    ],
  },
  {
    key: 'explanationDetail',
    label: '설명 상세도',
    options: [
      ['concise', '간결'],
      ['balanced', '균형'],
      ['detailed', '상세'],
    ],
  },
  {
    key: 'planPresentation',
    label: '계획 표현',
    options: [
      ['concise', '간결'],
      ['step_by_step', '단계별'],
      ['risk_focused', '위험 중심'],
    ],
  },
] as const;

const booleanPreferences = [
  ['preferTargetedTests', 'Targeted test 우선 표시'],
  ['completionNotifications', '완료 알림'],
] as const;

export function PreferencesPanel() {
  const [memory, setMemory] = useState<WorkerMemorySettings | null>(null);
  const [candidate, setCandidate] = useState<WorkspaceResumeCandidate | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [memoryResponse, candidateResponse] = await Promise.all([
        fetch('/api/settings/memory', { cache: 'no-store' }),
        fetch('/api/workspace/resume-candidate', { cache: 'no-store' }),
      ]);
      const memoryBody = await memoryResponse.json();
      const candidateBody = await candidateResponse.json();
      if (!memoryResponse.ok || !memoryBody.ok) throw new Error(memoryBody.error);
      setMemory(memoryBody.memory);
      if (candidateResponse.ok && candidateBody.ok) {
        setCandidate(candidateBody.candidate);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '설정을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (body?: Record<string, unknown>, reset = false) => {
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/settings/memory', {
        method: reset ? 'DELETE' : 'PATCH',
        headers: reset ? undefined : { 'Content-Type': 'application/json' },
        body: reset ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error);
      setMemory(result.memory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '설정을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const remove = (key: WorkerPreferenceKey) =>
    mutate({ operation: 'deletePreference', key });

  if (!memory) {
    return <div className="p-8 text-sm text-muted-foreground">설정을 불러오는 중입니다.</div>;
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6 lg:p-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">메모리 설정</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          명시적으로 확인한 표시 선호만 저장하며 실행 정책에는 적용하지 않습니다.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>선호 메모리</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Gate, Risk Floor, 파일 범위와 검증 정책은 변경되지 않습니다.</p>
          </div>
          <Switch
            aria-label="선호 메모리 활성화"
            checked={memory.enabled}
            disabled={saving}
            onCheckedChange={enabled => void mutate({ operation: 'setEnabled', enabled })}
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {enumPreferences.map(preference => {
            const record = memory.preferences[preference.key];
            return (
              <div key={preference.key} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">{preference.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {record ? `명시적 사용자 · 확인됨 · ${new Date(record.updatedAt).toLocaleString('ko-KR')}` : '저장되지 않음'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={preference.label}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={record?.value ?? ''}
                    disabled={saving || !memory.enabled}
                    onChange={event => {
                      if (event.target.value) {
                        void mutate({ operation: 'setPreference', key: preference.key, value: event.target.value });
                      }
                    }}
                  >
                    <option value="">선택 안 함</option>
                    {preference.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <Button variant="ghost" size="icon" aria-label={`${preference.label} 삭제`} disabled={!record || saving} onClick={() => void remove(preference.key)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}

          {booleanPreferences.map(([key, label]) => {
            const record = memory.preferences[key];
            return (
              <div key={key} className="flex items-center justify-between rounded-lg border p-4">
                <div>
                  <div className="font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{record ? '명시적 사용자 · 확인됨' : '저장되지 않음'}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    aria-label={label}
                    checked={record?.value ?? false}
                    disabled={saving || !memory.enabled}
                    onCheckedChange={value => void mutate({ operation: 'setPreference', key, value })}
                  />
                  <Button variant="ghost" size="icon" aria-label={`${label} 삭제`} disabled={!record || saving} onClick={() => void remove(key)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}

          <Button variant="outline" disabled={saving || Object.keys(memory.preferences).length === 0} onClick={() => {
            if (window.confirm('저장된 선호를 모두 삭제할까요?')) void mutate(undefined, true);
          }}>
            <RotateCcw className="mr-2 h-4 w-4" />
            선호 초기화
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>작업 재개 후보</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">기존 상태에서 계산한 비권위 제안입니다. 자동 복구하거나 상태를 저장하지 않습니다.</p>
          <div className="rounded-lg border bg-muted/30 p-4 font-mono text-xs">
            {candidate?.reason === 'none' || !candidate ? '재개할 후보가 없습니다.' : (
              <>
                <div>reason: {candidate.reason}</div>
                {candidate.session && <div>session: {candidate.session.sessionId}</div>}
                {candidate.run && <div>run: {candidate.run.runId} ({candidate.run.status})</div>}
                <div>authoritative: false</div>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
