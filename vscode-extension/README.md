# coXgem

로컬 AI 대화와 백그라운드 worker 오케스트레이션을 VS Code Secondary Side Bar에서 사용합니다. VS Code 1.106 이상이 필요합니다.

로컬에 설치된 `codex` · `gemini` CLI를 실행합니다. OpenAI · Google과 제휴 관계가 없습니다.

## 설치

1. `npm install`
2. `npm run compile`
3. `npm run package`
4. 생성된 `.vsix`를 VS Code에서 `Extensions: Install from VSIX...`로 설치합니다.

깨끗한 프로필에서 확인하려면:

```text
code --user-data-dir <empty-dir> --extensions-dir <empty-dir> --install-extension <file>.vsix
```

실행 후 폴더를 연 다음 Secondary Side Bar(오른쪽)의 coXgem 컨테이너를 사용합니다. 보이지 않으면 `View: Toggle Secondary Side Bar`를 실행합니다. Extension Development Host에서 `파일 > 폴더 열기`를 하면 디버그 창이 종료됩니다.

## 설정

`coxgem.*` 설정은 VS Code 설정 화면에서 바꿉니다.

- `workerTier`: Gemini 워커 등급(`fast`·`normal`·`advanced`·`reasoning`). 바꾸면 작업 폴더의 `worker-settings.json`에 저장되어 웹 대시보드와 공유됩니다.
- `codexModel`: 계획·대화 단계의 `codex exec --model` 값. 비우면 Extension 요청은 로컬 Codex CLI 기본값을 따릅니다.
- `codexChatModel`: 워커를 만들지 않는 Explain Selection 전용 모델. 비우면 `codexModel`을 따릅니다.

## 화면

대화 뷰 상단은 세션 행(선택·새 세션)과 `workspace · branch · file · Run 상태` 한 줄입니다. 입력창 위의 `현재 파일·선택 첨부` 칩(기본 꺼짐)을 켜면 활성 파일 경로와 선택 범위를 프롬프트에 붙이고, 보낸 메시지에 `[첨부 · VS Code: 경로:줄]`로 출처를 표기합니다. 계획 카드의 영향 파일을 누르면 편집기에서 열리고, `승인 후 실행` 버튼 하나로 Run을 만듭니다.

Task Graph는 대화 뷰 상단의 접이식 패널입니다. Run이 없으면 `표시할 Run이 없습니다`만 보이고, 계획 승인 시 자동으로 펼쳐집니다. 뷰 헤더의 `Refresh Task Tree`로 수동 갱신할 수 있습니다. Run 진행 중 대화 뷰에는 `Run <id> · <status> · 워커 N · 재시도 M` 한 줄만 표시되며, 입력은 질문 전용(`Run 진행 중 · 질문만 가능`)이라 계획 카드가 생기지 않습니다. 그래프 행을 누르면 노드 상세가 행 아래에 펼쳐집니다.

Run이 멈추면(`awaiting_review` 등) Task Graph 패널에 `검토` 섹션이 펼쳐집니다. 테스트 PASS/FAIL 수, Problems 수, 통합 브랜치, 접이식 `Run 증거`를 보여 주고, `현재 브랜치에 merge`는 통합 브랜치를 현재 브랜치에 merge 하고 Source Control을 엽니다. 통합 브랜치는 `.agent/integration` worktree에 있어 체크아웃은 하지 않습니다. 충돌이 나면 git은 merge 중간 상태로 멈추고, 알림의 `Source Control에서 해결` 또는 `merge 취소`(`git merge --abort`)로 이어집니다. `Review Changes` 명령은 이 섹션으로 포커스만 옮깁니다. `변경 파일` 영역은 노드별 변경 파일을 나열하고, 파일을 누르면 Run의 base commit과 통합 브랜치를 비교하는 diff 편집기를 엽니다. `워커 CLI` 영역은 실행 중인 워커의 정제된 CLI 출력을 접이식으로 보여 주고, 완료된 워커는 `완료 워커 이력`으로 옮깁니다.

계획 승인이나 검토 같은 Gate에 도달했을 때 대화 뷰가 보이지 않으면 뷰 배지가 켜지고, 뷰를 보면 꺼집니다. 토스트는 없습니다.

사용량은 입력창 아래의 `Codex`·`Gemini` 버튼을 눌렀을 때만 조회합니다. 결과는 버튼 오른쪽에 `N% 남음 · HH:MM 초기화`로 나오고, 버튼이나 결과에 마우스를 올리거나 키보드 focus 하면 창별(5h·weekly) 상세가 툴팁으로 보입니다.

