# v2.1 ver2 구현 보고서

갱신일: 2026-09-12
구현 브랜치: `hjw-v2.1-ver2`
작업 시작 HEAD: `d7fc751` (`fix(dashboard): defer usage cache restoration until mount`)
최종 코드 검증 HEAD: `c716ad0`
이 문서는 위 코드 HEAD 위에 문서 전용 커밋으로 기록한다. 보고서 자체 커밋은 `git log -1 -- docs/V2_1_IMPLEMENTATION_REPORT.md`로 확인한다.

## 1. 범위와 결과

이번 마무리 작업은 Dynamic Write Expansion 실행 루프 연결, canonical planner schema와 legacy runtime 호환성 의미 정리, ver2 보고서 갱신에 한정했다. 작업 시작 시 working tree는 깨끗했으며 모든 구현 커밋은 `hjw-v2.1-ver2`에 기록했다. 대시보드 UI 디자인, v2.2/v2.3 기능, 의존성 버전은 변경하지 않았다.

`main` 및 `origin/main`은 작업 시작과 종료 확인 시 모두 `f6e954b59377843f893707badee7b3986486b14b`이다. main 수정·병합과 원격 push는 수행하지 않았다. orchestration 회귀에서 생성한 worker/integration 브랜치는 임시 테스트 저장소 안에만 존재하며 테스트 종료 후 제거한다.

## 2. ver2까지 반영된 수정

- `93f02e4`: literal 경로 matcher, 공통 filesystem policy와 Node/npm preflight 도입.
- `bb3705d`: 보호 범위와 결정론적 dashboard fixture 회귀 보강.
- `7f3a384`: router launch 및 오류 표면화, strict planner/review schema 정리, PowerShell 7 launcher 처리와 관련 회귀 보강.
- `d7fc751`: usage cache 복원을 mount 이후로 옮겨 dashboard hydration mismatch 수정.
- 이번 구현: 구조화된 write expansion 요청을 실제 orchestration에 연결하고, 동일 worktree 재실행 및 저장 정책 기반 integration/review 검증 추가.
- 이번 계약 정리: schema를 canonical planner output 전용으로 명시하고 legacy-only task는 runtime normalization으로 지원.

이번 작업의 코드 커밋:

- `a2638cc feat(v2.1): wire dynamic write expansion orchestration`
- `c716ad0 fix(v2.1): clarify legacy task contract compatibility`

## 3. 최종 architecture

```text
router
  → canonical task policy
  → worktree worker
  → optional write expansion (정책 판정 → 저장 → 동일 worktree 재실행)
  → deterministic verification
  → integration review
```

### Dynamic Write Expansion

Worker는 추가 파일을 수정하기 전에 최종 응답으로 JSON 객체 하나를 반환한다. JSON 코드 블록 하나도 허용하며 일반 문장에서 action 이름을 검색해 요청으로 추측하지 않는다.

```json
{
  "action": "REQUEST_WRITE_EXPANSION",
  "target": "src/dependency.ts",
  "reason": "required by direct import dependency",
  "evidence": { "relation": "direct_import", "source_file": "src/original.ts" }
}
```

기존 `Get-WriteExpansionDecision`의 target/reason/evidence 계약과 relation 목록을 유지한다. 지원 relation은 `direct_import`, `direct_export`, `direct_symbol_dependency`, `interface_implementation`, `feature_implementation_dependency`, `new_unit_test`이다. source_file은 기존 expected 또는 승인된 derived 범위 안에 있어야 한다.

Orchestrator는 성공 종료한 worker의 현재 diff가 기존 정책을 통과한 경우에만 확장 요청을 처리한다. 이미 허용 밖의 파일을 수정한 worker를 소급 승인하지 않는다. 확장 요청이 있는 invocation에서는 일반 완료 테스트를 실행하지 않는다.

