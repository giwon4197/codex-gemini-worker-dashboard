@echo off
setlocal
set "PS_SCRIPT=%~dp0dashboard-launcher.ps1"
if not exist "%PS_SCRIPT%" (
  echo Required dashboard launcher not found: "%PS_SCRIPT%" 1>&2
  exit /b 2
)
if defined DASHBOARD_LAUNCHER_POWERSHELL goto configured
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh.exe^) is required. 1>&2
  exit /b 2
)
set "DASHBOARD_LAUNCHER_POWERSHELL=pwsh.exe"
:configured
"%DASHBOARD_LAUNCHER_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
exit /b %ERRORLEVEL%
