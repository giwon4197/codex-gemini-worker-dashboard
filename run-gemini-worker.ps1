param(
  [Parameter(Mandatory = $true)][string]$Task,
  [Parameter(Mandatory = $true)][string]$Prompt,
  [ValidateSet('plan', 'auto_edit')][string]$ApprovalMode = 'auto_edit',
  [string]$Model = '',
  [string]$Workspace = $PSScriptRoot,
  [string]$Timeout = '24h',
  [string]$OrchestrationRunId = '',
  [string]$TaskId = '',
  [string]$StateRoot = '',
  [string]$BaseCommit = '',
  [ValidateRange(1, 4)][int]$Attempt = 1,
  [string]$DashboardPath = '',
  [string]$DataDir = '',
  [string[]]$MockOutputLines = @(),
  [string]$MockOutputJson = '',
  [int]$MockExitCode = 0
)

$isMockRun = ($MockOutputLines -and $MockOutputLines.Count -gt 0) -or (-not [string]::IsNullOrWhiteSpace($MockOutputJson))
$antigravity = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (-not $isMockRun -and -not (Test-Path -LiteralPath $antigravity)) {
  throw 'Antigravity CLI를 찾을 수 없습니다.'
}

# 4-tier model mapping
$TierMap = @{
  'fast'      = 'gemini-3.8-flash-low'
  'normal'    = 'gemini-3.8-flash-medium'
  'advanced'  = 'gemini-3.8-flash-high'
  'reasoning' = 'gemini-3.1-pro-high'
}
$DefaultTier = 'normal'
$DefaultModel = $TierMap[$DefaultTier]
$settingsPath = Join-Path $PSScriptRoot 'worker-settings.json'

# Determine target model from parameter or settings file
$targetModel = ""

if ($Model) {
  if ($TierMap.ContainsKey($Model.ToLower())) {
    $targetModel = $TierMap[$Model.ToLower()]
  } else {
    $targetModel = $Model
  }
} else {
  $needRecover = $false
  if (Test-Path -LiteralPath $settingsPath) {
    try {
      $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
      if ($settings -and $settings.tier -and $TierMap.ContainsKey($settings.tier.ToString().ToLower())) {
        $targetModel = $TierMap[$settings.tier.ToString().ToLower()]
      } elseif ($settings -and $settings.model -and ($TierMap.Values -contains $settings.model.ToString())) {
        $targetModel = $settings.model.ToString()
      } else {
        $needRecover = $true
      }
    } catch {
      $needRecover = $true
    }
  } else {
    $needRecover = $true
  }

  if ($needRecover) {
    $targetModel = $DefaultModel
    try {
      $recovered = [pscustomobject]@{
        tier = $DefaultTier
        model = $DefaultModel
        updatedAt = (Get-Date).ToString('o')
      }
      $recovered | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $settingsPath -Encoding utf8
    } catch {
      # Ignore file write errors if workspace is read-only
    }
  }
}

if (-not $targetModel) {
  $targetModel = $DefaultModel
}

