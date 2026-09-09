# 2026-09-09 Gemini Worker 실패 원인 분석

## 요약

2026-09-09에 실행한 세 작업은 모두 최종 통합에 실패했지만, 기록을 분석한 결과 Gemini의 구현 능력 부족이 주원인은 아니었다. 계산기 테스트와 이벤트 라우터 테스트는 대부분 통과했으며, 실패는 오케스트레이터의 환경 정규화와 판정 로직에서 발생했다.

| 실행 | 표면 상태 | 실제 원인 | 성격 |
|---|---|---|---|
| 계산기 `/calculator` | `ENVIRONMENT_ERROR` | 검증 자식 프로세스에서 `npm`을 PATH로 찾지 못함 | 실행 환경 구성 문제 |
| 이벤트 기반 라우터 core | `INTERFACE_ERROR` | 성공 보고서에 포함된 오류 분류 명칭을 실제 오류로 오인 | Failure Classifier 오탐 |
| `/chat` 웹 제어면 | `POLICY_VIOLATION` | `[runId]`를 포함한 정확한 경로를 PowerShell wildcard 패턴으로 해석 | 허용 경로 비교 버그 |

라우터 관측 대시보드 작업은 자체 테스트와 빌드를 모두 통과했지만, 같은 실행의 core 작업이 오탐으로 실패하면서 integration candidate가 생성되지 않았다.

## 1. 계산기 실행 실패

### 관측 결과

- Gemini 상태: `completed`
- 정책 검사: PASS
- 변경 파일: 허용된 3개 파일과 정확히 일치
- 계산기 전용 테스트: 23개 통과, 0개 실패
- 후속 `npm` 명령 3개: 명령 자체를 찾지 못해 실패

실패한 명령은 다음과 같다.

```text
npm --prefix gemini-dashboard run test
npm --prefix gemini-dashboard run lint
npm --prefix gemini-dashboard run build
```

공통 오류:

```text
'npm' is not recognized as an internal or external command
```

### 근본 원인

검증기는 Windows에서 테스트 문자열을 `cmd.exe /d /s /c`로 실행한다. 라우터를 시작한 환경에서는 Node 실행 파일을 사용할 수 있었지만, 검증 자식 프로세스가 상속한 PATH에는 `npm.cmd`의 설치 경로가 포함되지 않았다.

따라서 구현과 계산 로직은 정상인데 검증 환경만 실패했다. `ENVIRONMENT_ERROR`로 분류하고 Gemini 재시도를 중단한 결정 자체는 v2 정책에 맞다.

### 수정 권장안

1. 라우터 시작 시 `node.exe`, `npm.cmd`를 `Get-Command`와 표준 설치 경로에서 탐색한다.
2. 찾은 디렉터리를 오케스트레이터와 모든 검증 자식 프로세스의 PATH에 명시적으로 전달한다.
3. Windows 테스트 명령은 필요하면 확인된 `npm.cmd` 절대 경로로 정규화한다.
4. 워커 실행 전 환경 preflight를 수행해 `node --version`, `npm.cmd --version` 실패 시 AI 호출 전에 종료한다.
5. PATH가 없는 mock 환경을 이용한 회귀 테스트를 추가한다.

## 2. 이벤트 기반 라우터 core 실패

### 관측 결과

- Gemini 상태: `completed`
- 정책 검사: PASS
- 이벤트 계약 테스트: 94개 통과
- 병렬 사용량 테스트: 95개 통과
- 대시보드 런처 테스트: 46개 통과
- 검증 명령 exit code: 모두 0
- 최종 판정: `INTERFACE_ERROR`

테스트가 모두 통과했는데 구조적 오류로 분류된 것은 모순이다.

### 근본 원인

현재 오케스트레이터는 다음 내용을 하나의 문자열로 합쳐 Failure Classifier에 전달한다.

```powershell
$failureParts = @($state.error, $state.finalResponse) + failedTestOutputs
```

그리고 분류기는 문자열 어디에든 아래 단어가 있으면 오류로 판정한다.

```text
INTERFACE_ERROR
CONTRACT_MISMATCH
schema mismatch
...
```

Gemini의 성공 보고서에는 구현한 에스컬레이션 정책을 설명하면서 다음 문장이 포함됐다.

```text
INTERFACE_ERROR, DESIGN_ERROR, ... 발생 시 즉시 requiresCodex
```

분류기가 이 문서 설명 속 `INTERFACE_ERROR`를 실제 오류 신호로 오인했다. 즉, **성공 보고서의 설명 텍스트를 실패 판정 입력으로 사용한 오탐**이다.

### 수정 권장안

1. `state.status=completed`이고 모든 검증 명령이 PASS라면 자유 형식 `finalResponse`를 실패 분류에 사용하지 않는다.
2. 실패 분류 입력은 구조화된 `workerReportedFailure`, 비어 있지 않은 `state.error`, 실패한 테스트 출력으로 제한한다.
3. 워커가 보고하는 failure category는 JSON enum 필드로 받으며 자연어 문자열 검색을 제거한다.
4. 분류 우선순위를 `policy/timeout/cancel → failed tests → structured worker failure → PASS`로 바꾼다.
5. 성공 보고서가 모든 오류 enum 이름을 언급해도 PASS가 유지되는 회귀 테스트를 추가한다.

## 3. `/chat` 웹 제어면 실패

### 관측 결과

