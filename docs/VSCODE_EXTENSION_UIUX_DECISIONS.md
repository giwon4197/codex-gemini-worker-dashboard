# VS Code Extension UI/UX 개편 결정 (2026-09-17)

[`VSCODE_EXTENSION_ROADMAP.md`](./VSCODE_EXTENSION_ROADMAP.md)의 워크플로우와 Core 계약은 그대로 둔다. 이 문서는 Extension UI 배치와 동선만 바꾸는 결정 목록이다. 용어는 [`CONTEXT.md`](../CONTEXT.md)를 따른다.

## 목표

한 Cycle(요청 → 계획 승인 → Run → 검토 → 병합 결정)을 Extension 밖으로 나가지 않고 끝낸다. Gate(계획 승인, 검토)는 제거하지 않는다. Gate 사이의 화면 이동을 제거한다.

## 불변

- Core API, Run 상태 전이, 승인 멱등 키, 재시도 정책, 사용량 조회 규칙(수동 조회, 실패를 0%로 표시하지 않음, 툴팁 상세).
- 승인당 Run 하나. `main` 병합은 사용자가 직접.
- `approveReview(runId)`는 이번 범위 밖(로드맵 후속 유지).

## 결정

1. **배치**: Secondary Side Bar 한 컨테이너. Activity Bar 아이콘 제거. `engines.vscode` `^1.106.0`. 근거는 [ADR-0001](./adr/0001-extension-lives-in-secondary-side-bar.md).
2. **Task Graph 패널**: 대화 Webview 상단의 접이식 `<details>` 패널. 별도 뷰와 `when` 컨텍스트 키는 없앤다(뷰 1개 구조). Run 승인 시 자동으로 펼쳐진다.
3. **검토 국면**: Run이 `awaiting_review`가 되면 Task Graph 패널 아래에 검토 섹션이 펼쳐진다. 변경 파일(클릭 → diff), 테스트 결과 요약, `현재 브랜치에 merge` 버튼. Markdown 미리보기 탭은 없앤다. `Review Changes` 명령은 이 섹션으로 포커스만 옮긴다.
4. **검토의 끝**: 통합 브랜치를 현재 브랜치에 merge 하고 Source Control을 여는 것까지. 통합 브랜치는 `.agent/integration` worktree에 있어 체크아웃할 수 없다. 충돌 시 git의 merge 중간 상태를 그대로 두고 `Source Control에서 해결` / `merge 취소` 선택지를 준다.
5. **실행 중 진행 표시**: 대화 뷰에는 `Run <id> · <status> · 워커 N · 재시도 M` 한 줄만. 8줄 진행 블록 제거. Run 종료 시 완료 블록(변경 파일, 실패 사유)은 이력으로 유지.
6. **대화 뷰 상단**: 세션 행(select + 새 세션, Webview 안에서 처리) 한 줄, 컨텍스트·Run 상태 한 줄. Quick Pick과 `view/title` 메뉴는 쓰지 않는다. 사용량 버튼 두 개는 로드맵 형태 그대로 입력창 아래로 이동.
7. **계획 승인 카드**: 구조 유지. 영향 파일을 클릭하면 편집기에서 연다. 버튼은 `승인 후 실행` 하나. 계획 수정은 대화로.
8. **컨텍스트 첨부**: 입력창 위 토글 칩 `현재 파일·선택 첨부`, 기본 꺼짐. 켜면 활성 파일 경로와 선택 범위를 붙이고 메시지에 출처를 표기. `@`멘션·파일 검색·드래그는 없음. (로드맵 후속 항목을 앞당김)
9. **Run 진행 중 입력**: 보내는 메시지는 전부 질문 전용(`forbidWorkers: true`). 계획 카드가 생기지 않는다. 힌트 `Run 진행 중 · 질문만 가능`. 웹 대시보드는 이 제한이 없으며 그 불일치는 허용한다.
10. **Gate 도달 알림**: Status Bar 텍스트 + 대화 뷰 배지(`WebviewView.badge`, 대기 중 Gate 수). 뷰를 보면 꺼진다. 토스트 없음. `진행 중 Run N (연결 안 됨)` 동작 유지.
11. **문서 동기화**: 구현 시 로드맵의 "3단계: 제공 화면"과 "후속 계획"만 최소 수정.

