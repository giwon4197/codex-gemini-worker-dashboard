# Web Workspace 오류 및 협업 인계 현황

## 문서 목적

이 문서는 사용 중 발견된 Web Workspace 문제를 협업자가 바로 이어서 처리할 수 있도록 정리한 인계 문서다.

- 사용자 체감 문제를 기준으로 우선순위를 다시 정한다.
- 이미 `main`에서 수정된 항목은 작업 목록에서 분리한다.
- VS Code Extension 전환으로 사라지는 Web 전용 문제는 Extension 백로그에서 제거한다.
- Web과 Extension이 공유할 Orchestrator Core 문제는 계속 추적한다.

판정 기준 커밋은 `main`의 `0448646`이며, 관련 원인 분석은
[`FAILURE_ANALYSIS_2026-09-09.md`](./FAILURE_ANALYSIS_2026-09-09.md)를 참고한다.

## 한눈에 보는 결론

| 구분 | 항목 수 | 처리 원칙 |
|---|---:|---|
| 수정 완료 | 6 | 회귀 테스트만 유지하고 재구현하지 않음 |
| P0 수정 필요 | 3 | Extension 착수 전 Core 기준으로 해결 |
| P1 수정 필요 | 4 | Web 안정화와 Core 분리를 병행 |
| Web 전용 / Extension에서 제거 | 4 | Web 유지보수 범위에서만 처리 |

가장 먼저 해결할 문제는 시각적 완성도가 아니라 **실행 중인 Run과 Worker가 실제 상태와 동일하게 보이는지**, **새 Run이 생성되면 모든 추적 화면이 같은 Run으로 전환되는지**, **새로고침 후에도 상태가 복구되는지**다.

## 수정 완료 — 다시 구현하지 않을 항목

### 1. 작업 그래프 선이 행 경계에서 잘리고 공중에 떠 보임

- 사용자 증상: 분기선과 합류선이 각 행에서 끊겨 하나의 트리처럼 보이지 않음.
- 원인: 행별 SVG 좌표계를 사용해 연결선이 셀 경계에서 잘림.
- 조치: 전체 그래프를 하나의 SVG와 전역 좌표계로 렌더링.
- 근거 커밋: `1021e42 fix(dashboard): implement single full-graph SVG with global coordinates`
- 상태: **수정 완료**
- 유지할 검증: 분기, 합류, 긴 그래프, 최신 이벤트 상단 배치 회귀 테스트.

### 2. 새 작업을 시작해도 기존 트리와 추적 정보가 남음

- 사용자 증상: 새 Run이 시작됐는데 작업 트리, 선택 상태, 사용량 등 추적 화면이 이전 Run을 계속 표시함.
- 조치: 공용 new-run invalidation과 추적 refresh 경로 추가.
- 근거 커밋: `3acbb58 feat(dashboard): add shared new-run invalidation and tracking refresh`
- 상태: **수정 완료**
- 유지할 검증: 최초 hydration은 잘못된 invalidation을 만들지 않고, 새 Run에서 그래프·선택·추적 데이터가 함께 갱신되어야 함.

### 3. 워커가 실행 중인데 활성 워커와 트리가 비어 보임

- 사용자 증상: 실제 Worker 프로세스는 진행 중인데 Web에는 활성 Worker가 없거나 Run이 조기 실패로 표시됨.
- 원인: 라우터 시작 직후 manifest 생성 전 상태, PID 생존 판정, 로그 연결 상태가 서로 다르게 해석됨.
- 조치: router bootstrap, launch-state reconciliation, process liveness와 workspace store 보강.
- 근거 커밋: `4d6a4b2 fix(dashboard): reconcile router launch state and logs`
- 상태: **핵심 수정 완료**
- 주의: 실제 장시간 Run을 이용한 재시작·복구 통합 검증은 P0 항목으로 유지한다.

### 4. 작업 상세에 실제 이벤트와 CLI 진행 내용이 부족함

- 조치: 프로젝트 작업 그래프, 활성 Worker CLI, 종료 Worker 이력과 상세 이벤트 표시 추가.
- 관련 커밋: `27456df`, `4d6a4b2`
- 상태: **기능 구현 완료**
- 주의: UI가 추측 상태를 만들지 않고 NDJSON/Core 상태만 표시하는지는 계속 검증한다.

### 5. 사용량 계산에서 캐시 토큰과 실질 토큰이 뒤섞임