| 판정 | 실행 처리 |
|---|---|
| `ALLOW_DERIVED` | target을 `write_scope.derived_approved`에 추가하고 필요한 literal merge scope를 추가한다. 저장한 정책을 prompt에 전달해 동일 worktree와 기존 변경을 유지한 채 재실행한다. |
| `REQUIRE_REVIEW` | `WRITE_EXPANSION_REVIEW_REQUIRED`로 종료하고 `requiresCodex=true`와 구체적 사유를 기록한다. 자동 재실행하지 않는다. |
| `DENY_FORBIDDEN` | 금지 target과 matchedPattern을 기록하고 즉시 종료한다. 자동 retry하지 않는다. |
| `DENY_DERIVED` | disabled, 부족한 evidence, 잘못된 경로/요청, 중복 target, merge deny, 확장 한도 등 구체적 사유와 함께 종료한다. |

다른 task의 expected/derived 소유 범위와 충돌하는 target은 review를 요구한다. 기존 merge deny를 확장으로 우회할 수 없다. 동일 target은 대소문자와 상대 경로 표기를 정규화한 뒤 중복 승인을 거부한다.

한 task당 승인 상한은 3회이다. `expansionCount`는 승인 횟수, `testRetryCount`는 TEST_FAILED로 재실행한 횟수이며 서로 예산을 소비하지 않는다. `attempt`는 사용량과 invocation 식별을 위해 모든 재실행에서 증가한다. 실제 worker의 attempt 입력 범위도 초기 실행 + 최대 test retry 3회 + expansion 3회를 수용하도록 1–7로 확장했다. 기존 두 번의 테스트 실패 후 High 승급 및 High 실패 시 Codex 인계 정책을 유지한다.

`.agent/runs/<run-id>/tasks/<task-id>.json`에 현재 `filesystemPolicy`, `expansionRequests`, `expansionCount`, `expansionLimit`, `testRetryCount`를 저장한다. 요청 기록에는 target, decision, reason, requestReason, evidence, matchedPattern, approvedAt 또는 deniedAt, 당시 derived_approved가 포함된다. workers/attempts/results 상태에서도 해당 정보와 현재 정책을 확인할 수 있다. 실제 worker의 상태 갱신도 저장된 task 정책을 읽어 이 정보를 유지한다.

최종 파일 판정은 기존 `Get-FilesystemScopeVerification`을 사용하며 승인 파일은 `DERIVED_APPROVED`로 PASS한다. 파일 수정 전 요청을 위해 빈 diff 입력도 허용한다. Integration cherry-pick 전 task별 후보 diff를 저장된 정책으로 다시 검증하고 integration artifact에 근거를 남긴다. `review-integration.ps1`도 저장된 task 정책을 로드한다. Git 파일 목록 조회에서 한글이 인용 escape되지 않게 하여 `[runId]`, 한글·공백·괄호가 포함된 실제 파일이 integration과 review 단계까지 literal로 통과한다.

### Legacy compatibility: Option 1

`router-plan.schema.json`은 **내부 canonical v2.1 planner output schema**이다. 최신 planner output에는 `allowed_files`, `read_scope`, `write_scope`, `merge_scope`가 모두 필요하며 planner prompt는 `allowed_files == write_scope.expected`를 지시한다. Schema의 title/description과 router의 주석/prompt에서 이 의미를 명시했다. JSON Schema 자체가 두 배열의 값 동등성을 강제하는 것은 아니다.

외부·기존 task 파일은 planner schema를 거치지 않고 runtime loader에서 `Resolve-FilesystemPolicy`로 정규화한다. 따라서 legacy `allowed_files`만 있는 task는 계속 지원된다. 그 값은 `write_scope.expected`로 매핑되며 기본 `merge_scope.expected`도 동일하다. Canonical task는 명시한 v2.1 정책으로 정규화된다. Legacy-only task가 canonical planner schema를 통과한다는 이전 문서 표현은 잘못된 것이므로 제거했다.

## 4. 회귀 검증

