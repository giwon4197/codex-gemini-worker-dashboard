[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TasksFile,
  [string]$Repository = (Get-Location).Path,
  [ValidateRange(1, 2)][int]$MaxWorkers = 2,
  [ValidateRange(1, 86400)][int]$WorkerTimeoutSeconds = 3600,
  [string]$Timeout = '24h',
  [switch]$CleanupWorktrees
)

$ErrorActionPreference = 'Stop'
$orchestratorRoot = $PSScriptRoot
$workerScript = Join-Path $orchestratorRoot 'run-gemini-worker.ps1'
$publicData = Join-Path $orchestratorRoot 'gemini-dashboard\public\data'

function Write-AtomicJson([string]$Path, $Data) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth 16), [Text.Encoding]::UTF8)
    [IO.File]::Move($temp, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Set-ObjectProperty($Object, [string]$Name, $Value) {
  if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
  else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Test-ProcessAlive($ProcessId) {
  if (-not $ProcessId) { return $false }
  return $null -ne (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)
}

function Stop-WorkerProcesses([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath)) { return }
  try {
    $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
    foreach ($processId in @($state.agentProcessId, $state.runnerProcessId)) {
      if (Test-ProcessAlive $processId) { Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
}

function Start-WorkerProcess($Task, $Worktree, [string]$Tier, [string]$RunId, [string]$RunRoot, [string]$BaseCommit, [string]$TimeoutValue, [int]$Attempt = 1) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = (Get-Command pwsh.exe).Source
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  foreach ($argument in @(
    '-NoProfile', '-File', $workerScript,
    '-Task', [string]$Task.name,
    '-Prompt', [string]$Task.prompt,
    '-Model', $Tier,
    '-Workspace', [string]$Worktree.path,
    '-Timeout', $TimeoutValue,
    '-OrchestrationRunId', $RunId,
    '-TaskId', [string]$Task.id,
    '-StateRoot', $RunRoot,
    '-BaseCommit', $BaseCommit,
    '-Attempt', $Attempt.ToString()
  )) { $null = $info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $null = $process.Start()
  return $process
}

function Sync-LiveWorkers([string]$RunRoot) {
  $states = @(
    Get-ChildItem -LiteralPath (Join-Path $RunRoot 'workers') -Filter '*.json' -ErrorAction SilentlyContinue |
      ForEach-Object { try { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } catch { $null } } |
      Where-Object { $_ } | Sort-Object startedAt
  )
  Write-AtomicJson -Path (Join-Path $publicData 'live-workers.json') -Data ([pscustomobject]@{
    runId = Split-Path -Leaf $RunRoot
    updatedAt = (Get-Date).ToString('o')
    workers = $states
  })
}

function Get-ChangedFiles([string]$Worktree, [string]$BaseCommit) {
  $tracked = @(& git -C $Worktree diff --name-only $BaseCommit -- 2>$null)
  $untracked = @(& git -C $Worktree ls-files --others --exclude-standard 2>$null)
  return @($tracked + $untracked | Where-Object { $_ } | ForEach-Object { $_.Replace('\', '/') } | Sort-Object -Unique)
}

function Test-AllowedPath([string]$Path, $AllowedPatterns) {
  foreach ($patternValue in @($AllowedPatterns)) {
    $pattern = ([string]$patternValue).Replace('\', '/')
    if ($pattern.EndsWith('/**')) {
      $prefix = $pattern.Substring(0, $pattern.Length - 3).TrimEnd('/')
      if ($Path -eq $prefix -or $Path.StartsWith("$prefix/", [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } elseif ($Path -like $pattern) { return $true }
  }
  return $false
}

function Invoke-Verification([string]$Worktree, $Commands) {
  $results = @()
  Push-Location $Worktree
  try {
    foreach ($commandValue in @($Commands)) {
      $command = [string]$commandValue
      $started = Get-Date
      $output = @(& pwsh.exe -NoProfile -Command $command 2>&1 | ForEach-Object { $_.ToString() })
      $exitCode = $LASTEXITCODE
      $joined = $output -join "`n"
      $results += [pscustomobject]@{
        command = $command
        exitCode = $exitCode
        durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
        output = $joined.Substring(0, [math]::Min(12000, $joined.Length))
        status = if ($exitCode -eq 0) { 'PASS' } else { 'FAIL' }
      }
    }
  } finally {
    Pop-Location
  }
  return $results
}

function Get-FailureClassification([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  $rules = [ordered]@{
    'INTERFACE_ERROR' = '(?i)INTERFACE_ERROR|CONTRACT_MISMATCH|contract mismatch|schema mismatch|계약 불일치|스키마 불일치'
    'DESIGN_ERROR' = '(?i)DESIGN_ERROR|architecture (?:error|impossible)|fundamental design|설계 (?:오류|문제)|아키텍처.*불가능'
    'PERMISSION_ERROR' = '(?i)PERMISSION_ERROR|permission denied|access (?:is )?denied|unauthorized|forbidden|EACCES|EPERM|권한.*(?:없|거부)'
    'ENVIRONMENT_ERROR' = '(?i)ENVIRONMENT_ERROR|command not found|is not recognized|module not found|cannot find (?:module|package)|missing dependency|ENOENT|환경.*(?:오류|문제)|의존성.*(?:없|실패)'
  }
  foreach ($entry in $rules.GetEnumerator()) { if ($Text -match $entry.Value) { return $entry.Key } }
  return $null
}

function Get-FailureFingerprint($Tests, [string]$Classification) {
  $basis = @($Tests | Where-Object status -eq 'FAIL' | ForEach-Object {
    $normalized = ([string]$_.output).ToLowerInvariant() -replace '\d+', '#' -replace '\s+', ' '
    "$($_.command)|$($_.exitCode)|$normalized"
  }) -join "`n"
  if (-not $basis) { $basis = $Classification }
  $bytes = [Text.Encoding]::UTF8.GetBytes($basis)
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-CompressedFailureLog($Tests) {
  $parts = @($Tests | Where-Object status -eq 'FAIL' | ForEach-Object {
    $output = [string]$_.output
    if ($output.Length -gt 2500) { $output = $output.Substring($output.Length - 2500) }
    "COMMAND: $($_.command)`nEXIT_CODE: $($_.exitCode)`nOUTPUT:`n$output"
  })
  $text = $parts -join "`n---`n"
  if ($text.Length -gt 5000) { $text = $text.Substring($text.Length - 5000) }
  return $text
}

function Repair-OrphanedRuns([string]$AgentRoot, [string]$RepositoryRoot) {
  $runsRoot = Join-Path $AgentRoot 'runs'
  if (-not (Test-Path -LiteralPath $runsRoot)) { return }
  foreach ($manifestFile in Get-ChildItem -LiteralPath $runsRoot -Filter 'run.json' -Recurse -ErrorAction SilentlyContinue) {
    try {
      $manifest = Get-Content -Raw -LiteralPath $manifestFile.FullName | ConvertFrom-Json
      if ($manifest.status -notin @('preparing', 'running', 'cancelling')) { continue }
      if (Test-ProcessAlive $manifest.orchestratorProcessId) { continue }
      $preserved = @()
      foreach ($worker in Get-ChildItem -LiteralPath (Join-Path $manifestFile.DirectoryName 'workers') -Filter '*.json' -ErrorAction SilentlyContinue) {
        Stop-WorkerProcesses $worker.FullName
        $state = Get-Content -Raw -LiteralPath $worker.FullName | ConvertFrom-Json
        if ($state.status -eq 'running') {
          Set-ObjectProperty $state 'status' 'interrupted'
          Set-ObjectProperty $state 'error' '오케스트레이터 중단으로 복구됨'
          Set-ObjectProperty $state 'updatedAt' (Get-Date).ToString('o')
          Write-AtomicJson $worker.FullName $state
        }
      }
      foreach ($wt in @($manifest.worktrees)) {
        $path = [string]$wt.path
        if (-not $path -or -not (Test-Path -LiteralPath $path)) { continue }
        $expectedRoot = [IO.Path]::GetFullPath((Join-Path $AgentRoot 'worktrees'))
        $resolved = [IO.Path]::GetFullPath($path)
        if (-not $resolved.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if (& git -C $resolved status --porcelain) { $preserved += $resolved; continue }
        & git -C $RepositoryRoot worktree remove $resolved --force 2>$null
      }
      $manifest.status = 'interrupted'
      $manifest.updatedAt = (Get-Date).ToString('o')
      Set-ObjectProperty $manifest 'recovery' ([pscustomobject]@{ recoveredAt = (Get-Date).ToString('o'); preservedDirtyWorktrees = $preserved })
      Write-AtomicJson $manifestFile.FullName $manifest
    } catch { Write-Warning "고아 실행 복구 실패: $($manifestFile.FullName): $($_.Exception.Message)" }
  }
  & git -C $RepositoryRoot worktree prune
}

$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$repoRoot = $repoRoot.Trim()
$agentRoot = Join-Path $repoRoot '.agent'
Repair-OrphanedRuns $agentRoot $repoRoot
if (& git -C $repoRoot status --porcelain) { throw '병렬 실행 전 저장소 변경 사항을 commit하거나 stash해야 합니다.' }

$tasksPath = (Resolve-Path -LiteralPath $TasksFile).Path
$tasks = @(Get-Content -Raw -LiteralPath $tasksPath | ConvertFrom-Json)
if ($tasks.Count -eq 0) { throw '작업 파일에 task가 없습니다.' }
$ids = @($tasks | ForEach-Object { $_.id })
if (($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or ($ids | Select-Object -Unique).Count -ne $ids.Count) { throw '각 task에는 고유한 id가 필요합니다.' }
foreach ($task in $tasks) {
  if (@($task.allowed_files).Count -eq 0) { throw "$($task.id): allowed_files가 최소 하나 필요합니다." }
}

$runId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runRoot = Join-Path $agentRoot "runs\$runId"
$worktreeRoot = Join-Path $agentRoot "worktrees\$runId"
New-Item -ItemType Directory -Path (Join-Path $runRoot 'tasks'), (Join-Path $runRoot 'workers'), (Join-Path $runRoot 'events'), (Join-Path $runRoot 'results'), $worktreeRoot -Force | Out-Null

$baseCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
$manifest = [pscustomobject]@{
  runId = $runId; status = 'preparing'; createdAt = (Get-Date).ToString('o'); updatedAt = (Get-Date).ToString('o')
  repository = $repoRoot; baseCommit = $baseCommit; maxWorkers = $MaxWorkers; orchestratorProcessId = $PID
  tasks = @($tasks | ForEach-Object { $_.id }); worktrees = @()
}
$manifestPath = Join-Path $runRoot 'run.json'
$cancelPath = Join-Path $runRoot 'cancel.requested'
Write-AtomicJson $manifestPath $manifest

$worktrees = @()
$jobRecords = @()
try {
  foreach ($task in $tasks) {
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
    $branch = "agent/$runId/$safeId"
    $worktree = Join-Path $worktreeRoot $safeId
    & git -C $repoRoot worktree add -b $branch $worktree $baseCommit
    if ($LASTEXITCODE -ne 0) { throw "worktree 생성 실패: $($task.id)" }
    $wtRecord = [pscustomobject]@{ id = $task.id; branch = $branch; path = $worktree; baseCommit = $baseCommit }
    $worktrees += $wtRecord
    $manifest.worktrees = $worktrees; $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
    Write-AtomicJson (Join-Path $runRoot "tasks\$safeId.json") ([pscustomobject]@{
      id = $task.id; name = $task.name; prompt = $task.prompt; tier = $task.tier; allowedFiles = @($task.allowed_files)
      testCommands = @($task.test_commands); timeoutSeconds = if ($task.timeout_seconds) { [int]$task.timeout_seconds } else { $WorkerTimeoutSeconds }
      retryLimit = if ($null -ne $task.retry_limit) { [math]::Min(3, [math]::Max(0, [int]$task.retry_limit)) } else { 3 }
      branch = $branch; worktree = $worktree; baseCommit = $baseCommit
    })
  }

  $manifest.status = 'running'; $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
  $pending = [Collections.Queue]::new(); foreach ($task in $tasks) { $pending.Enqueue($task) }
  while ($pending.Count -gt 0 -or @($jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }).Count -gt 0) {
    if (Test-Path -LiteralPath $cancelPath) {
      $manifest.status = 'cancelling'; $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
      foreach ($record in $jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }) {
        Stop-WorkerProcesses (Join-Path $runRoot "workers\$($record.SafeId).json")
        if (-not $record.Process.HasExited) { $record.Process.Kill($true) }
        $record.Cancelled = $true
      }
      while ($pending.Count -gt 0) { $null = $pending.Dequeue() }
    }

    $running = @($jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }).Count
    while ($pending.Count -gt 0 -and $running -lt $MaxWorkers) {
      $task = $pending.Dequeue(); $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
      $wt = $worktrees | Where-Object id -eq $task.id | Select-Object -First 1
      $tier = if ($task.tier) { [string]$task.tier } else { 'normal' }
      $process = Start-WorkerProcess $task $wt $tier $runId $runRoot $baseCommit $Timeout
      $jobRecords += [pscustomobject]@{ Process = $process; Task = $task; SafeId = $safeId; Worktree = $wt; StartedAt = Get-Date; TimedOut = $false; Cancelled = $false; Attempt = 1 }
      $running++
    }

    foreach ($record in $jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }) {
      $limit = if ($record.Task.timeout_seconds) { [int]$record.Task.timeout_seconds } else { $WorkerTimeoutSeconds }
      if (((Get-Date) - $record.StartedAt).TotalSeconds -gt $limit) {
        Stop-WorkerProcesses (Join-Path $runRoot "workers\$($record.SafeId).json")
        if (-not $record.Process.HasExited) { $record.Process.Kill($true) }
        $record.TimedOut = $true
      }
    }
    Sync-LiveWorkers $runRoot
    if (@($jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }).Count -gt 0) { Start-Sleep -Milliseconds 500 }
  }

  $failed = 0
  foreach ($task in $tasks) {
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'; $wt = $worktrees | Where-Object id -eq $task.id | Select-Object -First 1
    $statePath = Join-Path $runRoot "workers\$safeId.json"
    $record = $jobRecords | Where-Object { $_.Task.id -eq $task.id } | Select-Object -First 1
    $attempt = 1
    $retryLimit = if ($null -ne $task.retry_limit) { [math]::Min(3, [math]::Max(0, [int]$task.retry_limit)) } else { 3 }
    $history = @()
    $fingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

    while ($true) {
      $state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { [pscustomobject]@{ runId=$runId; taskId=$task.id; task=$task.name; status='failed'; error='워커 상태 파일이 생성되지 않음' } }
      $wasCancelled = Test-Path -LiteralPath $cancelPath
      $wasTimedOut = $record -and $record.TimedOut
      $changed = @(Get-ChangedFiles $wt.path $baseCommit)
      $violations = @($changed | Where-Object { -not (Test-AllowedPath $_ @($task.allowed_files)) })
      $tests = if (-not $wasCancelled -and -not $wasTimedOut -and $state.status -eq 'completed' -and $violations.Count -eq 0) { @(Invoke-Verification $wt.path @($task.test_commands)) } else { @() }
      $failureText = @($state.error, $state.finalResponse, @($tests | Where-Object status -eq 'FAIL' | ForEach-Object { $_.output })) -join "`n"
      $classification = Get-FailureClassification $failureText
      $decision = if ($wasCancelled) { 'CANCELLED' } elseif ($wasTimedOut) { 'TIMED_OUT' } elseif ($violations.Count -gt 0) { 'POLICY_VIOLATION' } elseif ($classification) { $classification } elseif ($state.status -ne 'completed') { 'WORKER_FAILED' } elseif (@($tests | Where-Object status -eq 'FAIL').Count -gt 0) { 'TEST_FAILED' } else { 'PASS' }

      if ($decision -ne 'TEST_FAILED') { break }
      $fingerprint = Get-FailureFingerprint $tests $decision
      $compressed = Get-CompressedFailureLog $tests
      $history += [pscustomobject]@{ attempt=$attempt; decision=$decision; fingerprint=$fingerprint; failureLog=$compressed; verifiedAt=(Get-Date).ToString('o') }
      if ($fingerprints.Contains($fingerprint)) { $decision = 'REPEATED_FAILURE'; break }
      $null = $fingerprints.Add($fingerprint)
      if (($attempt - 1) -ge $retryLimit) { $decision = 'RETRY_EXHAUSTED'; break }

      $attempt++
      $retryPrompt = @"
$($task.prompt)

이전 구현은 오케스트레이터의 결정론적 검증에 실패했습니다. 현재 worktree의 기존 변경을 유지하고 아래 실패만 수정하세요.
허용된 파일 외에는 수정하지 마세요. 테스트를 직접 실행해 통과시킨 뒤 결과를 보고하세요.

ATTEMPT: $attempt
CHANGED_FILES: $($changed -join ', ')
FAILURE_LOG:
$compressed
"@
      $retryTask = [pscustomobject]@{ id=$task.id; name="$($task.name) (retry $($attempt - 1)/$retryLimit)"; prompt=$retryPrompt }
      $tier = if ($task.tier) { [string]$task.tier } else { 'normal' }
      $process = Start-WorkerProcess $retryTask $wt $tier $runId $runRoot $baseCommit $Timeout $attempt
      $record = [pscustomobject]@{ Process=$process; Task=$task; SafeId=$safeId; Worktree=$wt; StartedAt=Get-Date; TimedOut=$false; Cancelled=$false; Attempt=$attempt }
      $jobRecords += $record
      $limit = if ($task.timeout_seconds) { [int]$task.timeout_seconds } else { $WorkerTimeoutSeconds }
      while (-not $process.HasExited) {
        if (Test-Path -LiteralPath $cancelPath) {
          Stop-WorkerProcesses $statePath
          if (-not $process.HasExited) { $process.Kill($true) }
          $record.Cancelled = $true
          break
        }
        if (((Get-Date) - $record.StartedAt).TotalSeconds -gt $limit) {
          Stop-WorkerProcesses $statePath
          if (-not $process.HasExited) { $process.Kill($true) }
          $record.TimedOut = $true
          break
        }
        Sync-LiveWorkers $runRoot
        Start-Sleep -Milliseconds 500
      }
    }

    $finalStatus = switch ($decision) {
      'PASS' { 'completed' }; 'POLICY_VIOLATION' { 'policy_violation' }; 'TEST_FAILED' { 'test_failed' }
      'TIMED_OUT' { 'timed_out' }; 'CANCELLED' { 'cancelled' }; 'WORKER_FAILED' { 'failed' }
      default { 'escalated' }
    }
    Set-ObjectProperty $state 'workerReportedStatus' $state.status; Set-ObjectProperty $state 'status' $finalStatus
    Set-ObjectProperty $state 'baseCommit' $baseCommit; Set-ObjectProperty $state 'branch' $wt.branch; Set-ObjectProperty $state 'worktree' $wt.path
    Set-ObjectProperty $state 'attempt' $attempt; Set-ObjectProperty $state 'retryLimit' $retryLimit; Set-ObjectProperty $state 'retryHistory' $history
    Set-ObjectProperty $state 'changedFiles' $changed
    Set-ObjectProperty $state 'policy' ([pscustomobject]@{ allowedFiles=@($task.allowed_files); violations=$violations; status=if($violations.Count){'FAIL'}else{'PASS'} })
    Set-ObjectProperty $state 'verification' ([pscustomobject]@{ decision=$decision; commands=$tests; verifiedAt=(Get-Date).ToString('o') })
    Set-ObjectProperty $state 'escalation' $(if ($decision -eq 'PASS') { $null } else { [pscustomobject]@{ requiresCodex=$true; category=$decision; reason="자동 처리 중단: $decision" } })
    Set-ObjectProperty $state 'updatedAt' (Get-Date).ToString('o')
    Write-AtomicJson $statePath $state; Write-AtomicJson (Join-Path $runRoot "results\$safeId-result.json") $state
    if ($decision -ne 'PASS') { $failed++ }
  }

  Sync-LiveWorkers $runRoot
  $manifest.status = if (Test-Path -LiteralPath $cancelPath) { 'cancelled' } elseif ($failed -eq 0) { 'completed' } else { 'failed' }
  $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
  Write-Output "Run: $runId"; Write-Output "State: $runRoot"; Write-Output "Status: $($manifest.status)"
  if ($manifest.status -ne 'completed') { exit 1 }
} finally {
  foreach ($record in $jobRecords) {
    if (-not $record.Process.HasExited) { try { $record.Process.Kill($true) } catch {} }
    $record.Process.Dispose()
  }
  if ($CleanupWorktrees) {
    foreach ($wt in $worktrees) {
      if (-not (& git -C $wt.path status --porcelain)) { & git -C $repoRoot worktree remove $wt.path --force 2>$null }
      else { Write-Warning "변경 사항이 있어 worktree를 보존합니다: $($wt.path)" }
    }
    & git -C $repoRoot worktree prune
  }
}
