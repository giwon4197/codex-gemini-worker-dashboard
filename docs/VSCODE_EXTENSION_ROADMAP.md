# Codex × Gemini VS Code Extension 로드맵

## 문서 목적

이 문서는 현재 웹 기반 로컬 멀티 에이전트 작업 공간을 VS Code Extension으로 확장하기 위한 협업 가이드다.

범위는 다음 지점까지로 제한한다.

```text
현재 Web Workspace 안정화
        ↓
공용 Orchestrator Core와 UI 분리
        ↓
VS Code Extension 구현
        ↓
설치 가능한 VSIX 패키지와 사용 가이드 배포
```

다중 사용자 협업, 조직 단위 권한, 공유 작업 큐, Multi-Repository 플랫폼은 이 문서의 범위가 아니다. Codex와 Gemini 워커 사이의 로컬 협업 구조는 유지한다.

## 현재 시스템 기준선

현재 프로젝트는 다음 실행 흐름을 제공한다.

```text
사용자
  ↓
Codex 대화 및 요청 분류
  ↓
실행 계획과 사용자 승인
  ↓
Orchestrator
  ↓
Gemini Worker + Git Worktree
  ↓
검증 · 재시도 · 에스컬레이션
  ↓
Codex 검토
  ↓
통합 브랜치 · main · GitHub
```

웹은 대화, Run 상태, 작업 그래프, 워커 이벤트, 검토 상태를 표시한다. Extension은 이 엔진을 새로 구현하지 않고 같은 Core를 호출하는 VS Code 전용 인터페이스가 되어야 한다.

## 목표 사용자 경험

### 대화 모드

일반 질문은 워커를 생성하지 않고 Codex 대화만 제공한다.

```text
┌──────────────────────────────────────┐
│ Codex × Gemini                       │
├──────────────────────────────────────┤
│                                      │
│             Conversation             │
│                                      │
├──────────────────────────────────────┤
│ Codex 조회하기 | Gemini 조회하기        │
└──────────────────────────────────────┘
```

### 실행 모드

코드 작업이 승인되면 작업 그래프가 자동으로 나타난다.

```text
┌────────────────────────┬─────────────┐
│                        │ 최신 ↑       │
│      Conversation      │ Review   ○  │
│                        │ TASK-003 ↻  │
│ User: ...              │ TASK-002 ✓  │
│ Codex: ...             │ TASK-001 ●  │
│                        │ 시작 ↓       │
│ [승인 후 실행]           │             │
├────────────────────────┴─────────────┤
│ Run: 워커 2명 · 재시도 1회 · 검토 대기   │
└──────────────────────────────────────┘
```

### 검토 모드

작업이 끝나면 선택한 노드의 Git diff, 변경 파일, 테스트 결과와 승인 동작을 표시한다. 완료 워커의 라이브 CLI는 활성 영역에서 제거하되 작업 그래프와 이력에는 보존한다.

## 1단계: 현재 Web Workspace 안정화

Extension 작업 전 다음 기준선이 `main`에서 통과해야 한다.

- 일반 대화와 실행 요청을 구분하고 일반 대화에는 워커를 만들지 않는다.
- 승인 후에만 실제 Run과 워커를 생성한다.
- Visual Studio Git Graph 형태의 작업 그래프가 실제 이벤트 관계로만 구성된다.
- 상세보기에서 실제 NDJSON 활동과 정제된 원본 CLI 출력을 확인할 수 있다.
- 안전한 실패에는 멱등적인 재시도 동작을 제공한다.
- 정책 위반, 파괴적 작업, 비밀정보 관련 실패는 자동 재시도하지 않는다.
- Codex와 Gemini 사용량은 사용자가 `조회하기`를 누를 때만 가져온다.
- 서버 재시작과 새로고침 후 Run, 그래프, 선택 상태를 복구한다.
- `npm test`, `npm run lint`, `npm run build`가 통과한다.

## 2단계: Core와 UI 분리

### 원칙

Web과 Extension이 동일한 실행 상태와 정책을 사용해야 한다.

```text
Web UI ─────────┐
                ├── Orchestrator Core
VS Code UI ─────┘        ├─ Request Classifier
                         ├─ Task/Worker Manager
                         ├─ Event Store
                         ├─ Git Worktree Manager
                         ├─ Verifier
                         ├─ Retry/Policy Engine
                         └─ Usage Providers
```