2026-09-12 로컬 Windows / PowerShell 7 / Node.js `v24.19.0` / npm `11.17.0`에서 실행했다.

| 명령 | 실제 결과 |
|---|---:|
| `pwsh.exe -NoProfile -File test-filesystem-policy.ps1` | 47/47 PASS |
| `pwsh.exe -NoProfile -File test-toolchain.ps1` | 9/9 PASS |
| `pwsh.exe -NoProfile -File test-bounded-process-runner.ps1` | 38/38 PASS |
| `pwsh.exe -NoProfile -File test-dependency-bootstrap.ps1` | 50/50 PASS |
| `pwsh.exe -NoProfile -File test-dashboard-launcher.ps1` | 48/48 PASS |
| `pwsh.exe -NoProfile -File test-parallel-usage.ps1` | 95/95 PASS |
| `pwsh.exe -NoProfile -File test-write-expansion.ps1` | 35/35 PASS |
| `npm --prefix gemini-dashboard run test` | 202/202 PASS, skipped 0 |
| `npm --prefix gemini-dashboard run lint` | PASS, exit 0 |
| `npm --prefix gemini-dashboard run build` | PASS, exit 0 |
| PowerShell parser / `git diff --check` | PASS |

새 regression은 요구된 열 가지 확장 시나리오를 포함한다. 실제 orchestrator를 임시 git 저장소에서 실행하고 AI worker만 deterministic fixture로 대체해 재실행·변경 보존·retry 분리·중복/한도·민감/금지 종료·integration 검증을 확인했다. Review loader는 외부 Codex 호출 대신 `SkipCodexReview` fixture로 실행해 후보 scope 검증과 병합하지 않는 동작을 확인했다. 실제 worker 스크립트도 mock output으로 실행해 저장된 확장 상태 보존과 7번째 invocation 수용을 확인했다.

기존 filesystem suite는 `[runId]`, `[slug]`, 한글, 공백, 괄호와 forbidden/sensitive 분류를 포함한다. 기존 dashboard suite의 retry API 및 launcher/toolchain/bootstrap/orchestration 테스트도 유지했다. Hydration 수정 파일은 이번에 변경하지 않았다.

## 5. 알려진 한계와 merge readiness

- 요구된 test/lint/build는 생략 없이 실행했다. 실제 Gemini 모델이 expansion JSON을 반환하는 온라인 실행과 실제 Codex 모델 리뷰는 수행하지 않았다. 외부 모델 호출 대신 결정론적 fixture로 실행 경로를 검증했다.
- Dependency evidence 검증은 기존 계약의 relation 및 승인된 source_file 범위를 기준으로 한다. 실제 import graph/AST 분석으로 의존성의 진위를 증명하는 기능은 추가하지 않았다.
- Sensitive/review-required 요청을 승인해 자동으로 이어가는 UI/API는 이번 범위에 포함하지 않았다. 해당 task는 종료 후 사람이 정책을 검토해야 한다. 새 확장 이력은 저장된 JSON에서 확인하며 별도의 dashboard UI는 추가하지 않았다.
- 기존 filesystem 정책은 worker prompt와 최종 diff 검증에 기반한다. OS 수준의 파일 읽기·쓰기 sandbox를 새로 구현하지 않았다.
- Build는 성공했지만 vinext의 route 정적 분류 한계 안내가 남는다. 기존 dependency audit 문제의 재평가나 dependency upgrade는 이번 범위에 포함하지 않았다.
- 현재 결정론적 검증에서 미해결 실패는 없다. 로컬 코드 리뷰 및 검증 기준으로 main 병합 검토가 가능한 상태이며, main 병합은 수행하지 않았다.

## ver3 — stabilization verification (2026-09-14)

검증은 진행 중이며 아래에는 실제 실행 결과만 누적한다. Gemini/Codex 온라인 모델 호출은 수행하지 않았다.

### Git baseline

