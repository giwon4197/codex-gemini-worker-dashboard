[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$RunId,
  [string]$Repository = (Get-Location).Path,
  [Alias('Deliver')][switch]$AutoDeliver,
  [string]$TargetBranch = '',
  [string]$Remote = '',
  [switch]$SkipCodexReview
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bounded-process-runner.ps1')
. (Join-Path $PSScriptRoot 'dashboard-dependency-bootstrap.ps1')
. (Join-Path $PSScriptRoot 'filesystem-policy.ps1')

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

function Invoke-Verification([string]$Worktree, $Commands, [int]$DefaultTimeoutSeconds = 120) {
  return @(Invoke-BoundedVerification -Worktree $Worktree -Commands $Commands -DefaultTimeoutSeconds $DefaultTimeoutSeconds)
}

$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$repoRoot = $repoRoot.Trim()
$runRoot = Join-Path $repoRoot ".agent\runs\$RunId"
$manifestPath = Join-Path $runRoot 'run.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "run을 찾을 수 없습니다: $RunId" }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if (-not $manifest.integration) { throw '검토할 integration 정보가 없습니다.' }
if ($manifest.integration.mainModified -and -not $manifest.delivery) { throw 'mainModified=true인 실행은 자동 리뷰하지 않습니다.' }

function Record-Diagnostic([string]$Category, [string]$Reason, [hashtable]$Details = @{}) {
  $redactedReason = Redact-Text $Reason
  $redactedDetails = @{}
  foreach ($k in $Details.Keys) {
    $val = $Details[$k]
    if ($val -is [string]) { $redactedDetails[$k] = Redact-Text $val }
    elseif ($val -is [array]) {
      $redactedDetails[$k] = @($val | ForEach-Object { if ($_ -is [string]) { Redact-Text $_ } else { $_ } })
    } else {
      $redactedDetails[$k] = $val
    }
  }

  $diagJsonPath = Join-Path $runRoot 'delivery-diagnostic.json'
  $diagMdPath = Join-Path $runRoot 'delivery-diagnostic.md'

  $diagData = [pscustomobject]@{
    runId = $RunId
    status = 'failed'
    errorCategory = $Category
    reason = $redactedReason
    details = $redactedDetails
    timestamp = (Get-Date).ToString('o')
  }
  Write-AtomicJson $diagJsonPath $diagData

  $mdLines = @(
    "# Delivery Diagnostic: $RunId",
    '',
    '- Status: failed',
    "- Category: $Category",
    "- Reason: $redactedReason",
    "- Timestamp: $($diagData.timestamp)",
    '',
    '## Details',
    '```json',
    ($diagData | ConvertTo-Json -Depth 8),
    '```'
  )
  [IO.File]::WriteAllText($diagMdPath, ($mdLines -join "`n"), [Text.Encoding]::UTF8)

  $m = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  $terminalStatus = if ($Category -in @('policy_violation', 'changes_requested', 'codex_review_failed', 'stale_review', 'divergence_detected', 'push_rejected', 'merge_conflict', 'missing_upstream')) { 'escalated' } else { 'failed' }
  Set-ObjectProperty $m 'status' $terminalStatus
  Set-ObjectProperty $m 'errorCategory' $Category
  Set-ObjectProperty $m 'failureReason' $redactedReason
  Set-ObjectProperty $m 'error' $redactedReason
  Set-ObjectProperty $m 'escalation' ([pscustomobject]@{
    requiresCodex = $true
    category = $Category
    reason = $redactedReason
  })
  Set-ObjectProperty $m 'delivery' ([pscustomobject]@{
    status = 'failed'
    errorCategory = $Category
    error = $redactedReason
    diagnosticArtifact = $diagJsonPath
    attemptedAt = (Get-Date).ToString('o')
  })
  Set-ObjectProperty $m 'updatedAt' (Get-Date).ToString('o')
  Write-AtomicJson $manifestPath $m

  [Console]::Error.WriteLine("DELIVERY_ERROR: [$Category] $redactedReason")
}

$settingsPath = Join-Path $repoRoot 'worker-settings.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
  try { Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json } catch { $null }
} else { $null }

