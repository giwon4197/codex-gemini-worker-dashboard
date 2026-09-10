[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Request,
  [string]$Repository = (Get-Location).Path,
  [switch]$PlanOnly,
  [Alias('Deliver')][switch]$AutoDeliver
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$schemaPath = Join-Path $root 'router-plan.schema.json'
$orchestrator = Join-Path $root 'run-parallel-workers.ps1'
. $orchestrator -ExportFunctionsOnly
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
3. Every allowed_files / write_scope.expected path must be repository-relative and narrowly scoped. Never allow .git/**, .agent/**, **, or the repository root.
4. Tasks in this executable plan must be independent, so depends_on must be empty. If work has dependencies, combine that chain into one task.
5. Prompts must include objective, allowed scope, acceptance criteria, and instructions to run the listed tests.
6. Choose deterministic existing test/build/lint commands after inspecting package manifests and project configuration.
7. Avoid overlapping allowed_files / write_scope.expected between workers. Shared manifests, lockfiles, schemas, and generated files belong to one task only.
8. Use fast for trivial work, normal for ordinary implementation, advanced for complex implementation, and reasoning only for hard algorithms or deep ambiguity.
9. Keep the plan minimal. Do not invent unrelated improvements.
10. Set retry_limit to at least 2 for implementation tasks: after two failed attempts the orchestrator promotes the next attempt to advanced, and any failure on advanced is escalated to Codex.
"@

& codex.exe exec --sandbox read-only --ephemeral --color never --output-schema $schemaPath --output-last-message $planPath --cd $repoRoot $prompt
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $planPath)) { throw 'Codex 라우터가 계획을 생성하지 못했습니다.' }
$plan = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json

if ($plan.max_workers -lt 1 -or $plan.max_workers -gt 2) { throw 'max_workers는 1 또는 2여야 합니다.' }
$ids = @($plan.tasks | ForEach-Object { $_.id })
if (($ids | Select-Object -Unique).Count -ne $ids.Count) { throw '중복 task id가 있습니다.' }

$allOwnership = @{}
foreach ($task in @($plan.tasks)) {
  if (@($task.depends_on).Count -gt 0) { throw "DEPENDENCY_PLAN_UNSUPPORTED: $($task.id)는 독립 작업으로 재계획해야 합니다." }
  $normPolicy = Normalize-FilesystemPolicy $task
  foreach ($pathValue in @($normPolicy.write_scope.expected)) {
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

$reviewParams = @{
  RunId = $runId
  Repository = $repoRoot
}
if ($PSBoundParameters.ContainsKey('AutoDeliver')) {
  $reviewParams['AutoDeliver'] = $AutoDeliver.IsPresent
}
& (Join-Path $root 'review-integration.ps1') @reviewParams
exit $LASTEXITCODE
