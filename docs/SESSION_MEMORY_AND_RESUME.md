# 세션 메모리와 작업 재개 설계

> 새 세션에서도 이전 작업을 안전하고 토큰 효율적으로 이어받기 위한
> 구현 설계 문서다. 코드 변경은 포함하지 않는다.
> 전체 구조는 [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md),
> 성능·학습 확장은 [v2.2/v2.3 로드맵](V2_2_V2_3_ROADMAP.md),
> 파일 범위 정책은
> [v2.1 Filesystem Policy](V2_1_FILESYSTEM_POLICY.md),
> Extension 정책은
> [VSCODE_EXTENSION_ROADMAP.md](VSCODE_EXTENSION_ROADMAP.md)를 따른다.
> 용어는 [CONTEXT.md](../CONTEXT.md)의
> Gate, Cycle, Run, Evidence 정의를 사용한다.

## 1. 목적과 범위

목표는 다음 두 가지를 동시에 만족하는 것이다.

- 사용자가 새 창·새 세션을 열어도 이전 대화와 Run의 현재 상태를
  잃지 않는다.
- 다음 Codex·Gemini 호출에 필요한 최소 기억만 전달해
  재탐색과 반복 설명을 줄인다.

범위는 로컬 단일 사용자·단일 저장소다. 다음은 범위 밖이다.

- 팀 공유 메모리
- 다중 사용자·조직 정책
- Multi-Repository 작업 DAG
- 기억을 이용한 자동 승인이나 자동 `main` 병합
- Claude식 자유형 장기 대화 기억 전체 복제

기억은 편의를 높일 수 있지만 다음을 대신할 수 없다.

- Plan Approval Gate
- Review Gate와 사용자 병합 결정
- `allowed_files`·sensitive·forbidden 정책
- 결정적 검증과 Risk Floor

## 2. 현재 상태

### 2.1 저장되는 것

Core는 허용된 저장소 루트 아래 `.agent/dashboard-state`에 다음을
원자적으로 저장한다.

- compact Run 상태:
  `packages/orchestrator-core/workspace-store.ts`의
  `saveCompactRunState`, `getCompactRunState`
- 실행 메타데이터와 로그:
  `saveLaunchMetadata`, `getLaunchMetadata`,
  `getRunLogPath`, `getRunLogContent`
- dashboard Run과 실제 Run 연결:
  `saveAliasRecord`, `getAliasRecord`, `findAndLinkActualRun`
- 대화 세션:
  `saveConversationSession`, `getConversationSession`,
  `listConversationSessions`
- 승인 멱등성:
  `getIdempotencyRecord`, `saveIdempotencyRecord`

대화 계약은 메시지, `pendingApproval`, `lastApproval`,
`linkedRunIds`를 보존한다.

- `packages/orchestrator-core/workspace-contract.ts`의
  `ConversationSession`
- `ConversationMessage`
- `ConversationApproval`

`gemini-dashboard/lib/workspace-contract.ts`와
`gemini-dashboard/lib/workspace-store.ts`는 Core 구현을 다시 내보내는
호환 계층이다. 실제 계약 변경은 `packages/orchestrator-core`에서 한다.

Run 상세 조회는 manifest, launch metadata, PID 생존 검사를 결합해
재시작 후 상태를 정정한다.

- `settleRunState`
- `listCompactRuns`
- `getRunDetails`
- `packages/orchestrator-core/process-liveness.ts`의 생존 검사

### 2.2 복원되지만 이어지지 않는 것

현재 구조의 한계는 저장이 아니라 재사용이다.

1. 저장된 대화는 UI 복원에만 쓰인다.
2. 다음 Codex 호출에는 현재 요청만 들어간다.
3. Codex는 `--ephemeral` 단발 호출이다.
4. Gemini는 매 호출에 `--new-project`를 사용한다.
5. workspace 단위의 현재 선택이 디스크에 없다.

구체적인 근거는 다음과 같다.

- `packages/orchestrator-core/codex-conversation.ts`의
  `buildPromptForCodex`는 분류 지침과 단일 사용자 입력만 조립한다.
- `evaluateCodexConversation`은 Codex 호출이 끝난 뒤에야 기존 세션을
  읽고 새 메시지를 추가한다.
- 승인 실행은 저장된 승인 카드의 `prompt`만 라우터로 넘긴다.
- `run-gemini-worker.ps1`은 매 invocation에
  `--new-project`, `--print $Prompt`를 사용한다.
- Extension 활성화는
  `vscode-extension/src/webview/conversation-view.ts`의
  `ConversationViewProvider.startFreshWindow`를 호출해 새 대화를 만든다.
  호출 지점은 `vscode-extension/src/extension.ts`의 활성화 경로와
  workspace folder 변경 handler다.
- 저장된 Run이 없는 fresh window는 이전 Run을 자동 채택하지 않는다:
  `vscode-extension/src/restore-state.ts`의
  `resolveTrackedRunId`, `resolveSessionId`.
