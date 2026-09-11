# Codex × Gemini Worker v2.2 / v2.3 로드맵

## 문서 목적

이 문서는 v2.1의 Filesystem Policy와 Dynamic Scope Expansion을 유지하면서, 현재 평균 작업 시간이 과도하게 길어지는 문제를 해결하고 이후 실제 실행 데이터를 이용한 학습형 오케스트레이션으로 확장하기 위한 계획서다.

핵심 방향은 다음과 같다.

```text
v2.1
안전하게 실행한다
        ↓
v2.2
필요한 만큼만 실행한다
        ↓
실행 로그 축적
        ↓
v2.3
얼마나 실행할지를 학습한다
```

이 로드맵은 기존 v2/v2.1을 폐기하거나 다시 만드는 계획이 아니다. 현재 구현된 무거운 전체 파이프라인은 STRICT 실행 프로필로 보존하고, 그보다 가벼운 실행 경로를 추가한다.

---

## 1. 문제 정의

현재 구조는 안전성과 검증 가능성을 우선하면서 다음 단계가 상당 부분 직렬로 연결되어 있다.

```text
Planning
→ Task Contract
→ Context Preparation
→ Worktree
→ Dependency Bootstrap
→ Gemini Worker
→ Scope Verification
→ Targeted Test
→ Lint
→ Typecheck
→ Build
→ Candidate
→ Rehearsal
→ Full Regression
→ Codex Review
→ Delivery
```

이 구조는 고위험 작업에는 적합하지만 작은 수정에도 동일하거나 유사한 절차가 적용되면 다음 문제가 발생한다.

- 실제 구현 시간보다 오케스트레이션 시간이 더 길어진다.
- 독립적으로 실행 가능한 검증 단계가 직렬 처리된다.
- 이미 준비된 dependency/worktree 상태를 반복 확인한다.
- 작은 변경에도 full build/regression/rehearsal 비용이 발생할 수 있다.
- Codex가 불필요하게 critical path에 포함될 수 있다.
- 성공률을 높이기 위한 안전장치가 전체 throughput을 낮춘다.

따라서 v2.2의 목표는 안전장치를 제거하는 것이 아니라 작업 위험도와 복잡도에 따라 필요한 만큼만 실행하고, 독립 단계는 병렬화하여 latency와 token cost를 줄이는 것이다.

---

# Part I. v2.2 — Adaptive Performance Layer

## 2. v2.2 목표

v2.2는 다음 여섯 가지를 핵심 기능으로 한다.

1. FAST / STANDARD / STRICT Execution Profile
2. DAG 기반 실행 스케줄링
3. 병렬 Verification
4. Incremental / Affected Verification
5. Dependency / Analysis Cache
6. 단계별 Timing / Cost Telemetry

v2.2는 학습 모델을 사용하지 않는다. 초기 선택은 Codex 추천과 Rule-based Safety Floor로 수행한다.

## 3. Execution Profile

### 3.1 기본 원칙

모든 작업에 동일한 실행 파이프라인을 적용하지 않는다.

```text
FAST
작고 위험이 낮고 자동 검증이 쉬운 작업

STANDARD
일반 기능 수정과 중간 수준의 변경

STRICT
보안, 인증, 스키마, CI/CD, 공용 API, 반복 실패 등 고위험 작업
```

### 3.2 권장 기본 정책

| 기능 | FAST | STANDARD | STRICT |
|---|---:|---:|---:|
| Secret/Forbidden 차단 | ON | ON | ON |
| 최소 Scope 검사 | ON | ON | ON |
| Gemini Worker | ON | ON | ON |
| Codex Planning | OFF/선택 | 선택 | ON |
| Targeted Test | ON | ON | ON |
| Lint | 선택 | ON | ON |
| Typecheck | 선택 | ON | ON |
| Build | OFF/선택 | 선택 | ON |
| Full Regression | OFF | OFF/선택 | ON |
| Rehearsal | OFF | OFF | ON |
| Codex Final Review | OFF | OFF/선택 | ON |
| Dynamic Write Expansion | 제한 | ON | ON |
| Parallel Worker | 제한 | 선택 | 선택 |