## 화면 스케치

Secondary Side Bar 한 열. 폭은 사용자 조정. 아래 세 그림은 같은 열의 Cycle 국면별 모습이다.

### 대화 (Run 없음)

```text
┌ CODEX × GEMINI ───────────────────────┐
│ 세션 [첫 질문 제목        ▾] [새 세션] │
│ repo · feat/x · src/a.ts:12-30 · idle  │
├────────────────────────────────────────┤
│ User: …                                │
│ Codex: …                               │
│ ┌ 계획 ────────────────────────────┐   │
│ │ 제목 / 설명                      │   │
│ │ 1. … 2. …                        │   │
│ │ src/a.ts  src/b.ts   (클릭→열기) │   │
│ │              [승인 후 실행]      │   │
│ └──────────────────────────────────┘   │
├────────────────────────────────────────┤
│ [ ] 현재 파일·선택 첨부                │
│ ┌──────────────────────────────────┐   │
│ │ 질문하거나 작업을 요청하세요     │   │
│ └──────────────────────────────────┘   │
│ Ctrl+Enter 보내기 · Esc 중단  [보내기] │
│ [Codex ]  59% 남음 · 14:30 초기화      │
│ [Gemini]  45% 남음 · 16:00 초기화      │
└────────────────────────────────────────┘
```

Task Graph 패널은 이 상태에서 접혀 있고 `표시할 Run이 없습니다`만 보인다.

### 실행 (Run 진행 중)

```text
┌ CONVERSATION ─────────────────────────┐
│ 세션 […▾] [새 세션]                    │
│ repo · feat/x · Run r-123 · running    │
├────────────────────────────────────────┤
│ …                                      │
│ Run r-123 · running · 워커 2 · 재시도 0│
├────────────────────────────────────────┤
│ Run 진행 중 · 질문만 가능              │
│ ┌──────────────────────────────────┐   │
│ └──────────────────────────────────┘   │
│                             [보내기]   │
├ TASK GRAPH ──────────────────── ↻ ▾ ──┤
│ ● Review        ○ 대기                 │
│ ├ TASK-002  ↻  Gemini · EDIT src/b.ts  │
│ ├ TASK-001  ✓  Gemini · 01:12          │
│ ● Plan          ✓                      │
│ ● Request       ✓                      │
│ ▸ 워커 CLI 출력 (정제됨)               │
└────────────────────────────────────────┘
```

Task Graph 패널 헤더의 `▾`는 `<details>` 접기다. 접으면 대화 영역이 열 전체를 쓴다.

### 검토 (`awaiting_review`)

```text
├ TASK GRAPH ──────────────────── ↻ ▾ ──┤
│ ● Review        ✓ awaiting_review      │
│ ├ TASK-002  ✓   ├ TASK-001  ✓          │
│ ─ 검토 ────────────────────────────────│
│ 변경 파일 (클릭 → diff)                │
│   TASK-001  src/a.ts  src/a.test.ts    │
│   TASK-002  src/b.ts                   │
│ 테스트  npm test · PASS 12 · FAIL 0    │
│ Problems  0                            │
│ 통합 브랜치  integration/r-123         │
│              [현재 브랜치에 merge]     │
│ ▸ 완료 워커 이력                       │
└────────────────────────────────────────┘
```

`현재 브랜치에 merge`는 `git merge --no-edit <통합 브랜치>`를 실행하고 Source Control 뷰를 연다. 충돌이면 merge 중간 상태를 유지한 채 `Source Control에서 해결` / `merge 취소` 알림을 띄운다.