- Dashboard 대화 목록 API는 최신 세션을 active로 선택할 뿐
  명시적인 resume API가 없다:
  `gemini-dashboard/lib/workspace-node-bridge.ts`의
  `GET /api/conversations`.

따라서 현재 모델은 정확히 말하면 다음과 같다.

```text
전체 기록 저장 + 요청별 독립 추론
```

### 2.3 Extension 복원 경계

Extension은 다음을 유지해야 한다.

- 저장된 세션과 추적 Run 연결은 복구할 수 있다.
- 자신이 추적하지 않던 진행 중 Run은 자동 채택하지 않는다.
- 연결되지 않은 Run은 Status Bar에 알린다.

이 정책은 이미 다음에 구현되어 있다.

- `vscode-extension/src/core-host.ts`의 `restoreWorkspaceBindings`
- `vscode-extension/src/webview/conversation-view.ts`의
  `restoreFromDisk`, `syncRunState`
- `vscode-extension/src/ids.ts`의
  `SESSION_STATE_KEY`, `TRACKED_RUN_KEY`

새 resume 기능도 이 경계를 깨지 않아야 한다. 이전에 실행 중이었다는
이유만으로 다른 저장소나 다른 Run을 현재 작업으로 승격하지 않는다.

## 3. Claude Memory와 비교

Claude Memory와 개념은 유사하지만 같은 기능으로 취급하면 안 된다.
이 프로젝트에서는 세 종류를 분리한다.

| 종류 | 내용 | 수명 | 우선순위 |
|---|---|---|---|
| 사용자 선호 | 모델, 언어, 설명 상세도, UI 표시 같은 명시적 설정 | 길다 | 강제 정책보다 낮다 |
| 작업 resume 상태 | 현재 대화, 현재 Run, 승인, 검증 결과, 미해결 위험 | Cycle 안에서는 유지, 종료 후에는 요약만 | 기존 Run/Event Store가 권위 출처 |
| Repository Memory | 구조, 심볼, 의존성, 테스트 매핑, 위험도, 검증된 패치 요약 | 파일·HEAD 변경 기반 무효화 | 요청별 최소 주입 |

이미 문서화된 Repository Memory 구조는 다음과 같다.

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

출처는 [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md)
이다. 이 문서는 그 설계를 대체하지 않고, 그 전에 필요한
작업 resume 계층을 먼저 정의한다.

사용자 선호의 첫 진입점은 이미 Web과 Extension이 공유하는
설치 루트의 `worker-settings.json`이다. 현재 계약은 `tier`, `model`,
`codexModel`, `updatedAt`만 지원하며 저장소별 override와 언어·설명
상세도 같은 memory 선호는 아직 구현되어 있지 않다.

- `packages/orchestrator-core/worker-settings.ts`
- `vscode-extension/src/core-host.ts`의 `syncWorkerSettings`

현재 Extension의 `syncWorkerSettings`는 VS Code 설정 변경 시 Core 설정에
쓰는 경로다. 활성화 시 `worker-settings.json`을 읽어 Extension UI에
역동기화하는 경로는 없으므로, 사용자 선호 자동 적용을 구현할 때 별도의
조회·초기화 흐름을 추가한다.

## 4. 권장 아키텍처

전체 대화를 매번 재전송하지 않는다. 기본 조합은 다음과 같다.

```text
구조화 resume 상태 + 최근 메시지 + 요청별 검색 결과
```

### 4.1 왜 전체 재전송이 아닌가

대화 turn당 평균 추가 기록을 `h` 토큰이라 하자. `n`번째 요청 입력은
약 `n·h`가 되고 세션 전체 추가 입력은 대략 다음과 같이 증가한다.

```text
h·n(n+1)/2
```

반면 고정 크기 요약을 `S` 토큰으로 유지하면 전체 추가 입력은 대략
`n·S`다. 구조화 resume 상태는 필요한 필드만 보내므로 보통 고정 또는
완만하게 증가한다.

이 프로젝트에는 이미 plan, approval, `linkedRunIds`, compact Run,
검증 결과가 있다. 이들을 다시 자유형 대화로 복원하는 것보다 구조화
상태로 유지하는 편이 토큰과 정확성 모두에 유리하다.

### 4.2 요청 처리 흐름

```text
사용자 요청
  → 명시적 사용자 선호 조회
  → workspace resume 상태 조회
  → 저장소·HEAD 유효성 검사
  → Triage와 Risk Floor
  → Codex 계획 필요 여부 결정
  → Task Contract 생성
  → Context Compiler가 최소 컨텍스트 구성
  → Gemini 실행
  → 결정적 검증
  → resume 상태와 candidate memory 갱신
  → 사용자 병합 확인 후 Golden Patch 승격 검토
```

Memory는 지시가 아니라 참고 데이터로 전달한다. 과거 패치나 대화의
자유형 텍스트를 system instruction과 직접 연결하지 않는다.

## 5. 데이터 설계

### 5.1 Workspace resume 상태

새 파일 위치는 다음을 권장한다.

```text
.agent/dashboard-state/workspace/current.json
```

`.agent/dashboard-state/`는 이미 `.gitignore`이며 로컬 상태용이다.
Git에 포함하지 않는다.