### 3.3 항상 유지되는 안전 불변식

Profile과 관계없이 다음은 항상 강제한다.

- Secret 및 credential 접근 차단
- Forbidden 파일 변경 차단
- Worker의 main 직접 수정 금지
- Worker의 remote push 금지
- force push 금지
- 최소 Scope Verification
- 실행 결과 및 실패 원인 기록
- 승인되지 않은 변경의 integration 금지

즉 FAST는 “안전하지 않은 모드”가 아니라 불필요한 고비용 검증을 생략하는 경량 모드다.

## 4. Profile 선택 구조

### 4.1 Codex 추천

Codex가 계획 단계에서 다음 값을 구조화해서 반환한다.

```json
{
  "recommended_profile": "FAST",
  "complexity": 1,
  "risk": 1,
  "testability": 4,
  "ambiguity": 1,
  "reason": "국소 UI 수정이며 공용 계약과 보안 영역에 영향 없음"
}
```

### 4.2 Rule-based Safety Floor

Orchestrator가 최종 Profile 하한선을 강제한다.

```text
auth / security / secrets       → STRICT
schema / migration              → STRICT
public API breaking change      → STRICT
CI/CD / deployment              → STRICT
package/lockfile                → STANDARD 이상
일반 UI 단일 파일               → FAST 허용
```

최종 Profile은 다음 개념으로 결정한다.

```text
Final Profile = max(
  Codex Recommendation,
  Rule-based Risk Floor,
  Runtime Escalation
)
```

Orchestrator는 하향 조정보다 상향 조정을 우선한다.

### 4.3 Runtime Escalation

작업 도중 조건이 변하면 Profile을 승격할 수 있다.

```text
FAST
→ Sensitive 파일 수정 필요
→ STANDARD 또는 STRICT

STANDARD
→ 동일 오류 반복
→ STRICT

FAST
→ targeted test 반복 실패
→ STANDARD
```

Runtime Escalation은 이유와 시점을 구조화 로그로 남긴다.

## 5. DAG Scheduler

### 5.1 목표

현재 긴 직렬 파이프라인을 “의존성이 있을 때만 직렬, 독립 단계는 병렬” 구조로 변경한다.

```text
                   ┌→ Scope Check ────┐
Gemini Complete ───┼→ Targeted Test ──┤
                   ├→ Lint ───────────┤→ Gate
                   └→ Typecheck ──────┘
```

### 5.2 병렬화 가능한 대표 단계

- Scope Verification
- Targeted Unit Tests
- Lint
- Typecheck
- 일부 static policy checks
- 독립된 Worker Task

### 5.3 병렬화 금지 또는 조건부 단계

- Build가 generated artifact를 요구하는 경우
- 한 Task의 output interface를 다른 Task가 사용하는 경우
- 동일 파일 ownership을 공유하는 Worker
- integration/rehearsal이 candidate commit을 필요로 하는 경우
- migration/schema 순서가 존재하는 경우

### 5.4 DAG 계약

각 node는 최소 다음 정보를 가진다.

```json
{
  "node_id": "verify-typecheck",
  "kind": "verification",
  "depends_on": ["worker-complete"],
  "can_run_parallel": true,
  "timeout_sec": 180,
  "required_profiles": ["STANDARD", "STRICT"]
}
```

스케줄러는 ready node만 실행하고, dependency가 없는 ready node는 가능한 범위에서 병렬 실행한다.

## 6. Worker Task 병렬화

병렬 Worker는 “Worker 수를 늘리는 기능”이 아니라 작업 의존성 그래프에 따라 독립 작업만 동시에 실행하는 기능으로 정의한다.