if ([string]::IsNullOrWhiteSpace($TargetBranch)) {
  if ($settings -and $settings.delivery -and -not [string]::IsNullOrWhiteSpace($settings.delivery.targetBranch)) {
    $TargetBranch = [string]$settings.delivery.targetBranch
  } elseif ($settings -and -not [string]::IsNullOrWhiteSpace($settings.targetBranch)) {
    $TargetBranch = [string]$settings.targetBranch
  } else {
    $TargetBranch = 'main'
  }
}

if ([string]::IsNullOrWhiteSpace($Remote)) {
  if ($settings -and $settings.delivery -and -not [string]::IsNullOrWhiteSpace($settings.delivery.remote)) {
    $Remote = [string]$settings.delivery.remote
  } elseif ($settings -and -not [string]::IsNullOrWhiteSpace($settings.remote)) {
    $Remote = [string]$settings.remote
  } else {
    $Remote = 'origin'
  }
}

$shouldDeliver = $false
if ($PSBoundParameters.ContainsKey('AutoDeliver')) {
  $shouldDeliver = $AutoDeliver.IsPresent
} else {
  if ($settings) {
    if ($settings.autoDeliver -eq $true -or ($settings.delivery -and $settings.delivery.enabled -eq $true) -or ($settings.delivery -and $settings.delivery.autoDeliver -eq $true)) {
      $shouldDeliver = $true
    }
  }
}

$reviewJsonPath = Join-Path $runRoot 'codex-review.json'
$reviewPath = Join-Path $runRoot 'codex-review.md'
$reviewSchema = Join-Path $PSScriptRoot 'codex-review.schema.json'

$baseCommit = [string]$manifest.integration.baseCommit
$integrationBranch = [string]$manifest.integration.branch
$candHash = (& git -C $repoRoot rev-parse --verify "refs/heads/$integrationBranch" 2>$null)
if (-not $candHash) {
  Record-Diagnostic 'integration_branch_missing' "Integration branch '$integrationBranch' does not exist."
  exit 1
}
$candidateCommit = $candHash.Trim()

# Codex Review execution or loading
$review = $null
if (Test-Path -LiteralPath $reviewJsonPath) {
  try { $review = Get-Content -Raw -LiteralPath $reviewJsonPath | ConvertFrom-Json } catch {}
}

if (-not $review) {
  if ($SkipCodexReview) {
    $review = [pscustomobject]@{
      verdict = 'PASS'
      summary = 'Verification review passed via SkipCodexReview'
      candidateCommit = $candidateCommit
      findings = @()
    }
    Write-AtomicJson $reviewJsonPath $review
  } elseif (Get-Command codex.exe -ErrorAction SilentlyContinue) {
    $reviewPrompt = @"
Review only the committed diff from base commit $baseCommit through candidate commit $candidateCommit (HEAD).
Candidate commit under review: $candidateCommit.
Focus on correctness, regressions, security, test gaps, documentation/API mismatches, and contract violations.
Do not edit files or merge branches. Run relevant read-only tests when useful.
Return verdict REQUEST_FIX when any actionable finding exists; otherwise return PASS. Set candidateCommit to '$candidateCommit'. Use repository-relative file paths.
"@
    $worktreeForReview = if ($manifest.integration.worktree -and (Test-Path -LiteralPath $manifest.integration.worktree)) {
      $manifest.integration.worktree
    } else {
      $repoRoot
    }
    Push-Location $worktreeForReview
    try {
      & codex.exe exec --sandbox read-only --ephemeral --color never --output-schema $reviewSchema --output-last-message $reviewJsonPath --cd $worktreeForReview $reviewPrompt
      $reviewExit = $LASTEXITCODE
    } finally { Pop-Location }

    if ($reviewExit -eq 0 -and (Test-Path -LiteralPath $reviewJsonPath)) {
      try { $review = Get-Content -Raw -LiteralPath $reviewJsonPath | ConvertFrom-Json } catch { $review = $null }
    }
  } else {
    Record-Diagnostic 'codex_review_failed' 'Codex CLI를 찾을 수 없으며 기존 review 아티팩트가 없습니다.'
    exit 1
  }
}