최소 스키마 예시:

```ts
interface WorkspaceResumeState {
  schemaVersion: 1;
  repositoryId: string;
  activeSessionId?: string;
  activeRunId?: string;
  actualRunId?: string;
  lastMessageId?: string;
  updatedAt: string;
}
```

설계 규칙:

- `repositoryId`는 canonical 저장소 루트 또는 git-root hash다.
- `activeRunId`는 dashboard Run ID를 정식 값으로 사용한다.
- dashboard·actual ID 변환은 기존 alias record로 정규화한다.
- `ConversationSession.linkedRunIds`는 유지한다.
- resume 상태는 현재 선택만 저장하고 Run 상태를 중복 소유하지 않는다.
- 저장은 기존 `atomicWriteJson` 패턴을 사용한다.

다음 시점에 갱신한다.

- 대화 생성과 메시지 저장
- 세션 전환
- Plan Approval로 Run 연결
- 추적 Run 변경
- Run 종료 또는 취소

### 5.2 Conversation resume context

`ConversationSession` 전체를 프롬프트에 넣지 않는다. 다음 형태로
파생된 입력을 구성한다.

```ts
interface ConversationResumeContext {
  recentMessages: Array<{
    sender: 'user' | 'codex';
    text: string;
    timestamp: string;
  }>;
  linkedRun?: {
    runId: string;
    status: RunStatus;
    baseCommit?: string;
    integrationBranch?: string;
    changedFiles?: string[];
    verificationDecision?: string;
  };
}
```

포함 규칙:

- 최근 2~4개 메시지 또는 문자 예산 기준 transcript
- 마지막 연결 Run의 compact/detail 요약
- 절대 경로, 로그 원문, secret은 기존 sanitizer를 거친 값만 포함
- 원문 로그·전체 diff·전체 대화는 ID와 경로만 넣는다

`--ephemeral`은 유지할 수 있다. 최소 구현에 CLI thread ID 저장은
필요하지 않다.

### 5.3 사용자 선호 계약

명시적으로 설정하거나 확인한 항목만 우선 지원한다.

- 기본 Gemini tier
- Codex 모델과 설명 전용 모델
- 응답 언어
- 설명 상세도
- 변경 후 targeted test 우선 같은 테스트 선호
- 간결한 계획 또는 상세한 위험 설명 같은 계획 표현 방식
- 현재 파일, 선택 코드, Problems, Git diff 같은 자동 첨부 컨텍스트 종류
- 완료 알림과 UI 표시 선호
- 기억 기능 활성화 여부와 보존 기간

저장하지 않는 항목:

- API key, access token, 인증 쿠키, 비밀번호
- 사용자 홈 디렉터리 절대경로
- 전체 선택 코드나 클립보드의 장기 저장
- 항상 승인 같은 Gate 무력화 선호
- 보안·테스트·파일 범위 정책을 낮추는 선호
- 한 번의 대화 관찰을 사용자 확인 없이 영구 선호로 승격하는 것

`allowed_files`, sensitive/forbidden scope, Codex 필수 검토, 최종
사용자 승인은 선호가 아니라 강제 정책이다.

목표 저장 우선순위:

1. Core가 읽는 설치 루트의 로컬 사용자 설정(현재 구현)
2. 저장소별 override(신규 구현)
3. VS Code UI 전용 상태

저장소별 override는 현재 `worker-settings.json` 계약에 없으므로 기존 전역
파일의 위치나 의미를 암묵적으로 바꾸지 않는다. 별도 scope와 병합 규칙을
계약으로 추가하고 Web과 Extension이 동일한 Core API를 사용하게 한다.

VS Code `globalState`·`workspaceState`에는 패널 접힘과 선택 탭 같은 UI
상태만 두고, 라우팅에 영향을 주는 선호의 권위 저장소로 사용하지
않는다. 민감정보가 필요하면 별도 credential 저장소를 사용하고 일반
memory 문서에 넣지 않는다. 이 프로젝트에서는 memory에 비밀정보를
저장하지 않는 정책을 권장한다.

### 5.4 Repository Memory와 Golden Patch

Repository Memory는 2단계 이후 범위다. 1단계가 안정되기 전에 전체를
구현하지 않는다.

장기적으로 둘 가치가 있는 정보:

- 저장소 구조 요약
- 심볼과 의존성 그래프
- 파일·영역별 위험도
- 파일·심볼과 관련 테스트 매핑
- 반복적으로 성공한 수정 패턴
- 실패 유형과 유효했던 복구 방식
- 작업 유형·모델별 성공률
- 변경 파일과 검증 결과의 압축 이력

Golden Patch 승격 조건은 엄격하게 둔다.

- 파일 범위 정책 통과
- 필수 테스트와 빌드 통과
- integration branch 생성 성공
- 가능하면 사용자 승인과 실제 병합 확인
- 저장 당시 base·HEAD와 관련 파일 hash 기록
- 실패 결과는 해결 사례가 아니라 실패 증거로 분리

