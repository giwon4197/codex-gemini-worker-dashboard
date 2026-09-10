# Codex × Gemini Worker Dashboard

> 차세대 Policy Engine, Repository Memory, Context Compiler, 선택적 Codex 호출 설계는 [v2 설계 및 구현 로드맵](docs/V2_ARCHITECTURE.md)을 참고하세요. 오늘 실행된 작업의 실패 원인과 수정 우선순위는 [실패 원인 분석](docs/FAILURE_ANALYSIS_2026-09-09.md)에 정리되어 있습니다.

Codex가 요구사항을 설계하고 작업 난이도에 맞는 Gemini 모델을 선택한 뒤, Gemini가 구현하고 Codex가 결과를 검증하는 로컬 워크플로입니다. 실행 상태와 토큰 사용량은 웹 대시보드에서 실시간으로 확인할 수 있습니다.

## 한 줄 설치 및 실행

Windows PowerShell에서 실행하세요.

```powershell
irm https://raw.githubusercontent.com/giwon4197/codex-gemini-worker-dashboard/main/install.ps1 | iex
```

설치기는 Node.js LTS와 Google Antigravity CLI를 확인하고, 최신 소스와 npm 의존성을 설치한 뒤 `gemini-worker`, `worker-dashboard` 전역 명령을 등록하고 대시보드를 시작합니다.

설치가 끝난 뒤 새 PowerShell을 열고 다음 명령을 사용할 수 있습니다.

```powershell
worker-dashboard
```

또는 저장소 루트나 설치 폴더(`%LOCALAPPDATA%\codex-gemini-worker-dashboard`)의 `dashboard-launcher.cmd`를 더블클릭하여 바로 실행할 수 있습니다. 개발 저장소에서 처음 실행할 때는 `dashboard-launcher.cmd -InstallDependencies` 또는 `gemini-dashboard` 폴더에서 `npm ci`로 의존성을 준비할 수 있습니다.

대시보드 주소는 `http://localhost:3000`입니다. 이미 실행 중인 경우 중복 실행 없이 기본 브라우저로 해당 URL을 엽니다.

## 다른 프로젝트에서 사용

작업할 폴더에서 실행하면 해당 폴더가 Gemini의 작업공간이 됩니다.

```powershell
cd C:\path\to\your-project
gemini-worker -Task "README 개선" -Prompt "README.md를 검토하고 개선해줘"
```

모델 등급을 직접 지정할 수도 있습니다.

```powershell
gemini-worker -Task "빠른 점검" -Prompt "오탈자를 수정해줘" -Tier fast
gemini-worker -Task "구조 개선" -Prompt "전체 구조를 분석하고 리팩터링해줘" -Tier reasoning
```

등급을 생략하면 웹 대시보드에서 선택한 기본값을 사용합니다.

## 두 작업 병렬 실행

`parallel-tasks.example.json`을 복사해 작업 목록을 작성한 뒤 대상 Git 저장소에서 실행합니다.

```powershell
Copy-Item parallel-tasks.example.json parallel-tasks.json
parallel-gemini-workers -TasksFile .\parallel-tasks.json -MaxWorkers 2
```

실행마다 `.agent/runs/<run-id>`에 manifest, task, worker 상태, NDJSON 이벤트가 분리 저장되고 각 작업은
`agent/<run-id>/<task-id>` 브랜치와 독립 worktree를 사용합니다. 기본적으로 검토를 위해 worktree를 유지합니다.
검증 후 즉시 worktree를 제거하려면 `-CleanupWorktrees`를 지정하세요.

각 task에는 수정 허용 범위와 오케스트레이터가 직접 재실행할 검증 명령을 지정합니다.

```json
{
  "integration_test_commands": ["npm test", "npm run build"],
  "tasks": [
    {
      "id": "TASK-001",
      "name": "독립 작업",
      "prompt": "docs/worker-a.md를 생성하세요.",
      "tier": "fast",
      "allowed_files": ["docs/worker-a.md"],
      "test_commands": ["if (-not (Test-Path 'docs/worker-a.md')) { exit 1 }"],
      "timeout_seconds": 300,
      "retry_limit": 3
    }
  ]
}
```

허용 범위를 벗어난 변경은 `POLICY_VIOLATION`, 검증 명령 실패는 `TEST_FAILED`, 제한 시간 초과는
`TIMED_OUT`으로 기록됩니다. 실행 취소는 별도 PowerShell에서 다음처럼 요청합니다.

```powershell
stop-parallel-run -RunId <run-id> -Repository C:\path\to\project
```

다음 실행을 시작할 때 중단된 run과 고아 worktree를 자동 점검합니다. 변경이 없는 고아 worktree만 정리하고,
수정 사항이 있는 worktree는 데이터 손실 방지를 위해 보존합니다.

