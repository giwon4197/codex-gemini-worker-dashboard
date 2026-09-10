# Codex × Gemini Worker v2.1

## Filesystem Policy & Dynamic Scope Expansion

> 이 문서는 [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md)의 전체 구조를 교체하지 않는다. Gemini Worker의 파일 접근 정책 때문에 발생하는 불필요한 중단, 전체 재호출, 토큰 낭비를 줄이기 위한 v2 정책 보완판이다.

핵심 원칙은 다음과 같다.

> Repository를 볼 수 있는 범위 ≠ 수정할 수 있는 범위 ≠ 최종 merge 가능한 범위

또한 다음 안전 원칙을 함께 적용한다.

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

다음 영역은 실행 환경에서 읽기를 차단한다.

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