`awaiting_review`만으로 성공 패턴에 승격하지 않는다. 가장 안전한
기준은 병합된 결과만 Golden Patch로 확정하고, 검증만 통과한 결과는
candidate로 보관하는 것이다.

## 6. 통합 지점

### 6.1 Orchestrator Core

수정 대상:

- `packages/orchestrator-core/workspace-contract.ts`
- `packages/orchestrator-core/workspace-store.ts`
- `packages/orchestrator-core/codex-conversation.ts`
- `packages/orchestrator-core/workspace-sanitize.ts`
- 관련 테스트:
  - `workspace-contract.test.ts`
  - `workspace-store.test.ts`
  - `codex-conversation.test.ts`
  - `workspace-sanitize.test.ts`

구현 내용:

1. resume 상태 계약과 조회·갱신 API 추가
2. 저장된 대화에서 resume context 파생 함수 추가
3. Codex 호출 입력에 resume context를 예산 안에서 포함
4. 저장 전 secret·경로 정제 적용
5. Run 상태는 기존 manifest·event를 권위 출처로 유지

`gemini-dashboard/lib` 아래 동명 파일은 Core 재내보내기이므로 직접
수정하지 않는다.

### 6.2 Dashboard

수정 대상:

- `gemini-dashboard/lib/workspace-node-bridge.ts`
- 신규 권장 경로:
  - `gemini-dashboard/app/api/workspace/resume/route.ts`

권장 API:

```http
GET /api/workspace/resume
```

```json
{
  "ok": true,
  "resume": {
    "schemaVersion": 1,
    "activeSessionId": "...",
    "activeRunId": "...",
    "actualRunId": "...",
    "updatedAt": "..."
  },
  "session": {},
  "run": {}
}
```

선택 변경을 웹 UI에서도 영속화해야 한다면 다음을 추가한다.

```http
PUT /api/workspace/resume
{
  "activeSessionId": "...",
  "activeRunId": "..."
}
```

서버는 클라이언트가 보낸 객체를 그대로 저장하지 않는다. ID 검증 후
기존 대화·Run 존재 여부를 확인하고 resume 상태를 재구성한다.

Dashboard는 Core Memory API의 조회·수정 UI 역할을 한다. 권장 기능은
다음과 같다.

- 기억 기능 전체 활성화·비활성화
- 사용자 선호 목록과 출처 표시
- Repository Memory 상태와 마지막 갱신 시각
- 기준 commit과 stale·invalid 표시
- 기억별 provenance 표시
- 수정, 삭제, 만료 연장
- 저장소 memory 전체 초기화
- 다음 호출에 첨부될 memory 미리보기

Core에 없는 기억을 UI에서 임의 생성하거나 Run 상태처럼 표현하지
않는다.

### 6.3 VS Code Extension

수정 대상:

- `vscode-extension/src/extension.ts`
- `vscode-extension/src/webview/conversation-view.ts`
- `vscode-extension/src/restore-state.ts`
- `vscode-extension/src/core-host.ts`
- 관련 테스트:
  - `restore-state.test.ts`
  - `core-host.test.ts`

구현 내용:

1. 활성화 시 기존 binding을 먼저 복구한다.
2. `ConversationViewProvider.startFreshWindow`의 현재 호출 지점은 활성화와
   workspace folder 변경이다. resume 구현 후에는 활성화 경로에서 제거하고,
   명시적인 새 대화 명령·버튼과 실제 workspace 변경에서만 호출한다.
   현재 새 대화 버튼 연결은 없으므로 명령·UI 연결도 함께 구현한다.
3. 저장된 session이 없을 때는 다음 순서로 선택한다.
   - workspace resume 상태의 `activeSessionId`
   - 활성 Run과 연결된 최신 대화
   - 없음이면 새 대화
4. Run은 선택된 대화의 마지막 `linkedRunIds` 항목을 우선한다.
5. 생존 검사를 통과한 경우에만 추적한다.
6. 현재 파일·선택 코드·Problems는 요청별 opt-in으로 유지한다.
7. 장기 memory에는 경로·심볼·테스트 같은 메타데이터만 남긴다.
8. 코드 본문은 현재 저장소에서 다시 읽는다.

Extension 재시작 시:

- 저장된 session·Run 연결은 기존 복구 정책 유지
- 연결되지 않은 Run은 자동 채택하지 않음
- 사용자 선호만 자동 적용 가능
- repository memory가 다른 HEAD 기준이면 무효화 또는 경고

### 6.4 Codex 호출

`codex-conversation.ts`에는 다음만 전달한다.

- 해당 요청에 관련된 사용자 선호
- 현재 HEAD에서 유효한 구조·위험·테스트 요약 일부
- 관련된 과거 성공·실패 사례의 압축 요약
- 각 기억의 출처, 생성 시점, confidence

Memory 텍스트를 명령으로 취급하지 않는다. `fact`, `preference`,
`evidence`, `provenance` 같은 typed field를 사용한다.

### 6.5 Gemini 호출과 Context Compiler

Gemini에는 Context Compiler를 통해 다음만 전달한다.