## 상태 → UI 대응

| Run 상태 | 대화 뷰 | Task Graph 패널 | Status Bar / 배지 |
|---|---|---|---|
| 없음 · `idle` | 일반 입력 | 접힘, 빈 안내 | `idle` |
| 계획 카드 도착 | `승인 후 실행` 활성 | 접힘, 빈 안내 | 배지 1 (뷰 안 보일 때) |
| `planning` · `running` · `retrying` · `verifying` | 한 줄 진행 표시, 질문 전용 입력 | 펼침, 폴링 | 상태 텍스트 |
| `awaiting_review` | 완료 블록(변경 파일 목록) | 검토 섹션 펼침 | 상태 텍스트 + 배지 1 |
| `failed` · `action required` | 실패 블록(사유·조치) | 재시도 버튼(재시도 가능한 경우만) | 상태 텍스트 + 배지 1 |
| `completed` · `cancelled` | 완료 블록 | 검토 섹션(변경이 있으면) | 상태 텍스트 |
| 연결 안 된 진행 중 Run | 변화 없음 | 변화 없음 | `진행 중 Run N (연결 안 됨)` |

배지는 사용자가 대화 뷰를 보는 순간 꺼진다. 뷰가 이미 보이는 상태에서 Gate에 도달하면 배지를 켜지 않는다.

## 구현 순서

결정 번호 순서가 곧 구현 순서다. 각 단계는 독립적으로 배포 가능해야 한다.

| 단계 | 변경 파일 | 검증 |
|---|---|---|
| 1. 배치 | `package.json` (`viewsContainers.secondarySidebar`, `engines`) | 새 프로필에서 VSIX 설치, 오른쪽에 뜨는지 |
| 2. Task Graph 패널 | `conversation-view.ts` (패널 HTML/CSS), `task-graph-view.ts` (메시지 채널 공유) | Run 전 빈 안내, 승인 후 펼침 |
| 3·4. 검토 섹션 | `task-graph-view.ts`, `graph-tree.ts` (`formatRunEvidence` 재사용), `vscode-context.ts` | `awaiting_review` 픽스처로 렌더, `현재 브랜치에 merge` 동작 |
| 5. 진행 한 줄 | `conversation-view.ts`, `protocol.ts` (`runProgressLines` 축소) | `protocol.test.ts` |
| 6. 상단 압축·사용량 이동 | `conversation-view.ts` HTML/CSS | 3개 테마에서 수동 확인 |
| 7. 영향 파일 클릭 | `conversation-view.ts`, `protocol.ts` (`openFile` 메시지) | 클릭 시 편집기 열림 |
| 8. 첨부 토글 | `conversation-view.ts`, `workspace-context.ts` | 켬/끔 각각 프롬프트에 출처 표기 확인 |
| 9. 질문 전용 | `conversation-view.ts` (`forbidWorkers` 조건) | Run 중 계획 카드가 생기지 않음 |
| 10. 배지 | `conversation-view.ts` (`badge`), `status-bar.ts` | Gate 도달 시 배지, 표시 시 해제 |
| 11. 문서 | `README.md` 체크리스트 갱신 | 문서와 화면 일치 |

## 범위 밖

- `@`멘션·파일 검색 첨부, 체크포인트 복원, 메시지 큐잉, 태스크 단위 재시도, 병합 승인 API.
- 키보드 단축키와 테마 검증은 README 체크리스트 그대로.

## 참고: 상용 도구 조사 요약

- Copilot Chat은 Secondary Side Bar 기본, 변경 파일 목록에 파일별 Keep/Undo, 요청 단위 체크포인트.
- Cursor·Cline·Roo·Claude Code·Continue는 모두 커스텀 Webview. 공개 Chat Participant API는 Copilot만 사용.
- 공통 편의: 파일별 수락/거부, 체크포인트, 메시지 큐잉, 승인 대기 시 아이콘 배지.
