# 빠른 시작

PowerShell에서 한 번에 설치하고 대시보드를 실행합니다.

```powershell
irm https://raw.githubusercontent.com/giwon4197/codex-gemini-worker-dashboard/main/install.ps1 | iex
```

설치 후 새 PowerShell에서:

```powershell
worker-dashboard
```

다른 프로젝트 폴더에서 Gemini 작업을 실행하려면:

```powershell
cd C:\path\to\your-project
gemini-worker -Task "작업 이름" -Prompt "구체적인 작업 내용"
```

자세한 설명은 [README.md](README.md)를 참고하세요.