- 기준: origin/hjw-v2.1-ver2 = 924639ede7833b45913d02329c85114b014562fd (로컬 ver2 브랜치 없음)
- 생성 브랜치: hjw-v2.1-ver3, 위 기준 SHA에서 생성
- main: a57323acf1a24897e55db986552486c56741291b
- origin/main (요청한 fetch 이후): f6e954b59377843f893707badee7b3986486b14b
- fetch 이전 origin/main: aa179e0f7f054e02266af69feb8933664118ca2c
- 시작 working tree: clean; 기존 ver3 로컬/원격 브랜치 없음
- 기존 Author/Committer: 허주완 <eric5519@naver.com>; 변경하지 않음
- 실행 환경: Windows, Node v24.15.0. Node 22 실행 검증은 아직 수행하지 않음.

### 검증 결과

기존 ver2의 npm test 202/202 PASS는 실행된 테스트의 성공 기록이다. 당시 15개 중 13개 파일만 수동 나열되어 test-file discovery coverage는 불완전했다.

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| A discovery | npm --prefix gemini-dashboard run test | 15 files / 219 cases | PASS | 0 | skipped 0, todo 0; 누락 2개 및 [projectId] 포함 |

A의 첫 sandbox 실행은 spawn EPERM으로 실패(exit 1)했다. sandbox 외부 재실행에서 Node 자체의 glob 해석으로 동적 route 파일이 빠지는 문제를 확인했다(212 cases). Node에 전달하는 경로의 대괄호까지 escape한 최종 실행은 219/219 PASS였다. 파일 발견은 shell glob이 아닌 filesystem traversal이며 lexical sort 후 전체 목록과 count를 출력한다.

발견된 기존 15개 파일:

```text
app/api/codex-usage/route.test.ts
app/api/gemini-quota/route.test.ts
app/api/projects/[projectId]/workers/route.test.ts
app/api/runs/route.test.ts
lib/codex-conversation.test.ts
lib/codex-usage.test.ts
lib/daily-token-stats.test.ts
lib/gemini-quota.test.ts
lib/process-liveness.test.ts
lib/project-event-graph.test.ts
lib/run-tracking.test.ts
lib/workspace-contract.test.ts
lib/workspace-node-bridge.test.ts
lib/workspace-sanitize.test.ts
lib/workspace-store.test.ts
```

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| B model tiers | npm --prefix gemini-dashboard run test | 16 files / 229 cases | PASS | 0 | 신규 model-tiers.test.ts 10 cases 자동 발견; README drift 초기 실패 수정 후 PASS |
| B PS loader | dot-source orchestration-common.ps1; Get-ModelTierConfiguration | 4 tiers / normal default | PASS | 0 | 기존 4 model ID 보존 |

모델 출처는 루트 model-tiers.json이다. TS는 같은 JSON을 bundle에 포함하고 explicit file loader도 제공한다. PowerShell은 공용 모듈의 PSScriptRoot에서 JSON을 직접 읽는다. worker-settings.example.json의 model은 기존 model-only fallback 계약을 위해 유지하며 자동 일치 검증한다. 설치 검증은 아직 수행하지 않았다.

### 공용 PowerShell contract 비교 및 통합