if (-not $review -or -not $review.verdict) {
  Record-Diagnostic 'codex_review_failed' 'Codex 리뷰 생성 또는 파싱에 실패했습니다.'
  exit 1
}

# Validate schema properties
$hasReqFields = ($review.PSObject.Properties.Name -contains 'verdict' -and
                 $review.PSObject.Properties.Name -contains 'summary' -and
                 $review.PSObject.Properties.Name -contains 'findings' -and
                 $review.PSObject.Properties.Name -contains 'candidateCommit')
if (-not $hasReqFields) {
  Record-Diagnostic 'codex_review_failed' 'Codex 리뷰 결과가 필수 스키마 필드(verdict, summary, findings, candidateCommit)를 모두 포함하지 않습니다.'
  exit 1
}

# Validate candidateCommit binding - reject missing or stale reviews
if ([string]::IsNullOrWhiteSpace($review.candidateCommit) -or ($review.candidateCommit.Trim() -ne $candidateCommit)) {
  Record-Diagnostic 'stale_review' "Codex review is stale or candidateCommit does not match resolved candidate. Expected: '$candidateCommit', Review has: '$($review.candidateCommit)'." @{
    expectedCandidateCommit = $candidateCommit
    reviewCandidateCommit   = [string]$review.candidateCommit
  }
  exit 1
}

# Write review markdown
$lines = @(
  "# Codex Review: $RunId",
  '',
  "- Verdict: $($review.verdict)",
  "- Candidate commit: $candidateCommit",
  '',
  $review.summary,
  '',
  '## Findings',
  ''
)
if (@($review.findings).Count -eq 0) { $lines += '- No actionable findings.' }
else { foreach ($finding in @($review.findings)) { $lines += "- [$($finding.severity)] $($finding.title) — $($finding.file):$($finding.line)`n  $($finding.body)" } }
[IO.File]::WriteAllText($reviewPath, ($lines -join "`n"), [Text.Encoding]::UTF8)

# Validate structured verdict
if ($review.verdict -ne 'PASS') {
  Record-Diagnostic 'changes_requested' "Codex review returned $($review.verdict): $($review.summary)" @{
    findings = @($review.findings)
  }
  exit 1
}

# Validate integration diff
$diffFiles = @(& git -C $repoRoot diff --name-only "$baseCommit...$candidateCommit" | Where-Object { $_ })
if ($diffFiles.Count -eq 0) {
  Record-Diagnostic 'diff_empty' "Integration diff between base commit '$baseCommit' and candidate commit '$candidateCommit' is empty."
  exit 1
}

# Validate the candidate diff with the same v2.1 policy engine used by workers.
$taskPolicies = [System.Collections.Generic.List[object]]::new()
$tasksDir = Join-Path $runRoot 'tasks'
if (Test-Path -LiteralPath $tasksDir) {
  foreach ($tFile in Get-ChildItem -LiteralPath $tasksDir -Filter '*.json') {
    try {
      $tObj = Get-Content -Raw -LiteralPath $tFile.FullName | ConvertFrom-Json
      if ($tObj.filesystemPolicy) {
        $taskPolicies.Add($tObj.filesystemPolicy)
      } elseif ($tObj.allowedFiles) {
        $taskPolicies.Add((Resolve-FilesystemPolicy ([pscustomobject]@{ id = $tObj.id; allowed_files = @($tObj.allowedFiles) })))
      }
    } catch {}
  }
}
$resultsDir = Join-Path $runRoot 'results'
if ($taskPolicies.Count -eq 0 -and $manifest.tasksFile -and (Test-Path -LiteralPath $manifest.tasksFile)) {
  try {
    $planObj = Get-Content -Raw -LiteralPath $manifest.tasksFile | ConvertFrom-Json
    $taskList = if ($planObj -is [array]) { $planObj } elseif ($planObj.tasks) { $planObj.tasks } else { @() }
    foreach ($t in $taskList) {
      $taskPolicies.Add((Resolve-FilesystemPolicy $t))
    }
  } catch {}
}