- Gemini 상태: `completed`
- 최종 판정: `POLICY_VIOLATION`
- 변경 파일 대부분은 허용 범위와 일치
- 위반으로 표시된 3개 경로는 실제로 allowed files 목록에도 정확히 존재

오탐 경로:

```text
gemini-dashboard/app/api/chat/runs/[runId]/route.ts
gemini-dashboard/app/api/chat/runs/[runId]/actions/route.ts
gemini-dashboard/app/api/chat/runs/[runId]/actions/route.test.ts
```

### 근본 원인

현재 허용 경로 검사는 `/**` 접두사 규칙이 아닌 경우 PowerShell의 `-like` 연산자를 사용한다.

```powershell
$Path -like $pattern
```

PowerShell wildcard 문법에서 대괄호는 리터럴 문자가 아니라 문자 집합 패턴이다. 따라서 실제 디렉터리명 `[runId]`가 정확한 허용 경로에 들어 있어도 문자열 그대로 일치하지 않는다.

보안 정책은 정상적으로 차단했지만, 경로 비교 방식 때문에 정상 변경을 정책 위반으로 오인했다.

### 수정 권장안

1. wildcard가 없는 allowed file은 `OrdinalIgnoreCase` 기반 정확한 문자열 비교를 사용한다.
2. 지원하는 wildcard를 `/**` 접미사 하나로 제한하고 나머지는 리터럴로 처리한다.
3. 범용 wildcard가 꼭 필요하면 입력 패턴을 명시적으로 escape한 뒤 별도 타입으로 관리한다.
4. `[runId]`, `[slug]`, 공백, 한글, 괄호가 포함된 경로 회귀 테스트를 추가한다.
5. policy report에 `matchedPattern`과 `comparisonMode`를 기록해 다음 진단 비용을 낮춘다.

## 4. 관측 대시보드 작업이 통합되지 않은 이유

이벤트 기반 라우터 실행은 두 개의 독립 작업으로 구성됐다.

- TASK-001: core 라우터와 상태 계약
- TASK-002: compact 상태 관측 대시보드

TASK-002는 TypeScript 테스트 80개와 production build를 통과했다. 그러나 TASK-001이 Failure Classifier 오탐으로 `INTERFACE_ERROR`가 되면서 전체 실행 상태가 `failed`가 됐고 integration branch를 만들지 않았다.

이는 부분 성공 결과를 자동 병합하지 않는 현재 안전 정책의 정상 동작이다. 다만 다음 버전에서는 성공한 독립 task commit을 보존하고 재실행 계획에 재사용할 수 있도록 해야 한다.

## 5. 공통 원인

세 실패는 다음 공통점을 가진다.

1. Gemini는 허용 범위 안에서 구현을 완료했다.
2. 여러 결정적 테스트가 실제로 통과했다.
3. 실패는 모델의 코딩 결과보다 실행기와 정책 계층의 경계 조건에서 발생했다.
4. compact failure record가 구체적인 근거 대신 분류명만 기록해 추가 진단이 필요했다.

즉 현재 병목은 **Gemini 모델 성능이 아니라 오케스트레이터의 환경·분류·경로 비교 정확도**다.

## 6. 우선 수정 순서

### P0 — 오탐 방지

1. 정확한 경로 비교와 `[runId]` 리터럴 처리
2. 성공 응답을 Failure Classifier 입력에서 제외
3. 모든 테스트 PASS 시 자연어 분류가 PASS를 덮어쓰지 못하도록 결정 순서 수정

### P1 — 환경 사전 검사

1. Node/npm 절대 경로 탐색 및 자식 프로세스 전달
2. worker 시작 전 toolchain preflight
3. `ENVIRONMENT_ERROR`에 누락 실행 파일과 탐색 경로를 compact evidence로 기록

### P2 — 재사용과 진단성

1. 성공한 독립 worker commit 보존
2. 실패 run 재계획 시 성공 task 재사용
3. `category`, `evidence`, `source`, `recommendedAction`을 포함한 구조화된 failure record

## 7. 필수 회귀 테스트

```text
1. PATH에 npm이 없고 표준 경로에 npm.cmd가 있을 때 검증 성공
2. 성공 보고서가 INTERFACE_ERROR 문자열을 포함해도 PASS
3. 실패 테스트의 구조화된 category만 Failure Classifier가 사용
4. [runId], [slug], 한글, 공백 경로 exact match 성공
5. 실제 allowed scope 밖 변경은 계속 POLICY_VIOLATION
6. 한 worker 실패 시 다른 completed worker commit 보존
7. ENVIRONMENT_ERROR와 PERMISSION_ERROR는 Gemini 재시도 0회
```

## 8. 결론

안전 장치 자체는 제대로 작동했다. 환경 오류에서 불필요한 Gemini 재시도를 막았고, 정책 검사에서 의심되는 경로를 병합하지 않았으며, 한 작업이 실패하자 부분 결과를 `main`에 자동 반영하지 않았다.

다음 단계는 안전 장치를 약하게 만드는 것이 아니라 판정 입력을 구조화하고 경로·환경 처리를 정확하게 만드는 것이다. 위 P0와 P1을 먼저 해결한 뒤 기존 worker branch 결과를 재검증하면 계산기, 이벤트 기반 라우터와 `/chat` 작업을 다시 처음부터 구현할 필요 없이 복구할 가능성이 높다.

