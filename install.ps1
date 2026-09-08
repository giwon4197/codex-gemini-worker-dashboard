[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard'),
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
    Write-Host '공개 저장소에서 최신 버전을 내려받습니다...' -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing $repoZip -OutFile $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
    if (-not $sourceRoot) { throw '다운로드한 저장소의 압축 구조를 확인할 수 없습니다.' }

    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $sourceRoot.FullName '*') -Destination $InstallRoot -Recurse -Force

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
$argsMap = @{Task=$Task;Prompt=$Prompt;ApprovalMode=$ApprovalMode;Workspace=$workspacePath;Timeout=$Timeout}
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
& (Join-Path $root 'run-parallel-workers.ps1') -TasksFile $TasksFile -Repository $repo -MaxWorkers $MaxWorkers -WorkerTimeoutSeconds $WorkerTimeoutSeconds -Timeout $Timeout -CleanupWorktrees:$CleanupWorktrees
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

    $dashboardLauncher = @'
[CmdletBinding()]
param()
$root = '__INSTALL_ROOT__'
$dashboard = Join-Path $root 'gemini-dashboard'
$url = 'http://localhost:3000/'
try { if ((Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2).StatusCode -eq 200) { Write-Host $url; exit 0 } } catch {}
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw '포트 3000을 다른 프로세스가 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행하세요.' }
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$npm = if ($npmCommand) { $npmCommand.Source } else { 'C:\Program Files\nodejs\npm.cmd' }
if (-not (Test-Path -LiteralPath $npm)) { throw 'npm.cmd를 찾을 수 없습니다. Node.js LTS 설치를 확인하세요.' }
$outLog = Join-Path $dashboard '.dev-server.stdout.log'
$errLog = Join-Path $dashboard '.dev-server.stderr.log'
Start-Process -FilePath $npm -ArgumentList 'run dev' -WorkingDirectory $dashboard -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog | Out-Null
for ($i=0;$i -lt 40;$i++) { Start-Sleep -Milliseconds 500; try { if ((Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2).StatusCode -eq 200) { Write-Host $url; exit 0 } } catch {} }
throw "대시보드 시작을 확인하지 못했습니다. 로그: $errLog"
'@.Replace('__INSTALL_ROOT__', $escapedRoot)
    Set-Content -LiteralPath (Join-Path $launcherDir 'worker-dashboard.ps1') -Value $dashboardLauncher -Encoding utf8
    $workerCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gemini-worker.ps1" %*
'@
    $dashboardCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0worker-dashboard.ps1" %*
'@
    $parallelCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0parallel-gemini-workers.ps1" %*
'@
    $stopParallelCmd = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-parallel-run.ps1" %*
'@
    Set-Content -LiteralPath (Join-Path $launcherDir 'gemini-worker.cmd') -Value $workerCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'worker-dashboard.cmd') -Value $dashboardCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'parallel-gemini-workers.cmd') -Value $parallelCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'stop-parallel-run.cmd') -Value $stopParallelCmd -Encoding ascii
    Add-UserPath $launcherDir

    Write-Host "설치 완료: $InstallRoot" -ForegroundColor Green
    Write-Host '새 터미널에서는 gemini-worker와 worker-dashboard 명령을 사용할 수 있습니다.' -ForegroundColor Green
    if (-not $NoStart) { & (Join-Path $launcherDir 'worker-dashboard.ps1') }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