$policyViolations = @()
$scopeEntries = @()
foreach ($f in $diffFiles) {
  $candidateEntries = @()
  foreach ($policy in $taskPolicies) {
    $check = Get-FilesystemScopeVerification -ChangedFiles @([string]$f) -Policy $policy
    $candidateEntries += @($check.entries)
  }
  $accepted = $candidateEntries | Where-Object authorized | Select-Object -First 1
  $entry = if ($accepted) { $accepted } else { $candidateEntries | Select-Object -First 1 }
  if ($entry) { $scopeEntries += $entry }
  if (-not $accepted) {
    $policyViolations += ([string]$f).Replace('\', '/')
  }
}
if ($policyViolations.Count -gt 0) {
  Record-Diagnostic 'policy_violation' "Policy violation: file(s) outside allowed scope: $($policyViolations -join ', ')" @{
    violations = $policyViolations
    scopeEntries = @($scopeEntries)
    changedFiles = $diffFiles
  }
  exit 1
}
$scopeVerification = [pscustomobject]@{
  filesystemPolicy = 'v2.1'
  candidateCommit = $candidateCommit
  status = 'PASS'
  entries = @($scopeEntries)
  verifiedAt = (Get-Date).ToString('o')
}
Set-ObjectProperty $manifest.integration 'scopeVerification' $scopeVerification
Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
Write-AtomicJson $manifestPath $manifest

# Validate test summaries
$failedTasks = @()
if (Test-Path -LiteralPath $resultsDir) {
  foreach ($rFile in Get-ChildItem -LiteralPath $resultsDir -Filter '*.json') {
    try {
      $rObj = Get-Content -Raw -LiteralPath $rFile.FullName | ConvertFrom-Json
      if ($rObj.status -ne 'completed' -or ($rObj.verification -and $rObj.verification.decision -ne 'PASS')) {
        $failedTasks += $rObj.taskId
      }
    } catch {}
  }
}
if ($manifest.integration -and $manifest.integration.decision -eq 'ENVIRONMENT_ERROR') {
  Record-Diagnostic 'environment_error' "Integration setup failed due to ENVIRONMENT_ERROR: $($manifest.integration.error)"
  exit 1
}

if ($failedTasks.Count -gt 0) {
  $hasEnvError = $false
  if (Test-Path -LiteralPath $resultsDir) {
    foreach ($rFile in Get-ChildItem -LiteralPath $resultsDir -Filter '*.json') {
      try {
        $rObj = Get-Content -Raw -LiteralPath $rFile.FullName | ConvertFrom-Json
        if ($rObj.verification -and $rObj.verification.decision -eq 'ENVIRONMENT_ERROR') {
          $hasEnvError = $true
        }
      } catch {}
    }
  }
  if ($hasEnvError) {
    Record-Diagnostic 'environment_error' "Worker environment error for task(s): $($failedTasks -join ', ')" @{
      failedTasks = $failedTasks
    }
  } else {
    Record-Diagnostic 'test_failed' "Worker test verification failed for task(s): $($failedTasks -join ', ')" @{
      failedTasks = $failedTasks
    }
  }
  exit 1
}

if ($manifest.integration -and $manifest.integration.tests) {
  $failedIntegTests = @($manifest.integration.tests | Where-Object { $_.status -eq 'FAIL' })
  if ($failedIntegTests.Count -gt 0) {
    Record-Diagnostic 'integration_test_failed' "Integration test command failed: $($failedIntegTests[0].command) (exit code $($failedIntegTests[0].exitCode))" @{
      failedTests = $failedIntegTests
    }
    exit 1
  }
}

# If auto-delivery is NOT enabled, stop at review
if (-not $shouldDeliver) {
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  Set-ObjectProperty $manifest 'status' 'awaiting_human_approval'
  Set-ObjectProperty $manifest 'codexReview' ([pscustomobject]@{
    status = 'completed'
    verdict = $review.verdict
    candidateCommit = $candidateCommit
    findingsCount = @($review.findings).Count
    artifact = $reviewPath
    jsonArtifact = $reviewJsonPath
    reviewedAt = (Get-Date).ToString('o')
    mainModified = $false
  })
  Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
  Write-AtomicJson $manifestPath $manifest
  Write-Output "Codex review: $reviewPath"
  Write-Output "Final status: $($manifest.status)"
  exit 0
}

# --- Delivery Phase ---

# Remote validation
$remotes = @(& git -C $repoRoot remote 2>$null)
if ($remotes -notcontains $Remote) {
  Record-Diagnostic 'missing_upstream' "Remote '$Remote' is not configured in repository."
  exit 1
}

# Fetch remote
$fetchOut = @(& git -C $repoRoot fetch --prune $Remote 2>&1 | ForEach-Object { Redact-Text $_.ToString() })
if ($LASTEXITCODE -ne 0) {
  Record-Diagnostic 'remote_fetch_failed' "Failed to fetch remote '$Remote': $($fetchOut -join ' ')" @{
    output = $fetchOut
  }
  exit 1
}

# Target and Integration branch validation
$hasLocalTarget = (& git -C $repoRoot rev-parse --verify "refs/heads/$TargetBranch" 2>$null)
$hasRemoteTarget = (& git -C $repoRoot rev-parse --verify "refs/remotes/$Remote/$TargetBranch" 2>$null)

if (-not $hasLocalTarget -and -not $hasRemoteTarget) {
  Record-Diagnostic 'target_branch_missing' "Target branch '$TargetBranch' does not exist locally or on remote '$Remote'."
  exit 1
}

if (-not $hasLocalTarget -and $hasRemoteTarget) {
  & git -C $repoRoot branch --track $TargetBranch "$Remote/$TargetBranch" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'target_branch_missing' "Failed to create local tracking branch for '$Remote/$TargetBranch'."
    exit 1
  }
}