```text
TASK-A Backend API ──┐
                     ├→ Integration
TASK-B Frontend UI ──┘
```

병렬 실행 조건:

- 동일 base에서 독립 실행 가능
- Write Ownership 충돌 없음
- shared entrypoint / package / schema를 동시에 수정하지 않음
- 한 Task의 output이 다른 Task의 input contract를 변경하지 않음

조건을 만족하지 않으면 sequential DAG로 실행한다.

## 7. Incremental Verification

전체 test/build를 매번 실행하지 않는다.

### 7.1 Affected Test Selection

다음 정보를 이용한다.

- changed files
- import/export dependency
- symbol reference
- test map
- 과거 실패 mapping

```text
변경: src/auth/login.ts

관련 테스트:
- login.test.ts
- auth.integration.test.ts
```

FAST/STANDARD에서는 affected tests를 우선 실행하고, STRICT 또는 integration gate에서만 full regression을 실행한다.

### 7.2 Build 정책

- 단순 텍스트/UI 국소 변경은 build 생략 가능
- public type/interface 변경은 typecheck 필수
- bundling/runtime 영향이 있는 경우 build 수행
- STRICT는 full build 기본 ON

## 8. Cache / Reuse

### 8.1 Dependency Fingerprint

다음 값이 동일하면 bootstrap 결과를 재사용할 수 있다.

```text
repository HEAD/base
package-lock hash
package.json hash
Node version
package manager version
platform
```

fingerprint가 일치하면 기존 READY 결과를 빠르게 재사용한다.

### 8.2 Analysis Cache

다음 결과는 변경 파일 기준으로 부분 무효화한다.

- symbol map
- dependency map
- test map
- risk map
- context hints

전체 repository 분석을 매 작업 반복하지 않는다.

## 9. v2.2 Telemetry

v2.2는 이후 v2.3 학습을 위해 실행 데이터를 구조화해서 저장한다.

### 9.1 반드시 기록할 값

#### 결정 당시 Feature Snapshot

- task type
- expected files / lines
- repository area
- complexity
- risk
- testability
- ambiguity
- sensitive zone 여부
- historical failure rate if available

#### Profile Decision

- Codex recommended profile
- rule floor
- final profile
- escalation history
- escalation reason

#### Execution

- models used
- worker count
- retry count
- Codex call count
- Gemini call count
- DAG node count
- parallel node count

#### Timing

- planning
- context preparation
- worktree
- bootstrap
- worker implementation
- scope verification
- targeted tests
- lint
- typecheck
- build
- regression
- rehearsal
- review
- idle/queue
- total wall-clock time

#### Cost

- Codex input/output/cached tokens
- Gemini input/output/cached tokens
- normalized token cost
- wall-clock cost

#### Outcome

- success/failure
- first-pass success
- failure category
- retryable
- user intervention
- user rejection/rework
- policy violation
- changed file count
- unexpected scope count

### 9.2 Data Leakage 방지

학습 시점에 사용할 feature와 작업 완료 후 알게 되는 outcome을 분리한다.

```text
predicted_changed_files = 2
actual_changed_files = 8
```

`actual_changed_files`를 최초 Profile 선택 feature로 사용하지 않는다.

### 9.3 저장 형식

권장 구조:

```text
.agent/
├─ runs/
├─ memory/
└─ analytics/
   ├─ executions.ndjson
   └─ spans.ndjson
```

`executions.ndjson`은 작업 단위 요약, `spans.ndjson`은 단계별 timing 기록으로 사용한다.

## 10. v2.2 구현 순서

### Phase 1 — Observability 먼저

1. 각 기존 단계에 start/end timestamp 추가
2. wall-clock / CPU-independent elapsed 기록
3. execution summary 생성
4. 기존 평균 40분 작업의 실제 병목 측정

### Phase 2 — Profile 도입