입력창 아래의 selector는 Codex 모델과 Gemini worker tier를 바꿉니다. 인증은 Extension이 저장하거나 읽지 않고 로컬 공식 CLI 세션을 사용합니다. Codex 로그인은 Integrated Terminal의 `codex login`, Gemini 로그인은 `agy`의 interactive flow로 진행합니다. 모델 목록 표시는 계정 entitlement 보장이 아니며 실제 CLI 실행 결과가 최종 기준입니다. Run이 `planning`·`running`·`retrying`인 동안 selector는 잠깁니다.

새 창은 현재 세션에 연결된 Run만 Task Graph에 복구합니다. 다른 창에서 시작한 Run이 진행 중이면 Status Bar에 `진행 중 Run N (연결 안 됨)`이 표시되고, 클릭하면 `Show Active Run`으로 이동합니다.

## 수동 검증 체크리스트

VSIX 설치 후 다음을 확인합니다.

- [ ] 일반 질문에 워커가 생성되지 않고 Codex 답변만 온다.
- [ ] 확장이 Secondary Side Bar에 나타나고 Activity Bar 아이콘은 없다.
- [ ] Run이 없을 때 Task Graph 패널이 `표시할 Run이 없습니다`를 보인다.
- [ ] 계획 승인 후 Run이 정확히 한 번 생성되고 Task Graph 패널이 펼쳐진다.
- [ ] 계획 카드의 영향 파일을 누르면 편집기가 열린다.
- [ ] `현재 파일·선택 첨부`를 켠 메시지에만 `[첨부 · VS Code: …]` 출처가 붙는다.
- [ ] Run 진행 중 보낸 메시지에 계획 카드가 생기지 않고 힌트가 `질문만 가능`으로 바뀐다.
- [ ] `awaiting_review`에서 검토 섹션이 펼쳐지고 `현재 브랜치에 merge`가 통합 브랜치를 merge 한 뒤 Source Control을 연다. 충돌 시 `Source Control에서 해결` / `merge 취소` 알림이 뜬다.
- [ ] 대화 뷰가 가려진 상태에서 Gate에 도달하면 배지가 켜지고, 뷰를 보면 꺼진다.
- [ ] VS Code를 닫았다 열면 같은 세션과 Run이 복구된다. 세션 없이 열면 Status Bar에 `연결 안 됨` Run 수가 보인다.
- [ ] `변경 파일`을 누르면 diff 편집기가 열리고 base commit과 통합 브랜치가 제목에 보인다.
- [ ] `Codex`·`Gemini` 버튼을 누를 때만 조회되고, 툴팁에 초기화 시각이 나온다.
- [ ] 실패 노드의 `이 Run 재시도`가 실행 중에는 비활성화되고 정책 위반 실패에는 나타나지 않는다.
- [ ] 라이트·다크·고대비 테마에서 버튼과 배지가 읽힌다.
- [ ] 키보드만으로 그래프 행, 파일, 사용량 버튼에 접근할 수 있다.
- [ ] Codex CLI 미설치 상태가 안전하게 표시된다.
- [ ] Codex 미로그인 상태에서 로그인 필요 UI가 표시된다.
- [ ] Codex 로그인 버튼이 Integrated Terminal에서 공식 로그인 command를 실행한다.
- [ ] 로그인 후 다시 확인하면 연결 상태가 갱신된다.
- [ ] Antigravity CLI 미설치 상태가 안전하게 표시된다.
- [ ] Gemini 미로그인 상태에서 로그인 필요 UI가 표시된다.
- [ ] Gemini 로그인 버튼이 Integrated Terminal에서 공식 CLI를 실행한다.
- [ ] Gemini 로그인 후 다시 확인하면 연결 상태가 갱신된다.
- [ ] Codex model selector가 보인다.
- [ ] Gemini tier/model selector가 보인다.
- [ ] Codex model 변경이 다음 Codex 요청에 반영된다.
- [ ] Gemini tier 변경이 다음 worker Run에 반영된다.
- [ ] Run 진행 중 selector 변경이 차단된다.
- [ ] VS Code 재시작 후 선택값이 유지된다.
- [ ] Web Dashboard와 Gemini tier 설정이 일치한다.
- [ ] token/API key/password가 UI/log에 표시되지 않는다.
- [ ] Light/Dark/High Contrast theme에서 읽을 수 있다.

## 개발

Core 모듈은 `packages/orchestrator-core`에 있으며 웹과 확장이 같은 파일을 import 합니다. `npm test`는 확장 테스트만 실행하고, Core 테스트는 `packages/orchestrator-core`에서 `npm test`로 실행합니다.

## 라이선스

MIT License. 전문은 [LICENSE](LICENSE)를 참고하세요.

이 확장은 런타임 의존성이 없으며, 배포본(`dist/extension.js`)에는 이 저장소의 코드만 포함됩니다. 별도의 서드파티 고지 항목은 없습니다.

`codex` · `gemini` CLI는 확장에 포함되지 않고 사용자의 로컬 설치본을 실행합니다. 각 CLI의 라이선스와 이용 약관은 해당 제공자를 따릅니다.