- Task Contract
- 관련 파일과 심볼
- 관련 테스트
- 저장소 규칙
- 검증된 유사 패치의 구조화 요약

사용자 선호가 `allowed_files`, forbidden operation, Risk Floor,
검증 명령을 바꾸지 않아야 한다.

`run-gemini-worker.ps1`의 `--new-project` 동작은 이 문서에서 바꾸지
않는다. 같은 task의 retry와 Dynamic Write Expansion에서 project key를
재사용하는 개선은
[GEMINI_LOAD_STALL_HANDOFF.md](GEMINI_LOAD_STALL_HANDOFF.md)의 후속
작업으로 다룬다.

### 6.6 Adaptive Router

모델 선택에는 집계 데이터만 사용한다.

- 작업 유형
- complexity·risk·testability·ambiguity
- 저장소 영역
- 모델별 검증 통과율
- 평균 retry 횟수
- 환경 오류를 제외한 실제 구현 실패율

개별 대화의 자유형 내용이나 사용자 코드 조각을 장기 라우팅 feature로
사용하지 않는다.

## 7. 재개 검증 절차

재개는 조회만으로 끝나지 않는다. 다음 순서로 검증한다.

1. 저장소 동일성
   - canonical 저장소 루트 또는 `repositoryId`가 현재 workspace와
     같은지 확인한다.
2. ID 안전성
   - `validateSessionId`와 `validateRunId`를 적용한다.
3. 대화 존재성
   - `getConversationSession(activeSessionId)` 성공 여부를 확인한다.
4. 세션·Run 연결성
   - resume Run이 `session.linkedRunIds`에 포함되는지 확인한다.
   - dashboard·actual ID는 alias record로 정규화한다.
5. Run 상태 복원
   - `listCompactRuns`·`settleRunState`로 manifest, launch metadata,
     PID 생존 검사를 다시 수행한다.
   - 죽은 PID를 running으로 복원하지 않는다.
6. Git 기준 검증
   - `baseCommit` 존재 여부와 integration branch·ref 존재 여부를
     확인한다.
   - 현재 worktree가 dirty이면 자동 실행·재시작은 금지하고 상태
     조회만 허용한다.
7. 승인 검증
   - `pendingApproval`은 표시만 복구하고 자동 승인하지 않는다.
   - 승인된 approval은 `idempotencyKey`와 기존 `runId`를 확인해 중복
     실행을 막는다.
8. 불일치 처리
   - 대화는 복원하되 Run 추적만 해제할 수 있다.
   - 연결되지 않은 활성 Run으로 노출한다.

재개는 기존 Run을 다시 실행하지 않고 기존 대화·Run을 다시 연결하는
것이 기본이다.

## 8. 토큰 예산과 telemetry

### 8.1 권장 예산

한 요청의 기억 입력을 다음처럼 제한한다.

- 구조화 resume 상태: 최대 1,500~2,000 tokens
  - 목표와 비목표
  - 승인된 설계 결정
  - 변경·관련 파일
  - 마지막 성공 검증
  - 실패 fingerprint와 재시도 금지 사항
  - 미해결 위험
  - 연결된 Run·commit ID
- 최근 대화: 마지막 2~4개 메시지, 최대 1,000~1,500 tokens
- 요청별 검색 결과: 상위 3~5개, 합계 최대 2,000~3,000 tokens
- 기억 총예산:
  - 일반 요청 4,000 tokens
  - 복잡한 수정 6,000~8,000 tokens 상한

원문 로그·전체 diff·전체 대화는 기본 재전송하지 않고 ID·경로만 넣은
뒤 필요할 때 검색한다.

예산 초과 시 축소 순서는 다음과 같다.

1. 오래된 최근 대화 제거
2. 검색 결과 개수 축소
3. resume 설명 축약
4. 목표·승인 결정·실패와 안전 제약은 끝까지 유지

전체 대화 재전송은 사용자가 정확한 과거 문구 회상을 요구한 경우에만
일회성으로 허용한다.

### 8.2 Telemetry

현재 토큰 추적 범위는 다음과 같다.

- Gemini:
  - prompt, candidate, cached, thought, total, request 수 분리
  - invocation·attempt 수준 분석 가능
  - 기억 관련 토큰과 일반 탐색 토큰 분리는 미구현
- Codex:
  - `~/.codex/sessions` JSONL tail에서 최신 누적값 추출
  - input·output·cached·reasoning·total 추출
  - 대화 세션이나 Run 귀속 telemetry는 없음

근거 파일:

- `run-gemini-worker.ps1`의 사용량 누적 처리
- `packages/orchestrator-core/codex-usage.ts`의 일별 집계
- `packages/orchestrator-core/daily-token-stats.ts`
- `packages/orchestrator-core/gemini-quota.ts`

새로 기록해야 할 값:

- 호출별 `memoryTokens`
- `recentTokens`
- `retrievedTokens`
- resume 상태 버전과 기준 commit
- 예산 초과로 축소된 항목