1. FAST / STANDARD / STRICT enum 추가
2. Codex plan schema에 `recommended_profile` 추가
3. Risk Floor rule 추가
4. runtime escalation 추가
5. 기존 전체 파이프라인을 STRICT로 매핑

### Phase 3 — Verification DAG

1. verification node dependency 정의
2. scope/test/lint/typecheck 병렬 실행
3. fail-fast / cancel policy 추가
4. 결과 취합 gate 추가

### Phase 4 — Incremental Verification

1. affected test selection
2. build decision rule
3. full regression을 STRICT/integration으로 제한

### Phase 5 — Cache / Reuse

1. dependency fingerprint
2. bootstrap reuse
3. analysis cache partial invalidation

### Phase 6 — Worker DAG

1. task dependency graph
2. write ownership 확인
3. 독립 task만 최대 N개 병렬 실행
4. shared resource conflict 시 sequential fallback

## 11. v2.2 완료 기준

### 기능

- FAST/STANDARD/STRICT가 실제로 다른 파이프라인을 실행한다.
- 현재 v2/v2.1 풀 파이프라인은 STRICT에서 보존된다.
- 독립 verification은 병렬 실행된다.
- dependency가 있는 단계는 순서를 보장한다.
- FAST 작업은 불필요한 build/regression/rehearsal을 실행하지 않는다.
- Sensitive 변경이 발생하면 Profile이 자동 승격된다.
- 안전 불변식은 모든 Profile에서 유지된다.

### 성능

최소 측정 목표:

- 평균 작업 시간 감소
- P50/P95 latency 감소
- Codex Calls / Successful Task 감소
- Full Regression / Build 실행 빈도 감소
- Retry 증가 없음 또는 제한된 증가
- Task Success Rate 유의미한 하락 없음
- Policy Violation Escape Rate 0

권장 초기 목표:

```text
Average Wall-clock Time: 40분 → 20~25분 이하
FAST eligible task: 10분 내외 목표
Task Success Rate: baseline 대비 2~3%p 이상 하락 금지
Policy Violation Escape: 0
```

수치는 초기 실측 후 조정한다.

---

# Part II. v2.3 — Learned Adaptive Orchestration

## 12. v2.3 시작 조건

v2.3은 v2.2 로그가 충분히 쌓인 뒤 시작한다.

초기에는 신경망을 바로 사용하지 않는다.

```text
Rule-based baseline
→ Logistic Regression / Tree model
→ Gradient Boosting
→ Contextual Bandit
→ Neural Router (필요한 경우)
```

데이터가 적을 때는 복잡한 신경망보다 단순 모델이 더 안정적일 수 있다.

## 13. v2.3 연구 문제

단순히 Profile을 분류하는 것이 아니라 다음을 최적화한다.

> 작업 성공률과 안전 하한선을 유지하면서 latency, token cost, retry cost, Codex call cost, verification cost를 최소화하는 실행 정책을 학습한다.

개념적 목적 함수:

```text
Minimize Expected Cost
= latency
+ token cost
+ retry cost
+ Codex escalation cost
+ verification cost
+ human intervention cost

Subject to
- success probability >= threshold
- deterministic safety policy satisfied
- forbidden/policy violation escape = 0
```

## 14. v2.3 입력 Feature

- task embedding 또는 task type
- repository area
- expected change size
- complexity/risk/testability/ambiguity
- file risk class
- dependency fan-out
- affected test count
- historical success rate
- historical retry rate
- model-specific success rate
- profile-specific success rate
- average latency by task class
- previous similar patch outcome

## 15. v2.3 Action Space

초기에는 Profile 선택만 학습한다.

```text
Action = FAST | STANDARD | STRICT
```

데이터가 충분해지면 다음으로 확장한다.

```json
{
  "profile": "STANDARD",
  "model": "gemini-model-x",
  "worker_count": 1,
  "verification_depth": "targeted",
  "full_build": false,
  "full_regression": false,
  "codex_plan": false,
  "codex_review": false,
  "rehearsal": false
}
```

