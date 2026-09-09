# Codex × Gemini Worker v2 설계 및 구현 로드맵

> 실제 구현 시도의 실패 원인과 재발 방지안은 [2026-09-09 실패 원인 분석](FAILURE_ANALYSIS_2026-09-09.md)을 참고한다.

## 1. 목표

Codex는 상시 작업자나 진행 상황 폴러가 아니라 설계자·진단자·고위험 검토자로만 사용한다. 구현과 단순 재시도는 Gemini가 담당하고, 기계적으로 판정할 수 있는 결과는 결정적 검증기가 확인한다.

핵심 목표는 다음과 같다.

- Codex 호출과 전달 컨텍스트 최소화
- Gemini의 첫 시도 성공률 향상
- 환경 오류와 권한 오류에 대한 불필요한 AI 재호출 방지
- 변경 범위와 위험도에 따른 선택적 검토
- 모든 `main` 병합 전 사용자 승인 유지
- 과거 작업 결과를 이용한 모델·컨텍스트·테스트 범위 자동 최적화

## 2. 전체 구조

```text
USER REQUEST
    ↓
Repository Memory
    ↓
Task Triage
  - Complexity
  - Risk
  - Testability
  - Ambiguity
    ↓
Risk Floor
    ↓
Execution Strategy
  ├─ Gemini Direct
  ├─ Gemini + Deterministic Verification
  ├─ Gemini Parallel DAG
  ├─ Gemini A/B Read-only Diagnosis
  └─ Codex Plan / Diagnosis
    ↓
Task Contract
    ↓
Context Compiler
    ↓
Isolated Git Worktree
    ↓
Gemini Worker Pool (default 1, max 2 per run)
    ↓
Verification Pipeline
    ├─ PASS → Integration Candidate
    └─ FAIL → Failure Classifier → Retry / Escalation
    ↓
Change Risk + Evidence-based Confidence
    ├─ LOW/MID → Summary → Human Approval
    └─ HIGH → Codex Diff Review → Human Approval
    ↓
main
```

## 3. Codex 단발 호출 정책

Codex CLI는 다음 상황에서만 `codex.exe exec --ephemeral`로 실행하고 결과를 compact JSON으로 저장한 뒤 종료한다.

1. 높은 모호성 또는 높은 위험 작업의 계획
2. 명세 오류 수정
3. 구조적 실패 진단
4. 고위험 최종 diff 검토

`running`과 `retrying` 상태에서는 Codex가 워커 로그를 폴링하거나 Gemini와 진행 대화를 하지 않는다. 전체 NDJSON은 compact 실패 기록만으로 원인을 판별할 수 없을 때만 읽는다.

## 4. 실행 상태 계약

모든 프로세스는 버전이 명시된 compact JSON으로 통신하며 임시 파일 작성 후 원자적으로 교체한다.

```text
planning
running
retrying
requiresCodex
awaiting_review
approved
failed
```

상태에는 최소한 다음 정보만 포함한다.

- 계약 버전과 갱신 시각
- 현재 상태와 작업 ID
- 변경 파일 목록
- 요구사항 통과 여부
- 테스트 요약
- diff 통계
- 위험도와 confidence 근거
- Gemini 재시도 및 모델 승격 이력
- Codex 호출 횟수와 호출 이유
- 압축된 실패 원인
- 상세 로그의 경로

## 5. Repository Memory

```text
.agent/memory/
  architecture.json
  symbols.json
  dependency-map.json
  test-map.json
  risk-map.json
  task-history.json
  patch-patterns.json
```

전체 저장소를 매번 다시 분석하지 않는다. 변경된 파일과 관련 심볼 그래프만 무효화하고 재분석한다. 성공한 작업의 문제 유형, 변경 파일, 해결 패턴, 모델, 시도 횟수와 테스트 결과를 Golden Patch로 저장한다.

## 6. Triage와 Risk Floor

단일 LOW/NORMAL/HARD 분류 대신 각 축을 독립적으로 1~5로 평가한다.

- **Complexity:** 구현 난이도
- **Risk:** 실패했을 때의 피해
- **Testability:** 자동 정답 판정 가능성
- **Ambiguity:** 원인과 요구사항의 불명확성

다음 영역은 LLM 판단과 별개로 최소 위험도를 강제로 올린다.

```text
auth, permission, security, secrets, payment,
database migration, schema, public API,
dependencies, CI/CD, deployment
```