### Core가 소유할 책임

- 요청 분류와 계획 계약
- 승인과 멱등 키
- Run, Task, Worker 상태 전이
- 실제 CLI 프로세스 실행과 종료 감지
- 구조화 이벤트 기록과 로그 정제
- 재시도 가능성 및 사용자 조치 판정
- Git worktree와 통합 브랜치 관리
- 검증 결과와 리뷰 자료 생성
- Codex/Gemini 사용량 공급자

### UI가 소유할 책임

- 대화, 작업 그래프, 상세보기 렌더링
- 승인·재시도·조회하기 동작 전달
- 현재 선택 상태와 접근성
- VS Code 테마 및 레이아웃 대응

UI에서 프로세스를 직접 실행하거나 Run 상태를 임의로 생성하지 않는다.

## 3단계: VS Code Extension

### 제공 화면

- Activity Bar의 전용 Codex × Gemini 아이콘
- Primary Side Bar의 대화 Webview
- 실행 시 자동으로 나타나는 Task Tree 또는 분할 Webview
- 선택 노드의 상세 이벤트, 변경 파일, 테스트 결과
- VS Code Status Bar의 간결한 Run 상태와 사용량 조회 진입점
- 실패 노드의 안전한 재시도 버튼

### VS Code에서 전달할 컨텍스트

Extension은 사용자의 명시적 요청과 승인 범위에서 다음 정보를 Core에 전달한다.

- 현재 workspace와 Git 저장소
- 현재 브랜치와 HEAD
- 활성 편집기 파일
- 선택한 코드 범위
- 열려 있는 파일 목록
- Problems의 진단 항목
- 현재 Git diff 요약
- 사용자가 선택한 테스트 실패 정보

전체 저장소를 매 요청마다 무조건 전달하지 않는다. 전달된 컨텍스트의 출처를 작업 요청에 명확히 기록한다.

### 명령 팔레트

최소 명령은 다음과 같다.

- `Codex × Gemini: Open Workspace`
- `Codex × Gemini: Explain Selection`
- `Codex × Gemini: Plan Fix for Selection`
- `Codex × Gemini: Show Active Run`
- `Codex × Gemini: Review Changes`
- `Codex × Gemini: Refresh Usage`

설명 명령은 워커를 생성하지 않는다. 수정 명령은 계획과 승인 단계를 거친다.

### 상태 표시

```text
idle → planning → awaiting approval → running
     → retrying → verifying → awaiting review
     → completed | failed | action required
```

VS Code 화면과 웹 화면은 같은 Run ID와 상태를 보여야 한다. Extension을 다시 열어도 디스크의 영속 상태를 기준으로 복구한다.

## 사용량 UI

원형 그래프를 사용하지 않고 작은 한 줄 형태를 사용한다.

```text
◴ Codex 사용량                         조회하기
◴ Gemini 사용량                        조회하기
```

조회 후에는 같은 위치에 남은 비율을 표시한다.

```text
◴ Codex 사용량                          59% 남음
◴ Gemini 사용량                         45% 남음
```

- 사용자가 누른 경우에만 실제 사용량을 조회한다.
- 조회 중에는 `조회 중…`, 실패하면 `다시 조회`를 표시한다.
- 퍼센트 hover, 키보드 focus 또는 모바일 대응 UI에서 초기화 날짜와 남은 시간을 표시한다.
- Gemini는 5시간 한도와 주간 한도를 구분한다.
- 조회 실패를 0%로 표현하지 않는다.
- 마지막 정상 값과 조회 시각을 캐시하되 자동 반복 조회하지 않는다.

## 작업 그래프와 상세 이벤트

- 최신 이벤트가 위에 오도록 아래에서 위로 진행한다.
- 병렬 워커는 Git branch처럼 분기되고 검토 단계에서 다시 합류한다.
- 그래프는 저장된 실제 부모·자식 이벤트 관계만 사용한다.
- 각 끝단에 담당자, 상태, 경과 시간, 완료 시각을 표시한다.
- 상세보기는 `LOAD`, `SEARCH`, `EDIT`, `SAVE`, `RUN`, `PASS`, `FAIL`, `DONE` 등 실제 기록만 표시한다.
- 원본 CLI 출력은 접이식 읽기 전용 영역으로 제공한다.
- 토큰, 인증정보, 사용자 홈 절대경로를 UI와 로그에서 정제한다.

