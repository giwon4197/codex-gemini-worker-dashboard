# Gemini LOAD 정체 및 로컬 실행 오류 인수인계

## 인계 목적

이 문서는 v2.1 ver3가 `main`에 병합된 직후 발견된 Gemini `LOAD` 정체 가능성, 보호 파일 정책으로 인한 자기수정 차단, 한글 경로 백그라운드 실행 실패와 대시보드 미실행 문제를 다음 작업자가 이어서 진단·수정할 수 있도록 기록한다.

이 문서 작성 시점에는 **진단과 재현만 수행했으며 소스 코드는 수정하지 않았다.**

## Git 기준선

- 저장소: `giwon4197/codex-gemini-worker-dashboard`
- 기준 브랜치: `main`
- 기준 커밋: `18e1d0a75f57dd0608719568c0ae0679a096006e`
- 기준 내용: `Merge branch 'hjw-v2.1-ver3'`
- 진단용 로컬 브랜치: `codex/fix-gemini-load-stall`
- 진단용 브랜치는 기준 커밋에서 생성됐고, 이 문서 전까지 코드 변경은 없다.

## 현재 관측 상태

### Dashboard

- 최초 관측: `localhost:3000` listener 없음, `ERR_CONNECTION_REFUSED`.
- 원인: v2.1 병합과 Dashboard 프로세스 실행은 별개인데 병합 후 서버가 자동 시작되지 않음.
- 복구 명령:

```powershell
./dashboard-launcher.cmd -NoBrowser -NonInteractive
```

- 복구 결과: `/projects` HTTP 200, `node.exe`가 port 3000에서 listening.
- 인계 시점 PID: `6132` — PID는 재시작 시 달라지므로 상태 근거로 고정 사용하지 말 것.

### 최초 LOAD 수정 Run

- Dashboard Run ID: `20260914-175416-loadfix`
- 상태: `failed`
- `actualRunId`: `null`
- Gemini Worker 실행: 안 됨
- 실패 이유:

```text
TASK-001: write_scope.expected 경로가 보호된 오케스트레이터 파일을 포함합니다:
run-parallel-workers.ps1
```

이는 v2.1 보호 정책의 정상 차단이다. 일반 Gemini Worker가 Orchestrator 자체를 수정하는 요청을 수행할 수 없기 때문에 이 유지보수는 Codex 직접 수정 또는 별도 고위험 maintenance policy로 진행해야 한다.

## 확인된 문제

## P0-1. Gemini 호출마다 새 프로젝트 생성

현재 `run-gemini-worker.ps1`의 CLI 인자에는 다음이 포함된다.

```text
--new-project
--model <model>
--mode accept-edits
--dangerously-skip-permissions
--print-timeout 24h
--output-format stream-json
--print <prompt>
```

`--new-project`가 매 invocation마다 사용된다. test retry와 Dynamic Write Expansion 재실행도 새 프로젝트 초기화·로딩 비용을 반복할 가능성이 있다.

Antigravity CLI `1.2.0`에서 확인한 사실:

- `--project <ID 또는 이름>` 옵션이 존재한다.
- 임의의 안정적인 이름을 넣은 `/quota` 단발 호출은 exit 0으로 성공했다.
- `/quota`는 프로젝트 로딩을 실제로 검증하지 않으므로 이것만으로 project reuse가 정상이라고 결론내리면 안 된다.
- `--new-project --output-format stream-json --print /quota` 출력에는 project ID가 포함되지 않았다.

필요한 구현:

1. Repository identity에서 안정적인 project key를 생성한다.
2. 최초 호출과 기존 project 복구 정책을 정의한다.
3. 같은 task의 test retry와 write expansion은 동일 project key를 사용한다.
4. project 없음·손상 오류일 때만 `--new-project` fallback을 한 번 허용한다.
5. fallback을 무한 반복하지 않는다.

## P0-2. LOAD/process stall 감지가 없음

현재 Worker loop는 프로세스가 살아 있는 동안 계속 heartbeat를 저장한다. 마지막 유효 이벤트 이후 진행이 없어도 `--print-timeout` 기본값인 24시간까지 실행 중으로 남을 수 있다.

현재 `LOAD`는 `view_file`, `read_file`, `read_url_content` tool call을 UI activity로 매핑한 값일 뿐이다. tool completion과 묶인 상태가 아니므로 마지막 표시가 `LOAD`인 것과 실제 CLI 정체를 구분하기 어렵다.

필요한 구현:

- 전체 작업 timeout과 별도의 stall timeout 도입
- 마지막 유효 progress event 시각 저장
- heartbeat는 progress로 인정하지 않음
- 장시간 tool call에 대한 false positive 방지
- stall 종료 시 구조화된 category와 evidence 기록
- 종료 시 Antigravity 프로세스 전체 tree 정리
- LOAD 시작/완료 또는 최소한 tool call/result 관계를 관측 가능하게 기록

권장 실패 계약 예시:

```json
{
  "category": "WORKER_STALLED",
  "phase": "LOAD",
  "last_progress_at": "ISO-8601",
  "stall_timeout_sec": 300,
  "last_tool": "read_file",
  "retryable": true
}
```

## P0-3. 한글 경로 백그라운드 실행 방식

첫 번째 Codex 수동 background launch는 `-EncodedCommand`로 router를 호출했지만 Git에 전달된 한글 저장소 경로가 깨졌다.

관측 오류:

```text
fatal: cannot change to 'C:/Users/1234/Documents/...': Invalid argument
```

이후 repository의 `gemini-dashboard/scripts/router-bootstrap.ps1`과 UTF-8 JSON input file을 이용한 실행에서는 경로가 정상 전달됐다. 앞으로 대시보드/백그라운드 Run은 이 bootstrap 경로를 단일 진입점으로 사용하고 임의의 shell command string 또는 직접 encoded command를 만들지 않는다.

## P1. Git 기계적 검사 실패

v2.1 ver3 검토 당시 다음 오류가 있었다.

```text
gemini-dashboard/lib/usage-handlers.ts:95: new blank line at EOF.
```

`git diff --check origin/main...origin/hjw-v2.1-ver3`가 exit 2였다. 현재 변경이 이미 `main`에 병합됐으므로 해당 파일 EOF를 수정하고 `git diff --check` 회귀를 추가해야 한다.

## 이미 확인한 검증

별도 detached review worktree에서 의존성을 다시 설치한 후 확인했다.

| 검증 | 결과 |
|---|---:|
| Dashboard Node tests | 17 files / 235 cases PASS |
| Dashboard lint | PASS |
| Dashboard production build | PASS |
| Bounded Process Runner | 38/38 PASS |
| PowerShell parser | 오류 0 |
| `git diff --check` | FAIL — EOF blank line 1건 |

처음에는 `npm ci`와 PowerShell dependency 검증을 동시에 실행해 `node_modules` 경합이 발생했고 TypeScript 2건이 실패했다. 이는 코드 실패가 아니다. `npm ci` 완료 후 순차 재실행에서는 Bounded Process Runner 38/38이 통과했다. 이후 검증에서는 같은 worktree의 dependency 설치/정리 작업을 병렬 실행하지 않는다.

## 권장 수정 순서

1. `usage-handlers.ts` EOF와 `git diff --check`를 먼저 수정한다.
2. `run-gemini-worker.ps1`의 CLI argument 생성 로직을 순수 함수로 분리한다.
3. 안정적인 repository project key와 재사용 상태를 구현한다.
4. mock CLI로 최초 생성, project reuse, missing-project fallback을 검증한다.
5. progress timestamp와 stall state machine을 구현한다.
6. mock stream으로 LOAD 진행, 정상 장시간 작업, 정체, 프로세스 종료를 검증한다.
7. 기존 filesystem/toolchain/bounded/dependency/launcher/parallel/write-expansion suite를 실행한다.
8. Node 235 tests, lint, build를 실행한다.
9. 모든 결정적 검증 이후 작은 임시 저장소에서 실제 Gemini E2E를 최대 1회 실행한다.
10. 결과를 review하고 사용자 승인 전에는 `main`에 병합하지 않는다.

## 필수 회귀 테스트

- 동일 repository의 두 invocation이 같은 project key를 사용
- test retry와 Dynamic Write Expansion이 같은 project key를 사용
- 서로 다른 repository는 다른 project key 사용
- 존재하지 않는 project는 한 번만 안전하게 생성 또는 복구
- 마지막 유효 event가 갱신되면 stall timer 재설정
- heartbeat만 갱신되어도 stall은 숨겨지지 않음
- 정상 장시간 tool execution을 즉시 오탐하지 않음
- stall 시 worker process와 descendants 종료
- `WORKER_STALLED` evidence에 secret/절대 사용자 경로가 노출되지 않음
- 기존 전체 timeout과 stall timeout이 독립 동작
- `git diff --check` PASS

## 이번 유지보수에서 제외할 것

- OS 수준 filesystem sandbox
- v2.2 FAST/STANDARD/STRICT profile
- v2.2 DAG scheduler
- v2.3 learned router
- Extension UI 신규 구현
- 사용자 승인 없는 main merge 또는 remote push

## 완료 기준

- 매 invocation의 무조건적인 `--new-project` 사용이 제거된다.
- 동일 task 재호출에서 repository project가 재사용된다.
- LOAD 정체가 bounded time 안에 명확한 실패로 종료된다.
- dashboard에 실제 progress와 stall 원인이 표시된다.
- 기존 v2.1 Scope/Secret/Git 안전 불변식이 유지된다.
- 모든 결정적 테스트와 최소 실제 E2E가 통과하거나, 온라인 E2E 미실행 사유가 명시된다.
- 최종 diff와 테스트 결과를 사용자에게 제시하고 승인받은 뒤에만 `main`에 병합한다.