$localTargetCommit = (& git -C $repoRoot rev-parse "refs/heads/$TargetBranch" 2>$null).Trim()
$remoteTargetCommit = if ($hasRemoteTarget) { (& git -C $repoRoot rev-parse "refs/remotes/$Remote/$TargetBranch" 2>$null).Trim() } else { $null }

# Ancestry validation: baseCommit must be ancestor of candidateCommit
& git -C $repoRoot merge-base --is-ancestor $baseCommit $candidateCommit
if ($LASTEXITCODE -ne 0) {
  Record-Diagnostic 'invalid_ancestry' "Base commit '$baseCommit' is not an ancestor of candidate commit '$candidateCommit'."
  exit 1
}

# Dirty worktree checks (excluding .agent runtime state)
$dirtyRepo = @(& git -C $repoRoot status --porcelain 2>$null | Where-Object { $_ -and ($_ -notmatch '^\?\?\s+\.agent(/|\\|$)') })
if ($dirtyRepo.Count -gt 0) {
  Record-Diagnostic 'dirty_worktree' "Repository worktree at '$repoRoot' is dirty: $($dirtyRepo -join '; ')" @{
    dirtyFiles = $dirtyRepo
  }
  exit 1
}

if ($manifest.integration.worktree -and (Test-Path -LiteralPath $manifest.integration.worktree)) {
  $dirtyInteg = @(& git -C $manifest.integration.worktree status --porcelain 2>$null | Where-Object { $_ -and ($_ -notmatch '^\?\?\s+\.agent(/|\\|$)') })
  if ($dirtyInteg.Count -gt 0) {
    Record-Diagnostic 'dirty_worktree' "Integration worktree at '$($manifest.integration.worktree)' is dirty: $($dirtyInteg -join '; ')" @{
      dirtyFiles = $dirtyInteg
    }
    exit 1
  }
}

