[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$bootstrapScript = Join-Path $repoRoot 'dashboard-dependency-bootstrap.ps1'
$runnerScript = Join-Path $repoRoot 'bounded-process-runner.ps1'
$parallelScript = Join-Path $repoRoot 'run-parallel-workers.ps1'
$reviewScript = Join-Path $repoRoot 'review-integration.ps1'

if (-not (Test-Path -LiteralPath $bootstrapScript)) {
  Write-Error "dashboard-dependency-bootstrap.ps1 not found: $bootstrapScript"
  exit 1
}

. $bootstrapScript
. $runnerScript

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-bootstrap-" + [guid]::NewGuid().ToString('N'))
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
      Write-Host "         Detail: $detail" -ForegroundColor Yellow
    }
    $script:failCount++
  }
}

function New-MockNpmEnv([string]$MockDir, [string]$Behavior = 'success') {
  if (-not (Test-Path -LiteralPath $MockDir)) {
    New-Item -ItemType Directory -Path $MockDir -Force | Out-Null
  }
  $logPath = Join-Path $MockDir 'npm-invocations.log'
  $pidPath = Join-Path $MockDir 'child-pids.log'
  $isWin = $IsWindows -or ($env:OS -like '*Windows*')

  if ($isWin) {
    $batchScript = switch ($Behavior) {
      'success' {
        @"
@echo off
echo %* >> "%~dp0npm-invocations.log"
if "%1"=="ci" (
  if not exist "node_modules\.bin" mkdir "node_modules\.bin"
  echo @echo off > "node_modules\.bin\tsc.cmd"
  echo rem Genuine mock TypeScript compiler >> "node_modules\.bin\tsc.cmd"
  echo exit /b 0 >> "node_modules\.bin\tsc.cmd"
)
exit /b 0
"@
      }
      'fail' {
        @"
@echo off
echo %* >> "%~dp0npm-invocations.log"
echo Mock npm failure: simulated package install error 1>&2
exit /b 42
"@
      }
      'hang' {
        @"
@echo off
echo %* >> "%~dp0npm-invocations.log"
powershell.exe -NoProfile -Command "Start-Sleep -Seconds 120"
exit /b 0
"@
      }
    }
    [IO.File]::WriteAllText((Join-Path $MockDir 'npm.cmd'), $batchScript, [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $MockDir 'npm.bat'), $batchScript, [Text.Encoding]::UTF8)
  } else {
    $shScript = switch ($Behavior) {
      'success' {
        @"
#!/bin/sh
echo "`$@" >> "$logPath"
if [ "`$1" = "ci" ]; then
  mkdir -p node_modules/.bin
  echo '#!/bin/sh' > node_modules/.bin/tsc
  echo 'exit 0' >> node_modules/.bin/tsc
  chmod +x node_modules/.bin/tsc
fi
exit 0
"@
      }
      'fail' {
        @"
#!/bin/sh
echo "`$@" >> "$logPath"
echo 'Mock npm failure: simulated package install error' >&2
exit 42
"@
      }
      'hang' {
        @"
#!/bin/sh
echo "`$@" >> "$logPath"
sleep 120
exit 0
"@
      }
    }
    $shFile = Join-Path $MockDir 'npm'
    [IO.File]::WriteAllText($shFile, $shScript, [Text.Encoding]::UTF8)
    try { & chmod +x $shFile } catch {}
  }
  return [pscustomobject]@{
    MockDir = $MockDir
    LogPath = $logPath
    PidPath = $pidPath
  }
}

