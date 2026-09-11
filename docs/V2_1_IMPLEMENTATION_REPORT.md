# v2.1 구현 보고서

작성일: 2026-09-11  
구현 브랜치: `hjw-v2.1-ver1`  
기준 커밋: `f6e954b` (`origin/main`)  

## 1. 결론

`V2_1_FILESYSTEM_POLICY`, `V2_ARCHITECTURE`, `V2_COMPLETION_AND_V2_1_HANDOFF`, `VSCODE_EXTENSION_ROADMAP`, `FAILURE_ANALYSIS_2026-09-09`에서 공통으로 요구한 v2.1의 우선 과제를 현재 구조에 최소 침습 방식으로 반영했다.

- PowerShell wildcard 의미에 기대지 않는 저장소 상대 경로 matcher를 공통 모듈로 도입했다.
- Read/Write(Expected, Derived, Sensitive, Forbidden)/Merge scope를 하나의 정책 계약으로 정규화했다.
- 최종 diff와 리뷰 후보 커밋을 같은 정책 엔진으로 검증하도록 실행·리뷰 경로를 통합했다.
- Node/npm을 실행 전에 절대 경로로 결정하고, 버전·실행 가능성·자식 PATH 전파를 검증하도록 만들었다.
- 기존 `allowed_files` 계약은 `write_scope.expected`로 자동 변환해 호환성을 유지했다.
- 대시보드 계약과 sanitizer가 v2.1 정책 근거를 안전하게 표시할 수 있게 확장했다.

## 2. 참고 문서와 기존 구조에서 확인한 문제

기존 구조는 `codex-router.ps1`이 계획을 만들고 `run-parallel-workers.ps1`이 worktree 워커를 실행한 뒤 `review-integration.ps1`이 후보를 검토·통합하는 흐름이었다. 안전 정책과 실행 환경 검사가 각 스크립트에 분산되어 다음 문제가 있었다.

1. 경로 허용 검사에 PowerShell `-like`가 사용되어 `[runId]`, `[slug]` 같은 실제 디렉터리명이 문자 클래스 wildcard로 해석될 수 있었다.
2. `allowed_files` 하나가 검색 범위, 예상 변경, 민감 파일, 병합 범위를 충분히 구분하지 못했다.
3. Node/npm 탐색이 프로세스별 PATH 상태에 영향을 받아 설치 후에도 자식 프로세스에서 재현되지 않을 수 있었다.
4. 실행기와 최종 리뷰가 동일한 파일 범위 판정 근거를 공유하지 않았다.
5. 대시보드 타입과 비공개 처리 계층이 새 중첩 정책 계약을 알지 못했다.

작업 중 `origin/codex/wip-v2.1-filesystem-policy`의 계약 및 테스트 아이디어만 선별 검토했다. 해당 브랜치는 최신 `main`과 서로 8개 커밋씩 갈라져 있었고 경로 판정에도 `-like`가 남아 있어 cherry-pick하지 않았다.

## 3. 구현 내용

### 3.1 공통 filesystem policy 엔진

새 `filesystem-policy.ps1`이 다음 기능을 단일 책임으로 제공한다.

- 모든 경로를 `/` 구분자의 저장소 상대 경로로 정규화한다.
- 경로 이탈, 절대 경로, NUL, 지원하지 않는 `?` wildcard를 거부한다.
- wildcard가 없는 경로는 `OrdinalIgnoreCase` literal exact 비교를 사용한다.
- 명시적으로 허용한 `*`와 `**`만 자체 regex로 컴파일하며, `[`, `]`, `(`, `)` 등 나머지 문자는 모두 escape한다.
- expected/derived/merge expected에는 literal 또는 끝의 `/**` 재귀 범위만 허용한다.
- 레거시 `allowed_files`를 `write_scope.expected`와 기본 `merge_scope.expected`로 변환한다.
- 기본 read deny, sensitive, forbidden 목록은 사용자 계약으로 제거할 수 없고 추가만 가능하다.
- `.git/**`, `.agent/**`, 비밀 파일뿐 아니라 정책·라우터·실행·리뷰 스크립트와 스키마를 보호된 forbidden 대상으로 둔다.
- 최종 변경 파일을 `EXPECTED`, `DERIVED_APPROVED`, `DERIVED_UNAPPROVED`, `SENSITIVE_UNAPPROVED`, `FORBIDDEN`, `MERGE_DENIED`, `MERGE_SCOPE_VIOLATION`으로 분류한다.
- 직접 import/export, symbol/interface/feature 의존성, 신규 단위 테스트 근거를 받는 derived expansion 판정 기반을 제공한다. 민감 범위는 검토 요구, forbidden은 항상 거부한다.
- 병렬 작업 간 동일·상하위 재귀 범위 겹침을 실행 전에 거부한다.