- 사용자 증상: 총 토큰보다 캐시 토큰이 크게 표시되거나 실질 사용량이 0으로 고정되고, 절감률 의미가 불명확함.
- 조치: Codex 누적 세션 사용량 파싱, cached input 분리, Gemini quota 조회 및 사용량 UI 보강.
- 상태: **계산·표현 로직 구현 완료**
- 유지할 검증: 누적 레코드 중복 합산 금지, 캐시 제외 값 음수 방지, 조회 실패를 0%로 표시하지 않기.

### 6. 안전한 재시도와 사용량 수동 조회가 없음

- 조치: 재시도 API, 재시도 가능성 판정, Codex/Gemini 사용량 수동 조회와 캐시 우회 새로고침 추가.
- 근거 커밋: `a57323a feat(dashboard): add safe retry and usage controls`
- 상태: **수정 완료**

## 남은 작업 — 우선순위 재정렬

## P0 — Extension 이전에도 반드시 해결할 Core 신뢰성

### P0-1. 실제 Run/Worker 상태와 화면 상태의 end-to-end 일치 검증

현재 단위 테스트와 상태 조정 로직은 존재하지만 다음 전체 흐름의 완료 증거가 부족하다.

```text
승인 → router bootstrap → manifest 생성 → worker 실행
→ NDJSON 반영 → 검증 → awaiting_review → 재시작 후 복구
```

완료 기준:

- 실행 중 Worker가 1회 이상 비어 보이거나 조기 종료로 오판되지 않는다.
- 새 Run 생성 시 대화, 프로젝트 목록, 그래프, Worker CLI, 상세 패널이 동일한 Run ID를 가리킨다.
- Web/Extension을 닫았다 다시 열어도 디스크의 compact state로 복구한다.
- 추측으로 생성한 가짜 노드나 가짜 진행률이 없다.

이 문제는 UI 문제가 아니라 Event Store와 상태 계약 문제이므로 Extension에서도 그대로 남는다.

### P0-2. Hydration mismatch 제거

- 관측 증상: `ProjectUsageBar`에서 서버는 사용량 조회 버튼을 렌더링했지만 클라이언트는 캐시된 사용량 패널을 렌더링해 React hydration 실패.
- 예상 원인: 초기 렌더에서 `localStorage`, 현재 시각, 브라우저 전용 상태를 읽어 서버 HTML과 다른 트리를 생성.
- 수정 방향:
  1. 서버와 클라이언트의 첫 렌더를 동일한 placeholder로 고정한다.
  2. 브라우저 저장소는 mount 이후 effect에서 읽는다.
  3. 날짜·남은 시간은 초기 HTML에 직접 계산해 넣지 않는다.
  4. hydration 경고를 숨기지 말고 구조 불일치를 제거한다.
- 완료 기준: `/projects` 새로고침과 저장된 사용량 유무 양쪽에서 hydration 경고 0건.

이 항목은 현재 Web에는 P0이지만 VS Code Webview가 client-only로 구현되면 같은 SSR hydration 문제는 사라진다. 따라서 **Extension Core 백로그에는 넣지 않고 Web 안정화 백로그에서만 처리**한다.

### P0-3. 검증기 오탐과 실행 환경 오류 제거

`FAILURE_ANALYSIS_2026-09-09.md`의 핵심 세 문제다.

- `[runId]`를 wildcard로 해석하는 allowed-path 비교 오탐
- 성공 응답의 `INTERFACE_ERROR` 문자열을 실제 실패로 오인
- 검증 자식 프로세스가 `npm.cmd`를 찾지 못하는 PATH 문제

이 문제들은 Web 표시 문제가 아니라 Worker 성공 여부와 integration 생성 여부를 바꾸는 Core 문제다. Extension에서도 반드시 해결해야 한다.

완료 기준:

- exact path는 wildcard가 아닌 리터럴 비교를 사용한다.
- 모든 테스트 PASS 시 자유 형식 성공 보고서가 결과를 실패로 덮어쓰지 못한다.
- Worker 실행 전에 Node/npm/toolchain preflight가 끝난다.
- 환경 오류는 AI 재시도 없이 구조화된 evidence를 남긴다.

## P1 — Core 분리와 함께 해결할 항목

### P1-1. Web UI가 파일과 프로세스를 직접 다루지 않도록 분리

