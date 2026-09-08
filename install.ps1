[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard'),
    [string]$SourcePath = '',
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$repoZip = 'https://github.com/giwon4197/codex-gemini-worker-dashboard/archive/refs/heads/main.zip'
$agyInstaller = 'https://antigravity.google/cli/install.ps1'
$launcherDir = Join-Path $env:LOCALAPPDATA 'agy\bin'

function Require-Windows {
    if ($env:OS -ne 'Windows_NT') { throw '이 설치기는 Windows PowerShell 전용입니다.' }
}

function Ensure-Node {
    if ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return }
    $standardNodeDir = 'C:\Program Files\nodejs'
    if ((Test-Path -LiteralPath (Join-Path $standardNodeDir 'node.exe')) -and
        (Test-Path -LiteralPath (Join-Path $standardNodeDir 'npm.cmd'))) {
        $env:Path = "$standardNodeDir;$env:Path"
        return
    }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.' }
    Write-Host 'Node.js LTS를 설치합니다...' -ForegroundColor Cyan
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ((Test-Path -LiteralPath (Join-Path $standardNodeDir 'node.exe')) -and
        (Test-Path -LiteralPath (Join-Path $standardNodeDir 'npm.cmd'))) {
        $env:Path = "$standardNodeDir;$env:Path"
        return
    }
    throw 'Node.js 설치에 실패했습니다.'
}

function Ensure-Antigravity {
    $agy = Join-Path $launcherDir 'agy.exe'
    if (Test-Path -LiteralPath $agy) { return }
    Write-Host 'Google Antigravity CLI를 공식 설치기로 설치합니다...' -ForegroundColor Cyan
    $script = (Invoke-WebRequest -UseBasicParsing $agyInstaller).Content
    if ($script -is [byte[]]) { $script = [Text.Encoding]::UTF8.GetString($script) }
    Invoke-Expression $script
    if (-not (Test-Path -LiteralPath $agy)) { throw 'Antigravity CLI 설치를 확인할 수 없습니다.' }
}

function Add-UserPath([string]$PathToAdd) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($current -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $normalized = $PathToAdd.TrimEnd('\')
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $normalized })) {
        $newPath = (@($parts) + $PathToAdd) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $normalized })) {
        $env:Path = "$PathToAdd;$env:Path"
    }
}

function Initialize-RuntimeFile([string]$Example, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Target)) {
        Copy-Item -LiteralPath $Example -Destination $Target
    }
}

Require-Windows
Ensure-Node
Ensure-Antigravity

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-gemini-install-" + [guid]::NewGuid())
$zipPath = Join-Path $tempRoot 'source.zip'
$extractPath = Join-Path $tempRoot 'source'
New-Item -ItemType Directory -Path $tempRoot, $extractPath -Force | Out-Null

