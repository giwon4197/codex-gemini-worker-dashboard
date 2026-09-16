[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'test-common.ps1') -AssertDetailLabel 'Detail'
. (Join-Path $PSScriptRoot 'bounded-process-runner.ps1')
$passCount = 0
$failCount = 0
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('native-runtime-' + [guid]::NewGuid().ToString('N'))
$fixtureRepo = Join-Path $fixtureRoot '한글 문서 저장소'
$treeProcess = $null
$recordedIds = @()

function Start-Probe([string]$Script, [string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [Text.Encoding]::UTF8
  foreach ($argument in @('-NoProfile', '-File', $Script) + $Arguments) { $info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(45000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "Probe timed out: $Script"
  }
  $result = [pscustomobject]@{ exitCode = $process.ExitCode; output = $stdout.GetAwaiter().GetResult(); error = $stderr.GetAwaiter().GetResult() }
  $process.Dispose()
  return $result
}

try {
  New-Item -ItemType Directory -Path $fixtureRepo -Force | Out-Null
  & git -C $fixtureRepo init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Fixture Git initialization failed' }
  # No commits or identity overrides are needed for repository-path preflight.
  [IO.File]::WriteAllText((Join-Path $fixtureRepo '.git/info/exclude'), ".agent/`n", [Text.Encoding]::UTF8)
  $fixtureAgent = Join-Path $fixtureRepo '.agent'
  New-Item -ItemType Directory -Path $fixtureAgent -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $fixtureAgent 'empty-tasks.json'), '{"tasks":[]}', [Text.Encoding]::UTF8)

  $probePath = Join-Path $fixtureRoot 'probe.ps1'
  [IO.File]::WriteAllText($probePath, @'
param($Case, $SourceRoot, $Repository, $ResultPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(949)
$OutputEncoding = [Console]::OutputEncoding
$global:plannerArgs = @()
$global:examplePlan = Join-Path $SourceRoot 'parallel-tasks.v2_1.example.json'
function codex.exe {
  $global:plannerArgs = @($args)
  $index = [array]::IndexOf($global:plannerArgs, '--output-last-message')
  Copy-Item -LiteralPath $global:examplePlan -Destination $global:plannerArgs[$index + 1]
  $global:LASTEXITCODE = 0
}
$errorText = ''
$output = @()
try {
  switch ($Case) {
    'router' { $output = @(& (Join-Path $SourceRoot 'codex-router.ps1') -Request '한글 경로 확인' -Repository $Repository -PlanOnly) }
    'parallel' { & (Join-Path $SourceRoot 'run-parallel-workers.ps1') -Repository $Repository -TasksFile (Join-Path $Repository '.agent/empty-tasks.json') -DataDir (Join-Path $Repository '.agent/data') }
    'review' { & (Join-Path $SourceRoot 'review-integration.ps1') -Repository $Repository -RunId 'missing-probe-run' }
    'review-retry' {
      $global:reviewRepository = $Repository
      function codex.exe { throw 'Cached review regression must not invoke a model' }
      function git {
        $arguments = @($args)
        $global:LASTEXITCODE = 0
        if ($arguments -contains '--show-toplevel') { return $global:reviewRepository }
        if ($arguments -contains 'rev-parse' -and $arguments -contains '--verify') { return ('c' * 40) }
        if ($arguments -contains 'diff' -and $arguments -contains '--name-only') { return 'src/change.ts' }
        throw "Unexpected Git operation in review-only fixture: $($arguments -join ' ')"
      }
      $output = @(& (Join-Path $SourceRoot 'review-integration.ps1') -Repository $Repository -RunId 'recovered-review' -AutoDeliver:$false)
    }
    'worker' {
      $output = @(& (Join-Path $SourceRoot 'run-gemini-worker.ps1') -Task '경로 검사' -Prompt 'mock only' -Workspace $Repository -StateRoot (Join-Path $Repository '.agent/worker-probe') -DataDir (Join-Path $Repository '.agent/data') -MockOutputJson '{"event":"result","result":{"response":"한글 mock 완료"}}')
    }
    'review-gate' { $output = @(& (Join-Path $SourceRoot 'codex-router.ps1') -Request 'mock review gate' -Repository $Repository) }
    default { throw "Unknown probe: $Case" }
  }
} catch { $errorText = $_.Exception.Message }
$gitRoot = & git -C $Repository rev-parse --show-toplevel 2>$null
$record = @{ error = $errorText; output = ($output -join "`n"); codePage = [Console]::OutputEncoding.CodePage; gitRoot = $gitRoot; plannerArgs = @($global:plannerArgs) }
[IO.File]::WriteAllText($ResultPath, ($record | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)
'@, [Text.Encoding]::UTF8)

  foreach ($case in @('router', 'parallel', 'review', 'worker')) {
    $resultPath = Join-Path $fixtureRoot "$case.json"
    $processResult = Start-Probe $probePath @('-Case', $case, '-SourceRoot', $PSScriptRoot, '-Repository', $fixtureRepo, '-ResultPath', $resultPath)
    Assert-Test "$case probe exits normally" ($processResult.exitCode -eq 0) $processResult.error
    $record = Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json
    Assert-Test "$case initializes UTF-8 from CP949" ($record.codePage -eq 65001) $record.error
    Assert-Test "$case preserves Korean and space-containing Git paths" ([IO.Path]::GetFullPath($record.gitRoot) -eq $fixtureRepo) $record.gitRoot
    switch ($case) {
      'router' {
        $cdIndex = [array]::IndexOf($record.plannerArgs, '--cd')
        Assert-Test 'Router supplies intact repository to planner adapter' ($record.error -eq '' -and $cdIndex -ge 0 -and [IO.Path]::GetFullPath($record.plannerArgs[$cdIndex + 1]) -eq $fixtureRepo) $record.error
        Assert-Test 'Router preserves read-only planner sandbox' (($record.plannerArgs -join ' ') -match '--sandbox read-only')
      }
      'parallel' { Assert-Test 'Parallel preflight reaches task validation' ($record.error -eq '작업 파일에 task가 없습니다.') $record.error }
      'review' { Assert-Test 'Review preflight reaches manifest validation' ($record.error -eq 'run을 찾을 수 없습니다: missing-probe-run') $record.error }
      'worker' { Assert-Test 'Worker mock completes and preserves Korean response' ($record.error -eq '' -and $record.output -match '한글 mock 완료') $record.error }
    }
  }

  # Exercise the real router with offline planner/orchestrator adapters. A review
  # sentinel catches accidental invocation even when it could enable delivery.
  $routerFixture = Join-Path $fixtureRoot 'router-adapters'
  New-Item -ItemType Directory -Path $routerFixture -Force | Out-Null
  foreach ($file in @('codex-router.ps1', 'filesystem-policy.ps1', 'router-plan.schema.json', 'parallel-tasks.v2_1.example.json')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $routerFixture
  }
  [IO.File]::WriteAllText((Join-Path $routerFixture 'run-parallel-workers.ps1'), @'
param($TasksFile, $Repository, $MaxWorkers)
$runRoot = Join-Path $Repository '.agent/runs/offline-review-gate'
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $runRoot 'run.json'), '{"status":"awaiting_review"}')
Write-Output 'Run: offline-review-gate'
$global:LASTEXITCODE = 0
'@, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $routerFixture 'review-integration.ps1'), @'
param($RunId, $Repository)
[IO.File]::WriteAllText((Join-Path $Repository '.agent/review-was-invoked'), 'unexpected')
throw 'Router invoked review without a separate user request'
'@, [Text.Encoding]::UTF8)
  $gateResultPath = Join-Path $fixtureRoot 'review-gate.json'
  $gateResult = Start-Probe $probePath @('-Case', 'review-gate', '-SourceRoot', $routerFixture, '-Repository', $fixtureRepo, '-ResultPath', $gateResultPath)
  $gate = Get-Content -Raw -LiteralPath $gateResultPath | ConvertFrom-Json
  Assert-Test 'Router returns successfully at awaiting_review' ($gateResult.exitCode -eq 0 -and $gate.error -eq '' -and $gate.output -match 'Awaiting review:') $gate.error
  Assert-Test 'Router does not invoke automatic review or settings-driven delivery' (-not (Test-Path -LiteralPath (Join-Path $fixtureAgent 'review-was-invoked')))

  # A real review invocation must resolve stale current failure fields after a
  # successful retry, while keeping earlier diagnostic files available unchanged.
  $retryRoot = Join-Path $fixtureAgent 'runs/recovered-review'
  New-Item -ItemType Directory -Path (Join-Path $retryRoot 'tasks'), (Join-Path $retryRoot 'results') -Force | Out-Null
  $retryManifestPath = Join-Path $retryRoot 'run.json'
  $diagnosticJsonPath = Join-Path $retryRoot 'delivery-diagnostic.json'
  $diagnosticMarkdownPath = Join-Path $retryRoot 'delivery-diagnostic.md'
  $priorDiagnosticJson = '{"errorCategory":"codex_review_failed","reason":"Earlier quota failure"}'
  $priorDiagnosticMarkdown = '# Earlier quota failure'
  [IO.File]::WriteAllText($diagnosticJsonPath, $priorDiagnosticJson, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($diagnosticMarkdownPath, $priorDiagnosticMarkdown, [Text.Encoding]::UTF8)
  Write-AtomicJson $retryManifestPath ([pscustomobject]@{
    runId = 'recovered-review'; status = 'escalated'; updatedAt = ''; request = 'preserve request metadata'
    errorCategory = 'codex_review_failed'; error = 'Earlier quota failure'; failureReason = 'Earlier quota failure'
    escalation = [pscustomobject]@{ requiresCodex = $true; category = 'codex_review_failed'; reason = 'Earlier quota failure' }
    delivery = [pscustomobject]@{ status = 'failed'; diagnosticArtifact = $diagnosticJsonPath; attemptedAt = '2026-09-15T00:00:00Z' }
    integration = [pscustomobject]@{
      branch = 'integration/recovered-review'; baseCommit = ('b' * 40); mainModified = $false; decision = 'AWAITING_CODEX_REVIEW'
      tests = @([pscustomobject]@{ command = 'offline fixture'; status = 'PASS'; exitCode = 0; timedOut = $false })
    }
  })
  Write-AtomicJson (Join-Path $retryRoot 'tasks/TASK-001.json') ([pscustomobject]@{ id = 'TASK-001'; allowedFiles = @('src/change.ts') })
  Write-AtomicJson (Join-Path $retryRoot 'results/TASK-001-result.json') ([pscustomobject]@{ taskId = 'TASK-001'; status = 'completed'; verification = [pscustomobject]@{ decision = 'PASS' } })
  Write-AtomicJson (Join-Path $retryRoot 'codex-review.json') ([pscustomobject]@{ verdict = 'PASS'; candidateCommit = ('c' * 40); summary = 'Current candidate passed'; findings = @() })
  $priorDeliveryRecord = (Get-Content -Raw -LiteralPath $retryManifestPath | ConvertFrom-Json).delivery | ConvertTo-Json -Compress
  $retryProbeResultPath = Join-Path $fixtureRoot 'review-retry.json'
  $retryProcessResult = Start-Probe $probePath @('-Case', 'review-retry', '-SourceRoot', $PSScriptRoot, '-Repository', $fixtureRepo, '-ResultPath', $retryProbeResultPath)
  $retryProbe = Get-Content -Raw -LiteralPath $retryProbeResultPath | ConvertFrom-Json
  $recoveredReview = Get-Content -Raw -LiteralPath $retryManifestPath | ConvertFrom-Json
  Assert-Test 'Successful review retry reaches human approval without model calls' ($retryProcessResult.exitCode -eq 0 -and $retryProbe.error -eq '' -and $recoveredReview.status -eq 'awaiting_human_approval') $retryProbe.error
  $staleFields = @(@('errorCategory', 'failureReason', 'error', 'escalation') | Where-Object { $recoveredReview.PSObject.Properties.Name -contains $_ })
  Assert-Test 'Successful review retry clears stale current errors and escalation' ($staleFields.Count -eq 0) ($staleFields -join ', ')
  Assert-Test 'Successful review retry remains bound to the current candidate' ($recoveredReview.codexReview.verdict -eq 'PASS' -and $recoveredReview.codexReview.candidateCommit -eq ('c' * 40) -and $recoveredReview.codexReview.findingsCount -eq 0 -and -not $recoveredReview.codexReview.mainModified)
  Assert-Test 'Successful review retry preserves historical JSON diagnostic' ([IO.File]::ReadAllText($diagnosticJsonPath) -ceq $priorDiagnosticJson)
  Assert-Test 'Successful review retry preserves historical Markdown diagnostic' ([IO.File]::ReadAllText($diagnosticMarkdownPath) -ceq $priorDiagnosticMarkdown)
  Assert-Test 'Successful review retry retains prior delivery-attempt evidence' (($recoveredReview.delivery | ConvertTo-Json -Compress) -ceq $priorDeliveryRecord)
  Assert-Test 'Successful review retry preserves unrelated request metadata' ($recoveredReview.request -eq 'preserve request metadata')

  # Exercise the production integration-result gate without a Codex review or
  # delivery. The diagnostic adapter captures rejection before its exit statement.
  $reviewTokens = $null
  $reviewErrors = $null
  $reviewAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'review-integration.ps1'), [ref]$reviewTokens, [ref]$reviewErrors)
  $resultGate = $reviewAst.Find({
    param($node)
    $node -is [Management.Automation.Language.IfStatementAst] -and
      $node.Clauses[0].Item1.Extent.Text -eq '$manifest.integration -and $manifest.integration.tests'
  }, $true)
  if (-not $resultGate) { throw 'Production integration-result gate not found' }
  & {
    param($GateText)
    function Record-Diagnostic([string]$Category, [string]$Reason, [hashtable]$Details) {
      throw "REVIEW_GATE_REJECTED:$Category"
    }
    foreach ($testCase in @(
      @{ name = 'FAIL status'; status = 'FAIL'; exitCode = 0; timedOut = $false; rejected = $true },
      @{ name = 'TIMED_OUT status'; status = 'TIMED_OUT'; exitCode = $null; timedOut = $false; rejected = $true },
      @{ name = 'timeout flag'; status = 'PASS'; exitCode = 0; timedOut = $true; rejected = $true },
      @{ name = 'nonzero exit'; status = 'PASS'; exitCode = 7; timedOut = $false; rejected = $true },
      @{ name = 'successful result'; status = 'PASS'; exitCode = 0; timedOut = $false; rejected = $false }
    )) {
      $manifest = [pscustomobject]@{ integration = [pscustomobject]@{ tests = @([pscustomobject]@{
        command = 'offline fixture'; status = $testCase.status; exitCode = $testCase.exitCode; timedOut = $testCase.timedOut
      }) } }
      $wasRejected = $false
      try { & ([scriptblock]::Create($GateText)) }
      catch {
        if ($_.Exception.Message -ne 'REVIEW_GATE_REJECTED:integration_test_failed') { throw }
        $wasRejected = $true
      }
      Assert-Test "Review gate handles $($testCase.name)" ($wasRejected -eq $testCase.rejected)
    }
  } $resultGate.Extent.Text

  # Load only the production cleanup functions; no orchestration/model run starts.
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-parallel-workers.ps1'), [ref]$tokens, [ref]$parseErrors)
  foreach ($name in @('Test-ProcessAlive', 'Stop-WorkerProcesses')) {
    $functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($functionAst.Extent.Text))
  }

  # Orphan recovery may remove only strict descendants of its worktree root.
  # Capture Git commands instead of deleting worktrees to make boundary failures
  # deterministic and safe to test, including sibling and '..' escape paths.
  $repairAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Repair-OrphanedRuns' }, $true)
  & {
    param($RepairText, $RecoveryRoot, $Repository)
    . ([scriptblock]::Create($RepairText))
    $ownedRoot = Join-Path $RecoveryRoot 'worktrees'
    $allowedPath = Join-Path $ownedRoot 'valid/worker'
    $dirtyPath = Join-Path $ownedRoot 'dirty/worker'
    $siblingPath = Join-Path $RecoveryRoot 'worktrees-other/worker'
    $traversalPath = Join-Path $ownedRoot '../outside/worker'
    $runRoot = Join-Path $RecoveryRoot 'runs/orphan'
    New-Item -ItemType Directory -Path $allowedPath, $dirtyPath, $siblingPath, $traversalPath, (Join-Path $runRoot 'workers') -Force | Out-Null
    $manifestPath = Join-Path $runRoot 'run.json'
    Write-AtomicJson $manifestPath ([pscustomobject]@{
      status = 'running'; orchestratorProcessId = 0; updatedAt = ''
      worktrees = @($allowedPath, $dirtyPath, $siblingPath, $traversalPath, $ownedRoot) | ForEach-Object { [pscustomobject]@{ path = $_ } }
    })
    $removedPaths = [Collections.Generic.List[string]]::new()
    $statusPaths = [Collections.Generic.List[string]]::new()
    function git {
      $arguments = @($args)
      $global:LASTEXITCODE = 0
      if ($arguments -contains 'status') {
        $path = $arguments[[array]::IndexOf($arguments, '-C') + 1]
        $statusPaths.Add($path)
        if ($path -eq $dirtyPath) { return ' M preserved.txt' }
      } elseif ($arguments -contains 'remove') {
        $removedPaths.Add($arguments[[array]::IndexOf($arguments, 'remove') + 1])
      } elseif ($arguments -notcontains 'prune') { throw 'Unexpected Git operation during recovery' }
    }
    Repair-OrphanedRuns $RecoveryRoot $Repository
    $recovered = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    Assert-Test 'Orphan recovery removes a clean owned descendant' ($removedPaths.Count -eq 1 -and $removedPaths[0] -eq $allowedPath) ($removedPaths -join ', ')
    Assert-Test 'Orphan recovery preserves dirty owned worktree' (@($recovered.recovery.preservedDirtyWorktrees) -contains $dirtyPath)
    Assert-Test 'Orphan recovery rejects a similarly named sibling directory' (-not $statusPaths.Contains($siblingPath))
    Assert-Test 'Orphan recovery rejects normalized parent traversal' (-not $statusPaths.Contains([IO.Path]::GetFullPath($traversalPath)))
    Assert-Test 'Orphan recovery never treats its root as a worker worktree' (-not $statusPaths.Contains($ownedRoot))
    Assert-Test 'Orphan recovery retains interrupted status contract' ($recovered.status -eq 'interrupted')
  } $repairAst.Extent.Text (Join-Path $fixtureAgent 'recovery-fixture') $fixtureRepo

  $treePath = Join-Path $fixtureRoot 'tree.ps1'
  $pidPath = Join-Path $fixtureRoot 'tree-pids.txt'
  [IO.File]::WriteAllText($treePath, @'
param([int]$Depth, [string]$PidPath)
Add-Content -LiteralPath $PidPath -Value $PID
if ($Depth -gt 0) {
  $info = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-Depth', ($Depth - 1).ToString(), '-PidPath', $PidPath)) { $info.ArgumentList.Add($argument) }
  $null = [Diagnostics.Process]::Start($info)
}
Start-Sleep -Seconds 120
'@, [Text.Encoding]::UTF8)
  $treeInfo = [Diagnostics.ProcessStartInfo]::new((Get-Command pwsh).Source)
  $treeInfo.UseShellExecute = $false
  $treeInfo.CreateNoWindow = $true
  foreach ($argument in @('-NoProfile', '-File', $treePath, '-Depth', '2', '-PidPath', $pidPath)) { $treeInfo.ArgumentList.Add($argument) }
  $treeProcess = [Diagnostics.Process]::Start($treeInfo)
  $readyWatch = [Diagnostics.Stopwatch]::StartNew()
  do {
    if (Test-Path -LiteralPath $pidPath) { $recordedIds = @(Get-Content -LiteralPath $pidPath | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }) }
    if ($recordedIds.Count -ge 3) { break }
    Start-Sleep -Milliseconds 100
  } while ($readyWatch.Elapsed.TotalSeconds -lt 20)
  Assert-Test 'Cleanup fixture started worker, child, and grandchild' ($recordedIds.Count -eq 3) ($recordedIds -join ', ')
  $statePath = Join-Path $fixtureRoot 'worker-state.json'
  [IO.File]::WriteAllText($statePath, (@{ agentProcessId = $treeProcess.Id; runnerProcessId = $null } | ConvertTo-Json), [Text.Encoding]::UTF8)
  Stop-WorkerProcesses $statePath
  $leakedIds = @($recordedIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  Assert-Test 'Worker cleanup leaves no child or grandchild running' ($leakedIds.Count -eq 0) ($leakedIds -join ', ')
} finally {
  if ($treeProcess) {
    if (-not $treeProcess.HasExited) { $treeProcess.Kill($true) }
    $treeProcess.Dispose()
  }
  foreach ($processId in $recordedIds) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedFixture.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe fixture cleanup path: $resolvedFixture" }
  if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}

Write-Host "Native runtime tests: $passCount/$($passCount + $failCount) passed; $failCount failed."
exit $(if ($failCount -gt 0) { 1 } else { 0 })