## 안전한 재시도

- 일시적인 실행기 오류나 검증 실패에만 재시도 버튼을 제공한다.
- 원래 요청, 실패 원인, 시도 번호와 새 Run ID의 연결을 유지한다.
- 중복 클릭과 중복 프로세스 생성을 멱등 키로 차단한다.
- 실행 중에는 버튼을 비활성화한다.
- 정책 위반, 비밀정보, 파괴적 작업, 사용자 결정 필요 상태에는 조치 사유만 표시한다.

## Extension 프로젝트 구조 권장안

```text
packages/
├─ orchestrator-core/
│  ├─ contracts/
│  ├─ runs/
│  ├─ workers/
│  ├─ events/
│  ├─ git/
│  ├─ verification/
│  └─ usage/
├─ web-ui/
└─ vscode-extension/
   ├─ src/extension.ts
   ├─ src/commands/
   ├─ src/providers/
   ├─ src/webview/
   ├─ media/
   └─ package.json
```

실제 이동은 한 번에 대규모로 수행하지 않는다. 먼저 계약과 읽기 전용 조회 계층을 추출하고, 테스트를 유지하면서 실행 계층을 단계적으로 이동한다.

## 구현 순서

1. 현재 웹의 회귀 테스트와 실행 상태를 안정화한다.
2. 공용 타입과 Run/Worker/Event 읽기 API를 Core로 분리한다.
3. 승인, 실행, 재시도 API를 Core 서비스로 이동한다.
4. 기존 Web이 분리된 Core를 사용하도록 변경하고 전체 회귀 테스트를 통과시킨다.
5. VS Code Extension을 생성하고 현재 workspace·브랜치·활성 파일을 연결한다.
6. 대화 화면과 일반 질문 경로를 연결한다.
7. 계획, 승인, 실행과 Task Tree를 연결한다.
8. 상세 이벤트, diff, Problems, 테스트 결과를 연결한다.
9. 사용량 조회와 Status Bar 상태를 연결한다.
10. 재시작 복구, 오류 처리, 접근성과 테마를 검증한다.
11. VSIX를 생성하고 깨끗한 VS Code 프로필에서 설치 테스트한다.

## 완료 기준

- 웹과 Extension이 동일한 Core 및 상태 계약을 사용한다.
- 일반 대화가 워커를 생성하지 않는다.
- 승인당 실제 Run이 정확히 한 번 생성된다.
- Extension에서 현재 저장소·파일·선택 코드·진단·diff를 선택적으로 전달할 수 있다.
- 작업 그래프와 상세 이벤트가 실제 영속 기록으로 복구된다.
- 재시도와 사용량 조회가 요구된 안전 경계를 지킨다.
- Extension 재시작 후 진행 중인 Run을 다시 표시한다.
- Web 회귀 테스트와 Core/Extension 테스트가 통과한다.
- VSIX 설치 후 주요 흐름을 수동 검증한다.
- 비밀정보와 사용자 절대경로가 로그와 UI에 노출되지 않는다.

## 범위 제외

이번 단계에서는 다음을 구현하지 않는다.

- 사용자 간 실시간 협업
- 팀 공유 대화 및 작업 큐
- 조직 단위 역할·권한·승인 정책
- Multi-Repository 작업 DAG
- 공유 Repository Memory
- 조직용 분석 및 과금 관리
- 자동 Production 배포

이 기능들은 단일 사용자·단일 저장소 Extension이 안정화된 이후 별도 제안서에서 다룬다.

## 협업 규칙

- 작업 시작 전 관련 계약과 테스트를 먼저 확인한다.
- UI 상태를 추측으로 생성하지 않고 실제 Core 이벤트만 표시한다.
- 기존 API를 변경할 때는 하위 호환성과 마이그레이션 경로를 명시한다.
- 파일 소유권이 겹치는 병렬 작업은 피한다.
- 모든 변경은 격리 브랜치에서 수행하고 테스트 결과와 남은 위험을 기록한다.
- `main` 병합 전 diff, 테스트, 빌드와 VSIX 설치 결과를 검토한다.