try {
    if ($SourcePath -and (Test-Path -LiteralPath $SourcePath)) {
        $sourceResolved = (Resolve-Path -LiteralPath $SourcePath).Path
        Write-Host "지정된 소스 경로에서 복사합니다: $sourceResolved" -ForegroundColor Cyan
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceResolved '*') -Destination $InstallRoot -Recurse -Force
    } else {
        Write-Host '공개 저장소에서 최신 버전을 내려받습니다...' -ForegroundColor Cyan
        Invoke-WebRequest -UseBasicParsing $repoZip -OutFile $zipPath
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
        $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
        if (-not $sourceRoot) { throw '다운로드한 저장소의 압축 구조를 확인할 수 없습니다.' }

        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceRoot.FullName '*') -Destination $InstallRoot -Recurse -Force
    }

    $dataDir = Join-Path $InstallRoot 'gemini-dashboard\public\data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Initialize-RuntimeFile (Join-Path $dataDir 'dashboard.example.json') (Join-Path $dataDir 'dashboard.json')
    Initialize-RuntimeFile (Join-Path $dataDir 'live-worker.example.json') (Join-Path $dataDir 'live-worker.json')
    Initialize-RuntimeFile (Join-Path $InstallRoot 'worker-settings.example.json') (Join-Path $InstallRoot 'worker-settings.json')

    Write-Host '대시보드 의존성을 설치합니다...' -ForegroundColor Cyan
    Push-Location (Join-Path $InstallRoot 'gemini-dashboard')
    try { & npm.cmd ci } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'npm 의존성 설치에 실패했습니다.' }

    New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
    $escapedRoot = $InstallRoot.Replace("'", "''")
    $workerLauncher = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true,Position=0)][string]$Task,
  [Parameter(Mandatory=$true,Position=1)][string]$Prompt,
  [Alias('Tier')][string]$Model='',
  [ValidateSet('plan','auto_edit')][string]$ApprovalMode='auto_edit',
  [string]$Workspace='',
  [string]$Timeout='24h'
)
$root = '__INSTALL_ROOT__'
$workspacePath = if ([string]::IsNullOrWhiteSpace($Workspace)) { (Get-Location).Path } else { (Resolve-Path -LiteralPath $Workspace).Path }
$sharedDataDir = Join-Path $root 'gemini-dashboard\public\data'
$sharedDashboardPath = Join-Path $sharedDataDir 'dashboard.json'
$argsMap = @{Task=$Task;Prompt=$Prompt;ApprovalMode=$ApprovalMode;Workspace=$workspacePath;Timeout=$Timeout;DashboardPath=$sharedDashboardPath;DataDir=$sharedDataDir}
if ($Model) { $argsMap.Model = $Model }
& (Join-Path $root 'run-gemini-worker.ps1') @argsMap
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'gemini-worker.ps1') -Value $workerLauncher -Encoding utf8

    $parallelLauncher = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true,Position=0)][string]$TasksFile,
  [string]$Repository='',
  [ValidateRange(1,2)][int]$MaxWorkers=2,
  [ValidateRange(1,86400)][int]$WorkerTimeoutSeconds=3600,
  [string]$Timeout='24h',
  [switch]$CleanupWorktrees
)
$root = '__INSTALL_ROOT__'
$repo = if ([string]::IsNullOrWhiteSpace($Repository)) { (Get-Location).Path } else { (Resolve-Path -LiteralPath $Repository).Path }
$sharedDataDir = Join-Path $root 'gemini-dashboard\public\data'
$sharedDashboardPath = Join-Path $sharedDataDir 'dashboard.json'
& (Join-Path $root 'run-parallel-workers.ps1') -TasksFile $TasksFile -Repository $repo -MaxWorkers $MaxWorkers -WorkerTimeoutSeconds $WorkerTimeoutSeconds -Timeout $Timeout -CleanupWorktrees:$CleanupWorktrees -DashboardPath $sharedDashboardPath -DataDir $sharedDataDir
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'parallel-gemini-workers.ps1') -Value $parallelLauncher -Encoding utf8

    $stopParallelLauncher = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true,Position=0)][string]$RunId,
  [string]$Repository=''
)
$root = '__INSTALL_ROOT__'
$repo = if ([string]::IsNullOrWhiteSpace($Repository)) { (Get-Location).Path } else { (Resolve-Path -LiteralPath $Repository).Path }
& (Join-Path $root 'stop-parallel-run.ps1') -RunId $RunId -Repository $repo
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'stop-parallel-run.ps1') -Value $stopParallelLauncher -Encoding utf8

    $codexRouterLauncher = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true,Position=0)][string]$Request,
  [string]$Repository='',
  [switch]$PlanOnly
)
$root = '__INSTALL_ROOT__'
$repo = if ([string]::IsNullOrWhiteSpace($Repository)) { (Get-Location).Path } else { (Resolve-Path -LiteralPath $Repository).Path }
& (Join-Path $root 'codex-router.ps1') -Request $Request -Repository $repo -PlanOnly:$PlanOnly
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'codex-route.ps1') -Value $codexRouterLauncher -Encoding utf8

    $reviewIntegrationLauncher = @'
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true,Position=0)][string]$RunId,
  [string]$Repository=''
)
$root = '__INSTALL_ROOT__'
$repo = if ([string]::IsNullOrWhiteSpace($Repository)) { (Get-Location).Path } else { (Resolve-Path -LiteralPath $Repository).Path }
& (Join-Path $root 'review-integration.ps1') -RunId $RunId -Repository $repo
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'review-integration.ps1') -Value $reviewIntegrationLauncher -Encoding utf8

    # Copy dashboard-launcher.cmd to launcher directory
    $installedLauncher = Join-Path $InstallRoot 'dashboard-launcher.cmd'
    if (Test-Path -LiteralPath $installedLauncher) {
        Copy-Item -LiteralPath $installedLauncher -Destination (Join-Path $launcherDir 'dashboard-launcher.cmd') -Force
    }

    $dashboardLauncherPs = @'
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$RemainingArgs
)
& (Join-Path $PSScriptRoot 'dashboard-launcher.cmd') @RemainingArgs
exit $LASTEXITCODE
'@
    Set-Content -LiteralPath (Join-Path $launcherDir 'worker-dashboard.ps1') -Value $dashboardLauncherPs -Encoding utf8
    $workerCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gemini-worker.ps1" %*
'@
    $dashboardCmd = @'
@echo off
"%~dp0dashboard-launcher.cmd" %*
'@
    $parallelCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0parallel-gemini-workers.ps1" %*
'@
    $stopParallelCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-parallel-run.ps1" %*
'@
    $codexRouterCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-route.ps1" %*
'@
    $reviewIntegrationCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0review-integration.ps1" %*
'@
    Set-Content -LiteralPath (Join-Path $launcherDir 'gemini-worker.cmd') -Value $workerCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'worker-dashboard.cmd') -Value $dashboardCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'parallel-gemini-workers.cmd') -Value $parallelCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'stop-parallel-run.cmd') -Value $stopParallelCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'codex-route.cmd') -Value $codexRouterCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'review-integration.cmd') -Value $reviewIntegrationCmd -Encoding ascii
    Add-UserPath $launcherDir
    [Environment]::SetEnvironmentVariable('CODEX_GEMINI_INSTALL_ROOT', $InstallRoot, 'User')
    $env:CODEX_GEMINI_INSTALL_ROOT = $InstallRoot

    Write-Host "설치 완료: $InstallRoot" -ForegroundColor Green
    Write-Host '새 터미널에서는 gemini-worker와 worker-dashboard 명령을 사용할 수 있습니다.' -ForegroundColor Green
    Write-Host '설치 폴더 또는 어디서든 dashboard-launcher.cmd를 더블클릭하여 대시보드를 실행할 수 있습니다.' -ForegroundColor Green
    if (-not $NoStart) { & (Join-Path $launcherDir 'worker-dashboard.ps1') }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
