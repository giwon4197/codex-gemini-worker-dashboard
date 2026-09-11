[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Run', Position = 0)]
  [string]$TasksFile,
  [Parameter(ParameterSetName = 'Run')]
  [string]$Repository = (Get-Location).Path,
  [Parameter(ParameterSetName = 'Run')]
  [ValidateRange(1, 2)][int]$MaxWorkers = 2,
  [Parameter(ParameterSetName = 'Run')]
  [ValidateRange(1, 86400)][int]$WorkerTimeoutSeconds = 3600,
  [string]$Timeout = '24h',
  [switch]$CleanupWorktrees,
  [string]$DataDir = '',
  [string]$DashboardPath = '',
  [Parameter(Mandatory = $true, ParameterSetName = 'SyncOnly')]
  [string]$SyncStateRoot = ''
)

$ErrorActionPreference = 'Stop'
$orchestratorRoot = $PSScriptRoot
$workerScript = Join-Path $orchestratorRoot 'run-gemini-worker.ps1'
. (Join-Path $orchestratorRoot 'bounded-process-runner.ps1')
. (Join-Path $orchestratorRoot 'dashboard-dependency-bootstrap.ps1')
. (Join-Path $orchestratorRoot 'filesystem-policy.ps1')

function Resolve-SharedDashboardPaths {
  param(
    [string]$ExplicitDataDir = '',
    [string]$ExplicitDashboardPath = '',
    [string]$RepoPath = ''
  )
  if (-not [string]::IsNullOrWhiteSpace($ExplicitDashboardPath)) {
    $dash = [System.IO.Path]::GetFullPath($ExplicitDashboardPath)
    return [pscustomobject]@{ DataDir = Split-Path -Parent $dash; DashboardPath = $dash }
  }
  if (-not [string]::IsNullOrWhiteSpace($ExplicitDataDir)) {
    $dDir = [System.IO.Path]::GetFullPath($ExplicitDataDir)
    return [pscustomobject]@{ DataDir = $dDir; DashboardPath = (Join-Path $dDir 'dashboard.json') }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_DASHBOARD_PATH)) {
    $dash = [System.IO.Path]::GetFullPath($env:CODEX_GEMINI_DASHBOARD_PATH)
    return [pscustomobject]@{ DataDir = Split-Path -Parent $dash; DashboardPath = $dash }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_DATA_DIR)) {
    $dDir = [System.IO.Path]::GetFullPath($env:CODEX_GEMINI_DATA_DIR)
    return [pscustomobject]@{ DataDir = $dDir; DashboardPath = (Join-Path $dDir 'dashboard.json') }
  }
  $checkDirs = @($PSScriptRoot, $RepoPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
  foreach ($dir in $checkDirs) {
    $commonDir = (& git -C $dir rev-parse --git-common-dir 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($commonDir)) {
      $commonTrim = $commonDir.Trim()
      $mainGitRoot = if ([System.IO.Path]::IsPathRooted($commonTrim)) {
        [System.IO.Path]::GetFullPath((Join-Path $commonTrim '..'))
      } else {
        [System.IO.Path]::GetFullPath((Join-Path $dir (Join-Path $commonTrim '..')))
      }
      $candData = Join-Path $mainGitRoot 'gemini-dashboard\public\data'
      if (Test-Path -LiteralPath $candData) {
        return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_INSTALL_ROOT)) {
    $candData = Join-Path $env:CODEX_GEMINI_INSTALL_ROOT 'gemini-dashboard\public\data'
    if (Test-Path -LiteralPath $candData) {
      return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candData = Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard\gemini-dashboard\public\data'
    if (Test-Path -LiteralPath $candData) {
      return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
    }
  }
  $fallbackData = Join-Path $PSScriptRoot 'gemini-dashboard\public\data'
  return [pscustomobject]@{ DataDir = $fallbackData; DashboardPath = (Join-Path $fallbackData 'dashboard.json') }
}

$targetRepo = if ($Repository) { $Repository } else { $PSScriptRoot }
$resolvedPaths = Resolve-SharedDashboardPaths -ExplicitDataDir $DataDir -ExplicitDashboardPath $DashboardPath -RepoPath $targetRepo
$publicData = $resolvedPaths.DataDir
$dashboardPath = $resolvedPaths.DashboardPath

function Write-AtomicJson([string]$Path, $Data) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth 16), [Text.Encoding]::UTF8)
    try {
      [IO.File]::Move($temp, $Path, $true)
    } catch {
      [IO.File]::Copy($temp, $Path, $true)
      [IO.File]::Delete($temp)
    }
  } finally {
    if (Test-Path -LiteralPath $temp) { try { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue } catch {} }
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

function Update-DashboardUsage {
  param(
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][string]$DashboardPath
  )

  if (-not (Test-Path -LiteralPath $RunRoot)) { return }

  $workerDir = Join-Path $RunRoot 'workers'
  $attemptsDir = Join-Path $RunRoot 'attempts'
  $eventsDir = Join-Path $RunRoot 'events'
  $resultsDir = Join-Path $RunRoot 'results'

  # We collect invocations: key -> invocation object
  # Key format: "$runId+$taskId+$attempt"
  $invocations = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)

  $registerInvocation = {
    param(
      [string]$rId,
      [string]$tId,
      [int]$att,
      [string]$st,
      $u,
      [string]$mdl,
      [string]$resp,
      [string]$err,
      $elapsedSec,
      [string]$updAt,
      [string]$tName
    )
    if ([string]::IsNullOrWhiteSpace($rId) -or [string]::IsNullOrWhiteSpace($tId)) { return }
    $attNum = if ($att -gt 0) { $att } else { 1 }
    $invKey = "$rId+$tId+$attNum"

    $prompt = if ($u -and $u.prompt) { [int64]$u.prompt } else { 0 }
    $candidates = if ($u -and $u.candidates) { [int64]$u.candidates } else { 0 }
    $cached = if ($u -and $u.cached) { [int64]$u.cached } else { 0 }
    $thoughts = if ($u -and $u.thoughts) { [int64]$u.thoughts } else { 0 }
    $total = if ($u -and $u.total -and [int64]$u.total -gt 0) {
      [int64]$u.total
    } else {
      $prompt + $candidates + $thoughts
    }
    $reqs = if ($u -and $u.requests -and [int64]$u.requests -gt 0) { [int64]$u.requests } else { 1 }
    $lat = if ($u -and $u.latencyMs -and [int64]$u.latencyMs -gt 0) {
      [int64]$u.latencyMs
    } elseif ($elapsedSec -and [double]$elapsedSec -gt 0) {
      [math]::Round([double]$elapsedSec * 1000)
    } else {
      0
    }

    $hasConfirmedUsage = ($total -gt 0) -or ($prompt -gt 0) -or ($candidates -gt 0) -or ($cached -gt 0) -or ($thoughts -gt 0)

    if ($invocations.ContainsKey($invKey)) {
      $existing = $invocations[$invKey]
      if (-not $existing.status -or $existing.status -in @('running', 'preparing')) { $existing.status = $st }
      if (-not $existing.model -and $mdl) { $existing.model = $mdl }
      if (-not $existing.finalResponse -and $resp) { $existing.finalResponse = $resp }
      if (-not $existing.error -and $err) { $existing.error = $err }
      if (-not $existing.taskName -and $tName) { $existing.taskName = $tName }
      if ((-not $existing.elapsedSeconds -or [double]$existing.elapsedSeconds -le 0) -and $elapsedSec) {
        $existing.elapsedSeconds = $elapsedSec
      }
      # State/result metadata is richer than the earlier confirmed_usage event.
      if ($updAt) { $existing.updatedAt = $updAt }
      if (-not $existing.hasConfirmedUsage -and $hasConfirmedUsage) {
        $existing.hasConfirmedUsage = $true
        $existing.prompt = $prompt
        $existing.candidates = $candidates
        $existing.cached = $cached
        $existing.thoughts = $thoughts
        $existing.total = $total
        $existing.requests = $reqs
        $existing.latencyMs = $lat
      }
      return
    }

    $invocations[$invKey] = [pscustomobject]@{
      runId             = $rId
      taskId            = $tId
      attempt           = $attNum
      status            = $st
      model             = $mdl
      finalResponse     = $resp
      error             = $err
      elapsedSeconds    = $elapsedSec
      updatedAt         = $updAt
      taskName          = $tName
      hasConfirmedUsage = $hasConfirmedUsage
      prompt            = $prompt
      candidates        = $candidates
      cached            = $cached
      thoughts          = $thoughts
      total             = $total
      requests          = $reqs
      latencyMs         = $lat
    }
  }

  # 1. Read events (*.ndjson)
  if (Test-Path -LiteralPath $eventsDir) {
    foreach ($file in Get-ChildItem -LiteralPath $eventsDir -Filter '*.ndjson' -ErrorAction SilentlyContinue) {
      try {
        $lines = [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8)
        foreach ($line in $lines) {
          if ([string]::IsNullOrWhiteSpace($line)) { continue }
          try {
            $evt = $line | ConvertFrom-Json
            if ($evt -and $evt.type -eq 'confirmed_usage' -and $evt.runId -and $evt.taskId) {
              $att = if ($evt.PSObject.Properties.Name -contains 'attempt' -and $evt.attempt) { [int]$evt.attempt } else { 1 }
              & $registerInvocation $evt.runId $evt.taskId $att $evt.status $evt.usage $null $null $null 0 $evt.timestamp $null
            }
          } catch {}
        }
      } catch {}
    }
  }

  # 2. Read attempts (*.json)
  if (Test-Path -LiteralPath $attemptsDir) {
    foreach ($file in Get-ChildItem -LiteralPath $attemptsDir -Filter '*.json' -ErrorAction SilentlyContinue) {
      try {
        $content = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
        if ($content -and $content.runId -and $content.taskId) {
          $att = if ($content.PSObject.Properties.Name -contains 'attempt' -and $content.attempt) { [int]$content.attempt } else { 1 }
          $u = if ($content.PSObject.Properties.Name -contains 'partialUsage') { $content.partialUsage } else { $content.usage }
          & $registerInvocation $content.runId $content.taskId $att $content.status $u $content.model $content.finalResponse $content.error $content.elapsedSeconds $content.updatedAt $content.task
        }
      } catch {}
    }
  }

  # 3. Read workers (*.json)
  if (Test-Path -LiteralPath $workerDir) {
    foreach ($file in Get-ChildItem -LiteralPath $workerDir -Filter '*.json' -ErrorAction SilentlyContinue) {
      try {
        $content = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
        if ($content -and $content.runId -and $content.taskId) {
          $att = if ($content.PSObject.Properties.Name -contains 'attempt' -and $content.attempt) { [int]$content.attempt } else { 1 }
          $u = if ($content.PSObject.Properties.Name -contains 'partialUsage') { $content.partialUsage } else { $content.usage }
          & $registerInvocation $content.runId $content.taskId $att $content.status $u $content.model $content.finalResponse $content.error $content.elapsedSeconds $content.updatedAt $content.task
        }
      } catch {}
    }
  }

  # 4. Read results (*-result.json)
  $resultStatusMap = @{}
  if (Test-Path -LiteralPath $resultsDir) {
    foreach ($file in Get-ChildItem -LiteralPath $resultsDir -Filter '*-result.json' -ErrorAction SilentlyContinue) {
      try {
        $content = Get-Content -Raw -LiteralPath $file.FullName | ConvertFrom-Json
        if ($content -and $content.runId -and $content.taskId) {
          $resultStatusMap["$($content.runId)+$($content.taskId)"] = $content
          $att = if ($content.PSObject.Properties.Name -contains 'attempt' -and $content.attempt) { [int]$content.attempt } else { 1 }
          $u = if ($content.PSObject.Properties.Name -contains 'partialUsage') { $content.partialUsage } else { $content.usage }
          & $registerInvocation $content.runId $content.taskId $att $content.status $u $content.model $content.finalResponse $content.error $content.elapsedSeconds $content.updatedAt $content.task
        }
      } catch {}
    }
  }

  if ($invocations.Count -eq 0) { return }

  # Group invocations by logical task key: "$runId+$taskId"
  $taskGroups = [System.Collections.Generic.Dictionary[string, System.Collections.Generic.List[object]]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($inv in $invocations.Values) {
    $tKey = "$($inv.runId)+$($inv.taskId)"
    if (-not $taskGroups.ContainsKey($tKey)) {
      $taskGroups[$tKey] = [System.Collections.Generic.List[object]]::new()
    }
    $taskGroups[$tKey].Add($inv)
  }

  # Deterministic cross-process lock on DashboardPath
  $normDashPath = [System.IO.Path]::GetFullPath($DashboardPath).ToLowerInvariant()
  $normBytes = [System.Text.Encoding]::UTF8.GetBytes($normDashPath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $dashHash = try {
    [System.BitConverter]::ToString($sha.ComputeHash($normBytes)) -replace '-', ''
  } finally {
    $sha.Dispose()
  }
  $lockName = "Local\CodexDashboardLock_$dashHash"

  $mutex = New-Object System.Threading.Mutex($false, $lockName)
  $hasLock = $false
  try {
    try {
      $hasLock = $mutex.WaitOne(60000)
    } catch [System.Threading.AbandonedMutexException] {
      $hasLock = $true
    }
    if (-not $hasLock) {
      throw "대시보드 잠금 획득 타임아웃 ($lockName)"
    }

    $data = $null
    if (Test-Path -LiteralPath $DashboardPath) {
      try {
        $data = Get-Content -Raw -LiteralPath $DashboardPath | ConvertFrom-Json
      } catch {
        $data = $null
      }
    }

    if (-not $data) {
      $data = [pscustomobject]@{
        updatedAt      = (Get-Date).ToString('o')
        summary        = [pscustomobject]@{
          tokens           = 0
          requests         = 0
          completed        = 0
          failed           = 0
          averageLatencyMs = 0
        }
        tokens         = [pscustomobject]@{
          prompt     = 0
          candidates = 0
          cached     = 0
          thoughts   = 0
        }
        codexDaily     = @()
        jobs           = @()
        processedKeys  = @()
        processedTasks = [pscustomobject]@{}
      }
    }

    if (-not ($data.PSObject.Properties.Name -contains 'summary') -or -not $data.summary) {
      $data | Add-Member -NotePropertyName 'summary' -NotePropertyValue ([pscustomobject]@{
        tokens = 0; requests = 0; completed = 0; failed = 0; averageLatencyMs = 0
      }) -Force
    }
    if (-not ($data.PSObject.Properties.Name -contains 'tokens') -or -not $data.tokens) {
      $data | Add-Member -NotePropertyName 'tokens' -NotePropertyValue ([pscustomobject]@{
        prompt = 0; candidates = 0; cached = 0; thoughts = 0
      }) -Force
    }
    if (-not ($data.PSObject.Properties.Name -contains 'jobs') -or -not $data.jobs) {
      $data | Add-Member -NotePropertyName 'jobs' -NotePropertyValue @() -Force
    }
    if (-not ($data.PSObject.Properties.Name -contains 'processedKeys') -or -not $data.processedKeys) {
      $data | Add-Member -NotePropertyName 'processedKeys' -NotePropertyValue @() -Force
    }
    if (-not ($data.PSObject.Properties.Name -contains 'processedTasks') -or -not $data.processedTasks) {
      $data | Add-Member -NotePropertyName 'processedTasks' -NotePropertyValue ([pscustomobject]@{}) -Force
    }

    $existingKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($k in @($data.processedKeys)) {
      if (-not [string]::IsNullOrWhiteSpace($k)) {
        [void]$existingKeys.Add([string]$k)
      }
    }

    $newJobs = [System.Collections.Generic.List[object]]::new()
    $keysToAdd = [System.Collections.Generic.List[string]]::new()
    $hasChanges = $false

    # Step 1: Process each invocation usage (Tokens, Requests, Latency)
    foreach ($inv in $invocations.Values) {
      $rId = $inv.runId
      $tId = $inv.taskId
      $att = $inv.attempt
      $usageKey = "$rId+$tId+$att"
      $colonUsageKey = "$($rId):$($tId):$att"
      $taskKey = "$rId+$tId"
      $colonTaskKey = "$($rId):$($tId)"

      # Check if already processed
      if ($existingKeys.Contains($usageKey) -or $existingKeys.Contains($colonUsageKey)) {
        continue
      }

      # Check legacy: if $taskKey is in $existingKeys, check whether any attempt-key exists
      if ($existingKeys.Contains($taskKey) -or $existingKeys.Contains($colonTaskKey)) {
        $hasAttemptKey = $false
        foreach ($k in $existingKeys) {
          if ($k.StartsWith("$taskKey+") -or $k.StartsWith($colonTaskKey + ':')) {
            $hasAttemptKey = $true
            break
          }
        }
        if (-not $hasAttemptKey) {
          # Legacy entry! Do not double-count
          continue
        }
      }

      # Include finalized usage whenever confirmed usage exists
      if (-not $inv.hasConfirmedUsage) {
        $keysToAdd.Add($usageKey)
        [void]$existingKeys.Add($usageKey)
        continue
      }

      $prevRequests = [int64]$data.summary.requests
      $totalRequests = $prevRequests + $inv.requests
      $totalLatency = ([int64]$data.summary.averageLatencyMs * $prevRequests) + $inv.latencyMs

      $data.summary.tokens = [int64]$data.summary.tokens + $inv.total
      $data.summary.requests = $totalRequests
      $data.summary.averageLatencyMs = if ($totalRequests -gt 0) { [math]::Round($totalLatency / $totalRequests) } else { 0 }

      $data.tokens.prompt = [int64]$data.tokens.prompt + $inv.prompt
      $data.tokens.candidates = [int64]$data.tokens.candidates + $inv.candidates
      $data.tokens.cached = [int64]$data.tokens.cached + $inv.cached
      $data.tokens.thoughts = [int64]$data.tokens.thoughts + $inv.thoughts

      $keysToAdd.Add($usageKey)
      [void]$existingKeys.Add($usageKey)
      $hasChanges = $true
    }

    # Step 2: Deduplicate logical completed/failed task counts separately by runId+taskId
    foreach ($entry in $taskGroups.GetEnumerator()) {
      $taskKey = $entry.Key
      $invList = $entry.Value
      $firstInv = $invList[0]
      $rId = $firstInv.runId
      $tId = $firstInv.taskId
      $colonTaskKey = "$($rId):$($tId)"

      # Authoritative final status from results if available
      $resObj = if ($resultStatusMap.ContainsKey($taskKey)) { $resultStatusMap[$taskKey] } else { $null }

      $isSuccess = $false
      $finalStatusStr = 'failed'
      if ($resObj) {
        $isSuccess = ($resObj.status -eq 'completed')
        $finalStatusStr = if ($isSuccess) { 'completed' } else { [string]$resObj.status }
      } else {
        $completedInv = $invList | Where-Object { $_.status -eq 'completed' } | Select-Object -First 1
        if ($completedInv) {
          $isSuccess = $true
          $finalStatusStr = 'completed'
        } else {
          $latestInv = $invList | Sort-Object attempt -Descending | Select-Object -First 1
          $finalStatusStr = if ($latestInv) { [string]$latestInv.status } else { 'failed' }
          $isSuccess = ($finalStatusStr -eq 'completed')
        }
      }

      $targetLogicalCountStatus = if ($isSuccess) { 'completed' } else { 'failed' }

      $isLegacyTask = $false
      if ($existingKeys.Contains($taskKey) -or $existingKeys.Contains($colonTaskKey)) {
        $hasAttemptKey = $false
        foreach ($k in $existingKeys) {
          if ($k.StartsWith("$taskKey+") -or $k.StartsWith($colonTaskKey + ':')) {
            $hasAttemptKey = $true
            break
          }
        }
        if (-not $hasAttemptKey) {
          $isLegacyTask = $true
        }
      }

      $prevCountStatus = $null
      if ($data.processedTasks.PSObject.Properties.Name -contains $taskKey) {
        $prevCountStatus = [string]$data.processedTasks.$taskKey
      } elseif ($isLegacyTask) {
        $prevCountStatus = 'legacy_counted'
        $data.processedTasks | Add-Member -NotePropertyName $taskKey -NotePropertyValue 'legacy_counted' -Force
      }

      if (-not $prevCountStatus) {
        if ($targetLogicalCountStatus -eq 'completed') {
          $data.summary.completed = [int64]$data.summary.completed + 1
        } else {
          $data.summary.failed = [int64]$data.summary.failed + 1
        }
        $data.processedTasks | Add-Member -NotePropertyName $taskKey -NotePropertyValue $targetLogicalCountStatus -Force
        $keysToAdd.Add($taskKey)
        [void]$existingKeys.Add($taskKey)
        $hasChanges = $true
      } elseif ($prevCountStatus -eq 'failed' -and $targetLogicalCountStatus -eq 'completed') {
        $data.summary.failed = [math]::Max(0, [int64]$data.summary.failed - 1)
        $data.summary.completed = [int64]$data.summary.completed + 1
        $data.processedTasks.$taskKey = 'completed'
        $hasChanges = $true
      }

      # Job entry management
      $existingJob = $null
      foreach ($j in @($data.jobs)) {
        if ($j.PSObject.Properties.Name -contains 'runId' -and $j.PSObject.Properties.Name -contains 'taskId') {
          if ($j.runId -eq $rId -and $j.taskId -eq $tId) {
            $existingJob = $j
            break
          }
        }
      }

      $latestAttemptInv = $invList | Sort-Object attempt -Descending | Select-Object -First 1
      $taskTotalTokens = ($invList | Measure-Object -Property total -Sum).Sum
      $taskPromptTokens = ($invList | Measure-Object -Property prompt -Sum).Sum
      $taskCandidatesTokens = ($invList | Measure-Object -Property candidates -Sum).Sum
      $taskCachedTokens = ($invList | Measure-Object -Property cached -Sum).Sum
      $taskThoughtsTokens = ($invList | Measure-Object -Property thoughts -Sum).Sum
      $taskRequests = ($invList | Measure-Object -Property requests -Sum).Sum
      $taskLatency = ($invList | Measure-Object -Property latencyMs -Sum).Sum
      $taskElapsed = ($invList | Measure-Object -Property elapsedSeconds -Sum).Sum

      $jobModel = if ($resObj -and $resObj.model) { [string]$resObj.model } elseif ($latestAttemptInv -and $latestAttemptInv.model) { [string]$latestAttemptInv.model } else { 'gemini-3.8-flash-medium' }
      $jobStatus = if ($isSuccess) { '완료' } else { '실패' }

      $jobSnippet = ""
      if ($isSuccess) {
        $finalResp = if ($resObj -and $resObj.finalResponse) { [string]$resObj.finalResponse } elseif ($latestAttemptInv -and $latestAttemptInv.finalResponse) { [string]$latestAttemptInv.finalResponse } else { "" }
        if ($finalResp) {
          $jobSnippet = $finalResp
          if ($jobSnippet.Length -gt 800) { $jobSnippet = $jobSnippet.Substring(0, 770) + "..." }
        }
      } else {
        $errMsg = if ($resObj -and $resObj.error) { [string]$resObj.error } elseif ($latestAttemptInv -and $latestAttemptInv.error) { [string]$latestAttemptInv.error } else { "" }
        if ($errMsg) {
          $jobSnippet = "에러: $errMsg"
        } else {
          $jobSnippet = "작업 실패 (상태: $finalStatusStr)"
        }
      }

      $jobTime = try {
        if ($latestAttemptInv -and $latestAttemptInv.updatedAt) { ([datetime]$latestAttemptInv.updatedAt).ToString('tt h:mm') } else { (Get-Date).ToString('tt h:mm') }
      } catch { (Get-Date).ToString('tt h:mm') }
      $jobTimestamp = if ($latestAttemptInv -and $latestAttemptInv.updatedAt) { [string]$latestAttemptInv.updatedAt } else { (Get-Date).ToString('o') }

      $jobStats = [pscustomobject]@{
        prompt     = [int64]$taskPromptTokens
        candidates = [int64]$taskCandidatesTokens
        cached     = [int64]$taskCachedTokens
        thoughts   = [int64]$taskThoughtsTokens
        requests   = [int64]$taskRequests
        latency    = [int64]$taskLatency
      }

      if ($existingJob) {
        $existingJob.status = $jobStatus
        $existingJob.tokens = ([int64]$taskTotalTokens).ToString('N0')
        $existingJob.duration = "${taskElapsed}초"
        $existingJob.snippet = $jobSnippet
        $existingJob.stats = $jobStats
      } else {
        $job = [pscustomobject]@{
          name      = if ($firstInv.taskName) { [string]$firstInv.taskName } else { $tId }
          model     = $jobModel
          status    = $jobStatus
          tokens    = ([int64]$taskTotalTokens).ToString('N0')
          duration  = "${taskElapsed}초"
          time      = $jobTime
          timestamp = $jobTimestamp
          snippet   = $jobSnippet
          runId     = $rId
          taskId    = $tId
          stats     = $jobStats
        }
        $newJobs.Add($job)
      }
    }

    if ($hasChanges -or $newJobs.Count -gt 0) {
      $data.updatedAt = (Get-Date).ToString('o')
      if ($newJobs.Count -gt 0) {
        $data.jobs = @($newJobs) + @($data.jobs) | Select-Object -First 50
      }
      if ($keysToAdd.Count -gt 0) {
        $data.processedKeys = @($data.processedKeys) + @($keysToAdd) | Select-Object -Unique
      }
      Write-AtomicJson -Path $DashboardPath -Data $data
    }
  } finally {
    if ($hasLock) {
      try { $mutex.ReleaseMutex() } catch {}
    }
    if ($mutex) {
      $mutex.Dispose()
    }
  }
}

if ($SyncStateRoot) {
  Update-DashboardUsage -RunRoot $SyncStateRoot -DashboardPath $dashboardPath
  return
}

function Start-WorkerProcess($Task, $Policy, $Worktree, [string]$Tier, [string]$RunId, [string]$RunRoot, [string]$BaseCommit, [string]$TimeoutValue, [int]$Attempt = 1) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = (Get-Command pwsh.exe).Source
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $policyJson = $Policy | ConvertTo-Json -Depth 8 -Compress
  $workerPrompt = @"
$([string]$Task.prompt)

FILESYSTEM POLICY v2.1:
$policyJson

Repository search/read is allowed only inside this task worktree, except read_scope.deny paths. Modify only write_scope.expected or write_scope.derived_approved. Do not modify sensitive or forbidden paths unless they are explicitly present in write_scope.expected. The orchestrator independently verifies the final diff and merge scope.
If another file is required, report a JSON object with action REQUEST_WRITE_EXPANSION, target, reason, and dependency evidence instead of silently expanding scope.
"@
  foreach ($argument in @(
    '-NoProfile', '-File', $workerScript,
    '-Task', [string]$Task.name,
    '-Prompt', $workerPrompt,
    '-Model', $Tier,
    '-Workspace', [string]$Worktree.path,
    '-Timeout', $TimeoutValue,
    '-OrchestrationRunId', $RunId,
    '-TaskId', [string]$Task.id,
    '-StateRoot', $RunRoot,
    '-BaseCommit', $BaseCommit,
    '-Attempt', $Attempt.ToString(),
    '-DashboardPath', $dashboardPath,
    '-DataDir', $publicData
  )) { $null = $info.ArgumentList.Add($argument) }
  if ($Task.PSObject.Properties.Name -contains 'mock_output_json' -and $Task.mock_output_json) {
    $null = $info.ArgumentList.Add('-MockOutputJson')
    $null = $info.ArgumentList.Add([string]$Task.mock_output_json)
  }
  if ($Task.PSObject.Properties.Name -contains 'mock_exit_code' -and $null -ne $Task.mock_exit_code) {
    $null = $info.ArgumentList.Add('-MockExitCode')
    $null = $info.ArgumentList.Add([string]$Task.mock_exit_code)
  }
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

function Invoke-Verification([string]$Worktree, $Commands, [int]$DefaultTimeoutSeconds = 120) {
  return @(Invoke-BoundedVerification -Worktree $Worktree -Commands $Commands -DefaultTimeoutSeconds $DefaultTimeoutSeconds)
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
  $basis = @($Tests | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') } | ForEach-Object {
    $normalized = ([string]$_.output).ToLowerInvariant() -replace '\d+', '#' -replace '\s+', ' '
    "$($_.command)|$($_.exitCode)|$($_.status)|$normalized"
  }) -join "`n"
  if (-not $basis) { $basis = $Classification }
  $bytes = [Text.Encoding]::UTF8.GetBytes($basis)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-CompressedFailureLog($Tests) {
  $parts = @($Tests | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') } | ForEach-Object {
    $output = [string]$_.output
    if ($output.Length -gt 2500) { $output = $output.Substring($output.Length - 2500) }
    "COMMAND: $($_.command)`nSTATUS: $($_.status)`nEXIT_CODE: $($_.exitCode)`nOUTPUT:`n$output"
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
$taskConfig = Get-Content -Raw -LiteralPath $tasksPath | ConvertFrom-Json
if ($taskConfig -is [array]) {
  $tasks = @($taskConfig)
  $integrationTestCommands = @()
} elseif ($taskConfig.PSObject.Properties.Name -contains 'tasks') {
  $tasks = @($taskConfig.tasks)
  $integrationTestCommands = @($taskConfig.integration_test_commands)
} else {
  throw '작업 파일은 task 배열 또는 tasks 속성을 가진 객체여야 합니다.'
}
if ($tasks.Count -eq 0) { throw '작업 파일에 task가 없습니다.' }
$ids = @($tasks | ForEach-Object { $_.id })
if (($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or ($ids | Select-Object -Unique).Count -ne $ids.Count) { throw '각 task에는 고유한 id가 필요합니다.' }
$normalizedPolicies = @{}
$ownership = [Collections.Generic.List[object]]::new()
foreach ($task in $tasks) {
  $policy = Resolve-FilesystemPolicy $task
  $normalizedPolicies[[string]$task.id] = $policy
  foreach ($pattern in @($policy.write_scope.expected)) {
    foreach ($existing in $ownership) {
      if (Test-PolicyPatternOverlap -Left ([string]$existing.pattern) -Right ([string]$pattern)) {
        throw "OWNERSHIP_OVERLAP: $pattern ($($existing.taskId), $($task.id))"
      }
    }
    $ownership.Add([pscustomobject]@{ taskId = [string]$task.id; pattern = [string]$pattern })
  }
}

$runId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runRoot = Join-Path $agentRoot "runs\$runId"
$worktreeRoot = Join-Path $agentRoot "worktrees\$runId"
New-Item -ItemType Directory -Path (Join-Path $runRoot 'tasks'), (Join-Path $runRoot 'workers'), (Join-Path $runRoot 'attempts'), (Join-Path $runRoot 'events'), (Join-Path $runRoot 'results'), $worktreeRoot -Force | Out-Null

$baseCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
$manifest = [pscustomobject]@{
  runId = $runId; status = 'preparing'; createdAt = (Get-Date).ToString('o'); updatedAt = (Get-Date).ToString('o')
  repository = $repoRoot; baseCommit = $baseCommit; maxWorkers = $MaxWorkers; orchestratorProcessId = $PID
  tasks = @($tasks | ForEach-Object { $_.id }); worktrees = @(); filesystemPolicy = 'v2.1'
  tasksFile = $tasksPath; integrationTestCommands = @($integrationTestCommands)
}
$manifestPath = Join-Path $runRoot 'run.json'
$cancelPath = Join-Path $runRoot 'cancel.requested'
Write-AtomicJson $manifestPath $manifest

$dashboardPackage = Join-Path $repoRoot 'gemini-dashboard\package.json'
if (Test-Path -LiteralPath $dashboardPackage) {
  $toolchain = Invoke-NodeNpmPreflight -WorkingDirectory $repoRoot -PackageJsonPath $dashboardPackage
  Set-ObjectProperty $manifest 'toolchain' ([pscustomobject]@{
    status = $toolchain.status
    nodePath = $toolchain.nodePath
    npmPath = $toolchain.npmPath
    nodeVersion = $toolchain.nodeVersion
    npmVersion = $toolchain.npmVersion
    requiredNodeVersion = $toolchain.requiredNodeVersion
    missing = @($toolchain.missing)
    error = $toolchain.error
    checkedAt = (Get-Date).ToString('o')
  })
  if (-not $toolchain.success) {
    $manifest.status = 'failed'
    Set-ObjectProperty $manifest 'errorCategory' 'environment_error'
    Set-ObjectProperty $manifest 'error' "ENVIRONMENT_ERROR: $($toolchain.error)"
    $manifest.updatedAt = (Get-Date).ToString('o')
    Write-AtomicJson $manifestPath $manifest
    Write-Output "Run: $runId"
    Write-Output "State: $runRoot"
    Write-Output 'Status: failed'
    exit 1
  }
  $env:PATH = $toolchain.augmentedPath
  $env:CODEX_GEMINI_NODE_PATH = $toolchain.nodePath
  $env:CODEX_GEMINI_NPM_PATH = $toolchain.npmPath
}

$worktrees = @()
$jobRecords = @()
try {
  foreach ($task in $tasks) {
    $policy = $normalizedPolicies[[string]$task.id]
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
    $branch = "agent/$runId/$safeId"
    $worktree = Join-Path $worktreeRoot $safeId
    & git -C $repoRoot worktree add -b $branch $worktree $baseCommit
    if ($LASTEXITCODE -ne 0) { throw "worktree 생성 실패: $($task.id)" }
    if (Test-Path -LiteralPath (Join-Path $worktree 'gemini-dashboard')) {
      Ensure-DashboardDependencies -Worktree $worktree -SourceWorktree $repoRoot | Out-Null
    }
    $wtRecord = [pscustomobject]@{ id = $task.id; branch = $branch; path = $worktree; baseCommit = $baseCommit }
    $worktrees += $wtRecord
    $manifest.worktrees = $worktrees; $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
    Write-AtomicJson (Join-Path $runRoot "tasks\$safeId.json") ([pscustomobject]@{
      id = $task.id; name = $task.name; prompt = $task.prompt; tier = $task.tier; allowedFiles = @($policy.write_scope.expected)
      filesystemPolicy = $policy
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
      $branchEvtPath = Join-Path $runRoot "events\$safeId.ndjson"
      if (-not (Test-Path -LiteralPath $branchEvtPath)) {
        $branchRecord = [ordered]@{
          id        = "$safeId-branch"
          parentId  = "$runId-plan"
          timestamp = (Get-Date).ToString('o')
          runId     = $runId
          taskId    = $task.id
          attempt   = 1
          type      = 'system'
          activity  = 'LOAD'
          message   = "워커 브랜치 시작: $($task.name)"
        }
        Add-Content -LiteralPath $branchEvtPath -Value ($branchRecord | ConvertTo-Json -Compress) -Encoding utf8
      }
      $policy = $normalizedPolicies[[string]$task.id]
      $process = Start-WorkerProcess $task $policy $wt $tier $runId $runRoot $baseCommit $Timeout
      $jobRecords += [pscustomobject]@{ Process = $process; Task = $task; SafeId = $safeId; Worktree = $wt; StartedAt = Get-Date; TimedOut = $false; Cancelled = $false; Attempt = 1 }
      $running++
    }

    foreach ($record in $jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }) {
      $limit = if ($record.Task.timeout_seconds) { [int]$record.Task.timeout_seconds } else { $WorkerTimeoutSeconds }
      if (((Get-Date) - $record.StartedAt).TotalSeconds -gt $limit) {
        $wPath = Join-Path $runRoot "workers\$($record.SafeId).json"
        Stop-WorkerProcesses $wPath
        if (-not $record.Process.HasExited) { $record.Process.Kill($true) }
        $record.TimedOut = $true
        if (Test-Path -LiteralPath $wPath) {
          try {
            $wState = Get-Content -Raw -LiteralPath $wPath | ConvertFrom-Json
            Set-ObjectProperty $wState 'status' 'timed_out'
            Set-ObjectProperty $wState 'error' '작업 시간 초과 (오케스트레이터 강제 종료)'
            Set-ObjectProperty $wState 'updatedAt' (Get-Date).ToString('o')
            Write-AtomicJson $wPath $wState
            $attPath = Join-Path $runRoot "attempts\$($record.SafeId).attempt-$($record.Attempt).json"
            Write-AtomicJson $attPath $wState
          } catch {}
        }
      }
    }
    Sync-LiveWorkers $runRoot
    if (@($jobRecords | Where-Object { -not $_.TimedOut -and -not $_.Cancelled -and -not $_.Process.HasExited }).Count -gt 0) { Start-Sleep -Milliseconds 500 }
  }

  $failed = 0
  foreach ($task in $tasks) {
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'; $wt = $worktrees | Where-Object id -eq $task.id | Select-Object -First 1
    $policy = $normalizedPolicies[[string]$task.id]
    $statePath = Join-Path $runRoot "workers\$safeId.json"
    $record = $jobRecords | Where-Object { $_.Task.id -eq $task.id } | Select-Object -First 1
    $attempt = 1
    $retryLimit = if ($null -ne $task.retry_limit) { [math]::Min(3, [math]::Max(2, [int]$task.retry_limit)) } else { 3 }
    $history = @()
    $fingerprints = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $currentTier = if ($task.tier) { [string]$task.tier } else { 'normal' }

    while ($true) {
      $state = if (Test-Path -LiteralPath $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { [pscustomobject]@{ runId=$runId; taskId=$task.id; task=$task.name; status='failed'; error='워커 상태 파일이 생성되지 않음' } }
      $wasCancelled = Test-Path -LiteralPath $cancelPath
      $wasTimedOut = $record -and $record.TimedOut
      $changed = @(Get-ChangedFiles $wt.path $baseCommit)
      $scopeVerification = Get-FilesystemScopeVerification -ChangedFiles $changed -Policy $policy
      $violations = @($scopeVerification.violations)
      $bootstrapFailed = $false
      $bootstrapError = $null
      if (-not $wasCancelled -and -not $wasTimedOut -and $state.status -eq 'completed' -and $violations.Count -eq 0) {
        if (Test-Path -LiteralPath (Join-Path $wt.path 'gemini-dashboard')) {
          $bootWt = Ensure-DashboardDependencies -Worktree $wt.path -SourceWorktree $repoRoot
          if (-not $bootWt.success) {
            $bootstrapFailed = $true
            $bootstrapError = $bootWt.error
            if (-not $state.error) { $state.error = "ENVIRONMENT_ERROR: $bootstrapError" }
          }
        }
      }
      $tests = if (-not $wasCancelled -and -not $wasTimedOut -and -not $bootstrapFailed -and $state.status -eq 'completed' -and $violations.Count -eq 0) { @(Invoke-Verification $wt.path @($task.test_commands)) } else { @() }
      $branchEvtPath = Join-Path $runRoot "events\$safeId.ndjson"
      if ($tests -and $tests.Count -gt 0 -and (Test-Path -LiteralPath $branchEvtPath)) {
        $vSeq = 0
        foreach ($testCmd in $tests) {
          $vSeq++
          $vRec = [ordered]@{
            id        = "$safeId-verify-$attempt-$vSeq"
            parentId  = "$safeId-branch"
            timestamp = (Get-Date).ToString('o')
            runId     = $runId
            taskId    = $task.id
            attempt   = $attempt
            type      = 'verification'
            activity  = if ($testCmd.status -eq 'PASS' -and $testCmd.exitCode -eq 0 -and -not $testCmd.timedOut) { 'PASS' } else { 'FAIL' }
            command   = $testCmd.command
            message   = "검증 실행: $($testCmd.status) ($($testCmd.command))"
          }
          Add-Content -LiteralPath $branchEvtPath -Value ($vRec | ConvertTo-Json -Compress) -Encoding utf8
        }
      }
      $hasTestFailures = @($tests | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') -or ($null -ne $_.exitCode -and $_.exitCode -ne 0) -or $_.timedOut }).Count -gt 0
      $isWorkerFailed = ($state.status -ne 'completed')
      $hasAnyFailure = $wasCancelled -or $wasTimedOut -or ($violations.Count -gt 0) -or $bootstrapFailed -or $isWorkerFailed -or $hasTestFailures

      $classification = $null
      if ($hasAnyFailure) {
        $failedTestOutputs = @($tests | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') -or ($null -ne $_.exitCode -and $_.exitCode -ne 0) -or $_.timedOut } | ForEach-Object { $_.output })
        $failureParts = @($state.error) + $failedTestOutputs
        if ($isWorkerFailed -and -not $state.error) {
          $failureParts += $state.finalResponse
        }
        $failureText = ($failureParts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n"
        $classification = Get-FailureClassification $failureText
      }

      $decision = if ($wasCancelled) {
        'CANCELLED'
      } elseif ($wasTimedOut) {
        'TIMED_OUT'
      } elseif ($violations.Count -gt 0) {
        'POLICY_VIOLATION'
      } elseif ($bootstrapFailed) {
        'ENVIRONMENT_ERROR'
      } elseif ($classification) {
        $classification
      } elseif ($isWorkerFailed) {
        'WORKER_FAILED'
      } elseif ($hasTestFailures) {
        'TEST_FAILED'
      } else {
        'PASS'
      }

      # Preserve attempt state file for current attempt
      $attFile = Join-Path $runRoot "attempts\$safeId.attempt-$attempt.json"
      try { Write-AtomicJson $attFile $state } catch {}

      if ($decision -ne 'TEST_FAILED') { break }
      $fingerprint = Get-FailureFingerprint $tests $decision
      $compressed = Get-CompressedFailureLog $tests
      $history += [pscustomobject]@{ attempt=$attempt; decision=$decision; fingerprint=$fingerprint; failureLog=$compressed; verifiedAt=(Get-Date).ToString('o') }
      $isHighTier = $currentTier -in @('advanced', 'reasoning')
      if ($isHighTier) { $decision = 'HIGH_MODEL_FAILED'; break }
      $isRepeated = $fingerprints.Contains($fingerprint)
      $null = $fingerprints.Add($fingerprint)
      if (($attempt - 1) -ge $retryLimit) { $decision = 'RETRY_EXHAUSTED'; break }

      # Two failed attempts (including the same fingerprint twice) promote the
      # next invocation to High. A failure on High is handed back to Codex.
      if ($history.Count -ge 2 -or $isRepeated) { $currentTier = 'advanced' }

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
      $process = Start-WorkerProcess $retryTask $policy $wt $currentTier $runId $runRoot $baseCommit $Timeout $attempt
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
          if (Test-Path -LiteralPath $statePath) {
            try {
              $wState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
              Set-ObjectProperty $wState 'status' 'timed_out'
              Set-ObjectProperty $wState 'error' '재시도 작업 시간 초과 (오케스트레이터 강제 종료)'
              Set-ObjectProperty $wState 'updatedAt' (Get-Date).ToString('o')
              Write-AtomicJson $statePath $wState
              $attPath = Join-Path $runRoot "attempts\$safeId.attempt-$attempt.json"
              Write-AtomicJson $attPath $wState
            } catch {}
          }
          break
        }
        Sync-LiveWorkers $runRoot
        Start-Sleep -Milliseconds 500
      }
    }

    $commitHashes = @()
    if ($decision -eq 'PASS' -and $changed.Count -gt 0) {
      & git -C $wt.path add -- @changed
      if ($LASTEXITCODE -ne 0) {
        $decision = 'COMMIT_FAILED'
      } else {
        & git -C $wt.path diff --cached --quiet
        if ($LASTEXITCODE -ne 0) {
          & git -C $wt.path -c user.name='Gemini Worker' -c user.email='gemini-worker@local' commit -m "agent($($task.id)): $($task.name)"
          if ($LASTEXITCODE -ne 0) { $decision = 'COMMIT_FAILED' }
        }
        if ($decision -eq 'PASS') { $commitHashes = @(& git -C $wt.path rev-list --reverse "$baseCommit..HEAD") }
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
    Set-ObjectProperty $state 'commitHashes' $commitHashes
    Set-ObjectProperty $state 'policy' ([pscustomobject]@{
      filesystemPolicy = 'v2.1'
      allowedFiles = @($policy.write_scope.expected)
      readScope = $policy.read_scope
      writeScope = $policy.write_scope
      mergeScope = $policy.merge_scope
      entries = @($scopeVerification.entries)
      violations = $violations
      sensitiveTouched = [int]$scopeVerification.sensitiveTouched
      status = $scopeVerification.status
    })
    Set-ObjectProperty $state 'verification' ([pscustomobject]@{ decision=$decision; commands=$tests; verifiedAt=(Get-Date).ToString('o') })
    Set-ObjectProperty $state 'escalation' $(if ($decision -eq 'PASS') { $null } else { [pscustomobject]@{ requiresCodex=$true; category=$decision; reason="자동 처리 중단: $decision" } })
    Set-ObjectProperty $state 'updatedAt' (Get-Date).ToString('o')
    Write-AtomicJson $statePath $state; Write-AtomicJson (Join-Path $runRoot "results\$safeId-result.json") $state
    $finalAttPath = Join-Path $runRoot "attempts\$safeId.attempt-$attempt.json"
    try { Write-AtomicJson $finalAttPath $state } catch {}
    Update-DashboardUsage -RunRoot $runRoot -DashboardPath $dashboardPath
    if ($decision -ne 'PASS') { $failed++ }
  }

  $integration = $null
  if ($failed -eq 0 -and -not (Test-Path -LiteralPath $cancelPath)) {
    $integrationBranch = "integration/$runId"
    $integrationPath = Join-Path $agentRoot "integration\$runId"
    New-Item -ItemType Directory -Path (Split-Path -Parent $integrationPath) -Force | Out-Null
    & git -C $repoRoot worktree add -b $integrationBranch $integrationPath $baseCommit
    if ($LASTEXITCODE -ne 0) {
      $integration = [pscustomobject]@{ branch=$integrationBranch; worktree=$integrationPath; decision='INTEGRATION_SETUP_FAILED'; approvalRequired=$true }
      $failed++
    } else {
      $bootInteg = Ensure-DashboardDependencies -Worktree $integrationPath -SourceWorktree $repoRoot
      if (-not $bootInteg.success) {
        $integrationDecision = 'ENVIRONMENT_ERROR'
        $integration = [pscustomobject]@{
          id="$runId-integration"; parentIds=@($tasks | ForEach-Object { "$([string]$_.id)-branch" }); startedAt=(Get-Date).ToString('o')
          branch=$integrationBranch; worktree=$integrationPath; baseCommit=$baseCommit; headCommit=(& git -C $integrationPath rev-parse HEAD).Trim()
          decision='ENVIRONMENT_ERROR'; approvalRequired=$true; mainModified=$false; cherryPicks=@()
          tests=@(); changedFiles=@(); diffStat=''; commits=@()
          reviewArtifact=(Join-Path $runRoot 'integration-review.md')
          error=$bootInteg.error
        }
        Write-AtomicJson (Join-Path $runRoot 'integration.json') $integration
        $failed++
      } else {
        $cherryPicks = @()
        $integrationDecision = 'AWAITING_CODEX_REVIEW'
        foreach ($task in $tasks) {
          $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
          $result = Get-Content -Raw (Join-Path $runRoot "results\$safeId-result.json") | ConvertFrom-Json
          foreach ($commitHash in @($result.commitHashes)) {
            & git -C $integrationPath cherry-pick $commitHash
            $pickStatus = if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'CONFLICT' }
            $cherryPicks += [pscustomobject]@{ taskId=$task.id; commit=$commitHash; status=$pickStatus }
            if ($pickStatus -eq 'CONFLICT') {
              & git -C $integrationPath cherry-pick --abort 2>$null
              $integrationDecision = 'INTEGRATION_CONFLICT'
              break
            }
          }
          if ($integrationDecision -eq 'INTEGRATION_CONFLICT') { break }
        }
        $integrationTests = if ($integrationDecision -eq 'AWAITING_CODEX_REVIEW') { @(Invoke-Verification $integrationPath $integrationTestCommands) } else { @() }
        if (@($integrationTests | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') -or ($null -ne $_.exitCode -and $_.exitCode -ne 0) -or $_.timedOut }).Count -gt 0) { $integrationDecision = 'INTEGRATION_TEST_FAILED' }
        $diffFiles = @(& git -C $integrationPath diff --name-only "$baseCommit...HEAD" | Where-Object { $_ })
        $diffStat = @(& git -C $integrationPath diff --stat "$baseCommit...HEAD") -join "`n"
        $integrationCommits = @(& git -C $integrationPath rev-list --reverse "$baseCommit..HEAD")
        $integration = [pscustomobject]@{
          id="$runId-integration"; parentIds=@($tasks | ForEach-Object { "$([string]$_.id)-branch" }); startedAt=(Get-Date).ToString('o')
          branch=$integrationBranch; worktree=$integrationPath; baseCommit=$baseCommit; headCommit=(& git -C $integrationPath rev-parse HEAD).Trim()
          decision=$integrationDecision; approvalRequired=$true; mainModified=$false; cherryPicks=$cherryPicks
          tests=$integrationTests; changedFiles=$diffFiles; diffStat=$diffStat; commits=$integrationCommits
          reviewArtifact=(Join-Path $runRoot 'integration-review.md')
        }
        Write-AtomicJson (Join-Path $runRoot 'integration.json') $integration
        $reviewLines = @(
          "# Integration Review: $runId", '', "- Decision: $integrationDecision", "- Base: $baseCommit",
          "- Branch: $integrationBranch", "- Head: $($integration.headCommit)", '- Main modified: false', '- Approval required: true', '',
          '## Changed files', ''
        ) + @($diffFiles | ForEach-Object { "- $_" }) + @('', '## Diff stat', '', '```text', $diffStat, '```', '', '## Integration tests', '') +
          @($integrationTests | ForEach-Object { "- [$($_.status)] ``$($_.command)`` (exit $($_.exitCode))" })
        [IO.File]::WriteAllText($integration.reviewArtifact, ($reviewLines -join "`n"), [Text.Encoding]::UTF8)
        if ($integrationDecision -ne 'AWAITING_CODEX_REVIEW') { $failed++ }
      }
    }
    Set-ObjectProperty $manifest 'integration' $integration
    Set-ObjectProperty $manifest 'integrationBranch' $integrationBranch
  }

  Sync-LiveWorkers $runRoot
  Update-DashboardUsage -RunRoot $runRoot -DashboardPath $dashboardPath
  $hasEnvError = $false
  if ($integration -and $integration.decision -eq 'ENVIRONMENT_ERROR') {
    $hasEnvError = $true
  }
  foreach ($task in $tasks) {
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
    $rPath = Join-Path $runRoot "results\$safeId-result.json"
    if (Test-Path -LiteralPath $rPath) {
      try {
        $r = Get-Content -Raw -LiteralPath $rPath | ConvertFrom-Json
        if ($r.verification -and $r.verification.decision -eq 'ENVIRONMENT_ERROR') {
          $hasEnvError = $true
        }
      } catch {}
    }
  }
  if ($hasEnvError) {
    Set-ObjectProperty $manifest 'errorCategory' 'environment_error'
    Set-ObjectProperty $manifest 'error' 'ENVIRONMENT_ERROR: Dashboard dependencies absent or invalid and bootstrap failed'
  }
  $manifest.status = if (Test-Path -LiteralPath $cancelPath) { 'cancelled' } elseif ($failed -gt 0) { 'failed' } elseif ($integration -and $integration.decision -eq 'AWAITING_CODEX_REVIEW') { 'awaiting_review' } else { 'completed' }
  $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
  Write-Output "Run: $runId"; Write-Output "State: $runRoot"; Write-Output "Status: $($manifest.status)"
  if ($manifest.status -notin @('completed', 'awaiting_review')) { exit 1 }
} finally {
  if ($runRoot -and (Test-Path -LiteralPath $runRoot)) {
    try { Update-DashboardUsage -RunRoot $runRoot -DashboardPath $dashboardPath } catch {}
  }
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