| 함수 | 기존 차이 | ver3 계약 |
|---|---|---|
| Write-AtomicJson | worker depth 8, 실패 무시; parallel/review depth 16, 실패 throw. 모두 move/copy fallback와 임시 파일 cleanup 사용 | 기본 depth 16/throw, worker만 명시적 -Depth 8 -BestEffort. fallback와 finally cleanup 유지 |
| Resolve-SharedDashboardPaths | worker/parallel 구현 동일 | orchestration-common.ps1의 동일 우선순위, 같은 루트 위치 유지 |
| Set-ObjectProperty / Invoke-Verification | parallel/review 구현 동일 | 공용 함수로 이동, bounded verification 위임 유지 |
| Redact-Text / Redact-Secrets | bounded runner가 GitHub/PAT/Google/Bearer/Authorization/URL/query/private key까지 보호. worker는 sk-/standalone key=value도 보호 | bounded 구현에 worker 추가 패턴을 합침. Redact-Secrets는 wrapper. failure compression은 절단 전에 같은 redactor 적용 |
| Record-Diagnostic | 이미 Redact-Text 사용 | 호출 유지; 새 보호 기능으로 주장하지 않음 |
| Assert-Test | 4개 파일의 출력/집계 동일; Detail/상세 label 차이 | test-common.ps1로 이동, label 매개변수로 기존 출력 보존 |

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| D module regression | pwsh -NoProfile -File test-toolchain.ps1 | baseline 9 → 23 | PASS | 0 | missing-module, write failure/cleanup, canonical redaction |
| D/E worker regression | pwsh -NoProfile -File test-parallel-usage.ps1 | baseline 95 → 95 | PASS | 0 | 기존 assertion 보존 |

### API 호출 경로 조사

기존 dev: workspaceBridgePlugin이 codex-usage/gemini-quota를 먼저 처리하며 settings는 workerSettingsPlugin이 처리한다. 뒤의 codexUsagePlugin은 GET에 도달하지 않는 dead middleware였다. build/start에서는 app route가 직접 처리한다. dev PID 21228/port 43181와 Wrangler CLI PID 10080/workerd PID 20500/port 43182의 readiness와 curl.exe GET 응답을 확인한 뒤 두 프로세스 트리를 종료했다.

기존 직접 Wrangler 응답은 HTTP 200이어도 host filesystem이 없어 Codex not_found/Gemini unavailable이었고 dev에서는 active/available이었다. 단순 status code 성공으로 parity를 주장하지 않는다. ver3 start-local.mjs는 로컬 Node bridge가 같은 shared handler를 실행하고 UI 요청을 빌드된 Wrangler runtime으로 전달한다. production 배포 기능을 추가한 것이 아니다. settings의 POST/PUT와 app route error contract를 보존하며 dev에도 동일하게 적용한다.

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| C baseline build | npm run build (gemini-dashboard) | vinext 5 stages | PASS | 0 | 변경 전 runtime 경로 조사 |
| C API regression (initial) | npm --prefix gemini-dashboard run test | 17 files / 233 passed, 1 failed | FAIL | 1 | 기존 bridge pass-through 테스트가 settings를 non-workspace로 가정; adapter 통합 계약에 맞춘 regression 보완 필요 |
| C lint | npm --prefix gemini-dashboard run lint | vite.config.ts 포함 | PASS | 0 | ignore 제거; 신규 import/type lint 오류 수정 후 재실행 |

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| C API regression (corrected) | npm --prefix gemini-dashboard run test | 17 files / 235 cases | PASS | 0 | non-workspace 통과 assertion 유지, settings interception assertion 추가 |
| C lint (corrected) | npm --prefix gemini-dashboard run lint | vite.config.ts 포함 | PASS | 0 | 신규 test response type 보완 |

### F/G/H 검증 누적

| 작업 영역 | command | test/file count | pass/fail | exit code | 비고 |
|---|---|---|---|---|---|
| F residue removal | npm run build (gemini-dashboard) | 5 vinext stages | PASS | 0 | next.config.ts/Sites 제거 후 |
| C/F API parity | node test-dashboard-api.mjs | dev/start 각 9 responses | PASS | 0 | 정상/POST/PUT/400/500/refresh/headers 비교; 변동 시각 제외 |
| G sync regression | pwsh -NoProfile -File test-installer.ps1 | 13/13 | PASS | 0 | stale cleanup, user state 보존, installed model lookup |
| G current-checkout install | pwsh -NoProfile -File install.ps1 -SourcePath . -InstallRoot .agent/background/ver3-install -NoStart -NoRegister | npm ci 557 packages | PASS | 0 | main.zip 미사용, 실사용 설치/전역 설정 미변경 |
| H canonical example | pwsh -NoProfile -File test-filesystem-policy.ps1 | baseline 47 → 52 | PASS | 0 | mixed 2 tasks, canonical 2 tasks, 실제 schema |