function New-IsolatedTestRepo([string]$Path, [bool]$InitDashboard = $true) {
  $remoteDir = Join-Path $Path 'remote.git'
  $localDir = Join-Path $Path 'local'

  New-Item -ItemType Directory -Path $remoteDir -Force | Out-Null
  & git -C $remoteDir init --bare -b main 2>$null | Out-Null

  New-Item -ItemType Directory -Path $localDir -Force | Out-Null
  & git -C $localDir init -b main 2>$null | Out-Null
  & git -C $localDir config user.name 'Test Runner'
  & git -C $localDir config user.email 'test@example.com'

  [IO.File]::WriteAllText((Join-Path $localDir 'README.md'), '# Test Repo', [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $localDir '.gitignore'), ".agent/`nnode_modules/`n", [Text.Encoding]::UTF8)

  if ($InitDashboard) {
    $dashDir = Join-Path $localDir 'gemini-dashboard'
    New-Item -ItemType Directory -Path $dashDir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $dashDir 'package.json'), '{"name":"mock-dashboard","version":"1.0.0"}', [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $dashDir 'package-lock.json'), '{"name":"mock-dashboard","lockfileVersion":3,"packages":{}}', [Text.Encoding]::UTF8)
    [IO.File]::WriteAllText((Join-Path $dashDir 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}', [Text.Encoding]::UTF8)
  }

  & git -C $localDir add -A 2>$null | Out-Null
  & git -C $localDir commit -m "initial commit" 2>$null | Out-Null

  $remoteUrl = $remoteDir.Replace('\', '/')
  & git -C $localDir remote add origin $remoteUrl 2>$null | Out-Null
  & git -C $localDir push -u origin main 2>$null | Out-Null

  return [pscustomobject]@{
    RemoteDir = $remoteDir
    LocalDir  = $localDir
  }
}

