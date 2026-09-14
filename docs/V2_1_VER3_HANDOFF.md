# v2.1 ver3 재개 메모

사용자 요청으로 5시간 한도 100% 사용 확인 후 일시 중단. 완료 보고 아님. 한도 초기화 안내 시각: 2026-09-14 20:04:30 KST. reset credit 사용/예약/자동 재개 없음.

## Git 안전 상태

- 저장소: C:\Users\SCH\OneDrive\문서\ChatGPT\codex-gemini
- 현재 브랜치: hjw-v2.1-ver3. 새 브랜치를 만들거나 초기 Git 절차를 다시 적용하지 말 것.
- 기준 origin/hjw-v2.1-ver2 SHA: 924639ede7833b45913d02329c85114b014562fd (로컬 ver2 브랜치는 없었음).
- 마지막 구현 commit: 11f94a7a37b96f4a0bed486e0d77e70ffba409ec.
- main: a57323acf1a24897e55db986552486c56741291b.
- origin/main: f6e954b59377843f893707badee7b3986486b14b (최초 요청한 fetch 이후 baseline).
- 기존 author/committer: 허주완 <eric5519@naver.com>. 변경 금지. main 수정/merge/rebase/push 금지. 원격 push 금지.
- 이번 요청의 ver3-only 및 온라인 model 호출 금지와 충돌하므로 Gemini router를 쓰지 않고 직접 수행했다. 재개에도 router를 실행하지 말 것.
- 재개용 문서 수정은 의도된 작업 상태다. 새 세션에서 dirty라고 삭제/stash하지 말 것.

## 완료된 구현 commit

1. 00c1d0a test: discover all dashboard regression files
2. 306da8a refactor: centralize model tier configuration
3. 0bb6951 refactor: share orchestration helpers and secret redaction
4. d817b6c test: share assertion helpers while preserving suite output
5. 5cc26b5 refactor: consolidate local API handlers and runtime adapters
6. be1a613 refactor: remove unused dashboard template configuration
7. 0ccd46e fix: synchronize installed program files and preserve user state
8. ea67b6e test: verify local API parity and complete process tree cleanup
9. 11f94a7 docs: align v2.1 contracts and future version handoff

## 실제 검증 상태

- Dashboard 최종: 17 test files / 235 cases PASS, skip/todo 0, exit 0. lint/build 각각 exit 0.
- 최종 PS 반복 실행 완료: filesystem 52, toolchain 23, bounded runner 38, dependency bootstrap 50, launcher 48; 모두 exit 0.
- 중단 정리 중 이미 실행 중이던 최종 suite가 자연 종료했다. parallel-usage 95/95, write-expansion 35/35도 exit 0. 최종 일곱 suite 모두 PASS.
- 검증 프로세스는 모두 종료됨. 종료 시도는 PID 검사 불일치로 아무 프로세스도 죽이지 않았으며, 이후 session 6982의 자연 종료(exit 0)를 확인했다.
- installer regression: test-installer.ps1 13/13 PASS. 현재 checkout 실제 격리 설치도 최종 재실행 exit 0.
- 격리 InstallRoot: .agent/background/ver3-install. NoRegister/NoStart 사용하여 기존 설치/사용자 PATH/전역 launcher 보존.
- API parity: node test-dashboard-api.mjs PASS. dev PID 11528 port 51096, start PID 18360 port 59898, Wrangler PID 18240 port 59900. 각 9 curl.exe 응답의 status/JSON/중요값/오류/Cache-Control 비교. 양쪽 root readiness 200, 프로세스 트리 종료 및 public port 폐쇄 확인.
- API 검증은 임시 Codex session 및 Gemini quota fixture. 실제 Gemini/Codex 온라인 모델 추론 호출 없음. 최초 baseline 조사 시 실제 로컬 usage 및 agy /quota 조회는 있었으나 모델 validation으로 주장하지 않음.
- npm ci는 기존 audit 11건(1 low, 2 moderate, 8 high)을 보고. dependency upgrade/downgrade/audit fix 없음.