API parity: dev PID 11528/port 51096, start PID 18360/port 59898, 내부 Wrangler PID 18240/port 59900. 양쪽 root readiness HTTP 200 확인. curl.exe로 GET settings, POST fast, GET persisted fast, PUT normal, invalid tier POST 400, malformed body POST 500, GET codex usage, refresh=true 이후 사용량 42→45, GET Gemini quota available을 비교했다. 사용량 데이터는 fixture이며 quota CLI 호출을 비활성화했다. 양쪽 프로세스 트리를 종료하고 public port 폐쇄를 확인했다. 초기 API 검증 스크립트의 IPv4 readiness 주소는 vinext의 localhost 바인딩과 달라 실패했고, 실제 localhost 주소로 수정한 뒤 위 검증을 통과했다.

설치 초기 시도는 OneDrive의 ReparsePoint 속성을 symlink와 동일하게 제외해 소스를 복사하지 못했다(exit 1). 실제 SymbolicLink/Junction만 제외하도록 수정한 후 현재 checkout 설치가 성공했다. npm ci가 기존 dependency audit 11건(1 low, 2 moderate, 8 high)을 보고했다. 버전 변경이나 audit fix는 수행하지 않았다. 설치기에는 프로그램 manifest sync와 격리 검증용 NoRegister를 추가했다. 기존 manifest 없는 설치는 알려진 폐기 파일만 정리하고 미확인 사용자 파일을 보존한다.

canonical example의 첫 schema 검증은 PowerShell scalar/array 직렬화 차이로 allowed_files가 string이 되어 실패했다. 배열로 보존한 최종 예제는 실제 schema PASS다.

Bounded runner의 첫 전체 실행은 37/38(exit 1)이었다. 기존 3초 tree fixture가 Windows에서 parent PID만 기록한 채 종료되어 실패했다. tree fixture timeout만 10초로 늘려 시작 시간을 확보하고 PID assertion을 >=2에서 >=3으로 강화했다. 별도 timeout-speed assertion은 유지했고 helper 프로세스 창을 숨겼다. 재실행은 38/38 PASS(exit 0), 부모·자식·손자 모두 종료 확인이다.

## 작업 일시 중단 — 2026-09-14

사용자가 한도 소진 전에 중단하고 재개할 수 있도록 정리를 요청했다. 계정 5시간 한도 100% 사용을 확인하여 추가 작업을 중단했다. 재개 시 docs/V2_1_VER3_HANDOFF.md를 먼저 읽는다. 이 시점은 전체 작업 완료가 아니다.

최종 소스에서 npm test는 17 files / 235 cases PASS (skip/todo 0), lint PASS, build PASS이며 각각 exit 0이다. 최종 installer는 SourcePath 현재 checkout + 격리 InstallRoot + NoRegister/NoStart로 재실행하여 exit 0이다.
최종 PowerShell 반복 실행에서 filesystem-policy 52, toolchain 23, bounded-process-runner 38, dependency-bootstrap 50, dashboard-launcher 48이 모두 exit 0으로 끝났다. parallel-usage 반복 실행은 중단 대상이고 write-expansion 최종 반복은 미실행이다. 앞선 동일 구현 검증에서는 parallel-usage 95/95, write-expansion 35/35 PASS였다. 중단된 반복 실행을 최종 PASS로 기록하지 않는다.

중단 정리 중 최종 suite 실행기가 자연 종료했다. session 6982 exit 0이며 parallel-usage 95/95 및 write-expansion 35/35도 최종 PASS다. 위의 중단 대상/미실행 상태는 종료 결과 확인 전의 기록이며 이 결과로 갱신한다. 모든 검증 프로세스는 종료되었다. 재개 시 테스트를 불필요하게 반복하지 말고 남은 parser/Git/author/scope 감사와 보고서 마무리를 진행한다.
