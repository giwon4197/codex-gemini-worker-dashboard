[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Request,
  [string]$Repository = (Get-Location).Path,
  [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$schemaPath = Join-Path $root 'router-plan.schema.json'
$orchestrator = Join-Path $root 'run-parallel-workers.ps1'
$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$repoRoot = $repoRoot.Trim()
if (& git -C $repoRoot status --porcelain) { throw '라우팅 전 main 작업공간을 commit하거나 stash해야 합니다.' }
if (-not (Get-Command codex.exe -ErrorAction SilentlyContinue)) { throw 'Codex CLI를 찾을 수 없습니다.' }

$planId = (Get-Date).ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$plansRoot = Join-Path $repoRoot '.agent\plans'
New-Item -ItemType Directory -Path $plansRoot -Force | Out-Null
$planPath = Join-Path $plansRoot "$planId.json"
$prompt = @"
ROUTER_PLANNING_SUBCALL

You are the read-only control-plane planner for a Codex + Gemini development system.
Inspect the repository at the current working directory and convert the user's request into the required JSON plan.

USER REQUEST:
$Request

Rules:
1. Do not edit files, run the worker router, or implement the request yourself.
2. Classify level 0-3. Use max_workers 2 only when tasks have disjoint file ownership and can execute against the same base commit.
3. Every allowed_files path must be repository-relative and narrowly scoped. Never allow .git/**, .agent/**, **, or the repository root.
4. Tasks in this executable plan must be independent, so depends_on must be empty. If work has dependencies, combine that chain into one task.
5. Prompts must include objective, allowed scope, acceptance criteria, and instructions to run the listed tests.
6. Choose deterministic existing test/build/lint commands after inspecting package manifests and project configuration.
7. Avoid overlapping allowed_files between workers. Shared manifests, lockfiles, schemas, and generated files belong to one task only.
8. Use fast for trivial work, normal for ordinary implementation, advanced for complex implementation, and reasoning only for hard algorithms or deep ambiguity.
9. Keep the plan minimal. Do not invent unrelated improvements.
"@

& codex.exe exec --sandbox read-only --ephemeral --color never --output-schema $schemaPath --output-last-message $planPath --cd $repoRoot $prompt
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $planPath)) { throw 'Codex 라우터가 계획을 생성하지 못했습니다.' }
$plan = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json

if ($plan.max_workers -lt 1 -or $plan.max_workers -gt 2) { throw 'max_workers는 1 또는 2여야 합니다.' }
$ids = @($plan.tasks | ForEach-Object { $_.id })
if (($ids | Select-Object -Unique).Count -ne $ids.Count) { throw '중복 task id가 있습니다.' }
foreach ($task in @($plan.tasks)) {
  if (@($task.depends_on).Count -gt 0) { throw "DEPENDENCY_PLAN_UNSUPPORTED: $($task.id)는 독립 작업으로 재계획해야 합니다." }
  foreach ($pathValue in @($task.allowed_files)) {
    $path = ([string]$pathValue).Replace('\', '/')
    if ([IO.Path]::IsPathRooted($path) -or $path -match '(^|/)\.\.(/|$)' -or $path -match '^(\.git|\.agent)(/|$)' -or $path -in @('*', '**', '**/*', './')) {
      throw "$($task.id): 안전하지 않은 allowed_files 경로: $path"
    }
  }
}

$allOwnership = @{}
foreach ($task in @($plan.tasks)) {
  foreach ($pathValue in @($task.allowed_files)) {
    $key = ([string]$pathValue).Replace('\', '/').ToLowerInvariant()
    if ($allOwnership.ContainsKey($key)) { throw "OWNERSHIP_OVERLAP: $key ($($allOwnership[$key]), $($task.id))" }
    $allOwnership[$key] = $task.id
  }
}

Write-Output "Plan: $planPath"
Write-Output "Level: $($plan.level), Workers: $($plan.max_workers), Tasks: $(@($plan.tasks).Count)"
if ($PlanOnly) { Get-Content -Raw -LiteralPath $planPath; exit 0 }

$runOutput = @(& $orchestrator -TasksFile $planPath -Repository $repoRoot -MaxWorkers ([int]$plan.max_workers))
$runOutput | Write-Output
$runExit = $LASTEXITCODE
$runLine = $runOutput | Where-Object { $_ -match '^Run:\s+' } | Select-Object -Last 1
if (-not $runLine) { exit $(if ($runExit) { $runExit } else { 1 }) }
$runId = ($runLine -replace '^Run:\s+', '').Trim()
$runRoot = Join-Path $repoRoot ".agent\runs\$runId"
$manifest = Get-Content -Raw -LiteralPath (Join-Path $runRoot 'run.json') | ConvertFrom-Json
if ($manifest.status -ne 'awaiting_review') { exit $(if ($runExit) { $runExit } else { 1 }) }

$integrationPath = [string]$manifest.integration.worktree
$reviewPath = Join-Path $runRoot 'codex-review.md'
$reviewPrompt = 'Review only the integration branch diff against the base. Focus on correctness, regressions, security, test gaps, and contract violations. Do not edit files or merge branches. Give concise findings with file paths and severity; say explicitly when there are no blocking findings.'
Push-Location $integrationPath
try {
  & codex.exe exec review --base main --ephemeral --output-last-message $reviewPath $reviewPrompt
  $reviewExit = $LASTEXITCODE
} finally { Pop-Location }

$manifest = Get-Content -Raw -LiteralPath (Join-Path $runRoot 'run.json') | ConvertFrom-Json
$manifest.status = if ($reviewExit -eq 0) { 'awaiting_human_approval' } else { 'codex_review_failed' }
$manifest | Add-Member -NotePropertyName codexReview -NotePropertyValue ([pscustomobject]@{
  status = if ($reviewExit -eq 0) { 'completed' } else { 'failed' }
  artifact = $reviewPath
  reviewedAt = (Get-Date).ToString('o')
  mainModified = $false
}) -Force
$temp = "$($runRoot)\run.json.$([guid]::NewGuid().ToString('N')).tmp"
[IO.File]::WriteAllText($temp, ($manifest | ConvertTo-Json -Depth 16), [Text.Encoding]::UTF8)
[IO.File]::Move($temp, (Join-Path $runRoot 'run.json'), $true)
Write-Output "Codex review: $reviewPath"
Write-Output "Final status: $($manifest.status)"
exit $(if ($reviewExit -eq 0) { 0 } else { 1 })
