[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$launcherPath = Join-Path $repoRoot 'dashboard-launcher.cmd'

if (-not (Test-Path -LiteralPath $launcherPath)) {
    Write-Error "dashboard-launcher.cmd를 찾을 수 없습니다: $launcherPath"
    exit 1
}

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-launcher-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testTempRoot -Force | Out-Null

$passCount = 0
$failCount = 0

. (Join-Path $PSScriptRoot 'test-common.ps1')

function Invoke-Launcher([string[]]$launcherArgs, [hashtable]$envOverrides = @{}, [string]$targetLauncher = $launcherPath) {
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = 'cmd.exe'
    $joinedArgs = if ($launcherArgs -and $launcherArgs.Count -gt 0) { $launcherArgs -join ' ' } else { '' }
    $pinfo.Arguments = "/d /c `"`"$targetLauncher`" $joinedArgs`""
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $pinfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $pinfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    foreach ($key in $envOverrides.Keys) {
        $pinfo.EnvironmentVariables[$key] = [string]$envOverrides[$key]
    }

    $proc = [System.Diagnostics.Process]::Start($pinfo)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit(120000)) { $proc.Kill($true); throw 'Launcher exceeded test deadline' }
    if (-not [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)).Wait(10000)) { throw 'Launcher descendant retained output pipes' }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()

    return [PSCustomObject]@{
        ExitCode = $proc.ExitCode
        Output = $stdout + "`n" + $stderr
    }
}

function New-MockDashboardDir([string]$path, [bool]$withDependencies = $true) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $path 'package.json') -Value '{"name":"mock-dashboard"}' -Encoding utf8
    if ($withDependencies) {
        $modDir = Join-Path $path 'node_modules\vinext'
        New-Item -ItemType Directory -Path $modDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $modDir 'index.js') -Value 'module.exports = {}' -Encoding utf8
    }
    return $path
}

