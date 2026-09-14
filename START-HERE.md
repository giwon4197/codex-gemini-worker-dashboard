# 빠른 시작

PowerShell 7에서 한 번에 설치하고 대시보드를 실행합니다.

```powershell
irm https://raw.githubusercontent.com/giwon4197/codex-gemini-worker-dashboard/main/install.ps1 | iex
```

설치 후 새 PowerShell에서:

```powershell
worker-dashboard
```

또는 저장소 루트나 설치 폴더에서 `dashboard-launcher.cmd`를 더블클릭하여 대시보드를 바로 실행할 수 있습니다. 이미 대시보드가 실행 중이면 새 서버를 중복 실행하지 않고 기본 브라우저로 접속합니다.

다른 프로젝트 폴더에서 Gemini 작업을 실행하려면:

```powershell
cd C:\path\to\your-project
gemini-worker -Task "작업 이름" -Prompt "구체적인 작업 내용"
```

자세한 설명은 [README.md](README.md)를 참고하세요.

## 설치 명령과 로컬 검증

설치기에서 생성하는 명령은 다음과 같다. 기본 등록 위치는 `%LOCALAPPDATA%\agy\bin`이다.

| 명령 | 설치 파일 | 역할 |
|---|---|---|
| gemini-worker | gemini-worker.ps1 / .cmd | 단일 Gemini worker |
| worker-dashboard | worker-dashboard.ps1 / .cmd | 대시보드 launcher 위임 |
| parallel-gemini-workers | parallel-gemini-workers.ps1 / .cmd | 최대 두 독립 worker 실행 |
| stop-parallel-run | stop-parallel-run.ps1 / .cmd | 실행 중단 요청 |
| codex-route | codex-route.ps1 / .cmd | 읽기 전용 계획과 worker orchestration |
| review-integration | review-integration.ps1 / .cmd | integration 검토 |
| dashboard-launcher.cmd | dashboard-launcher.cmd | 설치 루트/checkout에서 대시보드 실행 |

`agy`는 이 프로젝트가 구현하는 명령이 아니라 Google Antigravity dependency CLI다. PowerShell 7(`pwsh.exe`)과 Node.js >=22.13.0이 필요하다.

현재 checkout을 별도 폴더에 검증 설치할 때는 다음처럼 실행한다. `-NoRegister`는 launcher를 해당 InstallRoot의 bin에만 만들며 사용자 PATH와 영구 CODEX_GEMINI_INSTALL_ROOT를 바꾸지 않는다.

```powershell
pwsh -NoProfile -File install.ps1 -SourcePath . -InstallRoot "$env:TEMP\codex-gemini-ver3-check" -NoStart -NoRegister
```

업데이트는 `.installed-program-files.json`에 기록한 프로그램 파일만 동기화한다. worker-settings.json, dashboard runtime data, .agent 및 사용자 local state는 보존한다. manifest가 없는 기존 설치에서는 알려진 폐기 파일(next.config.ts와 빈 Sites hosting.json)만 정리하며 이름을 알 수 없는 사용자 파일은 삭제하지 않는다. 잘못된 SourcePath는 원격 다운로드로 대체하지 않고 실패한다.