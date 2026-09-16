[CmdletBinding()]
param(
    [string]$DashboardDir = '',
    [string]$InstallRoot = '',
    [int]$Port = 3000,
    [int]$ReadyTimeoutSeconds = 30,
    [switch]$NoBrowser,
    [switch]$NonInteractive,
    [switch]$InstallDependencies,
    # Mocks and test hooks:
    [string]$MockHttp = '',             # 'dashboard', 'other', 'none'
    [string]$MockPortListen = '',       # 'true', 'false'
    [string]$MockProcessMode = '',      # 'success', 'early_exit', 'timeout'
    [int]$MockProcessExitCode = 1,
    [string]$MockNodePath = '',
    [string]$MockNpmPath = '',
    [string]$RecordFile = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Environment variable overrides
if ($env:DASHBOARD_LAUNCHER_NONINTERACTIVE -eq '1') { $NonInteractive = $true }
if ($env:DASHBOARD_LAUNCHER_NO_BROWSER -eq '1') { $NoBrowser = $true }
if ($env:DASHBOARD_LAUNCHER_PORT) { $Port = [int]$env:DASHBOARD_LAUNCHER_PORT }
if ($env:DASHBOARD_LAUNCHER_TIMEOUT_SEC) { $ReadyTimeoutSeconds = [int]$env:DASHBOARD_LAUNCHER_TIMEOUT_SEC }
if ($env:DASHBOARD_LAUNCHER_MOCK_HTTP) { $MockHttp = $env:DASHBOARD_LAUNCHER_MOCK_HTTP }
if ($env:DASHBOARD_LAUNCHER_MOCK_PORT_LISTEN) { $MockPortListen = $env:DASHBOARD_LAUNCHER_MOCK_PORT_LISTEN }
if ($env:DASHBOARD_LAUNCHER_MOCK_PROCESS_MODE) { $MockProcessMode = $env:DASHBOARD_LAUNCHER_MOCK_PROCESS_MODE }
if ($env:DASHBOARD_LAUNCHER_MOCK_PROCESS_EXIT_CODE) { $MockProcessExitCode = [int]$env:DASHBOARD_LAUNCHER_MOCK_PROCESS_EXIT_CODE }
if ($env:DASHBOARD_LAUNCHER_MOCK_NODE_PATH) { $MockNodePath = $env:DASHBOARD_LAUNCHER_MOCK_NODE_PATH }
if ($env:DASHBOARD_LAUNCHER_MOCK_NPM_PATH) { $MockNpmPath = $env:DASHBOARD_LAUNCHER_MOCK_NPM_PATH }
if ($env:DASHBOARD_LAUNCHER_RECORD_FILE) { $RecordFile = $env:DASHBOARD_LAUNCHER_RECORD_FILE }

function Record-Action([string]$Action) {
    if ($RecordFile) {
        try {
            Add-Content -LiteralPath $RecordFile -Value $Action -Encoding utf8
        } catch {}
    }
}

function Start-LauncherProcess([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory, [string]$StdoutPath, [string]$StderrPath) {
    # Start-Process treats [] in WorkingDirectory/redirection paths as wildcards.
    # ShellExecute supplies a literal Windows cwd; CMD redirects into literal files
    # without leaving the launcher's output pipes open in background children.
    $quotedArguments = @($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $env:ComSpec
    $startInfo.Arguments = '/d /s /c ""' + $FilePath + '" ' + $quotedArguments + ' 1>"' + $StdoutPath + '" 2>"' + $StderrPath + '""'
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    return [Diagnostics.Process]::Start($startInfo)
}

function Wait-Acknowledgment([string]$PromptText, [int]$Seconds = 5) {
    if ($NonInteractive -or $env:DASHBOARD_LAUNCHER_NONINTERACTIVE -eq '1' -or $env:CI -eq '1') {
        return
    }
    if ([Console]::IsInputRedirected) {
        return
    }
    if ($Seconds -le 0) {
        return
    }
    Write-Host "`n$PromptText" -ForegroundColor Yellow
    $elapsed = 0
    while ($elapsed -lt ($Seconds * 10)) {
        try {
            if ([Console]::KeyAvailable) {
                [void][Console]::ReadKey($true)
                break
            }
        } catch {
            break
        }
        Start-Sleep -Milliseconds 100
        $elapsed++
    }
}

function Open-Browser([string]$TargetUrl) {
    Record-Action "OPEN_BROWSER:$TargetUrl"
    if ($NoBrowser -or $env:DASHBOARD_LAUNCHER_NO_BROWSER -eq '1') {
        return
    }
    try {
        Start-Process $TargetUrl | Out-Null
    } catch {
        Write-Host "기본 브라우저를 열지 못했습니다: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "브라우저에서 직접 접속하세요: $TargetUrl" -ForegroundColor Yellow
    }
}

function Stop-ServerProcess($Process) {
    if (-not $Process) {
        if ($MockProcessMode) { Record-Action 'PROCESS_TREE_STOPPED' }
        return
    }
    $treeIds = [Collections.Generic.List[int]]::new()
    try {
        $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $pendingParents = @([int]$Process.Id)
        while ($pendingParents.Count -gt 0) {
            $parentId = [int]$pendingParents[0]
            $pendingParents = @($pendingParents | Select-Object -Skip 1)
            $children = @($allProcesses | Where-Object { [int]$_.ParentProcessId -eq $parentId })
            foreach ($child in $children) {
                $childId = [int]$child.ProcessId
                if (-not $treeIds.Contains($childId)) {
                    [void]$treeIds.Add($childId)
                    $pendingParents += $childId
                }
            }
        }
    } catch {}
    [void]$treeIds.Add([int]$Process.Id)
    $taskkillSucceeded = $false
    try {
        & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
        $taskkillSucceeded = ($LASTEXITCODE -eq 0)
        [void]$Process.WaitForExit(3000)
        $Process.Refresh()
    } catch {}
    $aliveIds = @($treeIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if (-not $taskkillSucceeded -or $aliveIds.Count -gt 0) {
        $reverseIds = $treeIds.ToArray()
        [Array]::Reverse($reverseIds)
        foreach ($processId in $reverseIds) {
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
        [void]$Process.WaitForExit(3000)
        $Process.Refresh()
    }
    $aliveIds = @($treeIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($aliveIds.Count -gt 0) { throw "대시보드 서버 프로세스 트리를 종료하지 못했습니다. 남은 PID: $($aliveIds -join ', ')" }
    Start-Sleep -Milliseconds 300
    $remainingListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($remainingListener) { throw "대시보드 서버 종료 후에도 포트 $Port 리스너가 남아 있습니다." }
    Record-Action 'PROCESS_TREE_STOPPED'
}

try {
    # 1. Locate gemini-dashboard directory
    $targetDashboardDir = $null

    if ($DashboardDir) {
        if (Test-Path -LiteralPath $DashboardDir) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $DashboardDir).Path
        } else {
            Write-Host "[오류] 지정된 대시보드 디렉터리를 찾을 수 없습니다." -ForegroundColor Red
            Write-Host "지정된 경로: $DashboardDir" -ForegroundColor Yellow
            Record-Action 'MISSING_DASHBOARD'
            Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
            exit 2
        }
    }

    if (-not $targetDashboardDir -and $InstallRoot) {
        $cand = Join-Path $InstallRoot 'gemini-dashboard'
        if (Test-Path -LiteralPath $cand) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $cand).Path
        } else {
            Write-Host "[오류] 지정된 설치 디렉터리에서 gemini-dashboard를 찾을 수 없습니다." -ForegroundColor Red
            Write-Host "지정된 경로: $InstallRoot" -ForegroundColor Yellow
            Record-Action 'MISSING_DASHBOARD'
            Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
            exit 2
        }
    }

    $scriptDir = if ($env:LAUNCHER_FILE) { Split-Path -Parent $env:LAUNCHER_FILE } else { $PSScriptRoot }
    if (-not $scriptDir) { $scriptDir = (Get-Location).Path }

    if (-not $targetDashboardDir -and $scriptDir) {
        $cand = Join-Path $scriptDir 'gemini-dashboard'
        if (Test-Path -LiteralPath $cand) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $cand).Path
        }
    }

    if (-not $targetDashboardDir -and $env:CODEX_GEMINI_INSTALL_ROOT) {
        $cand = Join-Path $env:CODEX_GEMINI_INSTALL_ROOT 'gemini-dashboard'
        if (Test-Path -LiteralPath $cand) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $cand).Path
        }
    }

    if (-not $targetDashboardDir -and $env:LOCALAPPDATA) {
        $cand = Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard\gemini-dashboard'
        if (Test-Path -LiteralPath $cand) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $cand).Path
        }
    }

    if (-not $targetDashboardDir) {
        $cand = Join-Path (Get-Location).Path 'gemini-dashboard'
        if (Test-Path -LiteralPath $cand) {
            $targetDashboardDir = (Resolve-Path -LiteralPath $cand).Path
        }
    }

    if (-not $targetDashboardDir -or -not (Test-Path -LiteralPath $targetDashboardDir)) {
        Write-Host "[오류] gemini-dashboard 디렉터리를 찾을 수 없습니다." -ForegroundColor Red
        Write-Host "저장소 루트 또는 설치 디렉터리에 'gemini-dashboard' 폴더가 있는지 확인하세요." -ForegroundColor Yellow
        Record-Action 'MISSING_DASHBOARD'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 2
    }

    $packageJson = Join-Path $targetDashboardDir 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        Write-Host "[오류] 대시보드 디렉터리에서 package.json을 찾을 수 없습니다." -ForegroundColor Red
        Write-Host "확인한 경로: $targetDashboardDir" -ForegroundColor Yellow
        Record-Action 'MISSING_PACKAGE_JSON'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 2
    }

    # 2. Check Node.js and npm
    $nodeCmd = $null
    $npmCmd = $null

    if ($MockNodePath) {
        if (Test-Path -LiteralPath $MockNodePath) { $nodeCmd = $MockNodePath }
    } else {
        $nodeFromPath = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeFromPath) {
            $nodeCmd = $nodeFromPath.Source
        } elseif (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') {
            $nodeCmd = 'C:\Program Files\nodejs\node.exe'
        }
    }

    if ($MockNpmPath) {
        if (Test-Path -LiteralPath $MockNpmPath) { $npmCmd = $MockNpmPath }
    } else {
        $npmFromPath = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npmFromPath) { $npmFromPath = Get-Command npm.exe -ErrorAction SilentlyContinue }
        if (-not $npmFromPath) { $npmFromPath = Get-Command npm -ErrorAction SilentlyContinue }
        if ($npmFromPath) {
            $npmCmd = $npmFromPath.Source
        } elseif (Test-Path -LiteralPath 'C:\Program Files\nodejs\npm.cmd') {
            $npmCmd = 'C:\Program Files\nodejs\npm.cmd'
        }
    }

    if (-not $nodeCmd -or -not $npmCmd) {
        Write-Host "[오류] Node.js 또는 npm을 찾을 수 없습니다." -ForegroundColor Red
        Write-Host "원인: 대시보드를 실행하려면 Node.js(v22 LTS 이상)가 필요합니다." -ForegroundColor Yellow
        Write-Host "해결 방법: https://nodejs.org 에서 Node.js LTS 버전을 설치한 뒤 다시 실행하세요." -ForegroundColor Yellow
        Record-Action 'MISSING_NODE_OR_NPM'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 1
    }

    $nodeVersionText = (& $nodeCmd --version 2>$null | Select-Object -First 1)
    $nodeVersion = $null
    if (-not [version]::TryParse(([string]$nodeVersionText).Trim().TrimStart('v'), [ref]$nodeVersion) -or $nodeVersion -lt [version]'22.13.0') {
        Write-Host '[오류] Node.js 22.13.0 이상이 필요합니다.' -ForegroundColor Red
        Record-Action 'UNSUPPORTED_NODE_VERSION'
        exit 2
    }
    # 3. Check npm dependencies (node_modules/vinext)
    $vinextModule = Join-Path $targetDashboardDir 'node_modules\vinext'
    if (-not (Test-Path -LiteralPath $vinextModule)) {
        if ($InstallDependencies) {
            Write-Host "의존성(node_modules)을 설치합니다 (npm ci)..." -ForegroundColor Cyan
            Record-Action 'INSTALLING_DEPENDENCIES'
            Push-Location -LiteralPath $targetDashboardDir
            try {
                & $npmCmd ci
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "[오류] npm ci 명령이 실패했습니다 (종료 코드: $LASTEXITCODE)." -ForegroundColor Red
                    Record-Action 'INSTALL_DEPENDENCIES_FAILED'
                    Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
                    exit 3
                }
                Record-Action 'INSTALL_DEPENDENCIES_SUCCESS'
            } finally {
                Pop-Location
            }
        } else {
            Write-Host "[오류] 대시보드 의존성 모듈이 설치되어 있지 않습니다." -ForegroundColor Red
            Write-Host "원인: gemini-dashboard/node_modules 폴더가 누락되었습니다." -ForegroundColor Yellow
            Write-Host "해결 방법: 'gemini-dashboard' 디렉터리에서 'npm ci'를 실행하거나," -ForegroundColor Yellow
            Write-Host "          런처에 -InstallDependencies 옵션을 붙여 다시 실행하세요." -ForegroundColor Yellow
            Record-Action 'MISSING_DEPENDENCIES'
            Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
            exit 3
        }
    }

    # 4. Check port and running instances
    $url = "http://localhost:$Port/"
    $isDashboardOnline = $false

    if ($MockHttp -eq 'dashboard') {
        $isDashboardOnline = $true
    } elseif ($MockHttp -eq 'other' -or $MockHttp -eq 'none') {
        $isDashboardOnline = $false
    } else {
        try {
            $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($res.StatusCode -eq 200) {
                if ($res.Content -like '*Gemini 워커 관제실*' -or $res.Content -like '*gemini-dashboard*' -or $res.Content -like '*sites-project*' -or $res.Content -like '*vinext*' -or $res.Content -like '*codex-gemini-worker-dashboard*') {
                    $isDashboardOnline = $true
                } else {
                    try {
                        $apiRes = Invoke-WebRequest -Uri "http://localhost:$Port/api/settings" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                        if ($apiRes.StatusCode -eq 200 -and ($apiRes.Content -like '*tier*' -or $apiRes.Content -like '*model*')) {
                            $isDashboardOnline = $true
                        }
                    } catch {}
                }
            }
        } catch {}
    }

    if ($isDashboardOnline) {
        Write-Host "대시보드가 이미 실행 중입니다: $url" -ForegroundColor Green
        Record-Action 'ALREADY_RUNNING'
        Open-Browser $url
        if (-not $NoBrowser) {
            Write-Host "기본 브라우저에서 대시보드를 열었습니다." -ForegroundColor Cyan
        }
        Wait-Acknowledgment "잠시 후 창이 닫힙니다 (3초)..." 3
        exit 0
    }

    $isPortListening = $false
    if ($MockPortListen -eq 'true' -or $MockPortListen -eq '1') {
        $isPortListening = $true
    } elseif ($MockPortListen -eq 'false' -or $MockPortListen -eq '0') {
        $isPortListening = $false
    } else {
        try {
            $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
            if ($conns) { $isPortListening = $true }
        } catch {}
        if (-not $isPortListening) {
            try {
                $tcpClient = New-Object System.Net.Sockets.TcpClient
                $iar = $tcpClient.BeginConnect('127.0.0.1', $Port, $null, $null)
                $connected = $iar.AsyncWaitHandle.WaitOne(500, $false)
                if ($connected -and $tcpClient.Connected) {
                    $tcpClient.EndConnect($iar)
                    $isPortListening = $true
                }
                $tcpClient.Close()
            } catch {}
        }
    }

    if ($isPortListening) {
        $procDesc = ""
        try {
            $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
            if ($conns) {
                $pids = $conns.OwningProcess | Select-Object -Unique
                $pNames = foreach ($p in $pids) {
                    try {
                        $pr = Get-Process -Id $p -ErrorAction SilentlyContinue
                        if ($pr) { "$($pr.ProcessName) (PID: $p)" } else { "PID: $p" }
                    } catch { "PID: $p" }
                }
                if ($pNames) { $procDesc = " (점유 프로세스: " + ($pNames -join ', ') + ")" }
            }
        } catch {}

        Write-Host "[오류] 포트 $Port 이(가) 다른 프로세스에 의해 사용 중입니다.$procDesc" -ForegroundColor Red
        Write-Host "원인: 포트 $Port 이(가) 이미 점유되어 있어 새 대시보드 서버를 시작할 수 없습니다." -ForegroundColor Yellow
        Write-Host "해결 방법: 포트 $Port 을(를) 사용 중인 다른 프로그램을 종료한 뒤 다시 실행하세요." -ForegroundColor Yellow
        Record-Action 'PORT_CONFLICT'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 4
    }

    # 5. Start new dashboard server
    $outLog = Join-Path $targetDashboardDir ".dev-server-$Port.stdout.log"
    $errLog = Join-Path $targetDashboardDir ".dev-server-$Port.stderr.log"

    Set-Content -LiteralPath $outLog -Value '' -Encoding utf8 -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $errLog -Value '' -Encoding utf8 -ErrorAction SilentlyContinue

    Write-Host "대시보드 서버를 시작합니다 ($url)..." -ForegroundColor Cyan
    Record-Action 'SERVER_STARTING'

    $serverProcess = $null
    if ($MockProcessMode -eq 'early_exit') {
        Record-Action 'MOCK_EARLY_EXIT'
        Set-Content -LiteralPath $errLog -Value "Mock server failed on startup with code $MockProcessExitCode" -Encoding utf8
        Write-Host "`n[오류] 대시보드 서버 프로세스가 조기 종료되었습니다. (종료 코드: $MockProcessExitCode)" -ForegroundColor Red
        Write-Host "원인 및 상세 로그는 다음 파일에서 확인하세요:" -ForegroundColor Yellow
        Write-Host "  에러 로그: $errLog" -ForegroundColor Yellow
        Write-Host "  출력 로그: $outLog" -ForegroundColor Yellow
        Record-Action 'EARLY_EXIT'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 5
    } elseif ($MockProcessMode -eq 'timeout') {
        Record-Action 'MOCK_TIMEOUT'
        Stop-ServerProcess $serverProcess
        Set-Content -LiteralPath $errLog -Value "Mock server startup timed out waiting for readiness" -Encoding utf8
        Write-Host "`n[오류] 제한 시간(${ReadyTimeoutSeconds}초) 내에 대시보드 서버 준비를 확인하지 못했습니다." -ForegroundColor Red
        Write-Host "로그 파일을 확인하여 오류를 진단하세요:" -ForegroundColor Yellow
        Write-Host "  에러 로그: $errLog" -ForegroundColor Yellow
        Write-Host "  출력 로그: $outLog" -ForegroundColor Yellow
        Record-Action 'TIMEOUT'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 6
    } elseif ($MockProcessMode -eq 'success') {
        Record-Action 'MOCK_SUCCESS'
        Set-Content -LiteralPath $outLog -Value "Mock server ready at $url" -Encoding utf8
    } else {
        $devArguments = @('run', 'dev', '--', '--port', [string]$Port, '--strictPort')
        Record-Action ("START_ARGUMENTS:" + ($devArguments -join ' '))
        $serverProcess = Start-LauncherProcess -FilePath $npmCmd `
            -Arguments $devArguments `
            -WorkingDirectory $targetDashboardDir `
            -StdoutPath $outLog `
            -StderrPath $errLog
        Record-Action "SERVER_PID:$($serverProcess.Id)"
    }

    # 6. Wait for ready within timeout
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $isReady = ($MockProcessMode -eq 'success')
    $maxMs = $ReadyTimeoutSeconds * 1000

    while (-not $isReady -and ($stopwatch.ElapsedMilliseconds -lt $maxMs)) {
        Start-Sleep -Milliseconds 500

        if ($serverProcess -and $serverProcess.HasExited) {
            $exitCode = $serverProcess.ExitCode
            Write-Host "`n[오류] 대시보드 서버 프로세스가 조기 종료되었습니다. (종료 코드: $exitCode)" -ForegroundColor Red
            Write-Host "원인 및 상세 로그는 다음 파일에서 확인하세요:" -ForegroundColor Yellow
            Write-Host "  에러 로그: $errLog" -ForegroundColor Yellow
            Write-Host "  출력 로그: $outLog" -ForegroundColor Yellow
            Record-Action 'EARLY_EXIT'
            Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
            exit 5
        }

        try {
            $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($res.StatusCode -eq 200) {
                if ($res.Content -like '*Gemini 워커 관제실*' -or $res.Content -like '*gemini-dashboard*' -or $res.Content -like '*sites-project*' -or $res.Content -like '*vinext*' -or $res.Content -like '*codex-gemini-worker-dashboard*') {
                    $isReady = $true
                    break
                }
            }
        } catch {}
    }

    if (-not $isReady) {
        Stop-ServerProcess $serverProcess
        Write-Host "`n[오류] 제한 시간(${ReadyTimeoutSeconds}초) 내에 대시보드 서버 준비를 확인하지 못했습니다." -ForegroundColor Red
        Write-Host "로그 파일을 확인하여 오류를 진단하세요:" -ForegroundColor Yellow
        Write-Host "  에러 로그: $errLog" -ForegroundColor Yellow
        Write-Host "  출력 로그: $outLog" -ForegroundColor Yellow
        Record-Action 'TIMEOUT'
        Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
        exit 6
    }

    Record-Action 'SERVER_READY'
    if ($serverProcess) {
        foreach ($updaterName in @('refresh-gemini-quota.ps1', 'refresh-codex-rate-limits.ps1')) {
            $updaterPath = Join-Path (Split-Path -Parent $targetDashboardDir) $updaterName
            if (Test-Path -LiteralPath $updaterPath) {
                try {
                    $updaterLogBase = Join-Path $targetDashboardDir ('.' + [IO.Path]::GetFileNameWithoutExtension($updaterName) + '-' + $Port)
                    $updaterProcess = Start-LauncherProcess -FilePath (Join-Path $PSHOME 'pwsh.exe') -Arguments @('-NoProfile', '-File', $updaterPath, '-DashboardDir', $targetDashboardDir, '-ParentProcessId', [string]$serverProcess.Id) -WorkingDirectory $targetDashboardDir -StdoutPath ($updaterLogBase + '.stdout.log') -StderrPath ($updaterLogBase + '.stderr.log')
                    Record-Action "UPDATER_PID:$($updaterProcess.Id)"
                } catch { Write-Warning "사용량 갱신기를 시작하지 못했습니다: $($_.Exception.Message)" }
            }
        }
    }
    Write-Host "`n대시보드 서버가 준비되었습니다: $url" -ForegroundColor Green
    Open-Browser $url
    if (-not $NoBrowser) {
        Write-Host "기본 브라우저에서 대시보드를 열었습니다." -ForegroundColor Cyan
    }

    Wait-Acknowledgment "잠시 후 창이 닫힙니다 (3초)..." 3
    exit 0
} catch {
    Stop-ServerProcess $serverProcess
    Write-Host "`n[오류] 예기치 않은 오류가 발생했습니다: $($_.Exception.Message)" -ForegroundColor Red
    Record-Action "FATAL_ERROR:$($_.Exception.Message)"
    Wait-Acknowledgment "창을 닫으려면 아무 키나 누르세요 (10초 후 자동 종료)..." 10
    exit 99
}