# Ensure AgyProcessRunner helper type exists for robust line streaming and zero pipe-deadlock
if (-not ([System.Management.Automation.PSTypeName]'AgyProcessRunner').Type) {
  Add-Type -TypeDefinition @"
  using System;
  using System.Collections.Concurrent;
  using System.Collections.Generic;
  using System.Diagnostics;
  using System.Text;

  public class AgyProcessRunner {
      public ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
      public Process Process;

      public void Start(string fileName, IEnumerable<string> arguments, string workingDir) {
          Process = new Process();
          Process.StartInfo.FileName = fileName;
          if (arguments != null) {
              foreach (var arg in arguments) {
                  Process.StartInfo.ArgumentList.Add(arg);
              }
          }
          if (!string.IsNullOrEmpty(workingDir)) {
              Process.StartInfo.WorkingDirectory = workingDir;
          }
          Process.StartInfo.UseShellExecute = false;
          Process.StartInfo.RedirectStandardOutput = true;
          Process.StartInfo.RedirectStandardError = true;
          Process.StartInfo.StandardOutputEncoding = Encoding.UTF8;
          Process.StartInfo.StandardErrorEncoding = Encoding.UTF8;
          Process.StartInfo.CreateNoWindow = true;

          Process.OutputDataReceived += (s, e) => {
              if (e.Data != null) Lines.Enqueue(e.Data);
          };
          Process.ErrorDataReceived += (s, e) => {
              if (e.Data != null) Lines.Enqueue("[STDERR] " + e.Data);
          };

          Process.Start();
          Process.BeginOutputReadLine();
          Process.BeginErrorReadLine();
      }

      public void Kill() {
          try {
              if (Process != null && !Process.HasExited) {
                  Process.Kill(true);
              }
          } catch {}
      }
  }
"@
}

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

$resolvedDashboard = Resolve-SharedDashboardPaths -ExplicitDataDir $DataDir -ExplicitDashboardPath $DashboardPath -RepoPath $Workspace
$dashboardPath = $resolvedDashboard.DashboardPath
$dataDir = $resolvedDashboard.DataDir

$isParallelWorker = -not [string]::IsNullOrWhiteSpace($StateRoot)
$workerKey = if ($TaskId) { $TaskId } else { [System.Guid]::NewGuid().ToString('N') }
$liveWorkerPath = if ($isParallelWorker) {
  $workersDir = Join-Path $StateRoot 'workers'
  New-Item -ItemType Directory -Path $workersDir -Force | Out-Null
  Join-Path $workersDir "$workerKey.json"
} else {
  Join-Path $dataDir 'live-worker.json'
}
$attemptStatePath = if ($isParallelWorker) {
  $attemptsDir = Join-Path $StateRoot 'attempts'
  New-Item -ItemType Directory -Path $attemptsDir -Force | Out-Null
  Join-Path $attemptsDir "$workerKey.attempt-$Attempt.json"
} else { $null }
$liveWorkerRootPath = if ($isParallelWorker) { $null } else { Join-Path $PSScriptRoot 'live-worker.json' }
$eventPath = if ($isParallelWorker) {
  $eventsDir = Join-Path $StateRoot 'events'
  New-Item -ItemType Directory -Path $eventsDir -Force | Out-Null
  Join-Path $eventsDir "$workerKey.ndjson"
} else { $null }
$runnerProcessId = $PID
$agentProcessId = $null

function Write-AtomicJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Data
  )
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $tempPath = "$Path.$([System.Guid]::NewGuid().ToString('N')).tmp"
  try {
    $json = $Data | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($tempPath, $json, [System.Text.Encoding]::UTF8)
    [System.IO.File]::Move($tempPath, $Path, $true)
  } catch {
    try {
      [System.IO.File]::Copy($tempPath, $Path, $true)
      [System.IO.File]::Delete($tempPath)
    } catch {}
  } finally {
    if (Test-Path -LiteralPath $tempPath) {
      try { [System.IO.File]::Delete($tempPath) } catch {}
    }
  }
}

function Redact-Secrets {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return "" }
  $redacted = $Text -replace '(?i)(bearer\s+)[a-zA-Z0-9_\-\.]{10,}', '$1[REDACTED]'
  $redacted = $redacted -replace 'AIza[0-9A-Za-z-_]{35}', '[REDACTED_API_KEY]'
  $redacted = $redacted -replace 'sk-[a-zA-Z0-9]{20,}', '[REDACTED_SECRET]'
  $redacted = $redacted -replace '(?i)(key|token|secret|password|auth)=([a-zA-Z0-9_\-\.]{8,})', '$1=[REDACTED]'
  return $redacted
}