`files_read`, `search_calls`, `context_tokens` 수집은
[V2_1_FILESYSTEM_POLICY.md](V2_1_FILESYSTEM_POLICY.md)에서 설계 목표로
명시되어 있으며 현재 보장으로 간주하지 않는다. Codex·Gemini 호출 수와
input·output·cached token, normalized cost 기록은
[V2_2_V2_3_ROADMAP.md](V2_2_V2_3_ROADMAP.md)의 observability 항목이다.

## 9. 보안 정책

현재 Core 정제 기능은 다음과 같다.

- `packages/orchestrator-core/workspace-sanitize.ts`
- `workspace-store.ts`의 실패 원인 정제 처리

Memory 저장에도 동일 정제기를 적용하되 출력 시점뿐 아니라 저장 전
정제가 필요하다.

필수 정책:

1. 비밀정보 차단
   - key·token·password·credential 패턴 발견 시 저장을 거부한다.
   - 단순 마스킹 후 장기 저장보다 저장 생략을 우선한다.
2. 경로 격리
   - 현재 허용 저장소 밖 파일 경로를 거부한다.
   - `..`, 절대경로, symlink escape를 점검한다.
3. prompt injection 방어
   - memory 텍스트를 명령으로 취급하지 않는다.
   - 과거 CLI 출력이나 저장소 문서 지시를 사용자 선호로 승격하지
     않는다.
4. 정책 우선순위
   - 강제 보안 정책 > Risk Floor > Task Contract > 저장소 규칙 >
     사용자 선호
5. 로그 최소화
   - raw prompt, 전체 CLI 출력, 전체 diff 장기 저장을 금지한다.
6. Git 제외
   - 개인 선호와 Run-derived memory는 기본적으로 `.gitignore`한다.
   - 공유 memory는 현재 범위 밖이다.
7. 삭제 가능성
   - 사용자별·저장소별 전체 삭제를 지원한다.
   - 삭제 후 기존 캐시와 Context Compiler 결과도 무효화한다.

로컬 실행이 유출 위험 없음을 의미하지는 않는다. 저장소가 백업·동기화
되거나 악성 프로젝트 파일이 prompt injection을 시도할 수 있으므로
별도 경계가 필요하다.

## 10. 정확성·만료·충돌 정책

각 memory 레코드에 최소한 다음 필드를 권장한다.

```json
{
  "id": "memory-id",
  "kind": "user_preference | repository_fact | patch_candidate",
  "scope": "user | repository",
  "value": {},
  "source": {
    "type": "explicit_user | run | verifier | repository_scan",
    "runId": "optional",
    "baseCommit": "optional"
  },
  "createdAt": "...",
  "lastValidatedAt": "...",
  "expiresAt": "...",
  "confidence": "confirmed | verified | inferred | stale",
  "schemaVersion": 1
}
```

정확성 규칙:

- 사용자 선호는 명시적 입력만 `confirmed` 처리한다.
- LLM 추론 선호는 자동 적용하지 않고 제안 상태로 유지한다.
- Repository fact는 관련 파일 hash가 바뀌면 stale 처리한다.
- branch·HEAD가 달라지면 현재 checkout에서 재검증한다.
- 테스트 매핑은 테스트 파일 또는 관련 symbol 변경 시 무효화한다.
- Run 상태는 memory보다 기존 manifest·event를 우선한다.
- 충돌하는 기억은 최신 항목을 무조건 선택하지 않고 다음 순서로
  선택한다.
  - 명시적 사용자 확인
  - 현재 HEAD에서 검증된 사실
  - 더 구체적인 저장소 scope
- confidence는 LLM 자기평가가 아니라 테스트·정책·병합 증거로 산정한다.

권장 보존 정책:

| 종류 | 권장 정책 |
|---|---|
| 명시적 사용자 선호 | 기본 만료 없음, 180일 미사용 시 재확인 |
| 추론된 선호 제안 | 30일 또는 3회 노출 후 삭제 |
| 활성 Run 상태 | terminal 상태까지 유지, 권위 저장소는 기존 Run Store |
| 완료 Run 압축 요약 | 90일 |
| raw CLI·로그 | 7~30일 |
| 실패 사례 | 30~90일, 동일 fingerprint는 집계 |
| Golden Patch | 관련 파일 hash 변경 시 stale, 최대 최근 N개 유지 |
| 구조·심볼·의존성 map | TTL보다 변경 파일 기반 부분 무효화 |
| 테스트·위험 map | 관련 설정·테스트·보안 파일 변경 시 재검증 |
| VS Code 선택 코드·열린 파일 목록 | 요청 종료 또는 세션 종료 즉시 폐기 |
| 멱등성 레코드 | 관련 승인·Run 종료 후 제한 기간만 유지 |

Repository Memory는 시간 TTL만으로 폐기하기보다 변경 파일·관련 심볼
기반 부분 무효화가 핵심이다.

## 11. 단계별 구현 순서

### 1단계: 안전한 최소 범위

