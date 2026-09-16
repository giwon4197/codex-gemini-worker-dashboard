# Codex × Gemini Worker v2.1

## Filesystem Policy & Dynamic Scope Expansion

> 이 문서는 [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md)의 전체 구조를 교체하지 않는다. Gemini Worker의 파일 접근 정책 때문에 발생하는 불필요한 중단, 전체 재호출, 토큰 낭비를 줄이기 위한 v2 정책 보완판이다.

## 현재 구현 계약과 설계 목표의 구분 — 2026-09-15

이 문서의 기존 1–19절은 구현 방향과 설계 목표도 포함한다. 아래 표는 현재 v2.1 코드가 제공하는 계약이며, 이후 절의 더 강한 보안·자동화 목표가 모두 구현됐다는 뜻은 아니다. 실행 검증 결과와 릴리스 판정은 [구현 보고서의 Final Release Gate](V2_1_IMPLEMENTATION_REPORT.md#v21-final-release-gate)를 따른다.

| 현재 v2.1 계약 | 구현 범위와 근거 |
|---|---|
| Repository read/search 및 `read_scope.deny` | worker에 task worktree 내부의 project-wide 탐색을 허용하고 정규화한 read deny 정책을 전달한다. `Resolve-FilesystemPolicy`와 worker prompt의 정책 계약이며 OS 읽기 격리는 아니다. |
| `write_scope.expected` / `derived_approved` | 승인 범위와 실제 최종 diff를 비교한다. legacy `allowed_files`는 초기 expected 범위로 정규화한다. 물리적 파일 쓰기를 모두 사전에 가로채는 기능은 아니다. |
| Dynamic Write Expansion | 수정 전에 `REQUEST_WRITE_EXPANSION`을 반환한다. 허용된 relation, 승인 범위 안의 `evidence.source_file`, target 경로·소유권·금지 범위를 검사하고 `ALLOW_DERIVED`이면 저장한 정책으로 같은 worktree를 재실행한다. 기존 변경을 유지하지만 같은 모델 세션 유지까지 보장하지 않는다. |
| Sensitive / Forbidden | sensitive 확장 요청은 `REQUIRE_REVIEW`에서 중단하며, forbidden은 `DENY_FORBIDDEN`으로 거절한다. 명시적 초기 expected/merge 계약과 sensitive 자동 확장 승인은 구분한다. |
| 실행 상한 및 retry/escalation | task당 expansion 승인은 최대 3회, invocation attempt는 최대 7이다. expansion과 `TEST_FAILED` retry 횟수를 분리하고 기존 High 승급·Codex 인계 의미를 유지한다. |
| `merge_scope` 및 deterministic final diff verification | expected/승인된 derived라도 merge scope 밖이면 통과하지 못한다. merge deny는 확장으로 우회할 수 없고, 승인 전의 범위 밖 수정을 소급 승인하지 않는다. |
| Integration/review revalidation | worker 후보와 integration/review 단계에서 저장된 task 정책으로 diff를 다시 검증한다. 일반 worker 실행 성공은 main 반영 승인이 아니다. |
| Orchestrator 자체 보호 | `filesystem-policy.ps1`의 보호 목록에 `orchestration-common.ps1`을 포함한다. expected·derived 사전 지정과 broad pattern 우회, expansion target으로 자동 수정할 수 없도록 검사한다. |
| Worker의 main 직접 변경 / remote push 금지 | task 계약과 격리 worktree 실행, diff·Git 검증으로 금지 정책을 적용한다. 이 정책은 worker 프로세스가 가진 모든 OS/Git 권한을 제거했다는 보장이 아니다. 이 안정화 작업은 main merge와 remote push를 수행하지 않는다. |
| Secret redaction | 공용 redactor가 알려진 token, header, URL credential, query secret, private key 패턴을 로그·diagnostic 출력에서 가린다. 임의 secret의 완전한 탐지나 모든 파일 열람 차단을 보장하지 않는다. |

다음은 **미구현 / known limitation이며 별도 hardening 또는 future work**다. 현재 v2.1의 위 계약을 위반하는 버그와 구분하며, 이를 구현해야만 v2.1이 완성된다는 뜻으로 해석하지 않는다.

| 설계 목표 / 후속 항목 | 현재 보장하지 않는 것 |
|---|---|
| OS-level filesystem read sandbox | Windows ACL, AppContainer, container 등 kernel-enforced read isolation은 없다. `read_scope.deny`는 orchestration/prompt/policy 계약이다. |
| AST/import graph 기반 dependency truth proof | 구조화된 relation/source_file의 유효성을 검사하지만 실제 import AST graph로 dependency 진위를 증명하지 않는다. |
| Sensitive human approval API/UI | `REQUIRE_REVIEW` → `WRITE_EXPANSION_REVIEW_REQUIRED`에서 멈춘다. 승인 후 자동 재개를 제공하는 dashboard UI/API는 없다. |
| Expansion history dashboard visualization | state JSON과 artifact에는 요청·판정·승인 범위를 남기지만 전용 이력 UI는 없다. |
| 대규모 real workload 검증 | 소규모 online E2E는 release smoke validation이다. 통과해도 장기 workload, 통계적 신뢰도, 아래 KPI 개선을 증명하지 않는다. |

기존 [v2.2/v2.3 로드맵](V2_2_V2_3_ROADMAP.md)의 의미는 유지한다. Execution Profile, DAG scheduler, cache/telemetry engine, learned router 및 신규 승인 UI/API는 이번 v2.1 안정화에서 구현하지 않는다.

핵심 원칙은 다음과 같다.

> Repository를 볼 수 있는 범위 ≠ 수정할 수 있는 범위 ≠ 최종 merge 가능한 범위

또한 다음 안전 원칙을 적용한다. 아래 실행 환경의 secret 차단과 Risk Delivery Gate는 위 표보다 강한 **설계 목표**를 포함한다.

> 물리적 Worktree Write 권한은 Patch 승인 권한이 아니다.

> Secret 차단은 프롬프트가 아니라 실행 환경에서 강제한다.

> 자동 병합 여부는 Scope뿐 아니라 Risk Delivery Gate가 최종 결정한다.

## 1. 목적과 범위

v2의 역할 분담은 유지한다.

- Codex: 설계, 구조적 진단, 명세 수리, 고위험 검토
- Gemini: 실제 구현과 단순 재작업
- Deterministic Verifier: 범위, 계약, 테스트, 빌드, Git 상태 검증
- Human: 정책상 승인이 필요한 변경의 최종 승인

v2.1은 Context Compiler가 필요한 파일을 완벽하게 선택하지 못했을 때 Gemini가 관련 파일을 찾거나 필요한 변경 범위를 요청하지 못해 전체 작업이 중단되는 문제를 해결한다.

```text
Broad Read
+ Narrow Initial Context
+ Classified Write
+ Dynamic Write Expansion
+ Deterministic Scope Verification
+ Risk-based Delivery Gate
```

v2.1은 Rule-based Orchestrator를 유지하며 Neural Router, RL Policy, Learned Scheduler 또는 Repository Memory 전체 재설계를 포함하지 않는다.

## 2. 권한 모델

파일 접근을 하나의 `allowed_files`로 관리하지 않고 세 범위로 분리한다.

1. **Read Scope**: Worker가 탐색하고 읽을 수 있는 범위
2. **Write Scope**: Worker가 작업 후보에서 수정할 수 있는 범위
3. **Merge Scope**: 검증 후 integration/main에 반영할 수 있는 범위

```text
READ
└─ Task Worktree 내부 Repository 탐색 허용
   └─ Secret, credential, Git metadata, 다른 worktree 제외

INITIAL CONTEXT
└─ Context Compiler가 최소 관련 파일과 탐색 힌트 제공

WRITE
├─ Tier 0 Expected
├─ Tier 1 Derived
├─ Tier 2 Sensitive
└─ Tier 3 Forbidden

MERGE
└─ Scope + Contract + Test + Risk + Delivery 검증 통과 시에만 허용
```

## 3. Read Policy

Context Compiler는 Permission Gate가 아니라 **Relevance Optimizer**다. Initial Context에 포함되지 않은 파일을 읽는 것은 정상 동작이다.

Worker는 자신의 격리된 Task Worktree 안에서 다음 동작을 수행할 수 있다.

- Repository search
- 파일 읽기
- grep 및 symbol lookup
- import/export 및 dependency 탐색
- 관련 테스트 탐색

다음은 읽기를 차단할 영역에 대한 설계 목록이다. 현재 런타임이 정규화하는 deny 패턴의 기준은 `filesystem-policy.ps1`의 `DefaultReadDeny`이며, 이 목록 전체를 OS 수준에서 차단하는 구현은 없다.

```text
.env
.env.*
**/secrets/**
**/credentials/**
**/*private-key*
**/*.pem
**/*.p12
.git/**
다른 Worker Worktree
사용자 홈 디렉터리
시스템 디렉터리
```

### 3.1 Secret 강제 차단

이 절은 후속 hardening 목표다. 현재 적용된 canonical redaction과 read deny 정책을, secret 파일 제거·환경 변수 정화·모든 읽기 시도 audit까지 구현된 것으로 해석하지 않는다.

Secret 보호는 모델 지시만으로 구현하지 않는다.

- secret 파일을 worker worktree 또는 전달 컨텍스트에 포함하지 않는다.
- Worker 프로세스 환경에서 실제 secret 값을 제거하거나 최소 권한 값으로 대체한다.
- 명령 출력, 오류, 이벤트 로그, artifact에 redaction을 적용한다.
- 필요한 경우 값 대신 `DATABASE_URL exists: true`와 같은 존재 메타데이터만 제공한다.
- denylist 경로의 열람 시도 자체를 audit event로 기록한다.

## 4. Write Scope

### Tier 0 — Expected Scope

Task Contract에서 직접 변경이 예상된 파일이다. 일반 Scope Verification을 조건으로 수정 후보를 허용한다.

### Tier 1 — Derived Scope

Expected 변경 때문에 자연스럽게 필요한 직접 dependency다.

- 직접 import/export 관계
- 직접 symbol dependency
- interface 구현 관계
- 동일 feature의 명확한 implementation dependency
- 관련된 **신규** 단위 테스트

Worker는 구조화된 Write Expansion을 요청하며 Local Policy Engine이 기계적 증거를 확인하면 Codex 호출 없이 승인할 수 있다.

현재의 기계적 검사는 허용 relation, 승인된 source_file 범위 및 target 정책 확인이다. 아래의 dependency 진위까지 증명하는 목표는 AST/import graph 검증을 추가하는 후속 hardening에 해당한다.

같은 디렉터리에 있다는 사실이나 Worker의 주장만으로는 Derived로 승인하지 않는다.

### Tier 2 — Sensitive Scope

영향 범위가 크거나 False Pass를 만들 수 있는 파일이다.

```text
기존 테스트 수정
통합·회귀 테스트
package.json 및 lockfile
tsconfig 및 build/lint config
schema 및 migration
security/auth policy
public API
CI/CD 및 deployment
shared entrypoint/router
공용 interface breaking change
```

Sensitive 변경은 자동 확장하지 않는다. 근거를 수집하고 Risk Floor를 올린 뒤 정책에 따라 Codex 또는 Human 검토로 보낸다.

### Tier 3 — Forbidden Scope

```text
.env*
secrets/**
credentials/**
.git/**
다른 Worker Worktree
Orchestrator 보호 파일
Verifier 자체
Protected Test
Task Contract 원본
main 직접 변경
remote push
force push
```

Forbidden 접근 또는 변경은 `POLICY_VIOLATION`으로 종료한다.

## 5. 물리적 Write와 승인된 Patch

Gemini CLI가 모든 파일 수정 도구 호출을 사전에 가로채지 못하는 실행 환경에서는 Task Worktree 내부의 물리적 Write가 발생할 수 있다. 이 경우 물리적 Write를 승인으로 취급하지 않는다.

```text
Worker Worktree 수정
        ↓
Diff 파일 분류
        ↓
ALLOW_EXPECTED       → 후보 유지
ALLOW_DERIVED        → 승인 기록 후 후보 유지
REQUIRE_REVIEW       → 통합 중단 및 검토
DENY_SENSITIVE       → 후보 제외
DENY_FORBIDDEN       → 즉시 실패 및 격리
```

승인되지 않은 파일은 worker commit, integration candidate, main 중 어느 단계에도 들어갈 수 없다. 장기적으로 CLI hook 또는 sandbox가 지원되면 동일 정책을 pre-write gate에도 적용한다.

## 6. Dynamic Write Expansion

Worker가 현재 범위 밖 파일을 변경해야 하면 전체 작업을 재시작하지 않고 다음 이벤트를 반환한다.

```json
{
  "action": "REQUEST_WRITE_EXPANSION",
  "target": "src/domain/User.ts",
  "reason": "AuthService 반환 타입 변경으로 User interface 수정이 필요함",
  "evidence": {
    "source_file": "src/auth/service.ts",
    "relation": "direct_symbol_dependency",
    "symbol": "User"
  }
}
```

Local Policy Engine은 LLM을 먼저 호출하지 않고 다음 순서로 판정한다.

1. 대상이 현재 Task Worktree 내부인지 확인
2. Forbidden/Secret 경로 확인
3. 다른 Worker의 Write Ownership과 충돌하는지 확인
4. Expected Scope와 dependency 증거 확인
5. Sensitive 분류 확인
6. `ALLOW_DERIVED`, `REQUIRE_REVIEW`, `DENY_*` 결정

승인 결과와 근거는 Task State와 별도 artifact에 기록한다. Worker 세션을 계속할 수 있으면 같은 세션을 재개하며, 불가능하면 전체 history 대신 원래 계약, 현재 diff, expansion 결정만 전달하는 짧은 후속 호출을 사용한다.

## 7. Task Contract v2.1

아래 JSON은 설계 설명용 발췌이며 canonical planner schema를 만족하는 완전한 입력 예제가 아니다. 실제 required field와 실행 가능한 예제는 [`router-plan.schema.json`](../router-plan.schema.json)과 [`parallel-tasks.v2_1.example.json`](../parallel-tasks.v2_1.example.json)을 따른다. `expected_change_scope` 기반 anomaly/Risk 처리 설명 역시 실행 결과로 검증된 보장과 구분한다.

```json
{
  "objective": "로그인 refresh token 처리 수정",
  "read_scope": {
    "root": "task_worktree",
    "mode": "project_wide_search",
    "deny": [
      ".env*",
      "**/secrets/**",
      "**/credentials/**",
      ".git/**"
    ]
  },
  "write_scope": {
    "expected": [
      "src/auth/service.ts",
      "src/auth/token.ts"
    ],
    "derived_auto_expand": true,
    "sensitive": [
      "tests/**",
      "package.json",
      "**/*.config.*",
      "db/migrations/**",
      "src/security/**"
    ],
    "forbidden": [
      ".env*",
      "**/secrets/**",
      ".git/**",
      ".agent/protected/**"
    ]
  },
  "acceptance_criteria": [
    "기존 로그인 동작 유지",
    "refresh token regression test 통과"
  ],
  "test_commands": [
    "npm test -- auth",
    "npm run typecheck"
  ],
  "forbidden_operations": [
    "git push",
    "force push",
    "disable tests",
    "remove validation"
  ],
  "expected_change_scope": {
    "files": 3,
    "lines": 200
  }
}
```

기존 `allowed_files`는 하위 호환을 위해 초기에는 `write_scope.expected`로 해석한다. `expected_change_scope` 초과는 즉시 실패가 아니라 anomaly와 Risk 상승으로 처리한다.

## 8. Scope Verifier

작업 완료 후 `git diff --name-only`를 기준으로 모든 파일을 다시 분류한다.

```text
EXPECTED
DERIVED_APPROVED
DERIVED_UNAPPROVED
SENSITIVE_APPROVED
SENSITIVE_UNAPPROVED
FORBIDDEN
OWNERSHIP_CONFLICT
```

`DERIVED_UNAPPROVED`, `SENSITIVE_UNAPPROVED`, `FORBIDDEN`, `OWNERSHIP_CONFLICT`가 존재하면 integration candidate를 만들지 않는다. 승인 기록은 정확한 candidate commit과 결합하여 stale 승인을 재사용하지 않는다.

## 9. False Pass 방어

이 절의 원본 snapshot 전체 목록과 독립 protected-test 실행은 설계 목표를 포함한다. 현재 보장은 보호 파일 정책, 실제 diff와 저장된 task 정책의 재검증, 설정된 deterministic verification 명령 실행이다. 모든 항목의 원본 snapshot 및 독립 semantic verifier가 구현됐다고 보장하지 않는다.

`test`, `lint`, `build`의 PASS만으로 성공 처리하지 않는다.

작업 시작 시 다음 항목의 원본 hash 또는 snapshot을 보관한다.

- Protected Tests
- Verifier Scripts
- CI 및 Build Config
- Security Policy
- Schema
- Task Contract

테스트 정책은 다음처럼 세분화한다.

| 변경 | 기본 분류 |
|---|---|
| 관련 신규 단위 테스트 추가 | Derived 후보 |
| 기존 단위 테스트 수정 | Sensitive |
| 통합·회귀 테스트 수정 | Sensitive + Risk 상승 |
| Protected Test/Verifier 수정 | Forbidden |

최종 검증은 Worker가 임의로 완화할 수 없는 Original Protected Tests, contract-derived checks, policy checks를 별도 환경에서 수행한다.

## 10. Parallel Worker와 Ownership

병렬 Worker는 읽기 범위를 공유할 수 있지만 Write Ownership은 분리한다.

```text
Worker A ownership: src/auth/**
Worker B ownership: frontend/login/**
Integration-owned:  src/shared/**, src/routes.ts, package.json
```

공용 파일은 자동 expansion 대상에서 제외한다. 변경 필요 시 `OWNERSHIP_CONFLICT`로 기록하고 sequential task 또는 integration-owned task로 전환한다.

병렬 실행 조건은 Repository가 완전히 분리되어 있는지가 아니라 Write Ownership 충돌을 기계적으로 통제할 수 있는지로 판단한다.

## 11. Failure Classifier v2.1

아래 표는 설계상의 분류다. 모든 이름이 현재 terminal state로 구현됐다는 뜻은 아니다. 실제 runtime 상태와 retry/expansion 처리 계약은 [구현 보고서](V2_1_IMPLEMENTATION_REPORT.md)의 Dynamic Write Expansion 설명을 따른다.

| 분류 | 처리 |
|---|---|
| `CONTEXT_MISS` | Search/Read로 자체 보완, 실패로 계산하지 않음 |
| `WRITE_EXPANSION_REQUIRED` | Local Policy Engine 판정 |
| `WRITE_SCOPE_VIOLATION` | Patch reject 또는 rollback |
| `POLICY_VIOLATION` | Forbidden 접근 시 즉시 차단 |
| `OWNERSHIP_CONFLICT` | 병렬 중단 후 sequential/integration 전환 |
| `SENSITIVE_CHANGE` | Risk Floor 상승 및 검토 |
| `ENVIRONMENT_ERROR` | AI 재호출 없이 환경 조치 |
| `PERMISSION_ERROR` | 실제 OS/tool 권한 문제에만 사용 |
| `REPEATED_FAILURE` | 상위 Gemini 또는 Codex Diagnosis |
| `STRUCTURAL_ERROR` | Codex Diagnosis 후 Gemini 재작업 |

특히 `CONTEXT_MISS`와 `PERMISSION_ERROR`를 동일하게 취급하지 않는다.

## 12. Context Compiler v2.1

이 절은 설계 목표다. 아래 입력을 모두 사용하는 compiler와 read/search/token telemetry 수집을 현재 구현의 보장으로 간주하지 않는다.

Context Compiler는 다음 입력에서 Worker의 Initial Context를 만든다.

- User Request와 Task Contract
- Symbol/Dependency/Test Map
- Current Diff
- Golden Patch
- 관련 과거 성공·실패
- Sensitive/Forbidden Zone

출력은 다음으로 제한한다.

- Initial Context Set
- Search Hints
- 관련 테스트
- Sensitive Zones
- Forbidden Zones

Initial Context 밖의 정상적인 탐색은 허용하고 다음 telemetry를 기록한다.

```text
files_read
search_calls
initial_context_files
context_tokens
expansion_requests
expansion_approved
expansion_denied
```

## 13. Compact State

아래는 설계용 예시이며 현재 state JSON의 전체 schema가 아니다. 실제 expansion 상태는 `filesystemPolicy`, `expansionRequests`, `expansionCount`, `expansionLimit`, `testRetryCount`, `attempt` 등의 필드에 기록한다. 예시의 `files_read`/`search_calls` 수집까지 구현됐다는 뜻은 아니다.

```json
{
  "filesystem_policy": "v2.1",
  "files_read": 12,
  "search_calls": 4,
  "write_scope": {
    "expected": 2,
    "derived_approved": 1,
    "sensitive_touched": 0,
    "violations": 0
  },
  "expansion": {
    "requested": 1,
    "approved": 1,
    "denied": 0,
    "codex_escalated": 0
  }
}
```

긴 파일 목록과 전체 로그는 Compact State가 아니라 별도 artifact에 저장한다.

## 14. Delivery Gate

이 절은 장기 전달 정책 설계다. LOW 자동 fast-forward/push에 대한 설명은 현재 worker에게 main 변경이나 push 권한을 부여하지 않는다. 현재 v2.1 일반 실행은 integration/review gate에서 검토하며, 이 안정화 작업에서는 main merge/push를 금지한다.

Scope가 승인됐다는 사실만으로 자동 병합하지 않는다.

```text
Scope Verification
→ Contract Verification
→ Targeted Tests
→ Integration/Regression Tests
→ Conflict/Divergence Check
→ Risk & Confidence Gate
→ Delivery Policy
```

권장 기본 정책은 다음과 같다.

| 최종 위험도 | 전달 정책 |
|---|---|
| LOW | 모든 gate 통과 시 자동 fast-forward 및 push 가능 |
| MID | repository 설정에 따라 자동 전달 또는 사용자 승인 |
| HIGH | Codex Diff Review와 사용자 승인 필수 |
| Sensitive/Violation/Conflict/Test Failure | 자동 중단 및 보고 |

모든 자동 전달은 다음 불변식을 지킨다.

- fallible 검증을 실제 `main` 이동 전에 rehearsal branch/worktree에서 완료
- candidate commit과 review 결과를 정확히 결합
- force push 금지
- remote divergence 시 중단
- push 실패는 명시적으로 기록하고 안전하게 재시도 가능해야 함
- 실패, 충돌, 정책 위반 시 자동 병합하지 않음

## 15. 기본 실행 흐름

아래는 설계 전체 흐름이다. 현재 검증 대상 흐름은 `router → canonical task policy → isolated worker → optional expansion → deterministic verification → integration/review`이며, independent semantic verification·risk 자동 전달·main push 단계의 전체 구현을 주장하지 않는다.

```text
USER REQUEST
      ↓
Task Triage / Risk Floor
      ↓
Task Contract v2.1
      ↓
Context Compiler → Initial Context + Search Hints
      ↓
Isolated Git Worktree
      ↓
Gemini Worker
  ├─ Repository Search / Read
  ├─ Expected 수정
  └─ REQUEST_WRITE_EXPANSION
             ↓
      Local Policy Engine
       ├─ ALLOW_DERIVED
       ├─ REQUIRE_REVIEW
       └─ DENY
             ↓
Deterministic Scope / Contract Verification
      ↓
Independent Semantic Verification
      ↓
Risk & Confidence Delivery Gate
  ├─ LOW: 정책에 따라 자동 전달
  ├─ MID: 설정에 따라 자동 또는 승인
  └─ HIGH: Codex Review + 사용자 승인
      ↓
main fast-forward → deterministic Git checks → normal push
```

## 16. 구현 순서

아래는 설계 당시의 작업 순서다. 완료 체크리스트가 아니며 OS sandbox, dependency truth proof, telemetry 및 replay 성능 측정 등 후속 범위도 포함한다.

1. `allowed_files`와 실제 Filesystem Permission 분리
2. Task Worktree 내부 project-wide Search/Read 허용
3. 실행환경 기반 Read Denylist와 secret redaction 추가
4. `write_scope.expected` 및 하위 호환 도입
5. `REQUEST_WRITE_EXPANSION` schema 추가
6. dependency 증거 기반 Local Policy Engine 구현
7. Sensitive/Forbidden 경로 정책 추가
8. Scope Verifier 분류 확장
9. Protected Test/Config snapshot 검증 추가
10. Parallel Worker Write Ownership 검사 추가
11. compact state와 telemetry 추가
12. 기존 범위 실패 작업 replay 및 v2 대비 측정

## 17. Acceptance Criteria

이 절은 설계 목표와 장기 품질 기준이다. 현재 v2.1 릴리스의 필수 gate는 구현 보고서의 Final Release Gate에 별도로 기록하며, 아래 항목 전체를 검증 완료로 간주하지 않는다.

### 기능

- Initial Context에 없는 source를 Worker가 search/read할 수 있음
- Derived 파일이 필요할 때 전체 Worker 재실행 없이 expansion을 판정함
- Forbidden 및 secret 접근을 실행 환경에서 차단함
- Sensitive 파일 자동 expansion을 제한함
- 승인되지 않은 diff를 integration 전에 검출함
- 다른 Worker ownership 침범을 차단함
- Context Miss만으로 Codex를 호출하지 않음
- 기존 `allowed_files` 계약이 계속 동작함

### 비용과 품질

- Context-related Stop Rate 감소
- Gemini Full Restart Rate 감소
- Codex Calls / Successful Task 감소 또는 유지
- First-pass Completion Rate 증가
- Average Completion Time 감소
- Unexpected Scope Rate 증가 없음
- Policy Violation Escape Rate 0

### 안전성

- Secret 실제 값이 context/log/artifact에 포함되지 않음
- Verifier, Task Contract, Protected Test 변경 차단
- main 직접 Write와 Worker의 remote push 차단
- force push 차단
- candidate-bound review 적용
- 실패·충돌·정책 위반 시 main과 remote가 변경되지 않음

## 18. KPI

아래는 후속 workload 평가 지표다. 현재 측정값이나 개선 효과를 보고하는 절이 아니다.

다음 지표를 v2 적용 전후 동일한 방식으로 기록한다.

- First-pass success rate
- Context miss 및 context-related stop rate
- Write expansion 요청·승인·거절률
- Gemini restart count
- 평균 initial context 크기와 files read
- 작업당 context/token 사용량
- Codex calls per successful task
- Average completion time
- Unexpected scope 및 policy violation rate
- Merge conflict rate

핵심 KPI는 다음 세 가지다.

1. Context-related Stop Rate
2. Codex Calls / Successful Task
3. Unexpected Scope Rate

목표는 `Context Stop ↓`, `Codex Calls ↓`, `Unexpected Scope 유지 또는 ↓`다.

## 19. 최종 원칙

> Gemini에게 Repository를 탐색할 자유는 주되, 변경 자유는 Task Scope에 묶고 필요한 범위는 기계적 증거로 동적 확장한다.

Context Compiler는 처음부터 정답 파일만 강요하는 Permission Gate가 아니라 Worker가 빠르게 출발하도록 돕는 Relevance Optimizer다. Worktree에서 파일을 쓸 수 있다는 사실은 해당 변경을 integration 또는 main에 반영해도 된다는 뜻이 아니다.

v2.1은 Gemini를 “제공된 파일만 보는 Worker”에서 Repository-aware Implementation Worker로 확장하면서도 Deterministic Control, Cost Control, Scope Isolation, Selective Codex Escalation, Risk-based Delivery를 유지한다.