$workerRunId = [System.Guid]::NewGuid().ToString('d')
$started = Get-Date
$startedIso = $started.ToString('o')
$currentStatus = 'running'
$recentLogs = [System.Collections.Generic.List[object]]::new()
$maxLogEntries = 50

$promptTokens = 0
$candidateTokens = 0
$cachedTokens = 0
$thoughtTokens = 0
$totalTokens = 0
$requests = 0
$latency = 0
$modelNames = [System.Collections.Generic.List[string]]::new()
$modelNames.Add($targetModel)

$parsedResponse = ""
$finalResponse = ""
$errorMessage = ""
$rawLines = [System.Collections.Generic.List[string]]::new()
$eventSequence = 0
$lastEventId = "$workerKey-branch"

function Add-WorkerLog {
  param(
    [string]$Message,
    [string]$Type = 'info',
    [string]$Activity = '',
    [string]$File = '',
    [string]$Command = '',
    [string]$ParentId = ''
  )
  if ([string]::IsNullOrWhiteSpace($Message)) { return }
  $clean = Redact-Secrets -Text $Message
  if ($clean.Length -gt 600) {
    $clean = $clean.Substring(0, 580) + "... (생략)"
  }
  $entry = [pscustomobject]@{
    timestamp = (Get-Date).ToString('HH:mm:ss')
    message   = $clean
    type      = $Type
  }
  $recentLogs.Add($entry)
  if ($eventPath) {
    $script:eventSequence++
    $currEventId = "$workerKey-evt-$($script:eventSequence)"
    $effectiveParent = if ($ParentId) {
      $ParentId
    } elseif ($script:lastEventId) {
      $script:lastEventId
    } else {
      "$workerKey-branch"
    }
    $script:lastEventId = $currEventId

    $eventRecord = [ordered]@{
      id        = $currEventId
      parentId  = $effectiveParent
      timestamp = (Get-Date).ToString('o')
      runId     = if ($OrchestrationRunId) { $OrchestrationRunId } else { $workerRunId }
      taskId    = $workerKey
      attempt   = $Attempt
      type      = $Type
      message   = $clean
    }
    if ($Activity) { $eventRecord['activity'] = $Activity }
    if ($File)     { $eventRecord['file'] = $File }
    if ($Command)  { $eventRecord['command'] = $Command }

    Add-Content -LiteralPath $eventPath -Value ($eventRecord | ConvertTo-Json -Compress) -Encoding utf8
  }
  while ($recentLogs.Count -gt $maxLogEntries) {
    $recentLogs.RemoveAt(0)
  }
}

function Sync-LiveWorker {
  param(
    [string]$Status = $currentStatus,
    [string]$FinalResp = $finalResponse,
    [string]$Err = $errorMessage
  )
  $now = Get-Date
  $elapsed = [math]::Round(($now - $started).TotalSeconds, 2)
  $calcTotal = if ($totalTokens -gt 0) {
    $totalTokens
  } else {
    $promptTokens + $candidateTokens + $thoughtTokens
  }

  $effectiveRequests = if ($requests -gt 0) { [int64]$requests } else { 1 }
  $effectiveLatency = if ($latency -gt 0) { [int64]$latency } else { [math]::Round($elapsed * 1000) }

  $liveObj = [pscustomobject]@{
    runId          = if ($OrchestrationRunId) { $OrchestrationRunId } else { $workerRunId }
    taskId         = $workerKey
    attempt        = $Attempt
    baseCommit     = if ($BaseCommit) { $BaseCommit } else { $null }
    runnerProcessId = $runnerProcessId
    agentProcessId = $agentProcessId
    task           = $Task
    model          = if ($modelNames.Count -gt 0) { ($modelNames | Select-Object -Unique) -join ', ' } else { $targetModel }
    status         = $Status
    startedAt      = $startedIso
    updatedAt      = $now.ToString('o')
    elapsedSeconds = $elapsed
    recentLogs     = @($recentLogs)
    partialUsage   = [pscustomobject]@{
      prompt     = [int64]$promptTokens
      candidates = [int64]$candidateTokens
      cached     = [int64]$cachedTokens
      thoughts   = [int64]$thoughtTokens
      total      = [int64]$calcTotal
      requests   = [int64]$effectiveRequests
      latencyMs  = [int64]$effectiveLatency
    }
    finalResponse  = if ($FinalResp) { Redact-Secrets -Text $FinalResp } else { $null }
    error          = if ($Err) { Redact-Secrets -Text $Err } else { $null }
  }

  Write-AtomicJson -Path $liveWorkerPath -Data $liveObj
  if ($attemptStatePath) {
    try { Write-AtomicJson -Path $attemptStatePath -Data $liveObj } catch {}
  }
  try {
    if (-not $liveWorkerRootPath) { return }
    Write-AtomicJson -Path $liveWorkerRootPath -Data $liveObj
  } catch {}
}