- Core에 resume 상태 계약과 읽기 전용 조회 API 추가
- 명시적 사용자 선호만 지원
- 기존 `worker-settings.json`과 통합
- Dashboard·Extension에 조회·수정·삭제 UI
- 저장 전 secret·경로 정제
- Context Compiler 입력에 선호를 제한적으로 반영
- 승인, Risk Floor, 테스트 정책에는 영향 금지

1단계는 구현 완료다. Core는 `worker-settings.json`의 `memory` 블록과
`deriveWorkspaceResumeCandidate`를 제공하고, Dashboard는 `/settings`와
`/api/settings/memory`·`/api/workspace/resume-candidate`를, Extension은
`coxgem.memoryPreferences` 명령을 통해 같은 Core API를 쓴다.
2단계부터는 미구현이다.

### 2단계: 작업 resume

- workspace resume 상태 구현
- Extension 활성화 복구 정책 변경
- Dashboard resume 조회·갱신 경로 추가
- 저장된 대화 문맥을 다음 Codex 호출에 예산 안에서 전달
- Run 완료 시 compact 상태·변경 파일·검증·실패 fingerprint 병합
- 호출별 memory telemetry 추가

2단계는 Core와 Extension 범위에서 구현 완료다. Core는
`.agent/dashboard-state/workspace/current.json`에 resume 선택을 저장하고
(`getWorkspaceResumeState`, `saveWorkspaceResumeState`), Codex 호출은
`buildResumeContextProjection`이 만든 `[RESUME_CONTEXT_V1]` 블록을 예산
안에서 전달하며 비용을 `ConversationMessage.resumeTelemetry`에 남긴다.
Extension은 활성화 시 새 대화를 만들지 않고 저장된 선택을 복원한다
(`restoreWindow`). Dashboard resume 경로는 웹 UI 폐기 예정에 따라
구현하지 않는다. 변경 파일 목록은 별도 필드가 아니라 Run 완료 요약
메시지로 대화에 남아 최근 메시지 창에 포함된다.

### 3단계: Repository Memory

- `.agent/memory` 스키마 구현
- `.agent/memory/`를 `.gitignore`에 추가하고 Git 추적 방지 테스트 구현
- 구조·심볼·의존성·테스트·위험 map
- HEAD와 파일 hash 기반 무효화
- 기존 Run·Event Store에서 검증된 요약 생성
- Dashboard·Extension에서 provenance·stale 상태 표시

3단계는 증거 기반 범위로 구현했다. `packages/orchestrator-core/repository-memory.ts`가
`.agent/memory/task-history.json`과 `test-map.json`을 완료된 Run 증거에서만
생성하고, 레코드마다 `source`·`confidence`·`expiresAt`·`fileHashes`를 남긴다.
검증 명령이 모두 PASS한 Run만 `verified`이고 나머지는 `inferred`다. 읽을 때
만료 레코드는 버리고 파일 hash가 달라진 레코드는 `stale`로 표시한다. Extension은
대화 웹뷰의 `메모리` 패널에서 선호와 저장소 기억을 함께 보여주고(provenance·stale
포함) 재스캔·삭제를 제공한다. VS Code 네이티브 QuickPick은 쓰지 않는다.

4단계 진입 전 선행 작업도 끝났다.

- 소비자: `loadResumeContext`가 승인 대기 plan의 `affectedFiles`와 연결 Run의
  변경 파일에 대한 `verified` test-map 항목을 `verified_test_hints:`로 넣는다.
- 총예산: 요청당 기억 입력은 `MEMORY_TOTAL_TOKEN_BUDGET`(4,000 tokens)을 넘지
  않으며, 선호 블록을 뺀 나머지를 resume 블록이 쓴다. 초과 시 오래된 최근
  메시지 → 검색된 힌트 순으로 줄이고, 세션·Run·승인 상태는 끝까지 남긴다.
  telemetry에 `retrievedTokens`, `droppedHints`를 기록한다.
- 병합 확인: Extension이 `git merge-base --is-ancestor`로 integration branch가
  `main`/`master`에 도달했는지 확인해 task-history의 `merged`에 남긴다.
  git이 답할 수 없으면 `undefined`이며 절대 `true`로 승격하지 않는다.
- 자동 재스캔: Run 완료 요약을 대화에 남기는 시점(`appendRunCompletion`)에
  저장소 기억을 다시 생성한다.

이전 대화 기억은 "요약을 저장하지 않고 계산하는" 수준으로 구현했다
(`packages/orchestrator-core/session-summary.ts`).

- 세션 요약은 세션 JSON의 첫 사용자 메시지(goal), 승인 카드(plan·files),
  Run 완료 요약(outcome), 승인 대기(open)에서 읽을 때 계산한다. LLM 호출과
  별도 저장소가 없으므로 stale 문제도 없다.
- 새 대화에 사용자 턴이 없으면 workspace resume 상태의 직전 대화로 폴백하고
  `previous_session=`으로 출처를 표시한다. 새 대화가 자기 턴을 갖는 순간
  폴백은 끝난다.
- 요청 메시지와 goal·plan·파일명이 겹치는 과거 세션 상위 3개를
  `related_sessions:`에 한 줄씩 넣는다. 겹치지 않으면 넣지 않는다.
