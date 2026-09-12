$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'filesystem-policy.ps1')
$passed = 0
function Assert-Expansion([string]$Name, [bool]$Condition) {
  if (-not $Condition) { throw "FAIL: $Name" }
  $script:passed++; Write-Host "[PASS] $Name"
}
function New-Policy {
  Resolve-FilesystemPolicy ([pscustomobject]@{ id='TASK-001'; write_scope=[pscustomobject]@{
    expected=@('src/original.ts'); derived_auto_expand=$true; derived_approved=@()
  } })
}
function New-Request([string]$Target = 'src/dependency.ts', [string]$Relation = 'direct_import') {
  [pscustomobject]@{ action='REQUEST_WRITE_EXPANSION'; target=$Target; reason='required dependency'; evidence=[pscustomobject]@{ relation=$Relation; source_file='src/original.ts' } }
}

foreach ($relation in @('direct_import', 'interface_implementation', 'direct_symbol_dependency', 'feature_implementation_dependency')) {
  $policy = New-Policy
  $r = Invoke-TaskWriteExpansion (New-Request -Relation $relation) $policy
  Assert-Expansion "$relation approves and persists evidence" ($r.decision -eq 'ALLOW_DERIVED' -and $r.approvedAt -and $r.evidence.relation -eq $relation)
}
$policy = New-Policy; $policy.write_scope.derived_auto_expand = $false
$r = Invoke-TaskWriteExpansion (New-Request) $policy
Assert-Expansion 'disabled expansion denied with reason' ($r.decision -eq 'DENY_DERIVED' -and $r.reason -eq 'automatic expansion disabled')
$policy = New-Policy
$r = Invoke-TaskWriteExpansion (New-Request -Relation 'guess') $policy
Assert-Expansion 'insufficient evidence denied' ($r.decision -eq 'DENY_DERIVED' -and $r.reason -eq 'insufficient dependency evidence')
$r = Invoke-TaskWriteExpansion (New-Request 'package.json') $policy
Assert-Expansion 'sensitive requires review with matched pattern' ($r.decision -eq 'REQUIRE_REVIEW' -and $r.matchedPattern -eq 'package.json' -and $r.deniedAt)
$r = Invoke-TaskWriteExpansion (New-Request '.git/config') $policy
Assert-Expansion 'forbidden immediately denied with pattern' ($r.decision -eq 'DENY_FORBIDDEN' -and $r.matchedPattern -eq '.git/**')
foreach ($bad in @('../outside.ts', 'src/*.ts', 'C:/outside.ts')) {
  $r = Invoke-TaskWriteExpansion (New-Request $bad) $policy
  Assert-Expansion "invalid target $bad denied" ($r.decision -eq 'DENY_DERIVED')
}
$badEvidence = New-Request; $badEvidence.evidence.source_file = 'src/elsewhere.ts'
$r = Invoke-TaskWriteExpansion $badEvidence $policy
Assert-Expansion 'unapproved evidence source denied' ($r.decision -eq 'DENY_DERIVED')
$policy.merge_scope.deny = @('src/no-merge.ts')
$r = Invoke-TaskWriteExpansion (New-Request 'src/no-merge.ts') $policy
Assert-Expansion 'merge deny cannot be widened' ($r.decision -eq 'DENY_DERIVED' -and $r.matchedPattern -eq 'src/no-merge.ts')
$other = Resolve-FilesystemPolicy ([pscustomobject]@{allowed_files=@('src/dependency.ts')})
$r = Invoke-TaskWriteExpansion (New-Request) $policy -OtherPolicies @($other)
Assert-Expansion 'other task ownership requires review' ($r.decision -eq 'REQUIRE_REVIEW' -and $policy.write_scope.derived_approved.Count -eq 0)
$r = Invoke-TaskWriteExpansion (New-Request) $policy
$dup = Invoke-TaskWriteExpansion (New-Request './SRC/dependency.ts') $policy -ExpansionCount 1
Assert-Expansion 'duplicate normalized target denied without increment' ($dup.decision -eq 'DENY_DERIVED' -and $dup.expansionCount -eq 1 -and $policy.write_scope.derived_approved.Count -eq 1)
$verified = Get-FilesystemScopeVerification @('src/dependency.ts') $policy
Assert-Expansion 'approved target passes final verifier as DERIVED_APPROVED' ($verified.status -eq 'PASS' -and $verified.entries[0].classification -eq 'DERIVED_APPROVED')
Assert-Expansion 'empty diff can request expansion before edits' ((Get-FilesystemScopeVerification @() $policy).status -eq 'PASS')
$r = Invoke-TaskWriteExpansion (New-Request 'src/fourth.ts') $policy -ExpansionCount 3
Assert-Expansion 'bounded expansion loop stops at limit' ($r.decision -eq 'DENY_DERIVED' -and $r.reason -eq 'write expansion limit reached' -and $r.expansionCount -eq 3)
$json = New-Request | ConvertTo-Json -Compress
Assert-Expansion 'structured JSON parsed' ($null -ne (ConvertFrom-WriteExpansionResponse $json))
Assert-Expansion 'fenced JSON parsed' ($null -ne (ConvertFrom-WriteExpansionResponse ("``````json`n$json`n``````")))
Assert-Expansion 'generic text is not an expansion request' ($null -eq (ConvertFrom-WriteExpansionResponse 'Please REQUEST_WRITE_EXPANSION because forbidden'))