# Local / Remote divergence checks
if ($remoteTargetCommit) {
  $mbLocalRemote = (& git -C $repoRoot merge-base $localTargetCommit $remoteTargetCommit 2>$null)
  if ($mbLocalRemote) {
    $mbLocalRemote = $mbLocalRemote.Trim()
    if ($mbLocalRemote -ne $localTargetCommit -and $mbLocalRemote -ne $remoteTargetCommit) {
      Record-Diagnostic 'divergence_detected' "Local target branch '$TargetBranch' ($localTargetCommit) and remote '$Remote/$TargetBranch' ($remoteTargetCommit) have diverged." @{
        localCommit = $localTargetCommit
        remoteCommit = $remoteTargetCommit
        commonAncestor = $mbLocalRemote
      }
      exit 1
    }
  }

  if ($remoteTargetCommit -ne $baseCommit) {
    & git -C $repoRoot merge-base --is-ancestor $remoteTargetCommit $candidateCommit
    if ($LASTEXITCODE -ne 0) {
      Record-Diagnostic 'divergence_detected' "Remote '$Remote/$TargetBranch' ($remoteTargetCommit) has commits not present in candidate commit '$candidateCommit'." @{
        remoteCommit = $remoteTargetCommit
        candidateCommit = $candidateCommit
      }
      exit 1
    }
  }
}

if ($localTargetCommit -ne $baseCommit) {
  & git -C $repoRoot merge-base --is-ancestor $localTargetCommit $candidateCommit
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'divergence_detected' "Local target branch '$TargetBranch' ($localTargetCommit) has commits not present in candidate commit '$candidateCommit'." @{
      localCommit = $localTargetCommit
      candidateCommit = $candidateCommit
    }
    exit 1
  }
}

# Candidate commit verification
$allVerifyCommands = [System.Collections.Generic.List[object]]::new()
function Add-VerifyCommand($item) {
  if ($null -eq $item) { return }
  $itemCmd = if ($item -is [string]) { $item.Trim() } elseif ($item.PSObject.Properties.Name -contains 'command') { [string]$item.command } else { [string]$item }
  if ([string]::IsNullOrWhiteSpace($itemCmd)) { return }
  foreach ($existing in $allVerifyCommands) {
    $existingCmd = if ($existing -is [string]) { $existing.Trim() } elseif ($existing.PSObject.Properties.Name -contains 'command') { [string]$existing.command } else { [string]$existing }
    if ($existingCmd -eq $itemCmd) { return }
  }
  [void]$allVerifyCommands.Add($item)
}