- 축소 순서는 최근 메시지 → 관련 세션 → 테스트 힌트이며, 고정 welcome
  인사말은 최근 메시지 슬롯을 차지하지 않는다. telemetry에
  `droppedSessions`를 기록한다.
- LLM이 작성하는 자유형 장기 기억과 세션 전체 재전송은 여전히 비목표다.

`symbols.json`, `dependency-map.json`, `risk-map.json`, `architecture.json`은
구현하지 않았다. 정적 분석이 polyglot 저장소에서 얕고 빨리 stale해지는 반면,
이를 소비할 Context Compiler는 4단계에 있다. 필요해지는 시점에 추가한다.

### 4단계: Golden Patch와 Adaptive Router

- 충분한 실행 데이터가 쌓인 뒤 활성화
- 병합된 성공 결과만 Golden Patch 확정
- 실패·환경 오류·권한 오류 분리
- 모델 선택에 집계 통계만 사용
- 라우팅 결정 이유를 기록하고 사용자에게 표시

이 순서는 [V2_ARCHITECTURE.md](V2_ARCHITECTURE.md)
및 v2.2/v2.3 로드맵과 충돌하지 않는다. Repository Memory와 Context
Compiler, Golden Patch·Adaptive Router는 원래 후속 단계에 속한다.

## 12. 테스트와 완료 기준

### 기능 테스트

- resume 상태 원자 저장과 재시작 복구 테스트 통과
- 저장소 변경 시 resume 거부 또는 경고 테스트 통과
- 손상된 resume·대화 파일 무시 테스트 통과
- 죽은 PID를 running으로 복원하지 않는 테스트 통과
- 승인 자동 재개 금지 테스트 통과
- 멱등 승인 중복 실행 방지 테스트 통과
- 정책 위반·경로 탈출 테스트 통과
- 비밀정보 저장 거부 테스트 통과
- Web·Extension이 같은 Core 계약을 사용하는 테스트 통과

### 토큰 테스트

- 일반 요청 기억 입력이 예산 안에 들어오는지 검증
- 예산 초과 시 목표·승인·안전 제약이 남는지 검증
- 전체 대화 재전송이 기본 경로에서 발생하지 않는지 검증
- 호출별 memory·recent·retrieved token 기록 검증

### 완료 기준

- Extension 재시작 후 현재 세션에 연결된 대화·Run을 다시 표시한다.
- 연결되지 않은 진행 중 Run은 Status Bar에 알리고 자동 채택하지
  않는다.
- 새 Codex 호출이 이전 결정·실패·검증 요약을 예산 안에서 받는다.
- targeted test와 full integration test 분리를 유지한다.
- 위험도에 따른 Codex 검토 정책을 유지한다.
- 사용자 승인 없이 `main`이 변경되지 않는다.
- 기존 명령과 대시보드 기능에 회귀가 없다.
- 비밀정보와 사용자 절대경로가 로그와 UI에 노출되지 않는다.

## 13. 위험과 비목표

주요 위험:

- resume 상태와 Run Store 불일치
- 오래된 기억이 현재 HEAD에서 잘못 재사용됨
- 과거 거절 구현이 유사 사례로 계속 주입됨
- memory 텍스트를 통한 prompt injection 지속
- 전체 대화 재전송으로 인한 토큰 증가
- Web과 Extension이 서로 다른 기억을 사용함
- 삭제 요청 후 캐시에 기억이 남음

완화 원칙:

- Run 상태의 권위 출처를 기존 Store로 유지한다.
- 기억마다 provenance·commit·hash를 저장한다.
- 병합된 결과만 Golden Patch로 승격한다.
- memory를 참고 데이터로만 사용한다.
- 같은 Core API를 두 UI가 공유한다.
- 삭제 시 캐시와 파생 결과를 함께 무효화한다.

이 문서의 비목표는 다음과 같다.

- Codex CLI 네이티브 thread resume 구현
- Gemini project reuse 자체 구현
- 공유 Repository Memory와 조직 정책
- 학습형 라우터 모델 선택
- 전체 대화·전체 로그의 장기 보관

## 14. 토큰 절감에 대한 판단

전체 대화형 기억은 토큰 절감 목표와 반대 방향이다. 그러나 제한된
구조화 resume는 반대가 아니다.

- 현재 방식은 호출당 입력은 가장 적지만 후속 작업에서 저장소 재탐색,
  반복 설명, 같은 실패 반복 비용이 생긴다.
- 구조화 resume는 호출당 수천 토큰을 추가하지만 재탐색과 재시도를
  줄일 수 있다.
- 전체 재전송은 세션이 길어질수록 비용이 이차 형태로 증가하므로
  기본값으로 사용하지 않는다.
- 원문 전체를 기억으로 쓰지 않고 구조화 상태를 권위 출처로 두며
  원문은 요청별 검색 대상으로만 쓰는 방식이 가장 안정적이다.

따라서 권고는 기억 자체를 피하는 것이 아니라 기억 예산을 제한하고
정확한 기억만 전달하는 것이다.