# Run the production orchestrator in disposable repositories. Only the AI worker
# is replaced by a deterministic fixture; actual git, verification and retry run.
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('expansion-' + [guid]::NewGuid().ToString('N'))
$scripts = Join-Path $testRoot 'scripts'
New-Item -ItemType Directory -Path $scripts -Force | Out-Null
try {
  foreach ($file in @('run-parallel-workers.ps1', 'review-integration.ps1', 'filesystem-policy.ps1', 'bounded-process-runner.ps1', 'dashboard-dependency-bootstrap.ps1', 'toolchain.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $scripts
  }
  $fakeWorker = @'
param($Task,$Prompt,$Model,$Workspace,$Timeout,$OrchestrationRunId,$TaskId,$StateRoot,$BaseCommit,[int]$Attempt,$DashboardPath,$DataDir)
$ErrorActionPreference='Stop'
$config=Get-Content -Raw -LiteralPath (Join-Path $Workspace 'fixture.json') | ConvertFrom-Json
$step=$config.steps[[math]::Min($Attempt - 1, $config.steps.Count - 1)]
foreach($file in @($step.files)) {
  if(-not $file) { continue }
  $path=Join-Path $Workspace $file.path
  [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
  [IO.File]::WriteAllText($path, $file.text)
}
if($Attempt -gt 1 -and $config.expectExpansionPrompt -and $Attempt -eq 2 -and $Prompt -notmatch 'WRITE_EXPANSION_APPROVED:') { throw 'missing continuation prompt' }
$snapshot=Get-Content -Raw -LiteralPath (Join-Path $StateRoot "tasks/$TaskId.json") | ConvertFrom-Json
if($Attempt -eq 2 -and $config.expectExpansionPrompt -and $snapshot.filesystemPolicy.write_scope.derived_approved.Count -ne 1) { throw 'policy not saved before resume' }
$state=[pscustomobject]@{runId=$OrchestrationRunId;taskId=$TaskId;task=$Task;attempt=$Attempt;status='completed';finalResponse=$step.response;error=$null;model=$Model}
$state | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $StateRoot "workers/$TaskId.json")
'@
  [IO.File]::WriteAllText((Join-Path $scripts 'run-gemini-worker.ps1'), $fakeWorker)
  function Invoke-Fixture([string]$Name, $Steps, [string[]]$Commands = @(), [bool]$ExpectExpansionPrompt = $false) {
    $repo = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory((Join-Path $repo 'src')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $repo '.gitignore'), ".agent/`ndata/`n")
    [IO.File]::WriteAllText((Join-Path $repo 'src/original.ts'), 'original')
    [pscustomobject]@{steps=@($Steps);expectExpansionPrompt=$ExpectExpansionPrompt} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $repo 'fixture.json')
    & git -C $repo init -q
    & git -C $repo config user.name 'Expansion Test'
    & git -C $repo config user.email 'expansion@example.invalid'
    & git -C $repo add .
    & git -C $repo commit -qm fixture
    $task = [pscustomobject]@{id='TASK-001';name=$Name;prompt='Implement fixture';tier='normal';retry_limit=2;timeout_seconds=30;write_scope=(New-Policy).write_scope;test_commands=@($Commands)}
    $taskPath = Join-Path $testRoot "$Name.json"
    [pscustomobject]@{tasks=@($task);integration_test_commands=@()} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskPath
    $log = & pwsh.exe -NoProfile -File (Join-Path $scripts 'run-parallel-workers.ps1') -TasksFile $taskPath -Repository $repo -DataDir (Join-Path $repo 'data') -MaxWorkers 1 2>&1
    $exitCode = $LASTEXITCODE
    $run = Get-ChildItem -LiteralPath (Join-Path $repo '.agent/runs') -Directory | Select-Object -First 1
    $resultPath=Join-Path $run.FullName 'results/TASK-001-result.json'
    if (-not (Test-Path -LiteralPath $resultPath)) { throw "Fixture $Name missing result (exit $exitCode): $($log -join "`n")" }
    [pscustomobject]@{result=(Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json);run=$run.FullName;repo=$repo;exitCode=$exitCode;log=$log}
  }
  $target='src/[runId]/파일 이름(완료).ts'
  $steps=@(
    @{response=(New-Request $target | ConvertTo-Json -Compress);files=@(@{path='src/original.ts';text='preserved'})},
    @{response='done';files=@(@{path=$target;text='derived'})}
  )
  $case=Invoke-Fixture 'resume' $steps @() $true
  Assert-Expansion 'real loop resumes to PASS without test retry' ($case.result.verification.decision -eq 'PASS' -and $case.result.attempt -eq 2 -and $case.result.testRetryCount -eq 0 -and $case.result.expansionCount -eq 1)
  Assert-Expansion 'same worktree preserves original edits' ((Get-Content -Raw -LiteralPath (Join-Path $case.result.worktree 'src/original.ts')) -eq 'preserved')
  Assert-Expansion 'literal derived filename passes orchestrator' (@($case.result.policy.entries | Where-Object classification -eq 'DERIVED_APPROVED').Count -eq 1)
  $taskState=Get-Content -Raw -LiteralPath (Join-Path $case.run 'tasks/TASK-001.json') | ConvertFrom-Json
  Assert-Expansion 'task result and worker persist same approved policy' ($taskState.filesystemPolicy.write_scope.derived_approved[0] -eq $target -and $case.result.filesystemPolicy.write_scope.derived_approved[0] -eq $target)
  $integration=Get-Content -Raw -LiteralPath (Join-Path $case.run 'integration.json') | ConvertFrom-Json
  Assert-Expansion 'integration revalidates derived scope and stops for review' ($integration.decision -eq 'AWAITING_CODEX_REVIEW' -and $integration.taskPolicies[0].verification.status -eq 'PASS' -and @($integration.taskPolicies[0].verification.entries | Where-Object classification -eq 'DERIVED_APPROVED').Count -eq 1 -and $case.exitCode -eq 0)
  $beforeReview = & git -C $case.repo rev-parse HEAD
  $reviewLog = & pwsh.exe -NoProfile -File (Join-Path $scripts 'review-integration.ps1') -RunId (Split-Path -Leaf $case.run) -Repository $case.repo -SkipCodexReview 2>&1
  $reviewExit = $LASTEXITCODE
  $reviewed = Get-Content -Raw -LiteralPath (Join-Path $case.run 'run.json') | ConvertFrom-Json
  Assert-Expansion 'review loader uses saved expanded policy for literal candidate diff' ($reviewExit -eq 0 -and $reviewed.integration.scopeVerification.status -eq 'PASS' -and @($reviewed.integration.scopeVerification.entries | Where-Object classification -eq 'DERIVED_APPROVED').Count -eq 1)
  Assert-Expansion 'review never merges fixture source branch' ((& git -C $case.repo rev-parse HEAD) -eq $beforeReview -and $reviewed.status -eq 'awaiting_human_approval')
  $liveRoot = Join-Path $testRoot 'live-state'
  New-Item -ItemType Directory -Path (Join-Path $liveRoot 'tasks') -Force | Out-Null
  $taskState | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $liveRoot 'tasks/TASK-001.json')
  $mockResult = '{"event":"result","result":{"response":"done","status":"SUCCESS"}}'
  $liveLog = & pwsh.exe -NoProfile -File (Join-Path $PSScriptRoot 'run-gemini-worker.ps1') -Task 'saved policy' -Prompt 'fixture' -Workspace $case.repo -OrchestrationRunId 'saved-policy' -TaskId 'TASK-001' -StateRoot $liveRoot -DataDir (Join-Path $testRoot 'live-data') -Attempt 7 -MockOutputJson $mockResult -MockExitCode 0 2>&1
  $liveExit = $LASTEXITCODE
  $liveState = Get-Content -Raw -LiteralPath (Join-Path $liveRoot 'workers/TASK-001.json') | ConvertFrom-Json
  Assert-Expansion 'real worker state retains saved expansion metadata' ($liveExit -eq 0 -and $liveState.expansionCount -eq 1 -and $liveState.expansionRequests[0].evidence.relation -eq 'direct_import' -and $liveState.filesystemPolicy.write_scope.derived_approved[0] -eq $target -and $liveState.testRetryCount -eq 0)
  Assert-Expansion 'real worker accepts invocation above old retry-only limit' ($liveState.attempt -eq 7)
  # Expansion, then two distinct test failures, then success on High. If
  # invocation count consumes retry budget, the final invocation never runs.
  $retrySteps=@(
    @{response=(New-Request | ConvertTo-Json -Compress);files=@()},
    @{response='done';files=@(@{path='src/dependency.ts';text='one'})},
    @{response='done';files=@(@{path='src/dependency.ts';text='two'})},
    @{response='done';files=@(@{path='src/dependency.ts';text='ready'})}
  )
  $check = 'if ((Get-Content -Raw -LiteralPath src/dependency.ts) -ne ''ready'') { Write-Output (Get-Content -Raw -LiteralPath src/dependency.ts); exit 1 }'
  $checkCommand = 'pwsh.exe -NoProfile -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($check))
  $case=Invoke-Fixture 'retry' $retrySteps @($checkCommand) $true
  if ($case.result.verification.decision -ne 'PASS') { Write-Host ($case.result | ConvertTo-Json -Depth 12) }
  Assert-Expansion 'expansion does not consume test retry budget' ($case.result.verification.decision -eq 'PASS' -and $case.result.attempt -eq 4 -and $case.result.testRetryCount -eq 2 -and $case.result.expansionCount -eq 1 -and $case.result.retryHistory.Count -eq 2)
  foreach ($denial in @(@{target='package.json';decision='WRITE_EXPANSION_REVIEW_REQUIRED'}, @{target='.git/config';decision='DENY_FORBIDDEN'})) {
    $case=Invoke-Fixture $denial.decision @(@{response=(New-Request $denial.target | ConvertTo-Json -Compress);files=@()})
    Assert-Expansion "real loop stops $($denial.decision) without retry" ($case.result.verification.decision -eq $denial.decision -and $case.result.attempt -eq 1 -and $case.result.expansionRequests[0].matchedPattern -and $case.result.escalation.requiresCodex)
  }
  $case=Invoke-Fixture 'duplicate' @(@{response=$json;files=@()})
  Assert-Expansion 'real duplicate loop stops on second invocation' ($case.result.verification.decision -eq 'DENY_DERIVED' -and $case.result.attempt -eq 2 -and $case.result.expansionCount -eq 1 -and $case.result.expansionRequests.Count -eq 2)
  $limitSteps=@(1..4 | ForEach-Object { @{response=(New-Request "src/dep$_.ts" | ConvertTo-Json -Compress);files=@()} })
  $case=Invoke-Fixture 'limit' $limitSteps
  Assert-Expansion 'real loop bounded at three approvals' ($case.result.verification.decision -eq 'DENY_DERIVED' -and $case.result.attempt -eq 4 -and $case.result.expansionCount -eq 3 -and $case.result.testRetryCount -eq 0 -and $case.result.expansionRequests[-1].reason -eq 'write expansion limit reached')
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedTestRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedTestRoot) -notlike 'expansion-*') { throw 'Unsafe fixture cleanup path' }
  if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
Write-Host "Write expansion tests: $passed passed / 0 failed"