try {
  Write-Host "======================================================" -ForegroundColor Cyan
  Write-Host "   Dashboard Dependency Bootstrap Deterministic Tests " -ForegroundColor Cyan
  Write-Host "======================================================" -ForegroundColor Cyan

  $origPath = $env:PATH

  # 1. Missing Bootstrap Success: mock npm ci called when node_modules absent
  Write-Host "`n1. Missing Bootstrap Success: Lockfile-pinned npm ci bootstraps missing dependencies" -ForegroundColor Yellow
  $mock1 = New-MockNpmEnv (Join-Path $testTempRoot 'mock-npm-1') 'success'
  $env:PATH = "$($mock1.MockDir);$origPath"

  $case1 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case1')
  $res1 = Ensure-DashboardDependencies -Worktree $case1.LocalDir
  Assert-Test "Bootstrap returns success true" ($res1.success -eq $true) "Got: $($res1.success)"
  Assert-Test "Bootstrap returns status PASS" ($res1.status -eq 'PASS') "Got: $($res1.status)"
  Assert-Test "Reused is false on first missing bootstrap" ($res1.reused -eq $false)
  Assert-Test "TimedOut is false" ($res1.timedOut -eq $false)
  Assert-Test "ExitCode is 0" ($res1.exitCode -eq 0)
  Assert-Test "Dependencies are valid after bootstrap" (Test-DashboardDependenciesValid $case1.LocalDir)
  $tsc1 = Get-WorktreeTscPath $case1.LocalDir
  Assert-Test "Local tsc binary exists" (Test-Path -LiteralPath $tsc1)
  $mockInvocations1 = @(if (Test-Path -LiteralPath $mock1.LogPath) {
    Get-Content -LiteralPath $mock1.LogPath | Where-Object { [string]$_ -match '\S' } | ForEach-Object { ([string]$_).Trim() }
  })
  Assert-Test "Mock npm was invoked exactly once with ci" ($mockInvocations1.Count -eq 1 -and $mockInvocations1[0].StartsWith('ci')) "Invocations: $($mockInvocations1 -join '; ')"

  # 2. Valid Dependency Reuse: second call reuses without invoking npm
  Write-Host "`n2. Valid Dependency Reuse: Existing valid dependencies reused without invoking npm" -ForegroundColor Yellow
  $res2 = Ensure-DashboardDependencies -Worktree $case1.LocalDir
  Assert-Test "Second bootstrap returns success true" ($res2.success -eq $true)
  Assert-Test "Second bootstrap returns status PASS" ($res2.status -eq 'PASS')
  Assert-Test "Reused is true on valid tree" ($res2.reused -eq $true)
  $mockInvocations2 = @(if (Test-Path -LiteralPath $mock1.LogPath) { Get-Content -LiteralPath $mock1.LogPath | Where-Object { [string]$_ -match '\S' } | ForEach-Object { ([string]$_).Trim() } })
  Assert-Test "Mock npm was NOT invoked again (count remains 1)" ($mockInvocations2.Count -eq 1) "Invocations: $($mockInvocations2.Count)"

  # 3. Valid Source Worktree Junction Reuse: worktree reuses source tree via junction without invoking npm
  Write-Host "`n3. Junction Reuse: Worktree reuses source tree via junction without invoking npm" -ForegroundColor Yellow
  $case3 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case3')
  $res3 = Ensure-DashboardDependencies -Worktree $case3.LocalDir -SourceWorktree $case1.LocalDir
  Assert-Test "Junction bootstrap returns success true" ($res3.success -eq $true)
  Assert-Test "Junction bootstrap returns status PASS" ($res3.status -eq 'PASS')
  Assert-Test "Reused is true via junction" ($res3.reused -eq $true)
  Assert-Test "Case 3 dependencies are valid" (Test-DashboardDependenciesValid $case3.LocalDir)
  $mockInvocations3 = @(if (Test-Path -LiteralPath $mock1.LogPath) { Get-Content -LiteralPath $mock1.LogPath | Where-Object { [string]$_ -match '\S' } | ForEach-Object { ([string]$_).Trim() } })
  Assert-Test "Mock npm was NOT invoked for junction reuse" ($mockInvocations3.Count -eq 1)

  # 4. Broken Junction Recovery: broken junction safely replaced and bootstrapped
  Write-Host "`n4. Broken Junction Recovery: Broken junction is safely removed and bootstrapped" -ForegroundColor Yellow
  $case4 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case4')
  $brokenTarget = Join-Path $testTempRoot 'nonexistent-source-modules'
  $dstNm4 = Join-Path $case4.LocalDir 'gemini-dashboard\node_modules'
  try { New-Item -ItemType Junction -Path $dstNm4 -Target $brokenTarget -Force 2>$null | Out-Null } catch {}
  $res4 = Ensure-DashboardDependencies -Worktree $case4.LocalDir
  Assert-Test "Recovery from broken junction returns success true" ($res4.success -eq $true)
  Assert-Test "Case 4 dependencies valid after recovery" (Test-DashboardDependenciesValid $case4.LocalDir)
  Assert-Test "Case 4 reused is false (bootstrapped)" ($res4.reused -eq $false)

  # 5. Missing Lockfile: Fails deterministically as ENVIRONMENT_ERROR without invoking npm
  Write-Host "`n5. Missing Lockfile: Absence of package-lock.json triggers ENVIRONMENT_ERROR" -ForegroundColor Yellow
  $case5 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case5') $false
  $dashDir5 = Join-Path $case5.LocalDir 'gemini-dashboard'
  New-Item -ItemType Directory -Path $dashDir5 -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $dashDir5 'package.json'), '{"name":"nolock"}', [Text.Encoding]::UTF8)
  # No package-lock.json
  $res5 = Ensure-DashboardDependencies -Worktree $case5.LocalDir
  Assert-Test "Missing lockfile returns success false" ($res5.success -eq $false)
  Assert-Test "Missing lockfile returns ENVIRONMENT_ERROR" ($res5.status -eq 'ENVIRONMENT_ERROR')
  Assert-Test "Missing lockfile errorCategory is environment_error" ($res5.errorCategory -eq 'environment_error')

  # 6. npm Failure: Non-zero exit code yields ENVIRONMENT_ERROR
  Write-Host "`n6. npm Failure: Simulated npm ci failure yields non-retryable ENVIRONMENT_ERROR" -ForegroundColor Yellow
  $mock6 = New-MockNpmEnv (Join-Path $testTempRoot 'mock-npm-6') 'fail'
  $env:PATH = "$($mock6.MockDir);$origPath"

  $case6 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case6')
  $res6 = Ensure-DashboardDependencies -Worktree $case6.LocalDir
  Assert-Test "Failing npm returns success false" ($res6.success -eq $false)
  Assert-Test "Failing npm returns ENVIRONMENT_ERROR" ($res6.status -eq 'ENVIRONMENT_ERROR')
  Assert-Test "Failing npm errorCategory is environment_error" ($res6.errorCategory -eq 'environment_error')
  Assert-Test "ExitCode matches mock exit code 42" ($res6.exitCode -eq 42)
  Assert-Test "TimedOut is false" ($res6.timedOut -eq $false)
  Assert-Test "Output captured error" ($res6.output -match 'simulated package install error')

  # 7. Timeout & Tree Cleanup: npm exceeding timeout terminated and tree cleaned up
  Write-Host "`n7. Timeout & Tree Cleanup: npm exceeding timeout terminated and tree cleaned up" -ForegroundColor Yellow
  $mock7 = New-MockNpmEnv (Join-Path $testTempRoot 'mock-npm-7') 'hang'
  $env:PATH = "$($mock7.MockDir);$origPath"

  $case7 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case7')
  $sw7 = [System.Diagnostics.Stopwatch]::StartNew()
  $res7 = Ensure-DashboardDependencies -Worktree $case7.LocalDir -TimeoutSeconds 2
  $sw7.Stop()
  Assert-Test "Hanging npm returns success false" ($res7.success -eq $false)
  Assert-Test "Hanging npm status is ENVIRONMENT_ERROR" ($res7.status -eq 'ENVIRONMENT_ERROR')
  Assert-Test "Hanging npm timedOut is true" ($res7.timedOut -eq $true)
  Assert-Test "Hanging npm duration is bounded (~2-6s, not 120s)" ($sw7.Elapsed.TotalSeconds -lt 8) "Duration: $($sw7.Elapsed.TotalSeconds)s"

  # 8. Non-retryability & Tier Promotion Bypass: Worker bootstrap failure never retries
  Write-Host "`n8. Non-retryability: Worker bootstrap failure bypasses retry loop and tier promotion" -ForegroundColor Yellow
  $mock8 = New-MockNpmEnv (Join-Path $testTempRoot 'mock-npm-8') 'fail'
  $env:PATH = "$($mock8.MockDir);$origPath"

  $case8 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case8')
  $baseCommit8 = (& git -C $case8.LocalDir rev-parse HEAD).Trim()
  $tasksFile8 = Join-Path $testTempRoot 'tasks8.json'
  $tasksData8 = [ordered]@{
    tasks = @(
      [ordered]@{
        id               = 'TASK-001'
        name             = 'Bootstrap Task'
        prompt           = 'test prompt'
        allowed_files    = @('gemini-dashboard/**')
        test_commands    = @('pwsh -NoProfile -Command exit 0')
        timeout_seconds  = 10
        retry_limit      = 3
        mock_output_json = '{"event":"result","result":{"response":"success"}}'
      }
    )
  }
  [IO.File]::WriteAllText($tasksFile8, ($tasksData8 | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)

  $workerOut8 = @(& pwsh -NoProfile -File $parallelScript -TasksFile $tasksFile8 -Repository $case8.LocalDir 2>&1)
  $workerExit8 = $LASTEXITCODE

  Assert-Test "Orchestrator exits non-zero on worker bootstrap failure" ($workerExit8 -ne 0)
  $runDirs8 = @(Get-ChildItem -LiteralPath (Join-Path $case8.LocalDir '.agent\runs') -Directory)
  Assert-Test "Run folder created" ($runDirs8.Count -ge 1)
  if ($runDirs8.Count -ge 1) {
    $runManifest8 = Get-Content -Raw -LiteralPath (Join-Path $runDirs8[0].FullName 'run.json') | ConvertFrom-Json
    Assert-Test "Manifest records failure status" ($runManifest8.status -in @('failed', 'escalated')) "Status: $($runManifest8.status)"
    Assert-Test "Manifest records environment_error category" ($runManifest8.errorCategory -eq 'environment_error') "Category: $($runManifest8.errorCategory)"

    $taskResultPath8 = Join-Path $runDirs8[0].FullName 'results\TASK-001-result.json'
    if (Test-Path -LiteralPath $taskResultPath8) {
      $taskResult8 = Get-Content -Raw -LiteralPath $taskResultPath8 | ConvertFrom-Json
      Assert-Test "Worker decision is ENVIRONMENT_ERROR" ($taskResult8.verification.decision -eq 'ENVIRONMENT_ERROR') "Got: $($taskResult8.verification.decision)"
      Assert-Test "Attempt count remains 1 (no retries)" ($taskResult8.attempt -eq 1) "Attempt was: $($taskResult8.attempt)"
      Assert-Test "Retry history is empty" (@($taskResult8.retryHistory).Count -eq 0)
    } else {
      Assert-Test "Task result file exists" $false
    }
  }

  $mainRef8 = (& git -C $case8.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Local main remains at baseCommit after worker failure" ($mainRef8 -eq $baseCommit8)
  $remoteMainRef8 = (& git -C $case8.LocalDir rev-parse refs/remotes/origin/main).Trim()
  Assert-Test "Remote main remains at baseCommit after worker failure" ($remoteMainRef8 -eq $baseCommit8)

  # 9. Delivery Rehearsal Bootstrap Failure: Stops before merge/push as ENVIRONMENT_ERROR
  Write-Host "`n9. Delivery Rehearsal: Broken dependencies in rehearsal stops before merge/push" -ForegroundColor Yellow
  $mock9 = New-MockNpmEnv (Join-Path $testTempRoot 'mock-npm-9') 'fail'
  $env:PATH = "$($mock9.MockDir);$origPath"

  $case9 = New-IsolatedTestRepo (Join-Path $testTempRoot 'case9')
  $baseCommit9 = (& git -C $case9.LocalDir rev-parse HEAD).Trim()

  $integBranch9 = 'integration/run-009'
  & git -C $case9.LocalDir switch -c $integBranch9 $baseCommit9 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case9.LocalDir 'gemini-dashboard\component.ts'), 'export const x = 1;', [Text.Encoding]::UTF8)
  & git -C $case9.LocalDir add gemini-dashboard/component.ts
  & git -C $case9.LocalDir commit -m "add component" 2>$null | Out-Null
  $candCommit9 = (& git -C $case9.LocalDir rev-parse HEAD).Trim()
  & git -C $case9.LocalDir switch main 2>$null | Out-Null

  $runRoot9 = Join-Path $case9.LocalDir '.agent\runs\run-009'
  New-Item -ItemType Directory -Path (Join-Path $runRoot9 'tasks') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $runRoot9 'results') -Force | Out-Null

  $taskObj9 = [pscustomobject]@{ id = 'TASK-001'; allowedFiles = @('gemini-dashboard/**'); testCommands = @('pwsh -NoProfile -Command exit 0') }
  [IO.File]::WriteAllText((Join-Path $runRoot9 'tasks\TASK-001.json'), ($taskObj9 | ConvertTo-Json), [Text.Encoding]::UTF8)

  $resultObj9 = [pscustomobject]@{
    runId = 'run-009'; taskId = 'TASK-001'; status = 'completed'; commitHashes = @($candCommit9)
    policy = [pscustomobject]@{ allowedFiles = @('gemini-dashboard/**'); violations = @(); status = 'PASS' }
    verification = [pscustomobject]@{ decision = 'PASS'; commands = @() }
  }
  [IO.File]::WriteAllText((Join-Path $runRoot9 'results\TASK-001-result.json'), ($resultObj9 | ConvertTo-Json), [Text.Encoding]::UTF8)

  $reviewObj9 = [pscustomobject]@{ verdict = 'PASS'; summary = 'Clean'; candidateCommit = $candCommit9; findings = @() }
  [IO.File]::WriteAllText((Join-Path $runRoot9 'codex-review.json'), ($reviewObj9 | ConvertTo-Json), [Text.Encoding]::UTF8)

  $manifestObj9 = [pscustomobject]@{
    runId = 'run-009'; status = 'running'; baseCommit = $baseCommit9
    integration = [pscustomobject]@{
      branch = $integBranch9; baseCommit = $baseCommit9; headCommit = $candCommit9; decision = 'AWAITING_CODEX_REVIEW'
    }
    integrationTestCommands = @('pwsh -NoProfile -Command exit 0')
  }
  [IO.File]::WriteAllText((Join-Path $runRoot9 'run.json'), ($manifestObj9 | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)

  $reviewOut9 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-009' -Repository $case9.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $reviewExit9 = $LASTEXITCODE

  Assert-Test "Review-integration exits non-zero on rehearsal bootstrap failure" ($reviewExit9 -ne 0)
  $mainRef9 = (& git -C $case9.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Local main remains at baseCommit (not merged)" ($mainRef9 -eq $baseCommit9)
  $remoteMainRef9 = (& git -C $case9.LocalDir rev-parse refs/remotes/origin/main).Trim()
  Assert-Test "Remote origin/main remains at baseCommit (not pushed)" ($remoteMainRef9 -eq $baseCommit9)

  $diagPath9 = Join-Path $runRoot9 'delivery-diagnostic.json'
  Assert-Test "Delivery diagnostic JSON exists" (Test-Path -LiteralPath $diagPath9)
  if (Test-Path -LiteralPath $diagPath9) {
    $diagData9 = Get-Content -Raw -LiteralPath $diagPath9 | ConvertFrom-Json
    Assert-Test "Diagnostic records environment_error category" ($diagData9.errorCategory -eq 'environment_error') "Got: $($diagData9.errorCategory)"
  }

  # 10. Help-Only Output Rejection: tsc output containing only help/placeholder is rejected
  Write-Host "`n10. Help-Only Output Rejection: Help/placeholder text rejected from valid compilation" -ForegroundColor Yellow
  $mockTscHelp = @(Invoke-BoundedVerification -Worktree $repoRoot -Commands @(
    "tsc --help"
  ))[0]
  Assert-Test "Direct tsc command with help text status is FAIL" ($mockTscHelp.status -eq 'FAIL')
  Assert-Test "Direct tsc command with help text exitCode is 1" ($mockTscHelp.exitCode -eq 1)

  # 11. Zero Fallible Checks After Main Advances
  Write-Host "`n11. Zero Fallible Checks After Main Advances: Structural invariant verification" -ForegroundColor Yellow
  $reviewScriptText = Get-Content -Raw -LiteralPath $reviewScript
  $mergeIdx = $reviewScriptText.IndexOf('merge --ff-only')
  $postMergeCode = if ($mergeIdx -gt 0) { $reviewScriptText.Substring($mergeIdx) } else { '' }
  $hasPostApp = ($postMergeCode -match 'Invoke-Verification|Ensure-DashboardDependencies|npm\s+run|npm\s+ci')
  Assert-Test "Zero verification or bootstrap checks after git merge --ff-only" (-not $hasPostApp)

  Write-Host "`n======================================================" -ForegroundColor Cyan
  Write-Host "   테스트 완료: $passCount 통과 / $failCount 실패" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
  Write-Host "======================================================" -ForegroundColor Cyan

  if ($failCount -gt 0) { exit 1 }
  exit 0
} finally {
  $env:PATH = $origPath
  if (Test-Path -LiteralPath $testTempRoot) {
    try { Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}
