[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TasksFile,
  [string]$Repository = (Get-Location).Path,
  [ValidateRange(1, 2)][int]$MaxWorkers = 2,
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
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth 12), [Text.Encoding]::UTF8)
    [IO.File]::Move($temp, $Path, $true)
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Sync-LiveWorkers([string]$RunRoot) {
  $states = @(
    Get-ChildItem -LiteralPath (Join-Path $RunRoot 'workers') -Filter '*.json' -ErrorAction SilentlyContinue |
      ForEach-Object {
        try { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } catch { $null }
      } |
      Where-Object { $_ } |
      Sort-Object startedAt
  )
  Write-AtomicJson -Path (Join-Path $publicData 'live-workers.json') -Data ([pscustomobject]@{
    runId = Split-Path -Leaf $RunRoot
    updatedAt = (Get-Date).ToString('o')
    workers = $states
  })
}

$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$repoRoot = $repoRoot.Trim()
if (& git -C $repoRoot status --porcelain) {
  throw '병렬 실행 전 저장소 변경 사항을 commit하거나 stash해야 합니다.'
}

$tasksPath = (Resolve-Path -LiteralPath $TasksFile).Path
$tasks = @(Get-Content -Raw -LiteralPath $tasksPath | ConvertFrom-Json)
if ($tasks.Count -eq 0) { throw '작업 파일에 task가 없습니다.' }
$ids = @($tasks | ForEach-Object { $_.id })
if (($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or ($ids | Select-Object -Unique).Count -ne $ids.Count) {
  throw '각 task에는 고유한 id가 필요합니다.'
}

$runId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$agentRoot = Join-Path $repoRoot '.agent'
$runRoot = Join-Path $agentRoot "runs\$runId"
$worktreeRoot = Join-Path $agentRoot "worktrees\$runId"
New-Item -ItemType Directory -Path (Join-Path $runRoot 'tasks'), (Join-Path $runRoot 'workers'), (Join-Path $runRoot 'events'), $worktreeRoot -Force | Out-Null

$baseCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
$manifest = [pscustomobject]@{
  runId = $runId
  status = 'preparing'
  createdAt = (Get-Date).ToString('o')
  updatedAt = (Get-Date).ToString('o')
  repository = $repoRoot
  baseCommit = $baseCommit
  maxWorkers = $MaxWorkers
  tasks = @($tasks | ForEach-Object { $_.id })
  worktrees = @()
}
$manifestPath = Join-Path $runRoot 'run.json'
Write-AtomicJson $manifestPath $manifest

$worktrees = @()
$jobs = @()
try {
  foreach ($task in $tasks) {
    $safeId = ([string]$task.id) -replace '[^A-Za-z0-9._-]', '-'
    $branch = "agent/$runId/$safeId"
    $worktree = Join-Path $worktreeRoot $safeId
    & git -C $repoRoot worktree add -b $branch $worktree $baseCommit
    if ($LASTEXITCODE -ne 0) { throw "worktree 생성 실패: $($task.id)" }
    $worktrees += [pscustomobject]@{ id = $task.id; branch = $branch; path = $worktree }
    Write-AtomicJson (Join-Path $runRoot "tasks\$safeId.json") ([pscustomobject]@{
      id = $task.id; name = $task.name; prompt = $task.prompt; tier = $task.tier
      branch = $branch; worktree = $worktree; baseCommit = $baseCommit
    })
  }

  $manifest.status = 'running'; $manifest.updatedAt = (Get-Date).ToString('o'); Write-AtomicJson $manifestPath $manifest
  $pending = [Collections.Queue]::new()
  foreach ($task in $tasks) { $pending.Enqueue($task) }

  while ($pending.Count -gt 0 -or @($jobs | Where-Object State -eq 'Running').Count -gt 0) {
    $running = @($jobs | Where-Object State -eq 'Running').Count
    while ($pending.Count -gt 0 -and $running -lt $MaxWorkers) {
      $task = $pending.Dequeue()
      $wt = $worktrees | Where-Object id -eq $task.id | Select-Object -First 1
      $tier = if ($task.tier) { [string]$task.tier } else { 'normal' }
      $job = Start-Job -Name ([string]$task.id) -ScriptBlock {
        param($Script, $Name, $Prompt, $Tier, $Workspace, $TimeoutValue, $RunIdValue, $TaskIdValue, $StateRootValue)
        & $Script -Task $Name -Prompt $Prompt -Model $Tier -Workspace $Workspace -Timeout $TimeoutValue -OrchestrationRunId $RunIdValue -TaskId $TaskIdValue -StateRoot $StateRootValue
        exit $LASTEXITCODE
      } -ArgumentList $workerScript, ([string]$task.name), ([string]$task.prompt), $tier, $wt.path, $Timeout, $runId, ([string]$task.id), $runRoot
      $jobs += $job
      $running++
    }

    Sync-LiveWorkers $runRoot
    if (@($jobs | Where-Object State -eq 'Running').Count -gt 0) { Start-Sleep -Milliseconds 500 }
  }

  $failed = 0
  foreach ($job in $jobs) {
    Receive-Job -Job $job -Wait | ForEach-Object { "[$($job.Name)] $_" }
    if ($job.State -ne 'Completed') { $failed++ }
  }
  Sync-LiveWorkers $runRoot
  $states = @(Get-ChildItem (Join-Path $runRoot 'workers') -Filter '*.json' | ForEach-Object { Get-Content -Raw $_.FullName | ConvertFrom-Json })
  $failed += @($states | Where-Object status -ne 'completed').Count
  $manifest.status = if ($failed -eq 0 -and $states.Count -eq $tasks.Count) { 'completed' } else { 'failed' }
  $manifest.updatedAt = (Get-Date).ToString('o')
  $manifest.worktrees = $worktrees
  Write-AtomicJson $manifestPath $manifest
  Write-Output "Run: $runId"
  Write-Output "State: $runRoot"
  if ($manifest.status -ne 'completed') { exit 1 }
} finally {
  $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
  if ($CleanupWorktrees) {
    foreach ($wt in $worktrees) {
      & git -C $repoRoot worktree remove $wt.path --force 2>$null
    }
    & git -C $repoRoot worktree prune
  }
}