즉 장기적으로는 “모델 선택”이 아니라 전체 orchestration budget allocation을 학습한다.

## 16. Safety Architecture

Learned Router는 최종 권한을 갖지 않는다.

```text
Learned Router
= 효율 최적화 추천

Rule-based Safety Floor
= 최소 안전 수준 강제

Codex
= 의미적 설계 / 구조 진단 / 고위험 리뷰
```

예:

```text
Learned Router: FAST 추천
Risk Floor: auth → STRICT 최소
Final: STRICT
```

학습 모델은 안전 정책을 우회할 수 없다.

## 17. v2.3 비교 실험

권장 실험군:

```text
A. Always STRICT
B. Rule-based Adaptive (v2.2)
C. Learned Adaptive
D. Learned Adaptive + Deterministic Safety Floor
```

주요 지표:

- Task Success Rate
- First-pass Success Rate
- Average / P50 / P95 Completion Time
- Codex Tokens / Successful Task
- Gemini Tokens / Successful Task
- Total Normalized Cost
- Retry Count
- Codex Calls / Successful Task
- Build Count
- Full Regression Count
- Rehearsal Count
- Human Intervention Rate
- Unexpected Scope Rate
- Policy Violation Rate

## 18. 연구 기여 가능성

연구 포인트는 단순한 “모델 라우팅”보다 다음에 둔다.

### 18.1 Adaptive Orchestration Depth

작업별로 어느 정도의 계획·검증·리뷰가 필요한지를 동적으로 결정한다.

### 18.2 Adaptive Verification Budget

모든 작업에 full build/regression을 수행하지 않고 신뢰성 하한선을 유지하며 검증 비용을 배분한다.

### 18.3 Cost-aware Multi-agent Scheduling

모델 비용뿐 아니라 latency, retry, verification, human intervention까지 함께 최적화한다.

### 18.4 Learned Policy + Deterministic Safety Floor

효율 최적화는 학습 모델에 맡기되 안전 불변식은 결정적 정책으로 강제한다.

### 18.5 실제 시스템 로그 기반 평가

합성 task만이 아니라 실제 Codex/Gemini 작업 로그를 이용해 static → rule-adaptive → learned-adaptive 발전을 비교한다.

## 19. 버전 경계

### v2.1

```text
Filesystem / Scope Safety
- Read / Write / Merge 분리
- Dynamic Write Expansion
- Sensitive / Forbidden Policy
- Deterministic Scope Verification
```

### v2.2

```text
Adaptive Performance Layer
- FAST / STANDARD / STRICT
- DAG Scheduler
- Parallel Verification
- Incremental Verification
- Cache / Reuse
- Training-ready Telemetry
```

### v2.3

```text
Learned Adaptive Orchestration
- Profile prediction
- Cost / latency optimization
- model / verification / review budget selection
- Safety Floor 유지
```

## 20. 최종 원칙

v2.2와 v2.3의 목적은 시스템을 더 복잡하게 만드는 것이 아니다.

원래 프로젝트 목표는 다음과 같다.

> **Codex는 필요한 고난도 판단에만 사용하고, Gemini와 결정적 검증기를 이용해 같은 품질의 개발 결과를 더 적은 토큰, 더 적은 시간, 더 적은 사용자 개입으로 얻는다.**

따라서 새로운 기능은 다음 질문으로 평가한다.

```text
이 기능이 성공률 또는 안전성을 유의미하게 높이는가?
아니면 latency / token / human cost를 유의미하게 낮추는가?
```

둘 다 아니라면 기본 실행 경로에 넣지 않는다.

v2.2는 현재 과도하게 무거운 전체 파이프라인을 작업별로 필요한 수준만 사용하도록 경량화하는 버전이고, v2.3은 그 선택 자체를 실제 실행 데이터로 학습해 자동 최적화하는 버전이다.
