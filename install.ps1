[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard'),
    [string]$SourcePath = '',
    [switch]$NoStart,
    [switch]$NoRegister
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$repoZip = 'https://github.com/giwon4197/codex-gemini-worker-dashboard/archive/refs/heads/main.zip'
$agyInstaller = 'https://antigravity.google/cli/install.ps1'
$launcherDir = Join-Path $env:LOCALAPPDATA 'agy\bin'
if ($NoRegister) { $launcherDir = Join-Path $InstallRoot 'bin' }

function Require-Windows {
    if ($env:OS -ne 'Windows_NT') { throw '이 설치기는 Windows PowerShell 전용입니다.' }
}

function Assert-NodeVersion {
    $reportedVersion = & node.exe --version
    $parsedVersion = $null
    if (-not [version]::TryParse(([string]$reportedVersion).Trim().TrimStart('v'), [ref]$parsedVersion) -or $parsedVersion -lt [version]'22.13.0') {
        throw 'Node.js 22.13.0 이상이 필요합니다. Node.js를 업데이트한 뒤 다시 실행하세요.'
    }
}
function Ensure-Node {
    if ((Get-Command node.exe -ErrorAction SilentlyContinue) -and (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Assert-NodeVersion; return }
    $standardNodeDir = 'C:\Program Files\nodejs'
    if ((Test-Path -LiteralPath (Join-Path $standardNodeDir 'node.exe')) -and
        (Test-Path -LiteralPath (Join-Path $standardNodeDir 'npm.cmd'))) {
        $env:Path = "$standardNodeDir;$env:Path"
        Assert-NodeVersion
        return
    }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { throw 'Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.' }
    Write-Host 'Node.js LTS를 설치합니다...' -ForegroundColor Cyan
    & $winget.Source install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ((Test-Path -LiteralPath (Join-Path $standardNodeDir 'node.exe')) -and
        (Test-Path -LiteralPath (Join-Path $standardNodeDir 'npm.cmd'))) {
        $env:Path = "$standardNodeDir;$env:Path"
        Assert-NodeVersion
        return
    }
    throw 'Node.js 설치에 실패했습니다.'
}

function Ensure-Antigravity {
    $agy = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $agy) { return }
    Write-Host 'Google Antigravity CLI를 공식 설치기로 설치합니다...' -ForegroundColor Cyan
    $script = (Invoke-WebRequest -UseBasicParsing $agyInstaller).Content
    if ($script -is [byte[]]) { $script = [Text.Encoding]::UTF8.GetString($script) }
    Invoke-Expression $script
    if (-not (Test-Path -LiteralPath $agy)) { throw 'Antigravity CLI 설치를 확인할 수 없습니다.' }
}

function Resolve-PowerShell7 {
    $command = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
        return [IO.Path]::GetFullPath($command.Source)
    }
    foreach ($candidate in @(
        'C:\Program Files\PowerShell\7\pwsh.exe',
        'C:\Program Files\PowerShell\7-preview\pwsh.exe'
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    throw 'PowerShell 7(pwsh.exe)이 필요합니다. PowerShell 7을 설치한 뒤 다시 실행하세요.'
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
$pwshPath = Resolve-PowerShell7

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-gemini-install-" + [guid]::NewGuid())
$zipPath = Join-Path $tempRoot 'source.zip'
$extractPath = Join-Path $tempRoot 'source'
New-Item -ItemType Directory -Path $tempRoot, $extractPath -Force | Out-Null

try {
    if ($SourcePath) {
        if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) { throw "SourcePath not found: $SourcePath" }
        $sourceResolved = (Resolve-Path -LiteralPath $SourcePath).Path
        Write-Host "지정된 소스 경로에서 복사합니다: $sourceResolved" -ForegroundColor Cyan
        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        $syncModule = Join-Path $sourceResolved 'installer-common.ps1'
        if (-not (Test-Path -LiteralPath $syncModule)) { throw "Required installer module not found: $syncModule" }
        . $syncModule
        Sync-InstalledProgramFiles -SourceRoot $sourceResolved -InstallRoot $InstallRoot
    } else {
        Write-Host '공개 저장소에서 최신 버전을 내려받습니다...' -ForegroundColor Cyan
        Invoke-WebRequest -UseBasicParsing $repoZip -OutFile $zipPath
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
        $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
        if (-not $sourceRoot) { throw '다운로드한 저장소의 압축 구조를 확인할 수 없습니다.' }

        New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
        $syncModule = Join-Path $sourceRoot.FullName 'installer-common.ps1'
        if (-not (Test-Path -LiteralPath $syncModule)) { throw "Required installer module not found: $syncModule" }
        . $syncModule
        Sync-InstalledProgramFiles -SourceRoot $sourceRoot.FullName -InstallRoot $InstallRoot
    }

    $dataDir = Join-Path $InstallRoot 'gemini-dashboard\public\data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Initialize-RuntimeFile (Join-Path $dataDir 'dashboard.example.json') (Join-Path $dataDir 'dashboard.json')
    Initialize-RuntimeFile (Join-Path $dataDir 'live-worker.example.json') (Join-Path $dataDir 'live-worker.json')
    Initialize-RuntimeFile (Join-Path $InstallRoot 'worker-settings.example.json') (Join-Path $InstallRoot 'worker-settings.json')

    Write-Host '대시보드 의존성을 설치합니다...' -ForegroundColor Cyan
    Push-Location -LiteralPath (Join-Path $InstallRoot 'gemini-dashboard')
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
    [IO.File]::WriteAllText((Join-Path $launcherDir 'gemini-worker.ps1'), $workerLauncher, [Text.UTF8Encoding]::new($true))

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
    [IO.File]::WriteAllText((Join-Path $launcherDir 'parallel-gemini-workers.ps1'), $parallelLauncher, [Text.UTF8Encoding]::new($true))

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
    [IO.File]::WriteAllText((Join-Path $launcherDir 'stop-parallel-run.ps1'), $stopParallelLauncher, [Text.UTF8Encoding]::new($true))

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
    [IO.File]::WriteAllText((Join-Path $launcherDir 'codex-route.ps1'), $codexRouterLauncher, [Text.UTF8Encoding]::new($true))

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
    [IO.File]::WriteAllText((Join-Path $launcherDir 'review-integration.ps1'), $reviewIntegrationLauncher, [Text.UTF8Encoding]::new($true))

    # Copy dashboard-launcher.cmd and dashboard-launcher.ps1 to launcher directory
    $installedLauncherCmd = Join-Path $InstallRoot 'dashboard-launcher.cmd'
    if (Test-Path -LiteralPath $installedLauncherCmd) {
        Copy-Item -LiteralPath $installedLauncherCmd -Destination (Join-Path $launcherDir 'dashboard-launcher.cmd') -Force
    }
    $installedLauncherPs1 = Join-Path $InstallRoot 'dashboard-launcher.ps1'
    if (Test-Path -LiteralPath $installedLauncherPs1) {
        Copy-Item -LiteralPath $installedLauncherPs1 -Destination (Join-Path $launcherDir 'dashboard-launcher.ps1') -Force
    }

    $dashboardLauncherPs = @'
[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$RemainingArgs
)
$env:CODEX_GEMINI_INSTALL_ROOT = '__INSTALL_ROOT__'
& '__PWSH_PATH_PS__' -NoProfile -File (Join-Path $PSScriptRoot 'dashboard-launcher.ps1') @RemainingArgs
exit $LASTEXITCODE
'@.Replace('__INSTALL_ROOT__', $escapedRoot).Replace('__PWSH_PATH_PS__', $pwshPath.Replace("'", "''"))
    [IO.File]::WriteAllText((Join-Path $launcherDir 'worker-dashboard.ps1'), $dashboardLauncherPs, [Text.UTF8Encoding]::new($true))
    $escapedPwsh = $pwshPath.Replace('%', '%%')
    $workerCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0gemini-worker.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    $dashboardCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0worker-dashboard.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    $parallelCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0parallel-gemini-workers.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    $stopParallelCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0stop-parallel-run.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    $codexRouterCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0codex-route.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    $reviewIntegrationCmd = @'
@echo off
"__PWSH_PATH__" -NoProfile -File "%~dp0review-integration.ps1" %*
'@.Replace('__PWSH_PATH__', $escapedPwsh)
    Set-Content -LiteralPath (Join-Path $launcherDir 'gemini-worker.cmd') -Value $workerCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'worker-dashboard.cmd') -Value $dashboardCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'parallel-gemini-workers.cmd') -Value $parallelCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'stop-parallel-run.cmd') -Value $stopParallelCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'codex-route.cmd') -Value $codexRouterCmd -Encoding ascii
    Set-Content -LiteralPath (Join-Path $launcherDir 'review-integration.cmd') -Value $reviewIntegrationCmd -Encoding ascii
    if (-not $NoRegister) {
      Add-UserPath $launcherDir
      Add-UserPath (Split-Path -Parent $pwshPath)
      [Environment]::SetEnvironmentVariable('CODEX_GEMINI_INSTALL_ROOT', $InstallRoot, 'User')
    }
    $env:CODEX_GEMINI_INSTALL_ROOT = $InstallRoot

    Write-Host "설치 완료: $InstallRoot" -ForegroundColor Green
    if ($NoRegister) {
      Write-Host "격리 설치: 전역 등록 없이 $launcherDir 에 launcher를 생성했습니다." -ForegroundColor Green
    } else {
      Write-Host '새 터미널에서는 gemini-worker와 worker-dashboard 명령을 사용할 수 있습니다.' -ForegroundColor Green
    }
    Write-Host '설치 폴더 또는 어디서든 dashboard-launcher.cmd를 더블클릭하여 대시보드를 실행할 수 있습니다.' -ForegroundColor Green
    if (-not $NoStart) { & (Join-Path $launcherDir 'worker-dashboard.ps1') }
}
finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