Run/Worker/Event/Git/Usage 처리를 `orchestrator-core`로 이동하고 Web은 같은 API를 소비하는 UI로 제한한다. 이 분리가 되어야 Extension과 Web의 상태 불일치가 다시 생기지 않는다.

### P1-2. 성공한 독립 Worker 결과 재사용

한 Task 실패 때문에 이미 검증을 통과한 다른 Worker 결과까지 처음부터 다시 실행하지 않는다. 성공 commit과 verification artifact를 보존하고 재계획 시 재사용한다.

### P1-3. 상태·실패 레코드 구조화

자연어 로그 검색 대신 다음 필드를 저장한다.

```text
category
source
evidence
recommendedAction
retryable
requiresCodex
requiresUserAction
```

### P1-4. 실제 이벤트 지연과 누락 관측성

단순히 "실시간"이라고 표시하지 말고 마지막 이벤트 시각, 프로세스 생존, manifest 상태, 로그 tail 상태를 분리해 보여준다. stale 상태가 되면 원인을 식별할 수 있어야 한다.

## Extension 전환 시 제거할 Web 전용 문제

아래 항목은 VS Code Extension의 고유 구현에 그대로 옮기지 않는다.

| Web 문제 | Extension 처리 |
|---|---|
| `localhost:3000` 서버가 꺼져 `ERR_CONNECTION_REFUSED` 발생 | Activity Bar/Webview 진입으로 대체. Core 프로세스 연결 실패는 별도 상태로 표시 |
| Next.js SSR과 client cache 차이로 hydration mismatch | client-only Webview 초기 상태 계약으로 대체 |
| 브라우저 탭 새로고침·뒤로가기 때문에 선택 상태 소실 | VS Code workspaceState/globalState와 Core compact state로 복구 |
| 모바일/일반 브라우저 폭에서 그래프가 잘리거나 hover 의존 | VS Code 패널 폭 대응, focus/click 기반 상세보기로 설계 |

단, 다음 항목은 Extension이 자동으로 해결하지 않는다.

- Run/Worker/Event 상태 불일치
- NDJSON 누락 또는 지연
- Codex/Gemini 사용량 계산 오류
- 검증기 PATH와 명령 실행 오류
- Scope/Policy 오탐
- 재시도 중복 실행
- Git worktree, integration branch와 review 상태 복구

이들은 모두 공용 Core에서 해결해야 한다.

## 협업자 권장 실행 순서

1. `P0-3`의 deterministic regression test부터 추가하고 Core 오탐을 제거한다.
2. 실제 Gemini 장시간 Run 하나로 `P0-1` 전체 상태 전이를 검증한다.
3. Web을 계속 제공하는 동안에만 `P0-2` hydration 문제를 수정한다.
4. Run/Worker/Event 읽기 계층을 Core로 추출한다.
5. Web이 추출한 Core만 사용하도록 전환한 뒤 기존 회귀 테스트를 실행한다.
6. 그 다음 VS Code Extension의 client-only UI와 Task Tree를 연결한다.

## 협업자가 수정하지 않아야 할 것

- 이미 해결된 그래프 전역 SVG를 행별 SVG 구조로 되돌리지 않는다.
- UI 편의를 위해 실제 이벤트에 없는 가짜 진행 단계나 가짜 Worker를 만들지 않는다.
- hydration 경고에 `suppressHydrationWarning`만 붙여 원인을 숨기지 않는다.
- 사용량 조회 실패를 0% 또는 0 token으로 표현하지 않는다.
- 성공한 테스트보다 Worker의 자유 형식 문장을 우선해 실패를 판정하지 않는다.
- Extension 전환을 이유로 Core의 상태·검증·정책 문제를 완료 처리하지 않는다.

## 완료 체크리스트

- [ ] Router 전체 상태 전이 E2E 통과
- [ ] 실행 중 Worker와 그래프가 실제 Run과 일치
- [ ] 새 Run 시작 시 모든 추적 화면이 동일하게 갱신
- [ ] 재시작 후 active/awaiting_review 상태 복구
- [ ] `/projects` hydration mismatch 0건
- [ ] `[runId]` 리터럴 allowed-path 회귀 테스트 통과
- [ ] 성공 보고서의 오류 enum 문자열 오탐 방지
- [ ] Node/npm preflight와 자식 프로세스 PATH 검증
- [ ] 성공 Worker commit 재사용 정책 검증
- [ ] Web 전용 문제와 공용 Core 문제를 Extension 백로그에서 분리