# 1. Immediately record running status and initial log
Add-WorkerLog -Message "워커 초기화: 작업 '$Task' (모델: $targetModel, 시도: $Attempt)" -Type 'system'
Sync-LiveWorker -Status 'running'

$agentMode = if ($ApprovalMode -eq 'plan') { 'plan' } else { 'accept-edits' }
$cliArgs = @(
  '--new-project',
  '--model', $targetModel,
  '--mode', $agentMode,
  '--dangerously-skip-permissions',
  '--print-timeout', $Timeout,
  '--output-format', 'stream-json',
  '--print', $Prompt
)

$runner = [AgyProcessRunner]::new()
$exitCode = 0
$lastHeartbeat = [System.Diagnostics.Stopwatch]::StartNew()

try {
  if ($isMockRun) {
    $linesToFeed = if ($MockOutputLines -and $MockOutputLines.Count -gt 0) {
      @($MockOutputLines)
    } else {
      @($MockOutputJson -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    foreach ($mLine in $linesToFeed) {
      $runner.Lines.Enqueue($mLine)
    }
    $exitCode = $MockExitCode
  } else {
    $runner.Start($antigravity, [string[]]$cliArgs, $Workspace)
    $agentProcessId = $runner.Process.Id
  }
  Sync-LiveWorker -Status 'running'

  while (($isMockRun -and -not $runner.Lines.IsEmpty) -or (-not $isMockRun -and (-not $runner.Process.HasExited -or -not $runner.Lines.IsEmpty))) {
    $hasData = $false
    $line = ""
    while ($runner.Lines.TryDequeue([ref]$line)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $hasData = $true
      $rawLines.Add($line)

      if ($line.StartsWith("[STDERR]")) {
        $errText = $line.Substring(8).Trim()
        Add-WorkerLog -Message $errText -Type 'stderr'
        continue
      }

      $eventObj = $null
      if ($line.StartsWith("{") -and $line.EndsWith("}")) {
        try {
          $eventObj = $line | ConvertFrom-Json
        } catch {
          Add-WorkerLog -Message $line -Type 'raw'
        }
      } else {
        Add-WorkerLog -Message $line -Type 'raw'
      }

      if ($eventObj) {
        if ($eventObj.event -eq 'init') {
          if ($eventObj.init -and $eventObj.init.model) {
            $actualModel = [string]$eventObj.init.model
            if (-not $modelNames.Contains($actualModel)) {
              $modelNames.Add($actualModel)
            }
            Add-WorkerLog -Message "세션 시작됨 (모델: $actualModel)" -Type 'init'
          } else {
            Add-WorkerLog -Message "세션 시작됨" -Type 'init'
          }
        } elseif ($eventObj.event -eq 'step_update') {
          $su = $eventObj.step_update
          if ($su) {
            if ($su.usage) {
              if ($su.usage.input_tokens) { $promptTokens = [int64]$su.usage.input_tokens }
              if ($su.usage.output_tokens) { $candidateTokens = [int64]$su.usage.output_tokens }
              if ($su.usage.thinking_tokens) { $thoughtTokens = [int64]$su.usage.thinking_tokens }
              if ($su.usage.cache_read_tokens) { $cachedTokens = [int64]$su.usage.cache_read_tokens }
              if ($su.usage.total_tokens) { $totalTokens = [int64]$su.usage.total_tokens }
            }
            $stepType = if ($su.step_type) { $su.step_type } else { "step" }
            $stepState = if ($su.state) { $su.state } else { "" }

            if ($su.text_delta) {
              $parsedResponse += $su.text_delta
              $deltaSnippet = $su.text_delta.Trim()
              if ($deltaSnippet.Length -gt 150) {
                $deltaSnippet = $deltaSnippet.Substring(0, 140) + "..."
              }
              if ($deltaSnippet) {
                Add-WorkerLog -Message "생성: $deltaSnippet" -Type 'stream'
              }
            } elseif ($su.tool_call) {
              $toolName = if ($su.tool_call.name) { [string]$su.tool_call.name } else { "도구" }
              $toolArgs = $su.tool_call.args
              $act = ''
              $targetFile = ''
              $cmdStr = ''

              if ($toolName -in @('view_file', 'read_file', 'read_url_content')) {
                $act = 'LOAD'
                if ($toolArgs) {
                  $targetFile = if ($toolArgs.AbsolutePath) { [string]$toolArgs.AbsolutePath } elseif ($toolArgs.TargetFile) { [string]$toolArgs.TargetFile } elseif ($toolArgs.Url) { [string]$toolArgs.Url } else { '' }
                }
              } elseif ($toolName -in @('grep_search', 'find_by_name', 'search_web')) {
                $act = 'SEARCH'
                if ($toolArgs) {
                  $targetFile = if ($toolArgs.SearchPath) { [string]$toolArgs.SearchPath } elseif ($toolArgs.SearchDirectory) { [string]$toolArgs.SearchDirectory } else { '' }
                }
              } elseif ($toolName -in @('replace_file_content', 'edit_file')) {
                $act = 'EDIT'
                if ($toolArgs) {
                  $targetFile = if ($toolArgs.TargetFile) { [string]$toolArgs.TargetFile } else { '' }
                }
              } elseif ($toolName -in @('write_to_file', 'save_file')) {
                $act = 'SAVE'
                if ($toolArgs) {
                  $targetFile = if ($toolArgs.TargetFile) { [string]$toolArgs.TargetFile } else { '' }
                }
              } elseif ($toolName -in @('run_command', 'execute_command')) {
                $act = 'RUN'
                if ($toolArgs) {
                  $cmdStr = if ($toolArgs.CommandLine) { [string]$toolArgs.CommandLine } else { '' }
                }
              }

              Add-WorkerLog -Message "도구 호출: $toolName" -Type 'tool' -Activity $act -File $targetFile -Command $cmdStr
            } elseif ($stepType -eq 'user_input') {
              Add-WorkerLog -Message "사용자 입력 처리 완료" -Type 'step'
            } else {
              Add-WorkerLog -Message "단계: $stepType ($stepState)" -Type 'step'
            }
          }
        } elseif ($eventObj.event -eq 'result') {
          $res = $eventObj.result
          if ($res) {
            if ($res.response) {
              $parsedResponse = [string]$res.response
            }
            if ($res.usage) {
              if ($res.usage.input_tokens) { $promptTokens = [int64]$res.usage.input_tokens }
              if ($res.usage.output_tokens) { $candidateTokens = [int64]$res.usage.output_tokens }
              if ($res.usage.thinking_tokens) { $thoughtTokens = [int64]$res.usage.thinking_tokens }
              if ($res.usage.cache_read_tokens) { $cachedTokens = [int64]$res.usage.cache_read_tokens }
              if ($res.usage.total_tokens) { $totalTokens = [int64]$res.usage.total_tokens }
            }
            if ($res.num_turns) { $requests = [int64]$res.num_turns }
            if ($res.duration_seconds) { $latency = [math]::Round([double]$res.duration_seconds * 1000) }
            $resStatus = if ($res.status) { $res.status } else { "SUCCESS" }
            Add-WorkerLog -Message "결과 수신 (상태: $resStatus)" -Type 'result'
          }
        } elseif ($eventObj.event -eq 'error') {
          $errDetail = if ($eventObj.error -and $eventObj.error.message) { $eventObj.error.message } else { "오류 발생" }
          $errorMessage = $errDetail
          Add-WorkerLog -Message "에러: $errDetail" -Type 'error'
        } else {
          Add-WorkerLog -Message "이벤트: $($eventObj.event)" -Type 'info'
        }
      }
    }

    # Heartbeat: persist live-worker.json every <= 1s or on data
    if ($hasData -or $lastHeartbeat.ElapsedMilliseconds -ge 1000) {
      Sync-LiveWorker -Status 'running'
      $lastHeartbeat.Restart()
    }

    if (-not $isMockRun) {
      Start-Sleep -Milliseconds 80
    }
  }

  if (-not $isMockRun -and $runner.Process) {
    $runner.Process.WaitForExit()
    $exitCode = $runner.Process.ExitCode
  }
} catch {
  $exitCode = 1
  $errorMessage = $_.Exception.Message
  Add-WorkerLog -Message "워커 프로세스 예외: $errorMessage" -Type 'error'
} finally {
  if (-not $isMockRun -and $runner -and $runner.Process -and -not $runner.Process.HasExited) {
    try { $runner.Process.Kill($true) } catch {}
  }
}

$elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
if ($latency -le 0) {
  $latency = [math]::Round($elapsed * 1000)
}
if ($requests -le 0) {
  $requests = 1
}

# [토큰 분리 누적 원칙]
# Antigravity/Gemini usage.total_tokens는 캐시 제외 실질 토큰(input_tokens + output_tokens)입니다.
# usage.cache_read_tokens는 별도의 캐시 누적 토큰입니다.
# wrapper는 앞으로도 summary.tokens에 실질 total_tokens를, tokens.cached에 cache_read_tokens를 계속 분리 누적합니다.
# (캐시 포함 전체 처리량 = summary.tokens + tokens.cached)
$runTokens = if ($totalTokens -gt 0) {
  $totalTokens
} else {
  $promptTokens + $candidateTokens + $thoughtTokens
}

# Determine job outcome status
$isSuccess = ($exitCode -eq 0) -and [string]::IsNullOrEmpty($errorMessage) -and ($parsedResponse.Trim().Length -gt 0)
$finalStatus = if ($isSuccess) { 'completed' } else { 'failed' }

if (-not $isSuccess -and [string]::IsNullOrEmpty($errorMessage)) {
  $errorMessage = if ($rawLines.Count -gt 0) {
    $rawLines[-1]
  } else {
    "프로세스가 비정상 종료되었습니다 (ExitCode: $exitCode)"
  }
}

$outcomeAct = if ($isSuccess) { 'DONE' } else { 'FAIL' }
Add-WorkerLog -Message "작업 종료: 상태=$finalStatus, 소요시간=${elapsed}초, 종료코드=$exitCode" -Type $(if ($isSuccess) { 'system' } else { 'error' }) -Activity $outcomeAct

# 1. Update live-worker.json with final state
Sync-LiveWorker -Status $finalStatus -FinalResp $parsedResponse -Err $errorMessage

if ($eventPath) {
  $usageRecord = [pscustomobject]@{
    timestamp = (Get-Date).ToString('o')
    runId     = if ($OrchestrationRunId) { $OrchestrationRunId } else { $workerRunId }
    taskId    = $workerKey
    attempt   = $Attempt
    type      = 'confirmed_usage'
    status    = $finalStatus
    usage     = [pscustomobject]@{
      prompt     = [int64]$promptTokens
      candidates = [int64]$candidateTokens
      cached     = [int64]$cachedTokens
      thoughts   = [int64]$thoughtTokens
      total      = [int64]$runTokens
      requests   = [int64]$requests
      latencyMs  = [int64]$latency
    }
  }
  Add-Content -LiteralPath $eventPath -Value ($usageRecord | ConvertTo-Json -Compress) -Encoding utf8
}

# Parallel workers own only their state/event files. The orchestrator is the
# single writer for shared dashboard data, preventing lost read-modify-write updates.
if ($isParallelWorker) {
  if ($parsedResponse) {
    $parsedResponse
  } elseif ($errorMessage) {
    Write-Error $errorMessage
  }
  exit $exitCode
}

# 2. EXACTLY ONCE update to dashboard.json enclosed by deterministic cross-process lock
$normDashPath = [System.IO.Path]::GetFullPath($dashboardPath).ToLowerInvariant()
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
  if (Test-Path -LiteralPath $dashboardPath) {
    try {
      $data = Get-Content -Raw -LiteralPath $dashboardPath | ConvertFrom-Json
    } catch {
      $data = $null
    }
  }

  # Fallback/Initial layout if dashboard data is missing or corrupt
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

  $effectiveRunId = if ($OrchestrationRunId) { $OrchestrationRunId } else { $workerRunId }
  $effectiveTaskId = $workerKey
  $attemptNum = if ($Attempt) { [int]$Attempt } else { 1 }

  $usageKey = "$effectiveRunId+$effectiveTaskId+$attemptNum"
  $colonUsageKey = "$($effectiveRunId):$($effectiveTaskId):$attemptNum"
  $taskKey = "$effectiveRunId+$effectiveTaskId"
  $colonTaskKey = "$($effectiveRunId):$($effectiveTaskId)"

  $existingKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($k in @($data.processedKeys)) {
    if (-not [string]::IsNullOrWhiteSpace($k)) {
      [void]$existingKeys.Add([string]$k)
    }
  }

  # Check if usage already processed
  $usageAlreadyProcessed = $existingKeys.Contains($usageKey) -or $existingKeys.Contains($colonUsageKey)
  if (-not $usageAlreadyProcessed -and ($existingKeys.Contains($taskKey) -or $existingKeys.Contains($colonTaskKey))) {
    $hasAttemptKey = $false
    foreach ($k in $existingKeys) {
      if ($k.StartsWith("$taskKey+") -or $k.StartsWith($colonTaskKey + ':')) {
        $hasAttemptKey = $true
        break
      }
    }
    if (-not $hasAttemptKey) {
      $usageAlreadyProcessed = $true
    }
  }

  if (-not $usageAlreadyProcessed) {
    $prevRequests = [int64]$data.summary.requests
    $totalRequests = $prevRequests + $requests
    $totalLatency = ([int64]$data.summary.averageLatencyMs * $prevRequests) + $latency

    $data.summary.tokens = [int64]$data.summary.tokens + $runTokens
    $data.summary.requests = $totalRequests
    $data.summary.averageLatencyMs = if ($totalRequests -gt 0) { [math]::Round($totalLatency / $totalRequests) } else { 0 }

    $data.tokens.prompt = [int64]$data.tokens.prompt + $promptTokens
    $data.tokens.candidates = [int64]$data.tokens.candidates + $candidateTokens
    $data.tokens.cached = [int64]$data.tokens.cached + $cachedTokens
    $data.tokens.thoughts = [int64]$data.tokens.thoughts + $thoughtTokens
  }

  # Logical task count deduplication (counted only once per runId+taskId)
  $targetLogicalStatus = if ($isSuccess) { 'completed' } else { 'failed' }
  $prevCountStatus = $null
  if ($data.processedTasks.PSObject.Properties.Name -contains $taskKey) {
    $prevCountStatus = [string]$data.processedTasks.$taskKey
  } elseif ($existingKeys.Contains($taskKey) -or $existingKeys.Contains($colonTaskKey)) {
    $hasAttemptKey = $false
    foreach ($k in $existingKeys) {
      if ($k.StartsWith("$taskKey+") -or $k.StartsWith($colonTaskKey + ':')) {
        $hasAttemptKey = $true
        break
      }
    }
    if (-not $hasAttemptKey) {
      $prevCountStatus = 'legacy_counted'
      $data.processedTasks | Add-Member -NotePropertyName $taskKey -NotePropertyValue 'legacy_counted' -Force
    }
  }

  if (-not $prevCountStatus) {
    if ($targetLogicalStatus -eq 'completed') {
      $data.summary.completed = [int64]$data.summary.completed + 1
    } else {
      $data.summary.failed = [int64]$data.summary.failed + 1
    }
    $data.processedTasks | Add-Member -NotePropertyName $taskKey -NotePropertyValue $targetLogicalStatus -Force
  } elseif ($prevCountStatus -eq 'failed' -and $targetLogicalStatus -eq 'completed') {
    $data.summary.failed = [math]::Max(0, [int64]$data.summary.failed - 1)
    $data.summary.completed = [int64]$data.summary.completed + 1
    $data.processedTasks.$taskKey = 'completed'
  }

  # Prepare detailed Job Object
  $jobModel = if ($modelNames.Count -gt 0) { ($modelNames | Select-Object -Unique) -join ', ' } else { $targetModel }
  $jobStatus = if ($isSuccess) { '완료' } else { '실패' }

  $jobStats = [pscustomobject]@{
    prompt     = $promptTokens
    candidates = $candidateTokens
    cached     = $cachedTokens
    thoughts   = $thoughtTokens
    requests   = $requests
    latency    = $latency
  }

  $snippet = ""
  if ($isSuccess) {
    $snippet = $parsedResponse
    if ($snippet.Length -gt 800) {
      $snippet = $snippet.Substring(0, 770) + "..."
    }
  } else {
    if ($errorMessage) {
      $snippet = "에러: $errorMessage"
    } else {
      $snippet = "알 수 없는 오류 (Exit Code: $exitCode)"
    }
  }

  $existingJob = $null
  foreach ($j in @($data.jobs)) {
    if ($j.PSObject.Properties.Name -contains 'runId' -and $j.PSObject.Properties.Name -contains 'taskId') {
      if ($j.runId -eq $effectiveRunId -and $j.taskId -eq $effectiveTaskId) {
        $existingJob = $j
        break
      }
    }
  }

  if ($existingJob) {
    $existingJob.status = $jobStatus
    $existingJob.tokens = $runTokens.ToString('N0')
    $existingJob.duration = "${elapsed}초"
    $existingJob.snippet = $snippet
    $existingJob.stats = $jobStats
  } else {
    $job = [pscustomobject]@{
      name      = $Task
      model     = $jobModel
      status    = $jobStatus
      tokens    = $runTokens.ToString('N0')
      duration  = "${elapsed}초"
      time      = (Get-Date).ToString('tt h:mm')
      timestamp = (Get-Date).ToString('o')
      snippet   = $snippet
      runId     = $effectiveRunId
      taskId    = $effectiveTaskId
      stats     = $jobStats
    }
    $data.jobs = @($job) + @($data.jobs) | Select-Object -First 50
  }

  $data.updatedAt = (Get-Date).ToString('o')
  $data.processedKeys = @($data.processedKeys) + @($usageKey, $taskKey) | Select-Object -Unique
  Write-AtomicJson -Path $dashboardPath -Data $data
} finally {
  if ($hasLock) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  if ($mutex) {
    $mutex.Dispose()
  }
}

if ($parsedResponse) {
  $parsedResponse
} elseif ($errorMessage) {
  Write-Error $errorMessage
}

exit $exitCode