검증 결과가 `TEST_FAILED`이면 동일 worktree와 branch에서 실패 로그를 압축해 같은 Worker에 전달하고,
최대 3회까지 수정과 재검증을 반복합니다. `INTERFACE_ERROR`, `DESIGN_ERROR`, `PERMISSION_ERROR`,
`ENVIRONMENT_ERROR`, `POLICY_VIOLATION`은 재시도하지 않고 즉시 Codex 검토 대상으로 기록합니다.
동일한 실패 지문이 반복되면 `REPEATED_FAILURE`, 한도를 모두 사용하면 `RETRY_EXHAUSTED`로 escalation합니다.

모든 Worker가 PASS하면 검증된 변경을 Worker branch에 커밋하고 `integration/<run-id>` 브랜치를 생성합니다.
각 Worker commit을 작업 목록 순서대로 cherry-pick한 후 `integration_test_commands`를 실행하고,
`.agent/runs/<run-id>/integration-review.md`에 base 대비 변경 파일과 diff 통계를 기록합니다.
성공 상태는 `awaiting_review`이며 main branch는 수정하지 않습니다. 리뷰가 끝난 후 사용자가 직접 승인해야 합니다.

```powershell
git diff main...integration/<run-id>
git switch main
git merge --ff-only integration/<run-id>
```

| 등급 | 모델 | 권장 용도 |
|---|---|---|
| `fast` | Gemini 3.8 Flash Low | 문구 수정, 간단한 확인 |
| `normal` | Gemini 3.8 Flash Medium | 일반 기능 구현과 버그 수정 |
| `advanced` | Gemini 3.8 Flash High | 복합 기능과 정밀 분석 |
| `reasoning` | Gemini 3.1 Pro High | 심층 설계와 어려운 알고리즘 |

기본 등급은 `normal`입니다. Codex는 작업 난이도에 따라 더 가볍거나 강한 등급을 선택할 수 있습니다.

## Codex 자동 라우터

자연어 요청 하나로 Codex가 저장소를 읽기 전용으로 분석하고 구조화된 작업 계획을 만든 뒤 Gemini 병렬 실행,
검증, 임시 통합 브랜치, Codex diff review까지 수행합니다.

Codex 대화에서 실행할 때는 라우터를 백그라운드로 시작하고 진행 로그는 웹 대시보드에서 직접 확인하는 방식을 권장합니다. 워커는 NDJSON 상태를 대시보드에 직접 기록하므로 Codex가 중간 진행을 반복 조회할 필요가 없습니다. Codex는 `awaiting_review` 이후 최종 diff 검토를 요청받거나, 대시보드에 `requiresCodex` 같은 종료 에스컬레이션이 표시될 때만 다시 개입합니다.

```powershell
codex-route -Request "독립 유틸 함수와 문서를 추가하고 테스트해줘" -Repository .
```

실행 전 계획만 확인하려면:

```powershell
codex-route -Request "요청 내용" -Repository . -PlanOnly
```

Codex 계획 호출은 `read-only`, `ephemeral`, JSON Schema 강제 모드로 실행됩니다. 라우터는 절대 경로,
`.git/**`, `.agent/**`, 저장소 전체 wildcard, 중복 ownership을 거부합니다. 현재 실행 계획은 같은 base에서
독립적으로 수행 가능한 task만 허용하며 dependency chain은 하나의 task로 합쳐 계획합니다.


### 자동 배포(Automatic Delivery) 및 안전 게이트

`worker-settings.json`의 `autoDeliver: true` 설정 또는 `codex-route` / `review-integration`의 `-AutoDeliver` 스위치를 사용하면, 워커 작업 및 통합 완료 후 일련의 비파괴적 안전 게이트를 거쳐 `main` 브랜치에 자동으로 통합 및 푸시됩니다:

1. **Codex diff 리뷰 및 정책 검증**: 구조화된 판정(`verdict: PASS`), diff 존재 확인, `allowed_files` 범위 준수 여부, 워커 및 통합 테스트 성공 여부를 엄격히 검증합니다.
2. **원격 저장소 및 브랜치 안전 검사**: 구성된 GitHub 원격(`origin`)을 fetch하고, target `main`과 integration 브랜치의 식별자 및 조상 관계(`baseCommit` 포함)를 검증하며, 더티 워크트리와 로컬/원격 간 커밋 분기(divergence)를 탐지합니다. 기존 원격 및 로컬 작업을 덮어쓰지 않는 무충돌 상태를 증명합니다.
3. **후보 커밋 결정론적 검증**: 배포될 정확한 후보 커밋(`candidateCommit`)에서 계획의 필수 검증 명령을 사전 실행합니다.
4. **비파괴적 main 통합**: 오직 non-destructive Git 작업(`git merge --ff-only`)으로만 main에 통합합니다. `--force`, `--force-with-lease`, 파괴적 reset, 안전하지 않은 덮어쓰기는 일체 사용하지 않습니다.
5. **통합 후 재검증 및 정상 푸시**: 통합 완료 후 main에서 필수 검증 명령을 다시 실행하고, 통과 시 일반 `git push`로 원격에 배포합니다.
6. **장애 차단 및 진단 아티팩트**: 충돌, 커밋 분기, 정책 위반, 예상치 못한 파일, 검증 실패, 인증/원격 누락, 푸시 거부 발생 시 즉시 모든 병합/푸시 동작을 중단하고 원자적 에스컬레이션 상태(`escalated`/`failed`)와 마스킹된 진단 파일(`.agent/runs/<run-id>/delivery-diagnostic.json`)을 기록합니다.
7. **비밀정보 마스킹**: 토큰, 인증 헤더, 자격 증명이 포함된 URL 등은 로그 및 아티팩트에서 자동 마스킹됩니다.
8. **멱등성 및 복구**: 모든 게이트는 멱등성을 보장하므로 재실행 시 이미 통과한 게이트나 커밋/푸시를 중복 없이 인식하여 안전하게 복구합니다.
9. **부트스트랩 안내**: 자동 배포 파이프라인 구현 자체(최초 부트스트랩)는 안전을 위해 `awaiting_review` 상태로 보존되며 수동 검토 후 병합됩니다. 이후 자연어 라우팅 작업부터는 `worker-settings.json`에 의해 자동 배포가 기본 활성화됩니다.

자동 배포가 비활성화된 경우(예: `-AutoDeliver:$false`), 실행은 `awaiting_human_approval`에서 멈추며 `.agent/runs/<run-id>/codex-review.md`를 확인한 뒤 수동 승인으로 병합합니다. 리뷰 및 배포만 재시도하려면 `review-integration -RunId <run-id>`를 실행합니다.

## 대시보드 기능

- Gemini 작업 로그와 토큰을 NDJSON으로 실시간 수집
- Codex 로컬 세션의 최신 누적 사용량 자동 추적
- Codex/Gemini 캐시 제외 실질 토큰 비교
- Gemini가 대신 처리한 토큰을 1:1로 환산한 추정 Codex 절감량
- 일별 작업 기여도, 요청 수, 응답 속도, 성공률
- 웹에서 Gemini 기본 모델 등급 선택

### 지표 정의

- **실질 토큰:** 캐시 입력을 제외하고 새로 처리한 토큰
- **캐시 토큰:** 이전 컨텍스트를 재사용한 입력 토큰
- **전체 처리량:** 실질 토큰 + 캐시 토큰
- **추정 Codex 절감량:** Gemini 실질 토큰을 Codex 대체량으로 1:1 환산한 값입니다. 실제 비용 절감액이 아니며 신뢰도는 낮습니다.

## 요구사항

- Windows 10/11 및 PowerShell
- Node.js LTS
- Google AI Pro 사용이 가능한 Google 계정
- Google Antigravity CLI 로그인
- Codex 사용량 추적 시 로컬 Codex 세션 폴더

## 개인정보와 보안

대시보드는 로컬에서 실행됩니다. 사용량 JSON, 실행 로그, 모델 설정과 Codex 세션은 Git에 포함되지 않습니다. 공개 저장소에는 빈 예제 데이터만 들어 있습니다.

Antigravity는 선택한 작업 폴더의 파일을 읽고 수정할 수 있습니다. 신뢰하는 프로젝트에서만 사용하고 Git diff와 테스트 결과를 확인하세요.

## 업데이트

한 줄 설치 명령을 다시 실행하면 소스와 의존성이 업데이트됩니다. 기존 로컬 사용량과 설정은 보존됩니다.

## 문제 해결

- 명령이 인식되지 않으면 PowerShell을 완전히 닫았다가 다시 여세요.
- 대시보드가 열리지 않으면 `worker-dashboard` 또는 `dashboard-launcher.cmd`를 실행하고 안내된 로그 위치(`gemini-dashboard\.dev-server.stderr.log`)를 확인하세요.
- Gemini 로그인 오류가 발생하면 `agy`를 실행해 Google 계정 인증을 완료하세요.
- 포트 3000을 다른 프로그램이 사용 중인 경우 원인 프로세스를 확인하고 해당 프로그램을 종료한 뒤 다시 실행하세요.
- 개발 저장소에서 의존성 누락 오류가 표시되면 `dashboard-launcher.cmd -InstallDependencies`를 실행하거나 `gemini-dashboard` 폴더에서 `npm ci`를 실행하세요.

## License

[MIT](LICENSE)