## 7. Task Contract

Gemini에는 자유 형식 요청 대신 다음 실행 계약을 전달한다.

```json
{
  "objective": "완료해야 할 한 가지 목적",
  "allowed_files": ["허용된 경로"],
  "forbidden_files": ["수정 금지 경로"],
  "allowed_symbols": ["선택적 허용 심볼"],
  "acceptance_criteria": ["검증 가능한 완료 조건"],
  "test_commands": ["결정적 검증 명령"],
  "forbidden_operations": ["금지 작업"],
  "expected_change_scope": { "files": 3, "lines": 200 }
}
```

예상 변경량 초과는 즉시 실패로 처리하지 않는다. anomaly로 기록해 최종 위험도와 검토 수준을 높인다.

## 8. Context Compiler

워커에는 저장소 전체가 아니라 다음 정보만 전달한다.

- 사용자 요구사항과 Task Contract
- 관련 파일과 심볼
- 필요한 architecture snippet
- 현재 diff
- 관련 테스트
- 유사한 과거 성공 및 실패 사례

이를 통해 입력 토큰과 불필요한 코드 탐색을 줄이고 엉뚱한 영역을 수정할 확률을 낮춘다.

## 9. Worker와 DAG 정책

- 기본 워커 수: 1
- 실행별 최대 워커 수: 2
- 파일 소유권이 완전히 분리되고 같은 base에서 독립 실행할 수 있을 때만 병렬화
- 전체 빌드와 통합 테스트는 한 번에 하나만 실행
- 의존 작업은 ready 상태가 된 뒤 기존 워커 슬롯에 순차 배정

모호한 문제는 두 워커가 코드를 각각 수정하지 않는다. 두 Gemini가 read-only로 서로 다른 원인 가설과 근거를 제출하고, 증거 비교 후 선택된 한 워커만 구현한다.

## 10. Verification Pipeline

```text
1. allowed file 검사
2. forbidden file 및 operation 검사
3. diff anomaly 검사
4. lint/static 검사
5. 영향받은 단위 테스트
6. typecheck
7. targeted integration test
8. build
9. integration branch 테스트
10. full regression suite
11. security/schema/auth 검사
```

작업 중에는 Repository Memory의 test map을 이용해 영향받은 테스트만 실행하고, 전체 회귀 테스트는 통합 단계에서 한 번 실행한다.

## 11. Failure Classifier

| 분류 | 처리 |
|---|---|
| `LOCAL_ERROR` | 동일 Gemini 컨텍스트에 짧은 오류 전달 |
| `WRONG_IMPLEMENTATION` | reasoning history를 제외한 새 Gemini 컨텍스트 |
| `REPEATED_FAILURE` | Advanced Gemini로 승격 |
| `SPEC_ERROR` | Codex가 계약을 재설계 |
| `STRUCTURAL_ERROR` | Codex 진단 후 Gemini 재작업 |
| `SECURITY_RISK` | Codex 필수 검토 |
| `ENVIRONMENT_ERROR` | AI 재호출 없이 환경 조치 요청 |
| `PERMISSION_ERROR` | AI 재호출 없이 권한 조치 요청 |

Advanced Gemini가 실패해도 Codex가 직접 구현하지 않는다. Codex는 `ROOT_CAUSE`, `TARGET`, `DO`, `DON'T`, `VERIFY` 형태의 진단만 생성하고 Gemini가 수정한다.

## 12. Risk와 Confidence Gate

최종 위험도는 파일 위험도, 변경량 이상, 재시도 횟수, 테스트 범위, 보안·스키마·인증 영향과 unexpected scope로 계산한다.

Confidence는 LLM의 자기 평가가 아니라 다음 증거로 계산한다.

- 테스트와 빌드 통과
- 예상 범위 내 diff
- 정책 위반 없음
- 충분한 테스트 커버리지
- 재시도 및 scope anomaly 없음
- 진단 불확실성 없음

Risk 0~2는 Codex 리뷰를 생략할 수 있고, Risk 3은 선택적 검토, Risk 4~5는 Codex 검토를 필수로 한다. 어떤 경우에도 `main` 병합에는 사용자의 명시적 승인이 필요하다.

## 13. 웹 채팅 제어면

별도 `/chat` 화면에서 다음 기능을 제공한다.

