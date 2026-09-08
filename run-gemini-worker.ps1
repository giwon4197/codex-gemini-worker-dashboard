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
  [ValidateRange(1, 4)][int]$Attempt = 1
)

$antigravity = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
if (-not (Test-Path -LiteralPath $antigravity)) {
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

$isParallelWorker = -not [string]::IsNullOrWhiteSpace($StateRoot)
$workerKey = if ($TaskId) { $TaskId } else { [System.Guid]::NewGuid().ToString('N') }
$dashboardPath = Join-Path $PSScriptRoot 'gemini-dashboard\public\data\dashboard.json'
$liveWorkerPath = if ($isParallelWorker) {
  $workersDir = Join-Path $StateRoot 'workers'
  New-Item -ItemType Directory -Path $workersDir -Force | Out-Null
  Join-Path $workersDir "$workerKey.json"
} else {
  Join-Path $PSScriptRoot 'gemini-dashboard\public\data\live-worker.json'
}
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

function Add-WorkerLog {
  param(
    [string]$Message,
    [string]$Type = 'info'
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
    $eventRecord = [pscustomobject]@{
      timestamp = (Get-Date).ToString('o')
      runId = if ($OrchestrationRunId) { $OrchestrationRunId } else { $workerRunId }
      taskId = $workerKey
      type = $Type
      message = $clean
    }
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
    }
    finalResponse  = if ($FinalResp) { Redact-Secrets -Text $FinalResp } else { $null }
    error          = if ($Err) { Redact-Secrets -Text $Err } else { $null }
  }

  Write-AtomicJson -Path $liveWorkerPath -Data $liveObj
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
  $runner.Start($antigravity, [string[]]$cliArgs, $Workspace)
  $agentProcessId = $runner.Process.Id
  Sync-LiveWorker -Status 'running'

  while (-not $runner.Process.HasExited -or -not $runner.Lines.IsEmpty) {
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
              $toolName = if ($su.tool_call.name) { $su.tool_call.name } else { "도구" }
              Add-WorkerLog -Message "도구 호출: $toolName" -Type 'tool'
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

    Start-Sleep -Milliseconds 80
  }

  $runner.Process.WaitForExit()
  $exitCode = $runner.Process.ExitCode
} catch {
  $exitCode = 1
  $errorMessage = $_.Exception.Message
  Add-WorkerLog -Message "워커 프로세스 예외: $errorMessage" -Type 'error'
} finally {
  if ($runner -and $runner.Process -and -not $runner.Process.HasExited) {
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

Add-WorkerLog -Message "작업 종료: 상태=$finalStatus, 소요시간=${elapsed}초, 종료코드=$exitCode" -Type $(if ($isSuccess) { 'system' } else { 'error' })

# 1. Update live-worker.json with final state
Sync-LiveWorker -Status $finalStatus -FinalResp $parsedResponse -Err $errorMessage

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

# 2. EXACTLY ONCE update to dashboard.json
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
    updatedAt = (Get-Date).ToString('o')
    summary   = [pscustomobject]@{
      tokens           = 0
      requests         = 0
      completed        = 0
      failed           = 0
      averageLatencyMs = 0
    }
    tokens    = [pscustomobject]@{
      prompt     = 0
      candidates = 0
      cached     = 0
      thoughts   = 0
    }
    jobs      = @()
  }
}

$completedCount = if ($isSuccess) { 1 } else { 0 }
$failedCount = if ($isSuccess) { 0 } else { 1 }

$prevRequests = [int64]$data.summary.requests
$totalRequests = $prevRequests + $requests
$totalLatency = ([int64]$data.summary.averageLatencyMs * $prevRequests) + $latency

$data.updatedAt = (Get-Date).ToString('o')
# summary.tokens: 캐시 제외 실질 토큰(total_tokens) 분리 누적
$data.summary.tokens = [int64]$data.summary.tokens + $runTokens
$data.summary.requests = $totalRequests
$data.summary.completed = [int64]$data.summary.completed + $completedCount
$data.summary.failed = [int64]$data.summary.failed + $failedCount
$data.summary.averageLatencyMs = if ($totalRequests -gt 0) { [math]::Round($totalLatency / $totalRequests) } else { 0 }

$data.tokens.prompt = [int64]$data.tokens.prompt + $promptTokens
$data.tokens.candidates = [int64]$data.tokens.candidates + $candidateTokens
# tokens.cached: 캐시 토큰(cache_read_tokens) 별도 분리 누적
$data.tokens.cached = [int64]$data.tokens.cached + $cachedTokens
$data.tokens.thoughts = [int64]$data.tokens.thoughts + $thoughtTokens

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

$job = [pscustomobject]@{
  name      = $Task
  model     = $jobModel
  status    = $jobStatus
  tokens    = $runTokens.ToString('N0')
  duration  = "${elapsed}초"
  time      = (Get-Date).ToString('tt h:mm')
  timestamp = (Get-Date).ToString('o')
  snippet   = $snippet
  stats     = $jobStats
}

$data.jobs = @($job) + @($data.jobs) | Select-Object -First 50
Write-AtomicJson -Path $dashboardPath -Data $data

if ($parsedResponse) {
  $parsedResponse
} elseif ($errorMessage) {
  Write-Error $errorMessage
}

exit $exitCode