if ($manifest.integrationTestCommands) {
  foreach ($cmd in @($manifest.integrationTestCommands)) {
    Add-VerifyCommand $cmd
  }
}
if ($manifest.integration -and $manifest.integration.tests) {
  foreach ($t in @($manifest.integration.tests)) {
    Add-VerifyCommand $t
  }
}
if (Test-Path -LiteralPath $tasksDir) {
  foreach ($tFile in Get-ChildItem -LiteralPath $tasksDir -Filter '*.json') {
    try {
      $tObj = Get-Content -Raw -LiteralPath $tFile.FullName | ConvertFrom-Json
      foreach ($cmd in @($tObj.testCommands)) {
        Add-VerifyCommand $cmd
      }
    } catch {}
  }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$alreadyCandidateVerified = ($manifest.delivery -and $manifest.delivery.candidateVerifiedCommit -eq $candidateCommit)

if (-not $alreadyCandidateVerified) {
  $rehearsalWorktree = Join-Path $runRoot 'verify-rehearsal'
  if (Test-Path -LiteralPath $rehearsalWorktree) {
    & git -C $repoRoot worktree remove $rehearsalWorktree --force 2>$null
    if (Test-Path -LiteralPath $rehearsalWorktree) {
      Remove-Item -LiteralPath $rehearsalWorktree -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  & git -C $repoRoot worktree add --detach $rehearsalWorktree $candidateCommit 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'rehearsal_worktree_failed' "Failed to create rehearsal worktree for candidate commit '$candidateCommit'."
    exit 1
  }

  $bootRehearsal = Ensure-DashboardDependencies -Worktree $rehearsalWorktree -SourceWorktree $repoRoot
  if (-not $bootRehearsal.success) {
    Record-Diagnostic 'environment_error' "Dashboard dependency bootstrap failed in rehearsal worktree: $($bootRehearsal.error)" @{
      worktree = $rehearsalWorktree
      timedOut = $bootRehearsal.timedOut
      exitCode = $bootRehearsal.exitCode
      output   = $bootRehearsal.output
    }
    exit 1
  }

  try {
    $rehearsalHead = (& git -C $rehearsalWorktree rev-parse HEAD 2>$null).Trim()
    if ($rehearsalHead -ne $candidateCommit) {
      Record-Diagnostic 'rehearsal_head_mismatch' "Rehearsal worktree HEAD '$rehearsalHead' does not match candidate commit '$candidateCommit'." @{
        rehearsalHead   = $rehearsalHead
        candidateCommit = $candidateCommit
      }
      exit 1
    }

    $candResults = @(Invoke-Verification $rehearsalWorktree $allVerifyCommands)
    $candFails = @($candResults | Where-Object { $_.status -in @('FAIL', 'TIMED_OUT') -or ($null -ne $_.exitCode -and $_.exitCode -ne 0) -or $_.timedOut })
    if ($candFails.Count -gt 0) {
      $failedItem = $candFails[0]
      Record-Diagnostic 'verification_failed' "Candidate commit verification failed: $($failedItem.command) (status $($failedItem.status), exit $($failedItem.exitCode))" @{
        failedCommand = $failedItem.command
        status        = $failedItem.status
        exitCode      = $failedItem.exitCode
        output        = $failedItem.output
        timedOut      = $failedItem.timedOut
      }
      exit 1
    }
  } finally {
    if (Test-Path -LiteralPath $rehearsalWorktree) {
      & git -C $repoRoot worktree remove $rehearsalWorktree --force 2>$null
      if (Test-Path -LiteralPath $rehearsalWorktree) {
        Remove-Item -LiteralPath $rehearsalWorktree -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if (-not $manifest.delivery) {
    Set-ObjectProperty $manifest 'delivery' ([pscustomobject]@{})
  }
  Set-ObjectProperty $manifest.delivery 'candidateVerifiedCommit' $candidateCommit
  Set-ObjectProperty $manifest.delivery 'mainVerifiedCommit' $candidateCommit
  Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
  Write-AtomicJson $manifestPath $manifest
}

# Non-destructive integration into target branch (fast-forward only)
$alreadyIntegrated = $false
& git -C $repoRoot merge-base --is-ancestor $candidateCommit "refs/heads/$TargetBranch"
if ($LASTEXITCODE -eq 0) {
  $alreadyIntegrated = $true
}

if (-not $alreadyIntegrated) {
  $currentBranch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null).Trim()
  if ($currentBranch -ne $TargetBranch) {
    $switchOut = @(& git -C $repoRoot switch $TargetBranch 2>&1 | ForEach-Object { Redact-Text $_.ToString() })
    if ($LASTEXITCODE -ne 0) {
      Record-Diagnostic 'switch_failed' "Failed to switch to target branch '$TargetBranch': $($switchOut -join ' ')"
      exit 1
    }
  }

  $mergeOut = @(& git -C $repoRoot merge --ff-only $candidateCommit 2>&1 | ForEach-Object { Redact-Text $_.ToString() })
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'merge_conflict' "Non-destructive fast-forward merge failed for candidate commit '$candidateCommit': $($mergeOut -join ' ')" @{
      output = $mergeOut
    }
    exit 1
  }

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if (-not $manifest.delivery) {
    Set-ObjectProperty $manifest 'delivery' ([pscustomobject]@{})
  }
  Set-ObjectProperty $manifest.delivery 'integratedCommit' $candidateCommit
  Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
  Write-AtomicJson $manifestPath $manifest
}

# Post-integration deterministic Git invariants (no application verification after advancing real main)
$targetRefCommit = (& git -C $repoRoot rev-parse "refs/heads/$TargetBranch" 2>$null).Trim()
if ($targetRefCommit -ne $candidateCommit) {
  Record-Diagnostic 'target_ref_mismatch' "Target branch '$TargetBranch' ref ($targetRefCommit) does not match candidate commit '$candidateCommit'." @{
    targetBranch    = $TargetBranch
    targetRefCommit = $targetRefCommit
    candidateCommit = $candidateCommit
  }
  exit 1
}

$dirtyRepoPost = @(& git -C $repoRoot status --porcelain 2>$null | Where-Object { $_ -and ($_ -notmatch '^\?\?\s+\.agent(/|\\|$)') })
if ($dirtyRepoPost.Count -gt 0) {
  Record-Diagnostic 'dirty_worktree' "Repository worktree at '$repoRoot' is dirty after integration: $($dirtyRepoPost -join '; ')" @{
    dirtyFiles = $dirtyRepoPost
  }
  exit 1
}

& git -C $repoRoot merge-base --is-ancestor $baseCommit "refs/heads/$TargetBranch"
if ($LASTEXITCODE -ne 0) {
  Record-Diagnostic 'invalid_ancestry' "Base commit '$baseCommit' is not an ancestor of target branch '$TargetBranch'."
  exit 1
}

if ($remoteTargetCommit) {
  & git -C $repoRoot merge-base --is-ancestor $remoteTargetCommit $candidateCommit
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'divergence_detected' "Remote '$Remote/$TargetBranch' ($remoteTargetCommit) is not an ancestor of candidate commit '$candidateCommit'." @{
      remoteCommit    = $remoteTargetCommit
      candidateCommit = $candidateCommit
    }
    exit 1
  }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if (-not $manifest.delivery) {
  Set-ObjectProperty $manifest 'delivery' ([pscustomobject]@{})
}
Set-ObjectProperty $manifest.delivery 'mainVerifiedCommit' $candidateCommit
Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
Write-AtomicJson $manifestPath $manifest

# Normal remote push (never --force, -f, --force-with-lease)
$alreadyPushed = $false
if ($remoteTargetCommit) {
  & git -C $repoRoot merge-base --is-ancestor $candidateCommit "refs/remotes/$Remote/$TargetBranch"
  if ($LASTEXITCODE -eq 0) {
    $alreadyPushed = $true
  }
}

if (-not $alreadyPushed) {
  $pushOut = @(& git -C $repoRoot push $Remote $TargetBranch 2>&1 | ForEach-Object { Redact-Text $_.ToString() })
  if ($LASTEXITCODE -ne 0) {
    Record-Diagnostic 'push_rejected' "Push to $Remote/$TargetBranch was rejected: $($pushOut -join ' ')" @{
      output = $pushOut
    }
    exit 1
  }
}

# Complete delivery
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
Set-ObjectProperty $manifest 'status' 'completed'
Set-ObjectProperty $manifest 'codexReview' ([pscustomobject]@{
  status = 'completed'
  verdict = $review.verdict
  candidateCommit = $candidateCommit
  findingsCount = @($review.findings).Count
  artifact = $reviewPath
  jsonArtifact = $reviewJsonPath
  reviewedAt = (Get-Date).ToString('o')
  mainModified = $true
})
Set-ObjectProperty $manifest 'delivery' ([pscustomobject]@{
  status = 'completed'
  targetBranch = $TargetBranch
  remote = $Remote
  commit = $candidateCommit
  candidateVerifiedCommit = $candidateCommit
  mainVerifiedCommit = $candidateCommit
  deliveredAt = (Get-Date).ToString('o')
})
Set-ObjectProperty $manifest 'updatedAt' (Get-Date).ToString('o')
Write-AtomicJson $manifestPath $manifest

Write-Output "Codex review: $reviewPath"
Write-Output "Delivery completed: $TargetBranch at $candidateCommit pushed to $Remote"
Write-Output "Final status: $($manifest.status)"
exit 0