- 자연어 작업 요청과 안전한 CLI 인자 전달
- 요청 직후 비동기 run ID 반환
- compact 상태 기반 메시지 타임라인
- 계획, Gemini 실행, 재시도, 승격, 검증 결과 표시
- `requiresCodex`에서만 진단 요청 버튼 활성화
- `awaiting_review`에서만 최종 검토 버튼 활성화
- 검토 성공 후 별도 확인을 거친 승인
- 새로고침과 프로세스 재시작 후 상태 복구
- 중복 제출과 중복 Codex 호출 차단

웹 서버는 셸 문자열을 조합하거나 임의 저장소 경로를 실행하지 않는다. 허용된 현재 저장소와 검증된 run ID 및 integration branch만 다룬다.

## 14. Adaptive Router

초기에는 명시적인 정책 규칙을 사용한다. 데이터가 쌓이면 작업 유형, 파일, 네 가지 triage 점수, 변경량, 저장소 영역과 모델별 과거 성공률을 입력으로 사용한다.

선택 목표는 가장 강한 모델이 아니라 다음 조건을 만족하는 가장 저렴한 모델이다.

```text
선택 모델 = 목표 성공 확률을 만족하는 최소 예상 비용 모델
```

## 15. 핵심 지표

- First-pass success rate
- Retry 및 escalation rate
- 평균 완료 시간
- 성공 작업당 Codex/Gemini 토큰
- 성공 작업당 정규화 비용
- 환경·권한 오류 차단 횟수
- verifier와 Codex가 발견한 결함 수
- 사용자 거절률
- unexpected scope rate
- 모델별 성공률과 승격률

```text
Efficiency = Successful Tasks / Normalized Total Cost

Normalized Total Cost =
  Codex 비용 + Gemini 비용 + 재시도 비용
  + 실행 시간 패널티 + 사람 재작업 패널티
```

## 16. 2026-09-09 구현 시도 상태

아래 결과물은 격리된 worker branch에서 생성됐으며 `main`에 병합되지 않았다.

| 실행 | 결과 | 확인된 내용 | 미통합 이유 |
|---|---|---|---|
| 계산기 `/calculator` | 실패 | 전용 로직 테스트 23개 통과 | 검증 환경에서 `npm` PATH를 찾지 못해 `ENVIRONMENT_ERROR`로 종료 |
| 이벤트 기반 라우터 core | 실패 | 상태 계약 테스트 94개, 기존 병렬 사용량 테스트 95개, 런처 테스트 46개 통과 | 최종 검증에서 `INTERFACE_ERROR`로 에스컬레이션 |
| 라우터 관측 대시보드 | worker 완료 | TypeScript 테스트 80개와 production build 통과 | 같은 실행의 core 작업 실패로 통합 후보 미생성 |
| `/chat` 웹 제어면 | 실패 | 구현 시도 생성 | 허용 범위를 벗어난 변경이 감지되어 `POLICY_VIOLATION`으로 차단 |

이 결과는 실패를 숨기지 않고 다음 구현에 활용한다. 계산기는 환경 분류가 의도대로 AI 재시도를 막은 사례이고, `/chat`은 파일 소유권 정책이 범위 이탈을 차단한 사례다.

## 17. 단계별 구현 순서

1. npm/Node 실행 경로를 런처와 검증기에서 일관되게 정규화
2. compact 상태·결과 스키마와 원자적 상태 전이부터 독립적으로 통합
3. Failure Classifier와 Codex 단발 diagnosis/review 명령 분리
4. 대시보드 관측 기능을 새 상태 계약에 연결
5. `/chat` 범위를 더 작게 나눠 API 안전성 계층과 UI를 순차 구현
6. Repository Memory와 부분 무효화 추가
7. Context Compiler와 Test Impact Analysis 추가
8. Risk/Confidence Gate 추가
9. Golden Patch와 Adaptive Router를 충분한 실행 데이터가 쌓인 뒤 활성화

## 18. 완료 기준

- `running`/`retrying` 동안 Codex 호출 0회
- 계획·진단·검토 호출 이유가 모두 기록됨
- 환경·권한 오류는 AI 재시도 0회
- 상태 파일 원자성 및 재시작 복구 테스트 통과
- 정책 위반과 경로 탈출 테스트 통과
- targeted test와 full integration test 분리
- 위험도에 따른 Codex 검토 정책 테스트 통과
- 사용자 승인 없이 `main`이 변경되지 않음
- 기존 명령과 대시보드 기능 회귀 없음
