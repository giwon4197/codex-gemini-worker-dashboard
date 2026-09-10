[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$runnerScript = Join-Path $repoRoot 'bounded-process-runner.ps1'

if (-not (Test-Path -LiteralPath $runnerScript)) {
  Write-Error "bounded-process-runner.ps1 not found: $runnerScript"
  exit 1
}

. $runnerScript

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-runner-" + [guid]::NewGuid().ToString('N'))
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

try {
  Write-Host "======================================================" -ForegroundColor Cyan
  Write-Host "      Bounded Process Runner Deterministic Tests      " -ForegroundColor Cyan
  Write-Host "======================================================" -ForegroundColor Cyan

  # 1. Success execution
  Write-Host "`n1. Success: Process completes with exit code 0 and status PASS" -ForegroundColor Yellow
  $res1 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command Write-Output 'hello from runner'" -WorkingDirectory $repoRoot
  Assert-Test "Result status is PASS" ($res1.status -eq 'PASS') "Got $($res1.status)"
  Assert-Test "ExitCode is 0" ($res1.exitCode -eq 0) "Got $($res1.exitCode)"
  Assert-Test "TimedOut is false" ($res1.timedOut -eq $false)
  Assert-Test "Output contains expected string" ($res1.output -match 'hello from runner') "Output: $($res1.output)"
  Assert-Test "Duration is tracked" ($res1.durationSeconds -ge 0)

  # 2. Failure execution
  Write-Host "`n2. Failure: Process exits with non-zero exit code" -ForegroundColor Yellow
  $res2 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command [Console]::Error.WriteLine('error text'); exit 42" -WorkingDirectory $repoRoot
  Assert-Test "Result status is FAIL" ($res2.status -eq 'FAIL') "Got $($res2.status)"
  Assert-Test "ExitCode is 42" ($res2.exitCode -eq 42) "Got $($res2.exitCode)"
  Assert-Test "TimedOut is false" ($res2.timedOut -eq $false)
  Assert-Test "Output captured stderr" ($res2.output -match 'error text')

  # 3. Noninteractive stdin handling
  Write-Host "`n3. Noninteractive: Stdin is closed immediately so reads receive EOF without blocking" -ForegroundColor Yellow
  $res3 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command `$line = [Console]::In.ReadLine(); if (`$null -eq `$line) { Write-Output 'EOF_OK' } else { Write-Output 'NOT_EOF' }" -WorkingDirectory $repoRoot -TimeoutSeconds 5
  Assert-Test "Noninteractive read completes immediately with PASS" ($res3.status -eq 'PASS') "Got $($res3.status)"
  Assert-Test "Output confirmed EOF" ($res3.output -match 'EOF_OK') "Output: $($res3.output)"
  Assert-Test "Did not time out" ($res3.timedOut -eq $false)

  # 4. Deterministic per-command timeout
  Write-Host "`n4. Timeout: Process exceeding timeout terminates deterministically" -ForegroundColor Yellow
  $sw4 = [System.Diagnostics.Stopwatch]::StartNew()
  $res4 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command Start-Sleep -Seconds 60" -WorkingDirectory $repoRoot -TimeoutSeconds 2
  $sw4.Stop()
  Assert-Test "Result status is TIMED_OUT" ($res4.status -eq 'TIMED_OUT') "Got $($res4.status)"
  Assert-Test "TimedOut flag is true" ($res4.timedOut -eq $true)
  Assert-Test "ExitCode is null on timeout" ($null -eq $res4.exitCode)
  Assert-Test "Terminated in ~2-4 seconds instead of 60 seconds" ($sw4.Elapsed.TotalSeconds -lt 8) "Elapsed: $($sw4.Elapsed.TotalSeconds)s"
  Assert-Test "Output records timeout notice" ($res4.output -match '\[TIMEOUT\] Command timed out after 2s')

  # 5. Descendant process-tree cleanup
  Write-Host "`n5. Descendant Process-Tree Cleanup: Parent, child, and grandchild all terminated" -ForegroundColor Yellow
  $pidFile = Join-Path $testTempRoot 'pids.txt'
  $childScriptFile = Join-Path $testTempRoot 'child.ps1'
  $childScript = @'
param($pidFile)
$gc = Start-Process pwsh -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 120') -PassThru
Add-Content -LiteralPath $pidFile -Value $gc.Id
Start-Sleep -Seconds 120
'@
  [IO.File]::WriteAllText($childScriptFile, $childScript, [Text.Encoding]::UTF8)

  $parentScriptFile = Join-Path $testTempRoot 'parent.ps1'
  $parentScript = @'
param($pidFile, $childScript)
Add-Content -LiteralPath $pidFile -Value $PID
$child = Start-Process pwsh -ArgumentList @('-NoProfile', '-File', $childScript, $pidFile) -PassThru
Add-Content -LiteralPath $pidFile -Value $child.Id
Start-Sleep -Seconds 120
'@
  [IO.File]::WriteAllText($parentScriptFile, $parentScript, [Text.Encoding]::UTF8)

  $res5 = Invoke-BoundedCommand -Command "pwsh -NoProfile -File `"$parentScriptFile`" `"$pidFile`" `"$childScriptFile`"" -WorkingDirectory $testTempRoot -TimeoutSeconds 3
  Assert-Test "Tree command timed out" ($res5.timedOut -eq $true)

  Start-Sleep -Milliseconds 500
  $recordedPids = if (Test-Path -LiteralPath $pidFile) {
    @(Get-Content -LiteralPath $pidFile | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
  } else { @() }

  Assert-Test "Spawned PIDs were recorded" ($recordedPids.Count -ge 2) "Found $($recordedPids.Count) PIDs: $($recordedPids -join ', ')"
  $leakedPids = @()
  foreach ($pidToCheck in $recordedPids) {
    $proc = Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue
    if ($proc -and -not $proc.HasExited) {
      $leakedPids += $pidToCheck
      try { Stop-Process -Id $pidToCheck -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  Assert-Test "Zero leaked child/descendant processes" ($leakedPids.Count -eq 0) "Leaked PIDs: $($leakedPids -join ', ')"

  # 6. Bounded output
  Write-Host "`n6. Bounded Output: Output is truncated at MaxOutputChars" -ForegroundColor Yellow
  $res6 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command Write-Output ('X' * 30000)" -WorkingDirectory $repoRoot -MaxOutputChars 500
  Assert-Test "Output is capped at MaxOutputChars" ($res6.output.Length -le 500) "Length was $($res6.output.Length)"

  # 7. Redaction of sensitive values
  Write-Host "`n7. Redaction: Sensitive tokens, keys, credentials, and headers are redacted" -ForegroundColor Yellow
  $secretCmd = "pwsh -NoProfile -Command Write-Output 'PAT: ghp_1111222233334444555566667777 and API: AIzaSyD-1234567890123456789012345678901 and URL: https://admin:supersecret@github.com/repo and Auth: Bearer my_secret_token'"
  $res7 = Invoke-BoundedCommand -Command $secretCmd -WorkingDirectory $repoRoot
  Assert-Test "GitHub PAT redacted in output" (-not $res7.output.Contains('ghp_1111222233334444555566667777'))
  Assert-Test "Google API Key redacted in output" (-not $res7.output.Contains('AIzaSyD-1234567890123456789012345678901'))
  Assert-Test "URL credentials redacted in output" (-not $res7.output.Contains('supersecret'))
  Assert-Test "Bearer token redacted in output" (-not $res7.output.Contains('my_secret_token'))
  Assert-Test "Command itself has sensitive values redacted" (-not $res7.command.Contains('supersecret'))

  # 8. Multi-command verification with per-command timeouts
  Write-Host "`n8. Invoke-BoundedVerification: Multi-command execution with per-command timeouts" -ForegroundColor Yellow
  $cmdList = @(
    'pwsh -NoProfile -Command Write-Output pass1',
    [pscustomobject]@{ command = 'pwsh -NoProfile -Command Start-Sleep -Seconds 30'; timeoutSeconds = 2 },
    'pwsh -NoProfile -Command exit 1'
  )
  $verifResults = @(Invoke-BoundedVerification -Worktree $repoRoot -Commands $cmdList)
  Assert-Test "Returned 3 results" ($verifResults.Count -eq 3) "Count was $($verifResults.Count)"
  Assert-Test "First command passed" ($verifResults[0].status -eq 'PASS' -and $verifResults[0].exitCode -eq 0)
  Assert-Test "Second command timed out" ($verifResults[1].status -eq 'TIMED_OUT' -and $verifResults[1].timedOut -eq $true)
  Assert-Test "Third command failed" ($verifResults[2].status -eq 'FAIL' -and $verifResults[2].exitCode -eq 1)

  # 9. TypeScript Compilation: npm --prefix ./gemini-dashboard exec -- tsc --noEmit performs actual compilation
  Write-Host "`n9. TypeScript Compilation: npm --prefix ./gemini-dashboard exec -- tsc --noEmit performs actual compilation" -ForegroundColor Yellow
  $res9 = Invoke-BoundedCommand -Command 'npm --prefix ./gemini-dashboard exec -- tsc --noEmit' -WorkingDirectory $repoRoot
  Assert-Test "Dashboard tsc executes with status PASS" ($res9.status -eq 'PASS') "Got $($res9.status), output: $($res9.output)"
  Assert-Test "Dashboard tsc exitCode is 0" ($res9.exitCode -eq 0)
  Assert-Test "Dashboard tsc did not time out" ($res9.timedOut -eq $false)
  $isHelpOutput9 = ($res9.output -match '(?i)Syntax:\s+tsc|Examples:\s+tsc|tsc\s+\[options\]|--help|Common Commands|This is not the tsc command')
  Assert-Test "Dashboard tsc performed actual compilation without help-only output" (-not $isHelpOutput9) "Help text detected in output: $($res9.output)"

  # 10. Help-Only Output Rejection: Exit code 0 with TypeScript help text cannot masquerade as compilation
  Write-Host "`n10. Help-Only Output Rejection: Exit code 0 with help text cannot masquerade as compilation" -ForegroundColor Yellow
  $res10 = Invoke-BoundedCommand -Command "pwsh -NoProfile -Command Write-Output 'Syntax:   tsc [options] [file...]'" -WorkingDirectory $repoRoot
  Assert-Test "Mock help command exited 0" ($res10.exitCode -eq 0)
  $mockIsHelp = ($res10.output -match '(?i)Syntax:\s+tsc|Examples:\s+tsc|tsc\s+\[options\]|--help|Common Commands')
  Assert-Test "TypeScript help-only text is recognized and rejected from being considered a valid compile" $mockIsHelp

  Write-Host "`n======================================================" -ForegroundColor Cyan
  Write-Host "   테스트 완료: $passCount 통과 / $failCount 실패" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
  Write-Host "======================================================" -ForegroundColor Cyan

  if ($failCount -gt 0) {
    exit 1
  }
  exit 0
} finally {
  if (Test-Path -LiteralPath $testTempRoot) {
    try { Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}
