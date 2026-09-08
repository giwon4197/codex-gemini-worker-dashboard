# Codex × Gemini Worker Dashboard

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

대시보드 주소는 `http://localhost:3000`입니다.

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

성공 시 최종 상태는 `awaiting_human_approval`입니다. 라우터와 Codex review는 main을 수정하지 않으며,
`.agent/runs/<run-id>/codex-review.md`를 확인한 사용자가 명시적으로 승인해야 병합할 수 있습니다.
리뷰 호출만 실패한 경우 Worker를 다시 실행하지 않고 `review-integration -RunId <run-id>`로 재시도할 수 있습니다.

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
- 대시보드가 열리지 않으면 `worker-dashboard`를 다시 실행하고 안내된 로그를 확인하세요.
- Gemini 로그인 오류가 발생하면 `agy`를 실행해 Google 계정 인증을 완료하세요.
- 포트 3000을 다른 프로그램이 사용하면 해당 프로그램을 종료한 뒤 다시 실행하세요.

## License

[MIT](LICENSE)