`codex-router.ps1`, `run-parallel-workers.ps1`, `review-integration.ps1`이 이 모듈을 공통으로 사용한다. 워커 상태와 run manifest에는 정규화된 v2.1 정책 및 scope verification 근거가 기록된다. 리뷰 결과는 해석 시점의 후보 커밋 hash와 묶이며, 후보 전체 diff를 병합 전에 다시 판정한다.

### 3.2 스키마와 하위 호환성

`router-plan.schema.json`은 다음 두 입력을 모두 받는다.

- 레거시: `allowed_files`
- v2.1: `read_scope`, `write_scope`, `merge_scope`

예제 계획은 v2.1 작업과 레거시 작업을 함께 포함하도록 바꿔 혼합 입력의 마이그레이션 경로를 보여준다. 기존 계획은 수정 없이 동작하되 런타임에서 v2.1 정책 객체로 정규화된다.

### 3.3 Node/npm 결정적 preflight

새 `toolchain.ps1`은 다음 순서로 Node/npm을 결정한다.

1. 명시적 파라미터 또는 `CODEX_GEMINI_NODE_PATH`, `CODEX_GEMINI_NPM_PATH`
2. 현재 PATH
3. 신뢰할 수 있는 Windows 표준 설치 위치

명시적 override가 잘못되면 다른 설치본으로 조용히 fallback하지 않고 `ENVIRONMENT_ERROR`를 반환한다. 결정한 절대 경로와 보강 PATH는 bounded runner, 의존성 bootstrap, 워커와 검증 자식 프로세스에 전달된다. 실제 `package.json`의 `engines.node` 최소 버전도 실행 전에 확인한다.

Preflight는 worktree 생성과 AI 워커 실행보다 먼저 수행된다. 따라서 환경 오류가 코드 수정, 재시도, 모델 승급으로 잘못 분류되지 않는다.

### 3.4 대시보드 계약과 테스트 격리

`LiveWorkerPolicy` 타입에 v2.1 scope, 파일별 분류, 비교 방식, 위반 목록을 추가했다. sanitizer는 모든 중첩 정책 경로와 matched pattern을 저장소 상대 경로로 변환하고 절대 사용자 경로를 노출하지 않는다.

대시보드 테스트는 로컬 PC에 `agy.exe`가 설치되어 있다는 전제를 제거하고 각 테스트 저장소 안의 명시적 fixture를 사용한다. 운영 코드의 `agy` 필수 검사와 누락 오류 처리는 변경하지 않았다.

## 4. 회귀 검증

최종 검증 결과:

| 검증 | 결과 |
|---|---:|
| filesystem policy | 36/36 PASS |
| Node/npm toolchain | 9/9 PASS |
| bounded process runner | 38/38 PASS |
| dependency bootstrap | 50/50 PASS |
| dashboard launcher | 46/46 PASS |
| parallel usage/orchestration | 95/95 PASS |
| dashboard Node tests | 201/201 PASS |
| dashboard lint | PASS |
| dashboard production build | PASS |

필수 경로 회귀에는 `[runId]`, `[slug]`, 한글, 공백, 괄호, recursive glob, sibling 불일치, path traversal, 민감/금지/병합 범위, 정책 소유권 충돌이 포함된다.

Node.js LTS `24.19.0`과 npm `11.17.0`을 사용해 실제 lint/test/build를 수행했다. `npm ci` 결과 audit에는 11개 취약점(낮음 1, 보통 2, 높음 8)이 보고됐으나, 이번 범위를 벗어나는 자동 `audit fix`는 실행하지 않았다.

## 5. 체크포인트와 저장소 상태

- `93f02e4 feat(v2.1): add shared filesystem policy and toolchain preflight`
- `bb3705d test(v2.1): harden protected scope and deterministic dashboard fixtures`

`main`과 `origin/main`은 기준 커밋 `f6e954b`에 그대로 있다. 구현 브랜치는 `hjw-v2.1-ver1`이며 push 또는 main 병합은 수행하지 않았다.

## 6. 운영 시 주의사항과 후속 권고

- 이 PC에는 실제 `agy.exe`가 설치되어 있지 않다. 이는 이번 목표에서 Gemini/worker를 사용하지 않았다는 조건과 일치하며, 운영에서 Gemini worker를 실행하려면 사용자가 공식 설치 과정을 별도로 승인·수행해야 한다.
- 자동 derived expansion은 현재 정책 판정 함수와 구조화된 근거 계약까지 구현되어 있다. 실행 중 scope를 임의로 넓히지는 않으며, 승인된 결과는 계획의 `write_scope.derived_approved`로 명시한 뒤 동일한 최종 verifier를 통과해야 한다.
- npm audit 취약점은 별도 dependency-upgrade 작업으로 잠금 파일 변경과 전체 회귀 검증을 함께 수행하는 것이 안전하다.
- 향후 VS Code 확장에서는 현재 manifest의 `filesystem_policy`, `scopeVerification`, toolchain preflight 결과를 그대로 소비하고, UI가 별도의 허용/차단 판정을 재구현하지 않는 편이 정책 일관성을 유지한다.