function Get-UnusedPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Stop-PortProcesses([int]$TargetPort) {
    $conns = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        $pids = @($conns.OwningProcess | Select-Object -Unique)
        foreach ($pidToKill in $pids) {
            if ($pidToKill -gt 0) {
                & taskkill.exe /PID $pidToKill /T /F 2>$null | Out-Null
                Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Start-Sleep -Milliseconds 500
}

try {
    Write-Host '=== 대시보드 런처 테스트 시작 ===' -ForegroundColor Cyan

    # 1. 기존 서버 감지 테스트
    Write-Host ''
    Write-Host '1. 기존 서버 감지 테스트' -ForegroundColor Cyan
    $rec1 = Join-Path $testTempRoot 'rec1.txt'
    $dash1 = New-MockDashboardDir (Join-Path $testTempRoot 'dash1') -withDependencies $true
    $res1 = Invoke-Launcher @('-DashboardDir', "`"$dash1`"", '-MockHttp', 'dashboard', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec1`"")
    Assert-Test '기존 서버 감지 시 종료 코드 0' ($res1.ExitCode -eq 0) "실제 종료 코드: $($res1.ExitCode)"
    $rec1Content = if (Test-Path -LiteralPath $rec1) { Get-Content -LiteralPath $rec1 -Raw -Encoding UTF8 } else { '' }
    Assert-Test '기존 서버 감지 시 ALREADY_RUNNING 기록' ($rec1Content -like '*ALREADY_RUNNING*')
    Assert-Test '기존 서버 감지 시 브라우저 열기 기록' ($rec1Content -like '*OPEN_BROWSER:*')
    Assert-Test '기존 서버 감지 시 새 서버 시작 안함' ($rec1Content -notlike '*SERVER_STARTING*')

    # 2. 포트 충돌 테스트
    Write-Host ''
    Write-Host '2. 포트 충돌 테스트' -ForegroundColor Cyan
    $rec2 = Join-Path $testTempRoot 'rec2.txt'
    $dash2 = New-MockDashboardDir (Join-Path $testTempRoot 'dash2') -withDependencies $true
    $res2 = Invoke-Launcher @('-DashboardDir', "`"$dash2`"", '-MockHttp', 'other', '-MockPortListen', 'true', '-NonInteractive', '-RecordFile', "`"$rec2`"")
    Assert-Test '포트 충돌 시 종료 코드 4' ($res2.ExitCode -eq 4) "실제 종료 코드: $($res2.ExitCode)"
    $rec2Content = if (Test-Path -LiteralPath $rec2) { Get-Content -LiteralPath $rec2 -Raw -Encoding UTF8 } else { '' }
    Assert-Test '포트 충돌 시 PORT_CONFLICT 기록' ($rec2Content -like '*PORT_CONFLICT*')
    Assert-Test '포트 충돌 시 한국어 안내 메시지 포함' ($res2.Output -like '*포트*' -and $res2.Output -like '*점유*' -and $res2.Output -like '*해결 방법*')
    Assert-Test '포트 충돌 시 새 서버 시작 안함' ($rec2Content -notlike '*SERVER_STARTING*')

    # 3. 대시보드 디렉터리 누락 테스트
    Write-Host ''
    Write-Host '3. 대시보드 디렉터리 누락 테스트' -ForegroundColor Cyan
    $rec3 = Join-Path $testTempRoot 'rec3.txt'
    $fakeDir = Join-Path $testTempRoot 'no-such-dashboard'
    $res3 = Invoke-Launcher @('-DashboardDir', "`"$fakeDir`"", '-NonInteractive', '-RecordFile', "`"$rec3`"")
    Assert-Test '대시보드 디렉터리 누락 시 종료 코드 2' ($res3.ExitCode -eq 2) "실제 종료 코드: $($res3.ExitCode)"
    $rec3Content = if (Test-Path -LiteralPath $rec3) { Get-Content -LiteralPath $rec3 -Raw -Encoding UTF8 } else { '' }
    Assert-Test '대시보드 디렉터리 누락 기록' ($rec3Content -like '*MISSING_DASHBOARD*')

    # 4. package.json 누락 테스트
    Write-Host ''
    Write-Host '4. package.json 누락 테스트' -ForegroundColor Cyan
    $rec4 = Join-Path $testTempRoot 'rec4.txt'
    $noPkgDir = Join-Path $testTempRoot 'no-pkg-dash'
    New-Item -ItemType Directory -Path $noPkgDir -Force | Out-Null
    $res4 = Invoke-Launcher @('-DashboardDir', "`"$noPkgDir`"", '-NonInteractive', '-RecordFile', "`"$rec4`"")
    Assert-Test 'package.json 누락 시 종료 코드 2' ($res4.ExitCode -eq 2) "실제 종료 코드: $($res4.ExitCode)"
    $rec4Content = if (Test-Path -LiteralPath $rec4) { Get-Content -LiteralPath $rec4 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'package.json 누락 기록' ($rec4Content -like '*MISSING_PACKAGE_JSON*')

    # 5. Node.js / npm 누락 테스트
    Write-Host ''
    Write-Host '5. Node.js / npm 누락 테스트' -ForegroundColor Cyan
    $rec5 = Join-Path $testTempRoot 'rec5.txt'
    $dash5 = New-MockDashboardDir (Join-Path $testTempRoot 'dash5') -withDependencies $true
    $res5 = Invoke-Launcher @('-DashboardDir', "`"$dash5`"", '-MockNodePath', 'C:\non-existent\node.exe', '-NonInteractive', '-RecordFile', "`"$rec5`"")
    Assert-Test 'Node.js 누락 시 종료 코드 1' ($res5.ExitCode -eq 1) "실제 종료 코드: $($res5.ExitCode)"
    $rec5Content = if (Test-Path -LiteralPath $rec5) { Get-Content -LiteralPath $rec5 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'Node.js 누락 기록' ($rec5Content -like '*MISSING_NODE_OR_NPM*')
    Assert-Test 'Node.js 안내 메시지 포함' ($res5.Output -like '*Node.js*' -and $res5.Output -like '*LTS*')

    # 6. npm 의존성 누락 테스트 (옵션 미지정)
    Write-Host ''
    Write-Host '6. npm 의존성 누락 테스트 (옵션 미지정)' -ForegroundColor Cyan
    $rec6 = Join-Path $testTempRoot 'rec6.txt'
    $dashNoMods = New-MockDashboardDir (Join-Path $testTempRoot 'dash-no-mods') -withDependencies $false
    $res6 = Invoke-Launcher @('-DashboardDir', "`"$dashNoMods`"", '-NonInteractive', '-RecordFile', "`"$rec6`"")
    Assert-Test 'npm 의존성 누락 시 종료 코드 3' ($res6.ExitCode -eq 3) "실제 종료 코드: $($res6.ExitCode)"
    $rec6Content = if (Test-Path -LiteralPath $rec6) { Get-Content -LiteralPath $rec6 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'npm 의존성 누락 기록' ($rec6Content -like '*MISSING_DEPENDENCIES*')
    Assert-Test '의존성 설치 안내 메시지 포함' ($res6.Output -like '*npm ci*' -or $res6.Output -like '*-InstallDependencies*')

    # 7. Dependency installation with -InstallDependencies
    Write-Host ''
    Write-Host '7. npm 의존성 설치 연동 테스트 (-InstallDependencies)' -ForegroundColor Cyan
    $rec7 = Join-Path $testTempRoot 'rec7.txt'
    $dashInstall = New-MockDashboardDir (Join-Path $testTempRoot 'dash-install') -withDependencies $false
    $mockNpmDir = Join-Path $testTempRoot 'mock-npm'
    New-Item -ItemType Directory -Path $mockNpmDir -Force | Out-Null
    $mockNpmCmd = Join-Path $mockNpmDir 'npm.cmd'
    $mockNpmScript = "@echo off`r`nif `"%~1`"==`"ci`" (`r`n    mkdir `"node_modules\vinext`" 2>nul`r`n    echo ok > `"node_modules\vinext\index.js`"`r`n    exit /b 0`r`n)`r`nexit /b 0`r`n"
    [System.IO.File]::WriteAllText($mockNpmCmd, $mockNpmScript, [System.Text.Encoding]::ASCII)

    $res7 = Invoke-Launcher @('-DashboardDir', "`"$dashInstall`"", '-MockNpmPath', "`"$mockNpmCmd`"", '-InstallDependencies', '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec7`"")
    Assert-Test '의존성 설치 성공 시 종료 코드 0' ($res7.ExitCode -eq 0) "실제 종료 코드: $($res7.ExitCode)"
    $rec7Content = if (Test-Path -LiteralPath $rec7) { Get-Content -LiteralPath $rec7 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'INSTALL_DEPENDENCIES_SUCCESS 기록' ($rec7Content -like '*INSTALL_DEPENDENCIES_SUCCESS*')
    Assert-Test 'node_modules/vinext 생성 확인' (Test-Path -LiteralPath (Join-Path $dashInstall 'node_modules\vinext'))

    # 8. Server startup success
    Write-Host ''
    Write-Host '8. 서버 시작 성공 테스트' -ForegroundColor Cyan
    $rec8 = Join-Path $testTempRoot 'rec8.txt'
    $dashReady = New-MockDashboardDir (Join-Path $testTempRoot 'dash-ready') -withDependencies $true
    $res8 = Invoke-Launcher @('-DashboardDir', "`"$dashReady`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec8`"")
    Assert-Test '서버 시작 성공 시 종료 코드 0' ($res8.ExitCode -eq 0) "실제 종료 코드: $($res8.ExitCode)"
    $rec8Content = if (Test-Path -LiteralPath $rec8) { Get-Content -LiteralPath $rec8 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'SERVER_STARTING 및 SERVER_READY 기록' ($rec8Content -like '*SERVER_STARTING*' -and $rec8Content -like '*SERVER_READY*')
    Assert-Test '브라우저 오픈 호출 기록' ($rec8Content -like '*OPEN_BROWSER:*')

    # 9. Server early exit
    Write-Host ''
    Write-Host '9. 서버 조기 종료 실패 테스트' -ForegroundColor Cyan
    $rec9 = Join-Path $testTempRoot 'rec9.txt'
    $dashEarly = New-MockDashboardDir (Join-Path $testTempRoot 'dash-early') -withDependencies $true
    $res9 = Invoke-Launcher @('-DashboardDir', "`"$dashEarly`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'early_exit', '-MockProcessExitCode', '42', '-NonInteractive', '-RecordFile', "`"$rec9`"")
    Assert-Test '조기 종료 시 종료 코드 5' ($res9.ExitCode -eq 5) "실제 종료 코드: $($res9.ExitCode)"
    $rec9Content = if (Test-Path -LiteralPath $rec9) { Get-Content -LiteralPath $rec9 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'EARLY_EXIT 기록' ($rec9Content -like '*EARLY_EXIT*')
    Assert-Test '로그 위치 및 종료 코드 한국어 안내' ($res9.Output -like '*.dev-server-3000.stderr.log*' -and $res9.Output -like '*42*')

    # 10. Server startup timeout
    Write-Host ''
    Write-Host '10. 서버 시작 시간 초과 테스트' -ForegroundColor Cyan
    $rec10 = Join-Path $testTempRoot 'rec10.txt'
    $dashTimeout = New-MockDashboardDir (Join-Path $testTempRoot 'dash-timeout') -withDependencies $true
    $res10 = Invoke-Launcher @('-DashboardDir', "`"$dashTimeout`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'timeout', '-ReadyTimeoutSeconds', '1', '-NonInteractive', '-RecordFile', "`"$rec10`"")
    Assert-Test '시간 초과 시 종료 코드 6' ($res10.ExitCode -eq 6) "실제 종료 코드: $($res10.ExitCode)"
    $rec10Content = if (Test-Path -LiteralPath $rec10) { Get-Content -LiteralPath $rec10 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'TIMEOUT 기록' ($rec10Content -like '*TIMEOUT*')
    Assert-Test '제한 시간 및 로그 파일 안내 포함' ($res10.Output -like '*제한 시간*' -and $res10.Output -like '*.dev-server-3000.stderr.log*')
    Assert-Test '시간 초과 시 프로세스 트리 정리' ($rec10Content -like '*PROCESS_TREE_STOPPED*')

    # 10-1. Structured argument forwarding and custom port
    Write-Host ''
    Write-Host '10-1. 안전한 인자 전달 및 사용자 지정 포트 테스트' -ForegroundColor Cyan
    $rec10a = Join-Path $testTempRoot 'rec10a.txt'
    $specialRoot = Join-Path $testTempRoot 'dashboard & safe'
    $dashSpecial = New-MockDashboardDir $specialRoot -withDependencies $true
    $res10a = Invoke-Launcher @('-DashboardDir', "`"$dashSpecial`"", '-Port', '4317', '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec10a`"")
    Assert-Test '특수문자가 포함된 경로를 코드 평가 없이 전달' ($res10a.ExitCode -eq 0) "실제 종료 코드: $($res10a.ExitCode)"
    Assert-Test '사용자 지정 포트 URL 사용' ((Get-Content -LiteralPath $rec10a -Raw -Encoding UTF8) -like '*OPEN_BROWSER:http://localhost:4317/*')

    $launcherPs1Path = Join-Path $repoRoot 'dashboard-launcher.ps1'
    $launcherContent = Get-Content -LiteralPath $launcherPs1Path -Raw -Encoding UTF8
    $cmdContent = Get-Content -LiteralPath $launcherPath -Raw -Encoding UTF8
    Assert-Test 'dashboard-launcher.cmd가 dashboard-launcher.ps1로 위임함' ($cmdContent -match 'dashboard-launcher\.ps1')
    Assert-Test 'dashboard-launcher.cmd 내 powershell 추출 로직 없음' ($cmdContent -notmatch 'LastIndexOf\(''\[CmdletBinding\]''\)')
    Assert-Test 'Invoke-Expression 미사용' ($launcherContent -notmatch 'Invoke-Expression')
    Assert-Test '실제 서버 시작 명령에 포트 전달' ($launcherContent -match '\$devArguments\s*=.*''--port''.*\$Port')
    Assert-Test 'taskkill 종료 코드 확인' ($launcherContent -match '\$taskkillSucceeded\s*=\s*\(\$LASTEXITCODE\s+-eq\s+0\)')
    Assert-Test '자손 프로세스 PID 수집' ($launcherContent -match 'Get-CimInstance Win32_Process' -and $launcherContent -match 'ParentProcessId')
    Assert-Test '자식부터 fallback 종료' ($launcherContent -match '\[Array\]::Reverse\(\$reverseIds\)')
    Assert-Test '종료 후 전체 PID와 포트 재확인' ($launcherContent -match '\$aliveIds\.Count -gt 0' -and $launcherContent -match 'Get-NetTCPConnection -LocalPort \$Port')
    Assert-Test '부모 선종료 시 cleanup 조기 반환 없음' ($launcherContent -notmatch 'if \(\$Process\.HasExited\) \{ return \}')

    # 11. Finding dashboard from repo root and install root
    Write-Host ''
    Write-Host '11. 저장소 루트 및 설치 디렉터리 경로 탐색 테스트' -ForegroundColor Cyan
    $testInstallRoot = Join-Path $testTempRoot 'fake-install-root'
    New-MockDashboardDir (Join-Path $testInstallRoot 'gemini-dashboard') -withDependencies $true | Out-Null
    Copy-Item -LiteralPath $launcherPath -Destination (Join-Path $testInstallRoot 'dashboard-launcher.cmd') -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot 'dashboard-launcher.ps1') -Destination (Join-Path $testInstallRoot 'dashboard-launcher.ps1') -Force

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = 'cmd.exe'
    $rec11 = Join-Path $testTempRoot 'rec11.txt'
    $copiedCmd = Join-Path $testInstallRoot 'dashboard-launcher.cmd'
    $pinfo.Arguments = "/d /c `"`"$copiedCmd`" -MockHttp none -MockPortListen false -MockProcessMode success -NoBrowser -NonInteractive -RecordFile `"$rec11`"`""
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $pinfo.CreateNoWindow = $true
    $proc11 = [System.Diagnostics.Process]::Start($pinfo)
    $proc11.WaitForExit()
    Assert-Test '설치 루트에서 실행 시 성공 (종료 코드 0)' ($proc11.ExitCode -eq 0) "실제 종료 코드: $($proc11.ExitCode)"
    $rec11Content = if (Test-Path -LiteralPath $rec11) { Get-Content -LiteralPath $rec11 -Raw -Encoding UTF8 } else { '' }
    Assert-Test '설치 루트 gemini-dashboard 탐색 성공' ($rec11Content -like '*SERVER_READY*')

    # 12. install.ps1 integration
    Write-Host ''
    Write-Host '12. install.ps1 연동 및 통합 런처 검증' -ForegroundColor Cyan
    $installPs1Path = Join-Path $repoRoot 'install.ps1'
    $installContent = Get-Content -LiteralPath $installPs1Path -Raw -Encoding UTF8

    $noDuplicate = [bool]($installContent -notlike '*Start-Process -FilePath $npm -ArgumentList ''run dev''*')
    Assert-Test 'install.ps1 내 중복 dashboardLauncher 구현 제거됨' $noDuplicate
    $copiesCmd = [bool]($installContent -like '*dashboard-launcher.cmd*')
    Assert-Test 'install.ps1이 dashboard-launcher.cmd를 복사함' $copiesCmd
    $copiesPs1 = [bool]($installContent -like '*dashboard-launcher.ps1*')
    Assert-Test 'install.ps1이 dashboard-launcher.ps1을 복사함' $copiesPs1
    $cmdDelegates = [bool]($installContent -like '*"%~dp0worker-dashboard.ps1" %*')
    Assert-Test 'worker-dashboard.cmd가 PS wrapper로 위임함' $cmdDelegates
    $ps1Delegates = [bool]($installContent -like '*dashboard-launcher.cmd*')
    Assert-Test 'worker-dashboard.ps1이 dashboard-launcher.cmd로 위임함' $ps1Delegates
    Assert-Test 'install.ps1이 PowerShell 7 절대 경로를 결정함' ($installContent -like '*Resolve-PowerShell7*' -and $installContent -like '*$pwshPath*')
    Assert-Test '생성 워커 CMD가 Windows PowerShell 5.1 대신 pwsh를 사용함' ($installContent -like '*"__PWSH_PATH__" -NoProfile -File*' -and $installContent -notlike '*powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0gemini-worker.ps1"*')

    # 13. cmd.exe /d /c 실행 및 PowerShell 소스의 CMD 오해석 방지
    Write-Host ''
    Write-Host '13. cmd.exe /d /c 실행 및 PowerShell 소스 오해석 방지' -ForegroundColor Cyan
    $rec13 = Join-Path $testTempRoot 'rec13.txt'
    $dash13 = New-MockDashboardDir (Join-Path $testTempRoot 'dash13') -withDependencies $true
    $res13 = Invoke-Launcher @('-DashboardDir', "`"$dash13`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec13`"")
    Assert-Test 'cmd.exe /d /c 실행 시 정상 종료 코드 0' ($res13.ExitCode -eq 0)
    Assert-Test 'CMD 구문 에러 또는 알 수 없는 명령어 에러 없음' ($res13.Output -notmatch 'is not recognized' -and $res13.Output -notmatch 'unexpected at this time')

    # 14. code/VS Code 미실행 검증
    Write-Host ''
    Write-Host '14. code/VS Code 미실행 검증' -ForegroundColor Cyan
    $mockCodeDir = Join-Path $testTempRoot 'mock-code-dir'
    New-Item -ItemType Directory -Path $mockCodeDir -Force | Out-Null
    $codeCalledLog = Join-Path $mockCodeDir 'code-called.log'
    $mockCodeCmd = Join-Path $mockCodeDir 'code.cmd'
    [System.IO.File]::WriteAllText($mockCodeCmd, "@echo off`r`necho CALLED >> `"%~dp0code-called.log`"`r`nexit /b 88`r`n", [System.Text.Encoding]::ASCII)
    $rec14 = Join-Path $testTempRoot 'rec14.txt'
    $dash14 = New-MockDashboardDir (Join-Path $testTempRoot 'dash14') -withDependencies $true
    $res14 = Invoke-Launcher @('-DashboardDir', "`"$dash14`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec14`"") @{ 'PATH' = "$mockCodeDir;$env:PATH" }
    Assert-Test 'mock code가 PATH에 있어도 정상 종료 0' ($res14.ExitCode -eq 0)
    Assert-Test 'code/VS Code가 실행되지 않음' (-not (Test-Path -LiteralPath $codeCalledLog))

    # 15. 정확히 1회의 PowerShell 런처 호출 검증
    Write-Host ''
    Write-Host '15. 정확히 1회의 PowerShell 런처 호출 검증' -ForegroundColor Cyan
    $mockPwshDir = Join-Path $testTempRoot 'mock-pwsh-dir'
    New-Item -ItemType Directory -Path $mockPwshDir -Force | Out-Null
    $pwshCallsLog = Join-Path $mockPwshDir 'pwsh-calls.log'
    $pwshWrapperCmd = Join-Path $mockPwshDir 'track-pwsh.cmd'
    $pwshExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
    if (-not $pwshExe) { $pwshExe = 'powershell.exe' }
    [System.IO.File]::WriteAllText($pwshWrapperCmd, "@echo off`r`necho INVOCATION >> `"$pwshCallsLog`"`r`n`"$pwshExe`" %*`r`nexit /b %ERRORLEVEL%`r`n", [System.Text.Encoding]::ASCII)
    $rec15 = Join-Path $testTempRoot 'rec15.txt'
    $dash15 = New-MockDashboardDir (Join-Path $testTempRoot 'dash15') -withDependencies $true
    $res15 = Invoke-Launcher @('-DashboardDir', "`"$dash15`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'success', '-NoBrowser', '-NonInteractive', '-RecordFile', "`"$rec15`"") @{ 'DASHBOARD_LAUNCHER_POWERSHELL' = $pwshWrapperCmd }
    Assert-Test '추적 래퍼 경유 시 정상 종료 0' ($res15.ExitCode -eq 0)
    $pwshCalls = if (Test-Path -LiteralPath $pwshCallsLog) { @(Get-Content -LiteralPath $pwshCallsLog | Where-Object { $_ -match 'INVOCATION' }) } else { @() }
    Assert-Test 'PowerShell 런처 호출 횟수가 정확히 1회임' ($pwshCalls.Count -eq 1)

    # 16. 공백/한글/특수문자 경로 인자 전달 및 모의 종료 코드 보존 검증
    Write-Host ''
    Write-Host '16. 공백/한글/특수문자 경로 인자 전달 및 모의 종료 코드 보존 검증' -ForegroundColor Cyan
    $specialKoreanRoot = Join-Path $testTempRoot '대시보드 [공백 & 특수문자] 테스트'
    $dash16 = New-MockDashboardDir $specialKoreanRoot -withDependencies $true
    $rec16 = Join-Path $testTempRoot 'rec16.txt'
    $res16 = Invoke-Launcher @('-DashboardDir', "`"$dash16`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'early_exit', '-MockProcessExitCode', '77', '-NonInteractive', '-NoBrowser', '-RecordFile', "`"$rec16`"")
    Assert-Test '모의 조기 종료 코드 5 보존' ($res16.ExitCode -eq 5)
    Assert-Test '공백/한글/특수문자 경로가 온전히 전달됨' ($res16.Output -like '*77*' -and $res16.Output.Contains('대시보드 [공백 & 특수문자] 테스트'))
    $rec16Content = if (Test-Path -LiteralPath $rec16) { Get-Content -LiteralPath $rec16 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'EARLY_EXIT 기록 확인' ($rec16Content -like '*EARLY_EXIT*')

    # Git archives may use LF. Both byte layouts must remain executable CMD.
    foreach ($lineEnding in @('LF','CRLF')) {
        $layoutRoot = Join-Path $testTempRoot $lineEnding
        New-Item -ItemType Directory -Path $layoutRoot | Out-Null
        Copy-Item -LiteralPath (Join-Path $repoRoot 'dashboard-launcher.ps1') -Destination $layoutRoot
        $layoutCmd = Join-Path $layoutRoot 'dashboard-launcher.cmd'
        $layoutText = [IO.File]::ReadAllText($launcherPath).Replace("`r`n","`n")
        if ($lineEnding -eq 'CRLF') { $layoutText = $layoutText.Replace("`n","`r`n") }
        [IO.File]::WriteAllText($layoutCmd,$layoutText,[Text.Encoding]::ASCII)
        $layoutResult = Invoke-Launcher @('-DashboardDir', ('"'+$dash16+'"'), '-MockHttp','dashboard','-MockPortListen','true','-NoBrowser','-NonInteractive') @{'PATH'="$mockCodeDir;$env:PATH"} $layoutCmd
        Assert-Test "$lineEnding wrapper returns success without executing source" ($layoutResult.ExitCode -eq 0 -and $layoutResult.Output -notmatch 'F8\)|dDir|CODE -eq')
        Assert-Test "$lineEnding wrapper does not execute code" (-not (Test-Path -LiteralPath $codeCalledLog))
    }
    $oldNode = Join-Path $testTempRoot 'old-node.cmd'
    [IO.File]::WriteAllText($oldNode,"@echo off`r`necho v20.0.0`r`n",[Text.Encoding]::ASCII)
    $oldNodeResult = Invoke-Launcher @('-DashboardDir',('"'+$dash16+'"'),'-MockNodePath',('"'+$oldNode+'"'),'-NoBrowser','-NonInteractive')
    Assert-Test 'unsupported Node fails with explicit version requirement' ($oldNodeResult.ExitCode -eq 2 -and $oldNodeResult.Output.Contains('22.13.0'))

    # 17. 격리 설치 및 자식 프로세스 PATH를 통한 사용자 대면 명령 해석 검증
    Write-Host ''
    Write-Host '17. 격리 설치 및 자식 프로세스 PATH를 통한 사용자 대면 명령 해석 검증' -ForegroundColor Cyan
    $disposableInstallRoot = Join-Path $testTempRoot '설치 [공백]'
    $installOut = Join-Path $testTempRoot 'install.stdout.log'
    $installErr = Join-Path $testTempRoot 'install.stderr.log'
    $installProc = Start-Process -FilePath $pwshExe `
        -ArgumentList @('-NoProfile', '-File', ('"' + (Join-Path $repoRoot 'install.ps1') + '"'), '-SourcePath', ('"' + $repoRoot + '"'), '-InstallRoot', ('"' + $disposableInstallRoot + '"'), '-NoRegister', '-NoStart') `
        -WindowStyle Hidden -RedirectStandardOutput $installOut -RedirectStandardError $installErr -PassThru
    if (-not $installProc.WaitForExit(600000)) { $installProc.Kill($true); throw 'Isolated install timed out' }
    Get-Content -LiteralPath $installOut
    Get-Content -LiteralPath $installErr
    Assert-Test 'install.ps1 격리 설치 성공 (종료 코드 0)' ($installProc.ExitCode -eq 0)
    if ($installProc.ExitCode -ne 0) { throw 'Isolated install failed; refusing fallback to global worker-dashboard' }

    $installedBin = Join-Path $disposableInstallRoot 'bin'
    Assert-Test '설치된 worker-dashboard.cmd 존재' (Test-Path -LiteralPath (Join-Path $installedBin 'worker-dashboard.cmd'))
    Assert-Test '설치된 worker-dashboard.ps1 존재' (Test-Path -LiteralPath (Join-Path $installedBin 'worker-dashboard.ps1'))
    Assert-Test '설치된 dashboard-launcher.cmd 존재' (Test-Path -LiteralPath (Join-Path $installedBin 'dashboard-launcher.cmd'))
    Assert-Test '설치된 dashboard-launcher.ps1 존재' (Test-Path -LiteralPath (Join-Path $installedBin 'dashboard-launcher.ps1'))
    foreach ($requiredWrapper in @('worker-dashboard.cmd','worker-dashboard.ps1','dashboard-launcher.cmd','dashboard-launcher.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installedBin $requiredWrapper))) { throw "Missing isolated launcher: $requiredWrapper" }
    }
    $isolatedCommand = Get-Command -Name (Join-Path $installedBin 'worker-dashboard.cmd') -ErrorAction Stop
    Assert-Test 'installed command resolves to isolated bin' ($isolatedCommand.Source -eq (Join-Path $installedBin 'worker-dashboard.cmd'))

    $rec17 = Join-Path $testTempRoot 'rec17.txt'
    $pinfo17 = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo17.FileName = 'cmd.exe'
    $pinfo17.Arguments = '/d /c ""' + $isolatedCommand.Source + '" -MockHttp none -MockPortListen false -MockProcessMode success -NoBrowser -NonInteractive -RecordFile "' + $rec17 + '""'
    $pinfo17.RedirectStandardOutput = $true
    $pinfo17.RedirectStandardError = $true
    $pinfo17.UseShellExecute = $false
    $pinfo17.CreateNoWindow = $true
    $pinfo17.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $pinfo17.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $pinfo17.EnvironmentVariables['PATH'] = "$installedBin;$env:PATH"
    $proc17 = [System.Diagnostics.Process]::Start($pinfo17)
    $out17 = $proc17.StandardOutput.ReadToEndAsync()
    $err17 = $proc17.StandardError.ReadToEndAsync()
    if (-not $proc17.WaitForExit(120000)) { $proc17.Kill($true); throw 'Installed CMD timed out' }
    $proc17Out = $out17.GetAwaiter().GetResult()
    $proc17Err = $err17.GetAwaiter().GetResult()
    Assert-Test 'PATH 내 worker-dashboard 명령 직접 해석 성공 (종료 코드 0)' ($proc17.ExitCode -eq 0)
    $rec17Content = if (Test-Path -LiteralPath $rec17) { Get-Content -LiteralPath $rec17 -Raw -Encoding UTF8 } else { '' }
    Assert-Test '설치된 런처 SERVER_READY 기록' ($rec17Content -like '*SERVER_READY*')
    $psWrapper = Join-Path $installedBin 'worker-dashboard.ps1'
    $psRecord = Join-Path $testTempRoot 'installed-ps-record.txt'
    & $pwshExe -NoProfile -File $psWrapper -Port 4319 -MockHttp none -MockPortListen false -MockProcessMode success -NoBrowser -NonInteractive -RecordFile $psRecord
    Assert-Test 'installed PowerShell worker-dashboard preserves named options' ($LASTEXITCODE -eq 0 -and (Get-Content -Raw -LiteralPath $psRecord).Contains('OPEN_BROWSER:http://localhost:4319/'))
    Assert-Test 'mock launcher does not start quota background processes' (-not (Get-Content -Raw -LiteralPath $psRecord).Contains('UPDATER_PID:'))
    $hostRecord = Join-Path $testTempRoot 'windows-powershell-record.txt'
    $hostScript = Join-Path $testTempRoot 'windows-powershell-command.ps1'
    $hostBody = @'
$env:Path = '__BIN__;' + $env:Path
if ((Get-Command worker-dashboard).Source -ne '__WRAPPER__') { throw 'Unexpected global worker-dashboard resolution' }
worker-dashboard -Port 4321 -MockHttp none -MockPortListen false -MockProcessMode early_exit -MockProcessExitCode 77 -NoBrowser -NonInteractive -RecordFile '__RECORD__'
exit $LASTEXITCODE
'@.Replace('__BIN__', $installedBin.Replace("'","''")).Replace('__WRAPPER__', $psWrapper.Replace("'","''")).Replace('__RECORD__', $hostRecord.Replace("'","''"))
    [IO.File]::WriteAllText($hostScript, $hostBody, [Text.UTF8Encoding]::new($true))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScript
    Assert-Test 'Windows PowerShell command resolves isolated Unicode install and preserves failure exit' ($LASTEXITCODE -eq 5 -and (Test-Path -LiteralPath $hostRecord) -and (Get-Content -Raw -LiteralPath $hostRecord).Contains('EARLY_EXIT'))

    # 18. 실제 소스 및 설치 런처의 실제(Non-Mock) 백그라운드 준비 및 프로세스 정리 검증
    Write-Host ''
    Write-Host '18. 실제 소스 및 설치 런처의 실제 백그라운드 준비 및 프로세스 정리 검증' -ForegroundColor Cyan
    $codeProcessIdsBefore = @(Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object Id)
    $realPort1 = Get-UnusedPort
    $recReal1 = Join-Path $testTempRoot 'rec-real1.txt'
    $dashDirReal = Join-Path $repoRoot 'gemini-dashboard'

    Write-Host "  실제 소스 런처 실행 (포트: $realPort1)..." -ForegroundColor Gray
    $resReal1 = Invoke-Launcher @('-DashboardDir', "`"$dashDirReal`"", '-Port', [string]$realPort1, '-NoBrowser', '-NonInteractive', '-ReadyTimeoutSeconds', '45', '-RecordFile', "`"$recReal1`"")
    Assert-Test '실제 소스 런처 시작 성공 (종료 코드 0)' ($resReal1.ExitCode -eq 0) "출력: $($resReal1.Output)"
    $recReal1Content = if (Test-Path -LiteralPath $recReal1) { Get-Content -LiteralPath $recReal1 -Raw -Encoding UTF8 } else { '' }
    Write-Host "SOURCE port=$realPort1; $($recReal1Content.Replace("`n", '; '))"
    Assert-Test '실제 소스 런처 SERVER_READY 기록' ($recReal1Content -like '*SERVER_READY*')

    # Verify HTTP readiness on allocated port
    $httpSuccess1 = $false
    try {
        $realHttpRes1 = Invoke-WebRequest -Uri "http://localhost:$realPort1/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $httpSuccess1 = ($realHttpRes1.StatusCode -eq 200)
    } catch {}
    Assert-Test '실제 소스 런처 HTTP 200 준비 확인' $httpSuccess1

    # Cleanup test-started processes on realPort1
    Stop-PortProcesses $realPort1
    $remConns1 = Get-NetTCPConnection -LocalPort $realPort1 -State Listen -ErrorAction SilentlyContinue
    Assert-Test '실제 소스 런처 프로세스 정리 완료 (포트 해제)' ($null -eq $remConns1)

    # Real installed launcher test on separate unused port
    $realPort2 = Get-UnusedPort
    $recReal2 = Join-Path $testTempRoot 'rec-real2.txt'
    Write-Host "  실제 설치 런처 실행 (포트: $realPort2)..." -ForegroundColor Gray
    $pinfoReal2 = New-Object System.Diagnostics.ProcessStartInfo
    $pinfoReal2.FileName = 'cmd.exe'
    $pinfoReal2.Arguments = '/d /c ""' + $isolatedCommand.Source + '" -Port ' + $realPort2 + ' -NoBrowser -NonInteractive -ReadyTimeoutSeconds 45 -RecordFile "' + $recReal2 + '""'
    $pinfoReal2.RedirectStandardOutput = $true
    $pinfoReal2.RedirectStandardError = $true
    $pinfoReal2.UseShellExecute = $false
    $pinfoReal2.CreateNoWindow = $true
    $pinfoReal2.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $pinfoReal2.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $pinfoReal2.EnvironmentVariables['PATH'] = "$installedBin;$env:PATH"
    $procReal2 = [System.Diagnostics.Process]::Start($pinfoReal2)
    $outReal2 = $procReal2.StandardOutput.ReadToEndAsync()
    $errReal2 = $procReal2.StandardError.ReadToEndAsync()
    if (-not $procReal2.WaitForExit(120000)) { $procReal2.Kill($true); throw 'Installed real launcher timed out' }
    $procReal2Out = $outReal2.GetAwaiter().GetResult()
    $procReal2Err = $errReal2.GetAwaiter().GetResult()

    Assert-Test '실제 설치 런처 시작 성공 (종료 코드 0)' ($procReal2.ExitCode -eq 0) "출력: $procReal2Out $procReal2Err"
    $recReal2Content = if (Test-Path -LiteralPath $recReal2) { Get-Content -LiteralPath $recReal2 -Raw -Encoding UTF8 } else { '' }
    Write-Host "INSTALLED port=$realPort2; $($recReal2Content.Replace("`n", '; '))"
    Assert-Test '실제 설치 런처 SERVER_READY 기록' ($recReal2Content -like '*SERVER_READY*')

    $httpSuccess2 = $false
    try {
        $realHttpRes2 = Invoke-WebRequest -Uri "http://localhost:$realPort2/" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $httpSuccess2 = ($realHttpRes2.StatusCode -eq 200)
    } catch {}
    Assert-Test '실제 설치 런처 HTTP 200 준비 확인' $httpSuccess2

    Stop-PortProcesses $realPort2
    $remConns2 = Get-NetTCPConnection -LocalPort $realPort2 -State Listen -ErrorAction SilentlyContinue
    Assert-Test '실제 설치 런처 프로세스 정리 완료 (포트 해제)' ($null -eq $remConns2)
    $newCodeProcesses = @(Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object Id -notin $codeProcessIdsBefore)
    Assert-Test 'real source and installed launchers start no VS Code process' ($newCodeProcesses.Count -eq 0)

} finally {
    if ($realPort1) { Stop-PortProcesses $realPort1 }
    if ($realPort2) { Stop-PortProcesses $realPort2 }
    foreach ($recordPath in @($recReal1, $recReal2)) {
        if ($recordPath -and (Test-Path -LiteralPath $recordPath)) {
            foreach ($recordLine in Get-Content -LiteralPath $recordPath) {
                if ($recordLine -match '^(SERVER|UPDATER)_PID:(\d+)$') {
                    $ownedProcess = Get-Process -Id ([int]$Matches[2]) -ErrorAction SilentlyContinue
                    if ($ownedProcess) { $ownedProcess.Kill($true) }
                }
            }
        }
    }
    if (Test-Path -LiteralPath $testTempRoot) {
        $cleanupRoot = [IO.Path]::GetFullPath($testTempRoot)
        $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
        if (-not $cleanupRoot.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $cleanupRoot) -notlike 'test-launcher-*') { throw 'Unsafe test cleanup path' }
        Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '=== 테스트 결과 요약 ===' -ForegroundColor Cyan
Write-Host "통과: $passCount 개" -ForegroundColor Green
Write-Host "실패: $failCount 개" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })

if ($failCount -gt 0) {
    exit 1
} else {
    exit 0
}
