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

function Assert-Test([string]$testName, [bool]$condition, [string]$detail = '') {
    if ($condition) {
        Write-Host "  [PASS] $testName" -ForegroundColor Green
        $script:passCount++
    } else {
        Write-Host "  [FAIL] $testName" -ForegroundColor Red
        if ($detail) {
            Write-Host "         상세: $detail" -ForegroundColor Yellow
        }
        $script:failCount++
    }
}

function Invoke-Launcher([string[]]$launcherArgs, [hashtable]$envOverrides = @{}) {
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = 'cmd.exe'
    $joinedArgs = if ($launcherArgs -and $launcherArgs.Count -gt 0) { $launcherArgs -join ' ' } else { '' }
    $pinfo.Arguments = "/c `"`"$launcherPath`" $joinedArgs`""
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
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()

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
    Assert-Test '로그 위치 및 종료 코드 한국어 안내' ($res9.Output -like '*.dev-server.stderr.log*' -and $res9.Output -like '*42*')

    # 10. Server startup timeout
    Write-Host ''
    Write-Host '10. 서버 시작 시간 초과 테스트' -ForegroundColor Cyan
    $rec10 = Join-Path $testTempRoot 'rec10.txt'
    $dashTimeout = New-MockDashboardDir (Join-Path $testTempRoot 'dash-timeout') -withDependencies $true
    $res10 = Invoke-Launcher @('-DashboardDir', "`"$dashTimeout`"", '-MockHttp', 'none', '-MockPortListen', 'false', '-MockProcessMode', 'timeout', '-ReadyTimeoutSeconds', '1', '-NonInteractive', '-RecordFile', "`"$rec10`"")
    Assert-Test '시간 초과 시 종료 코드 6' ($res10.ExitCode -eq 6) "실제 종료 코드: $($res10.ExitCode)"
    $rec10Content = if (Test-Path -LiteralPath $rec10) { Get-Content -LiteralPath $rec10 -Raw -Encoding UTF8 } else { '' }
    Assert-Test 'TIMEOUT 기록' ($rec10Content -like '*TIMEOUT*')
    Assert-Test '제한 시간 및 로그 파일 안내 포함' ($res10.Output -like '*제한 시간*' -and $res10.Output -like '*.dev-server.stderr.log*')
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

    $launcherContent = Get-Content -LiteralPath $launcherPath -Raw -Encoding UTF8
    Assert-Test 'Invoke-Expression 미사용' ($launcherContent -notmatch 'Invoke-Expression')
    Assert-Test '실제 서버 시작 명령에 포트 전달' ($launcherContent -match '\$devArguments\s*=.*''--port''.*\$Port')
    Assert-Test 'taskkill 종료 코드 확인' ($launcherContent -match '\$taskkillSucceeded\s*=\s*\(\$LASTEXITCODE\s+-eq\s+0\)')
    Assert-Test '종료 후 프로세스 상태 재확인' ($launcherContent -match 'WaitForExit\(3000\)' -and $launcherContent -match 'if \(-not \$Process\.HasExited\) \{ throw')

    # 11. Finding dashboard from repo root and install root
    Write-Host ''
    Write-Host '11. 저장소 루트 및 설치 디렉터리 경로 탐색 테스트' -ForegroundColor Cyan
    $testInstallRoot = Join-Path $testTempRoot 'fake-install-root'
    New-MockDashboardDir (Join-Path $testInstallRoot 'gemini-dashboard') -withDependencies $true | Out-Null
    Copy-Item -LiteralPath $launcherPath -Destination (Join-Path $testInstallRoot 'dashboard-launcher.cmd') -Force

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = 'cmd.exe'
    $rec11 = Join-Path $testTempRoot 'rec11.txt'
    $copiedCmd = Join-Path $testInstallRoot 'dashboard-launcher.cmd'
    $pinfo.Arguments = "/c `"`"$copiedCmd`" -MockHttp none -MockPortListen false -MockProcessMode success -NoBrowser -NonInteractive -RecordFile `"$rec11`"`""
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
    $cmdDelegates = [bool]($installContent -like '*"%~dp0dashboard-launcher.cmd" %*')
    Assert-Test 'worker-dashboard.cmd가 dashboard-launcher.cmd로 위임함' $cmdDelegates
    $ps1Delegates = [bool]($installContent -like '*dashboard-launcher.cmd*')
    Assert-Test 'worker-dashboard.ps1이 dashboard-launcher.cmd로 위임함' $ps1Delegates

} finally {
    if (Test-Path -LiteralPath $testTempRoot) {
        Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue
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
