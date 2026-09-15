# v2.1 문서·구현 대조 및 실사용 검증 — 2026-09-15

검토 대상: `hjw-v2.1-ver3`, `9338e5cbe6e557c9825a68dbade3fb85e8aa0c6f`.
기존 구현 보고서의 검증 성공과 설계 문서 전체의 구현 완료는 별개다. 이번 검토는 코드를 변경하지 않는다.

## 문서와 실제 구조

실제 경로는 `codex-router.ps1` → canonical planner schema → `run-parallel-workers.ps1` → 격리 worktree의 `run-gemini-worker.ps1` → bounded deterministic verification → integration → `review-integration.ps1`이다. worker 성공 후 orchestrator는 `awaiting_review`, 기본 router가 이어서 실행하는 Codex review까지 성공하면 `awaiting_human_approval`로 진행한다. 자동 delivery 설정은 별도이며 이번 온라인 fixture에서는 명시적으로 끈다.

| 문서 계약 | 구현 근거 | 판정 |
|---|---|---|
| read/write/merge 분리, legacy 호환 | filesystem-policy.ps1의 Resolve-FilesystemPolicy/Get-FilesystemScopeVerification, canonical schema 및 두 example | 구현됨. read deny 목록은 OS 접근 차단을 뜻하지 않음 |
| Dynamic Write Expansion | Invoke-TaskWriteExpansion, 저장된 policy와 동일 worktree 재시도, integration 재검증 | 구현됨. 승인 최대 3회, worker Attempt 최대 7 |
| Derived dependency의 기계적 증명 | Get-WriteExpansionDecision이 relation enum 및 승인된 source_file만 확인 | 부분 구현. 실제 import/symbol 관계의 진위는 증명하지 않음 |
| secret 접근을 실행 환경에서 차단 | deny 계약·prompt·diff 검사 및 공용 redactor | 설계 문서 §3의 OS 수준 읽기/환경 격리 보장과 차이. redaction은 읽기 sandbox가 아님 |
| Protected Tests/Verifier 원본 snapshot 및 독립 semantic 검증 | scope 차단과 결정론적 명령, candidate-bound Codex review | §9 전체를 구현했다고 볼 수 없음. 전용 원본 snapshot 검증과 동일하지 않음 |
| Context Compiler의 symbol/dependency/test map, KPI | router의 저장소 조사와 task prompt | §12·18의 전체 compiler/측정 체계 구현 또는 성능 개선을 입증하지 못함 |
| sensitive 승인 | expansion REQUIRE_REVIEW 및 escalation | 중단 경로 존재. 승인 API/UI는 후속 범위 |
| 모델·API 공용화 | model-tiers.json, worker-settings.ts, usage-handlers.ts, Node bridge | dev와 npm start의 공용 handler 계약 재검증 PASS |

`V2_1_FILESYSTEM_POLICY.md`는 설계 목표를 포함한다. 현재 제공하는 보장은 `V2_1_IMPLEMENTATION_REPORT.md`의 알려진 한계와 함께 읽어야 한다. v2.2/v2.3 기능을 이번 검토에서 구현하지 않았다.

## 새로 확인한 보호 목록 누락

**우선 수정 필요:** `filesystem-policy.ps1`의 `DefaultProtected`에 ver3에서 추출한 `orchestration-common.ps1`이 없다. 이 파일은 verification wrapper 및 redaction 등 공용 실행 로직을 포함한다. 기존 문서는 orchestrator/verifier를 금지 대상으로 규정한다.

읽기 전용 재현:

```powershell
. ./filesystem-policy.ps1
$policy = Resolve-FilesystemPolicy ([pscustomobject]@{allowed_files=@('orchestration-common.ps1')})
Get-FilesystemScopeVerification -Policy $policy -ChangedFiles @('orchestration-common.ps1')
```

실제 결과: `status=PASS`, `classification=EXPECTED`, `authorized=true`, exit 0. scope 밖에서 임의 수정해도 통과한다는 뜻은 아니다. planner/legacy contract가 이 파일을 expected로 지정하면 기존 protected script와 달리 거부되지 않는다는 뜻이다. 작업 요청은 비교·검증이므로 이번에 구현을 수정하지 않았다. 보호 파일 목록 및 회귀 검증 보강이 필요하다.

## 이번에 다시 실행한 검증

| 명령 | 결과 | exit | 비고 |
|---|---|---|---|
| pwsh -NoProfile -File test-filesystem-policy.ps1 | 52 PASS / 0 FAIL | 0 | 기존 테스트 성공은 위 공용 모듈 누락을 검출하지 못함 |
| pwsh -NoProfile -File test-write-expansion.ps1 | 35 PASS / 0 FAIL | 0 | 로컬 loop fixture, 온라인 모델 호출 아님 |
| node test-dashboard-api.mjs | dev/start 9개 요청 parity PASS | 0 | 실제 HTTP, 임시 usage/quota 데이터. 온라인 inference 아님 |

API 서버: dev PID 16244 / port 58750, start PID 11104 / port 58812, 내부 Wrangler PID 6184 / port 58814. 양쪽 root readiness HTTP 200. settings GET/POST/PUT, invalid tier 400, malformed JSON 500, codex usage GET/refresh, Gemini quota GET을 비교했다. 상태·정규화 JSON·Cache-Control 일치. 테스트 종료 후 두 서버 종료 및 public port 폐쇄를 확인했다.

전체 7개 PowerShell suite, npm 17 files/235 cases, lint/build 등 이전 결과는 구현 보고서의 ver3 최종 검증을 참조한다. 이번에 다시 실행하지 않은 항목을 신규 실행으로 기재하지 않는다.

## 온라인 실사용 검증

사용자가 실제 모델 호출을 승인했다. 현재 checkout의 router/worker를 사용해 별도 임시 Git 저장소에서 단일 함수 수정 작업을 실행한다. 테스트 파일 변경, dependency 설치, 원격 설정, merge/push는 요청에서 금지한다. fixture는 autoDeliver=false로 설정한다.

온라인 실행 결과는 아직 미확정이다. AGENTS.md의 dashboard-first 비동기 규칙에 따라 시작 이후에는 polling하지 않고 사용자 요청 시 compact terminal result, integration diff, test summary를 검토한다. 시작 성공을 Gemini/Codex E2E 성공으로 표현하지 않는다. 실제 보안 sandbox나 expansion 시나리오까지 이 단일 smoke test가 검증하는 것은 아니다.