## 재개할 일 (원래 사용자 A~K 요구사항 유지)

1. git status와 branch/HEAD/main SHA 확인. 이 메모 이후 변경이 있으면 검토하여 기존 작업을 보존.
2. 최종 일곱 suite 결과를 보고서 표로 정리. 소스 변경/새 우려가 없으면 재실행 불필요.
3. 최종 설치 환경에서 생성 launcher의 embedded CODEX_GEMINI_INSTALL_ROOT, model-tiers.json 및 orchestration-common.ps1 해석을 추가 확인. 실제 설치는 이미 끝났으므로 변경이 없으면 npm ci 재실행 불필요.
4. 모든 repository tracked *.ps1에 Parser::ParseFile 실행, 오류 0 확인. test-dashboard-api.mjs/start-local.mjs의 문법 확인도 가능.
5. 최종 integration diff를 직접 review. 특히 installer 삭제 범위/manifest state 보호, 공용 함수 계약, start Node/Wrangler adapter, 모델 경로를 살펴볼 것.
6. git diff --check 및 base..HEAD diff check, 전체 신규 commit Author/Committer/trailer 감사. main/origin/main SHA 불변 재확인.
7. v2.1 scope audit: Execution Profile/recommended_profile/DAG scheduler/affected-test/cache/analytics/learned router/profile prediction/approval UI/API 신규 구현 없음 확인. 로드맵은 후속 이관 문서 변경만.
8. docs/V2_1_IMPLEMENTATION_REPORT.md ver3 절 마무리: 최종 검증 표, baseline→ver3 PS count, 변경 계약 8항목 표(삭제/추가/공용함수/discovery/model/API/installer/framework), 실제 추가/삭제 파일 목록, 남은 한계 작성. 기존 ver2 삭제 금지.
9. docs: prefix의 보고서 commit 생성. 마지막 Git 감사 결과 기록. 최종 답변은 원래 사용자 K의 19개 순서를 따를 것. 미검증 항목을 PASS/완료라 표현하지 말 것.

## 로그와 중요한 설계 판단

- .agent/background/ver3-validation/final/*.log 및 exits.csv: 최종 PS 반복 결과. 모든 일곱 suite가 exit 0으로 종료.
- .agent/background/ver3-validation/final-npm-test.log: 17개 파일 전체 목록, 235 cases.
- .agent/background/ver3-validation/final-npm-build.log: 최종 build.
- docs/V2_1_IMPLEMENTATION_REPORT.md에 단계별 실제 실패/수정/성공 누적.
- Node 자체도 test 경로를 glob 처리하므로 run-tests.mjs는 filesystem discovery 후 []를 Node용 literal pattern으로 escape. 기존 15개 모두 + 신규 model/settings 2개.
- Write-AtomicJson 기본 depth16/throw, worker만 depth8/BestEffort. Redact-Text에 기존 worker의 sk/key=value 패턴을 합침. Record-Diagnostic의 기존 redaction 유지.
- 기존 직접 Wrangler start는 host filesystem 데이터를 읽지 못함. start-local.mjs가 동일 Node bridge/shared handler를 실행하고 UI만 Wrangler로 proxy. 직접 Wrangler만 실행한 것을 parity PASS라고 하지 말 것.
- next/* imports와 UI 유지. 빈 next.config.ts 및 null .openai/hosting.json 삭제, Sites plugin만 dependency 제거. 나머지 lock version/resolution 변경 없음.
- installer manifest로 소유 프로그램만 제거. pre-manifest는 알려진 폐기 파일만 정리. OneDrive ReparsePoint 파일은 정상 source이므로 실제 symlink/junction만 제외.
- bounded tree fixture 초기 3초는 프로세스 생성 전에 timeout. fixture만 10초로 늘리고 PID assertion >=2→>=3으로 강화. 별도 timeout-speed test 유지. 최종 38/38.

재개 요청 예: "docs/V2_1_VER3_HANDOFF.md를 읽고 v2.1 ver3 안정화 작업의 남은 검증과 최종 보고를 이어서 완료해줘."
