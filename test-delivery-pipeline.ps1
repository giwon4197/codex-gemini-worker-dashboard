[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$reviewScript = Join-Path $repoRoot 'review-integration.ps1'
$routerScript = Join-Path $repoRoot 'codex-router.ps1'
$workersScript = Join-Path $repoRoot 'run-parallel-workers.ps1'

if (-not (Test-Path -LiteralPath $reviewScript)) {
  Write-Error "review-integration.ps1 not found: $reviewScript"
  exit 1
}

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-delivery-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testTempRoot -Force | Out-Null

$passCount = 0
$failCount = 0

function Assert-Test([string]$testName, [bool]$condition, [string]$detail = '') {
  if ($condition) {
    Write-Host "  [PASS] $testName" -ForegroundColor Green
    $script:passCount++
  } else {
    Write-Host "  [FAIL] $testName" -ForegroundColor Red
    if ($detail) {
      Write-Host "         Detail: $detail" -ForegroundColor Yellow
    }
    $script:failCount++
  }
}

function New-IsolatedTestRepo([string]$RootPath) {
  $remoteDir = Join-Path $RootPath 'remote.git'
  $localDir = Join-Path $RootPath 'local'

  @($remoteDir, $localDir) | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_)) {
      New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
  }

  & git init --bare -b main $remoteDir 2>$null | Out-Null
  & git -C $localDir init -b main 2>$null | Out-Null
  & git -C $localDir config user.name 'Test Delivery Runner'
  & git -C $localDir config user.email 'delivery@test.local'
  & git -C $localDir config commit.gpgSign false

  [IO.File]::WriteAllText((Join-Path $localDir '.gitignore'), ".agent/`nworker-settings.json`n", [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $localDir 'README.md'), "# Test Repository`n", [Text.Encoding]::UTF8)
  & git -C $localDir add .gitignore README.md
  & git -C $localDir commit -m "initial commit" 2>$null | Out-Null

  $remoteUrl = $remoteDir.Replace('\', '/')
  & git -C $localDir remote add origin $remoteUrl
  & git -C $localDir push -u origin main 2>$null | Out-Null

  return [pscustomobject]@{
    RemoteDir = $remoteDir
    LocalDir = $localDir
    RemoteUrl = $remoteUrl
  }
}

function Setup-MockRun([string]$LocalRepo, [string]$RunId, [string]$BaseCommit, [string]$IntegrationBranch, [string[]]$AllowedFiles, [string[]]$TestCommands, [string]$Verdict = 'PASS', [hashtable]$Extra = @{}) {
  $runRoot = Join-Path $LocalRepo ".agent\runs\$RunId"
  @((Join-Path $runRoot 'tasks'), (Join-Path $runRoot 'results')) | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_)) {
      New-Item -ItemType Directory -Path $_ -Force | Out-Null
    }
  }

  $taskObj = [pscustomobject]@{
    id = 'TASK-001'
    name = 'Test Task'
    allowedFiles = $AllowedFiles
    testCommands = $TestCommands
  }
  [IO.File]::WriteAllText((Join-Path $runRoot 'tasks\TASK-001.json'), ($taskObj | ConvertTo-Json), [Text.Encoding]::UTF8)

  $resultObj = [pscustomobject]@{
    runId = $RunId
    taskId = 'TASK-001'
    status = if ($Extra.TaskFailed) { 'failed' } else { 'completed' }
    commitHashes = @()
    policy = [pscustomobject]@{
      allowedFiles = $AllowedFiles
      violations = @()
      status = 'PASS'
    }
    verification = [pscustomobject]@{
      decision = if ($Extra.TaskFailed) { 'FAIL' } else { 'PASS' }
      commands = @()
    }
  }
  [IO.File]::WriteAllText((Join-Path $runRoot 'results\TASK-001-result.json'), ($resultObj | ConvertTo-Json), [Text.Encoding]::UTF8)

  $reviewObj = [pscustomobject]@{
    verdict = $Verdict
    summary = if ($Verdict -eq 'PASS') { 'Review passed cleanly' } else { 'Review requested fixes' }
    findings = if ($Verdict -eq 'PASS') { @() } else {
      @([pscustomobject]@{ severity = 'P1'; title = 'Fix required'; file = 'file.txt'; line = 1; body = 'Fix required' })
    }
  }
  [IO.File]::WriteAllText((Join-Path $runRoot 'codex-review.json'), ($reviewObj | ConvertTo-Json), [Text.Encoding]::UTF8)

  $candCommit = (& git -C $LocalRepo rev-parse "refs/heads/$IntegrationBranch" 2>$null)
  if ($candCommit) { $candCommit = $candCommit.Trim() }

  $manifest = [pscustomobject]@{
    runId = $RunId
    status = 'awaiting_review'
    repository = $LocalRepo
    baseCommit = $BaseCommit
    tasks = @('TASK-001')
    tasksFile = (Join-Path $runRoot 'tasks\TASK-001.json')
    integrationBranch = $IntegrationBranch
    integrationTestCommands = $TestCommands
    integration = [pscustomobject]@{
      id = "$RunId-integration"
      branch = $IntegrationBranch
      worktree = (Join-Path $LocalRepo ".agent\worktrees\$RunId\integration")
      baseCommit = $BaseCommit
      headCommit = $candCommit
      decision = 'AWAITING_CODEX_REVIEW'
      mainModified = $false
      tests = @()
      changedFiles = @()
    }
  }
  [IO.File]::WriteAllText((Join-Path $runRoot 'run.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)

  return $manifest
}

try {
  Write-Host "======================================================" -ForegroundColor Cyan
  Write-Host "   PowerShell Control Plane Automatic Delivery Tests   " -ForegroundColor Cyan
  Write-Host "======================================================" -ForegroundColor Cyan

  # 1. Success Delivery Test
  Write-Host "`n1. Success: Worker integration -> Review -> Verify -> Merge -> Post-verify -> Push" -ForegroundColor Yellow
  $case1Dir = Join-Path $testTempRoot 'case1-success'
  $case1 = New-IsolatedTestRepo $case1Dir
  $baseCommit1 = (& git -C $case1.LocalDir rev-parse HEAD).Trim()

  $integBranch1 = 'integration/run-001'
  & git -C $case1.LocalDir switch -c $integBranch1 $baseCommit1 2>$null | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $case1.LocalDir 'src') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $case1.LocalDir 'src\app.ps1'), 'Write-Output "Hello World"', [Text.Encoding]::UTF8)
  & git -C $case1.LocalDir add src/app.ps1
  & git -C $case1.LocalDir commit -m "feat(app): add app.ps1" 2>$null | Out-Null
  $candCommit1 = (& git -C $case1.LocalDir rev-parse HEAD).Trim()
  & git -C $case1.LocalDir switch main 2>$null | Out-Null

  $manifest1 = Setup-MockRun $case1.LocalDir 'run-001' $baseCommit1 $integBranch1 @('src/**') @('pwsh -NoProfile -Command exit 0') 'PASS'

  $out1 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-001' -Repository $case1.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit1 = $LASTEXITCODE

  Assert-Test "Delivery execution returns exit code 0" ($exit1 -eq 0) ($out1 -join "`n")
  $localMainCommit1 = (& git -C $case1.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Local main fast-forwarded to candidate commit" ($localMainCommit1 -eq $candCommit1) "Expected $candCommit1, got $localMainCommit1"
  $remoteMainCommit1 = (& git -C $case1.LocalDir rev-parse refs/remotes/origin/main).Trim()
  Assert-Test "Remote origin/main updated to candidate commit" ($remoteMainCommit1 -eq $candCommit1) "Expected $candCommit1, got $remoteMainCommit1"
  $updatedManifest1 = Get-Content -Raw -LiteralPath (Join-Path $case1.LocalDir '.agent\runs\run-001\run.json') | ConvertFrom-Json
  Assert-Test "Manifest status is completed" ($updatedManifest1.status -eq 'completed') "Got $($updatedManifest1.status)"
  Assert-Test "Manifest records delivery object" ($updatedManifest1.delivery -and $updatedManifest1.delivery.status -eq 'completed') "Got $($updatedManifest1.delivery.status)"
  Assert-Test "Delivery diagnostic artifact is NOT created on success" (-not (Test-Path -LiteralPath (Join-Path $case1.LocalDir '.agent\runs\run-001\delivery-diagnostic.json')))

  # 2. Merge Conflict Test
  Write-Host "`n2. Merge Conflict: Conflicting branch change stops delivery and creates diagnostic" -ForegroundColor Yellow
  $case2Dir = Join-Path $testTempRoot 'case2-conflict'
  $case2 = New-IsolatedTestRepo $case2Dir
  $baseCommit2 = (& git -C $case2.LocalDir rev-parse HEAD).Trim()

  $integBranch2 = 'integration/run-002'
  & git -C $case2.LocalDir switch -c $integBranch2 $baseCommit2 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case2.LocalDir 'shared.txt'), 'Integration branch content', [Text.Encoding]::UTF8)
  & git -C $case2.LocalDir add shared.txt
  & git -C $case2.LocalDir commit -m "integ change" 2>$null | Out-Null
  & git -C $case2.LocalDir switch main 2>$null | Out-Null

  # Make conflicting commit on main
  [IO.File]::WriteAllText((Join-Path $case2.LocalDir 'shared.txt'), 'Conflicting main content', [Text.Encoding]::UTF8)
  & git -C $case2.LocalDir add shared.txt
  & git -C $case2.LocalDir commit -m "main conflict" 2>$null | Out-Null
  & git -C $case2.LocalDir push origin main 2>$null | Out-Null
  $mainBefore2 = (& git -C $case2.LocalDir rev-parse refs/heads/main).Trim()

  $manifest2 = Setup-MockRun $case2.LocalDir 'run-002' $baseCommit2 $integBranch2 @('shared.txt') @('pwsh -NoProfile -Command exit 0') 'PASS'

  $out2 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-002' -Repository $case2.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit2 = $LASTEXITCODE

  Assert-Test "Delivery fails with non-zero exit code on conflict" ($exit2 -ne 0)
  $mainAfter2 = (& git -C $case2.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Main branch was NOT overwritten" ($mainAfter2 -eq $mainBefore2)
  $updatedManifest2 = Get-Content -Raw -LiteralPath (Join-Path $case2.LocalDir '.agent\runs\run-002\run.json') | ConvertFrom-Json
  Assert-Test "Manifest status is escalated" ($updatedManifest2.status -eq 'escalated') "Got $($updatedManifest2.status)"
  $diagPath2 = Join-Path $case2.LocalDir '.agent\runs\run-002\delivery-diagnostic.json'
  Assert-Test "Diagnostic artifact was written" (Test-Path -LiteralPath $diagPath2)
  $diagObj2 = Get-Content -Raw -LiteralPath $diagPath2 | ConvertFrom-Json
  Assert-Test "Diagnostic records failure category" ($diagObj2.errorCategory -in @('merge_conflict', 'divergence_detected')) "Got $($diagObj2.errorCategory)"

  # 3. Local / Remote Divergence Test
  Write-Host "`n3. Local/Remote Divergence: Remote has unmerged commits" -ForegroundColor Yellow
  $case3Dir = Join-Path $testTempRoot 'case3-divergence'
  $case3 = New-IsolatedTestRepo $case3Dir
  $baseCommit3 = (& git -C $case3.LocalDir rev-parse HEAD).Trim()

  $integBranch3 = 'integration/run-003'
  & git -C $case3.LocalDir switch -c $integBranch3 $baseCommit3 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case3.LocalDir 'integ.txt'), 'Candidate', [Text.Encoding]::UTF8)
  & git -C $case3.LocalDir add integ.txt
  & git -C $case3.LocalDir commit -m "candidate" 2>$null | Out-Null
  & git -C $case3.LocalDir switch main 2>$null | Out-Null

  # Clone another repo to push a commit to origin
  $otherCloneDir = Join-Path $case3Dir 'other-clone'
  & git clone -b main $case3.RemoteUrl $otherCloneDir 2>$null | Out-Null
  & git -C $otherCloneDir config user.name 'Remote Committer'
  & git -C $otherCloneDir config user.email 'remote@local'
  [IO.File]::WriteAllText((Join-Path $otherCloneDir 'remote-work.txt'), 'New remote work', [Text.Encoding]::UTF8)
  & git -C $otherCloneDir add remote-work.txt
  & git -C $otherCloneDir commit -m "remote commit" 2>$null | Out-Null
  & git -C $otherCloneDir push origin main 2>$null | Out-Null
  $remoteExpectedCommit3 = (& git -C $otherCloneDir rev-parse HEAD).Trim()

  $manifest3 = Setup-MockRun $case3.LocalDir 'run-003' $baseCommit3 $integBranch3 @('integ.txt') @('pwsh -NoProfile -Command exit 0') 'PASS'

  $out3 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-003' -Repository $case3.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit3 = $LASTEXITCODE

  Assert-Test "Delivery fails when remote has diverged" ($exit3 -ne 0)
  $remoteActualCommit3 = (& git -C $otherCloneDir rev-parse refs/remotes/origin/main).Trim()
  Assert-Test "Remote work was NOT overwritten" ($remoteActualCommit3 -eq $remoteExpectedCommit3)
  $updatedManifest3 = Get-Content -Raw -LiteralPath (Join-Path $case3.LocalDir '.agent\runs\run-003\run.json') | ConvertFrom-Json
  Assert-Test "Manifest records divergence escalation" ($updatedManifest3.status -eq 'escalated' -and $updatedManifest3.errorCategory -eq 'divergence_detected')

  # 4. Failed Verification Commands Test
  Write-Host "`n4. Failed Tests: Pre-delivery candidate verification failure blocks merge and push" -ForegroundColor Yellow
  $case4Dir = Join-Path $testTempRoot 'case4-failed-tests'
  $case4 = New-IsolatedTestRepo $case4Dir
  $baseCommit4 = (& git -C $case4.LocalDir rev-parse HEAD).Trim()

  $integBranch4 = 'integration/run-004'
  & git -C $case4.LocalDir switch -c $integBranch4 $baseCommit4 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case4.LocalDir 'broken.txt'), 'Broken code', [Text.Encoding]::UTF8)
  & git -C $case4.LocalDir add broken.txt
  & git -C $case4.LocalDir commit -m "broken commit" 2>$null | Out-Null
  & git -C $case4.LocalDir switch main 2>$null | Out-Null

  # Plan requires test command that fails
  $manifest4 = Setup-MockRun $case4.LocalDir 'run-004' $baseCommit4 $integBranch4 @('broken.txt') @('pwsh -NoProfile -Command exit 1') 'PASS'

  $out4 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-004' -Repository $case4.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit4 = $LASTEXITCODE

  Assert-Test "Delivery fails when verification command fails" ($exit4 -ne 0)
  $mainCurrent4 = (& git -C $case4.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Main branch remains at baseCommit" ($mainCurrent4 -eq $baseCommit4)
  $updatedManifest4 = Get-Content -Raw -LiteralPath (Join-Path $case4.LocalDir '.agent\runs\run-004\run.json') | ConvertFrom-Json
  Assert-Test "Manifest status is failed" ($updatedManifest4.status -eq 'failed')
  Assert-Test "Diagnostic artifact created for failed verification" (Test-Path -LiteralPath (Join-Path $case4.LocalDir '.agent\runs\run-004\delivery-diagnostic.json'))

  # 5. Failed Review and Policy Violations
  Write-Host "`n5. Failed Review / Policy: REQUEST_FIX and unexpected files stop delivery" -ForegroundColor Yellow
  # 5A: REQUEST_FIX
  $case5aDir = Join-Path $testTempRoot 'case5a-review-fix'
  $case5a = New-IsolatedTestRepo $case5aDir
  $baseCommit5a = (& git -C $case5a.LocalDir rev-parse HEAD).Trim()
  $integBranch5a = 'integration/run-005a'
  & git -C $case5a.LocalDir switch -c $integBranch5a $baseCommit5a 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case5a.LocalDir 'fixme.txt'), 'Fix me', [Text.Encoding]::UTF8)
  & git -C $case5a.LocalDir add fixme.txt
  & git -C $case5a.LocalDir commit -m "fixme commit" 2>$null | Out-Null
  & git -C $case5a.LocalDir switch main 2>$null | Out-Null

  $manifest5a = Setup-MockRun $case5a.LocalDir 'run-005a' $baseCommit5a $integBranch5a @('fixme.txt') @('pwsh -NoProfile -Command exit 0') 'REQUEST_FIX'
  $out5a = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-005a' -Repository $case5a.LocalDir -AutoDeliver 2>&1)
  $exit5a = $LASTEXITCODE

  Assert-Test "REQUEST_FIX verdict causes non-zero exit code" ($exit5a -ne 0)
  $updatedManifest5a = Get-Content -Raw -LiteralPath (Join-Path $case5a.LocalDir '.agent\runs\run-005a\run.json') | ConvertFrom-Json
  Assert-Test "Status is escalated for REQUEST_FIX" ($updatedManifest5a.status -eq 'escalated')
  Assert-Test "Diagnostic records changes_requested" ($updatedManifest5a.errorCategory -eq 'changes_requested')

  # 5B: Policy Violation (unexpected file)
  $case5bDir = Join-Path $testTempRoot 'case5b-policy'
  $case5b = New-IsolatedTestRepo $case5bDir
  $baseCommit5b = (& git -C $case5b.LocalDir rev-parse HEAD).Trim()
  $integBranch5b = 'integration/run-005b'
  & git -C $case5b.LocalDir switch -c $integBranch5b $baseCommit5b 2>$null | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $case5b.LocalDir 'secrets') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $case5b.LocalDir 'secrets\keys.txt'), 'Secret content', [Text.Encoding]::UTF8)
  & git -C $case5b.LocalDir add secrets/keys.txt
  & git -C $case5b.LocalDir commit -m "policy violation commit" 2>$null | Out-Null
  & git -C $case5b.LocalDir switch main 2>$null | Out-Null

  # Task only allows src/**, but branch touched secrets/keys.txt
  $manifest5b = Setup-MockRun $case5b.LocalDir 'run-005b' $baseCommit5b $integBranch5b @('src/**') @('pwsh -NoProfile -Command exit 0') 'PASS'
  $out5b = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-005b' -Repository $case5b.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit5b = $LASTEXITCODE

  Assert-Test "Policy violation causes non-zero exit code" ($exit5b -ne 0)
  $updatedManifest5b = Get-Content -Raw -LiteralPath (Join-Path $case5b.LocalDir '.agent\runs\run-005b\run.json') | ConvertFrom-Json
  Assert-Test "Status is escalated for policy_violation" ($updatedManifest5b.status -eq 'escalated')
  Assert-Test "Diagnostic records policy_violation" ($updatedManifest5b.errorCategory -eq 'policy_violation')

  # 6. Push Rejection Test
  Write-Host "`n6. Push Rejection: Remote hook rejects push" -ForegroundColor Yellow
  $case6Dir = Join-Path $testTempRoot 'case6-push-rejection'
  $case6 = New-IsolatedTestRepo $case6Dir
  $baseCommit6 = (& git -C $case6.LocalDir rev-parse HEAD).Trim()

  # Create pre-receive hook in remote that rejects pushes
  $hookDir = Join-Path $case6.RemoteDir 'hooks'
  if (-not (Test-Path -LiteralPath $hookDir)) {
    New-Item -ItemType Directory -Path $hookDir -Force | Out-Null
  }
  $hookFile = Join-Path $hookDir 'pre-receive'
  $hookContent = "#!/bin/sh`necho 'Push rejected by remote security policy' >&2`nexit 1`n"
  [IO.File]::WriteAllText($hookFile, $hookContent, [Text.Encoding]::ASCII)

  $integBranch6 = 'integration/run-006'
  & git -C $case6.LocalDir switch -c $integBranch6 $baseCommit6 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case6.LocalDir 'feature6.txt'), 'Feature 6', [Text.Encoding]::UTF8)
  & git -C $case6.LocalDir add feature6.txt
  & git -C $case6.LocalDir commit -m "feature 6" 2>$null | Out-Null
  & git -C $case6.LocalDir switch main 2>$null | Out-Null

  $manifest6 = Setup-MockRun $case6.LocalDir 'run-006' $baseCommit6 $integBranch6 @('feature6.txt') @('pwsh -NoProfile -Command exit 0') 'PASS'

  $out6 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-006' -Repository $case6.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit6 = $LASTEXITCODE

  Assert-Test "Push rejection returns non-zero exit code" ($exit6 -ne 0)
  $updatedManifest6 = Get-Content -Raw -LiteralPath (Join-Path $case6.LocalDir '.agent\runs\run-006\run.json') | ConvertFrom-Json
  Assert-Test "Manifest status is escalated on push rejection" ($updatedManifest6.status -eq 'escalated')
  Assert-Test "Diagnostic records push_rejected" ($updatedManifest6.errorCategory -eq 'push_rejected')

  # 7. Rerun Idempotency Test
  Write-Host "`n7. Rerun Idempotency: Re-running completed delivery is idempotent and non-duplicating" -ForegroundColor Yellow
  $mainBeforeRerun = (& git -C $case1.LocalDir rev-parse refs/heads/main).Trim()
  $commitCountBefore = @(& git -C $case1.LocalDir rev-list HEAD).Count

  $outRerun = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-001' -Repository $case1.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exitRerun = $LASTEXITCODE

  Assert-Test "Rerun on already-delivered run succeeds with exit code 0" ($exitRerun -eq 0) ($outRerun -join "`n")
  $mainAfterRerun = (& git -C $case1.LocalDir rev-parse refs/heads/main).Trim()
  $commitCountAfter = @(& git -C $case1.LocalDir rev-list HEAD).Count
  Assert-Test "Commit hash is unchanged after rerun" ($mainAfterRerun -eq $mainBeforeRerun)
  Assert-Test "No duplicate commits were created" ($commitCountAfter -eq $commitCountBefore)
  $rerunManifest = Get-Content -Raw -LiteralPath (Join-Path $case1.LocalDir '.agent\runs\run-001\run.json') | ConvertFrom-Json
  Assert-Test "Manifest remains completed" ($rerunManifest.status -eq 'completed')

  # 8. Compact Diagnostics & Redaction Test
  Write-Host "`n8. Compact Diagnostics & Redaction: Secrets and credentials are redacted" -ForegroundColor Yellow
  $case8Dir = Join-Path $testTempRoot 'case8-redaction'
  $case8 = New-IsolatedTestRepo $case8Dir
  $baseCommit8 = (& git -C $case8.LocalDir rev-parse HEAD).Trim()

  $integBranch8 = 'integration/run-008'
  & git -C $case8.LocalDir switch -c $integBranch8 $baseCommit8 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case8.LocalDir 'test8.txt'), 'test', [Text.Encoding]::UTF8)
  & git -C $case8.LocalDir add test8.txt
  & git -C $case8.LocalDir commit -m "test 8" 2>$null | Out-Null
  & git -C $case8.LocalDir switch main 2>$null | Out-Null

  # Fail with output containing various secret formats
  $secretCommand = 'pwsh -NoProfile -Command "[Console]::Error.WriteLine(''Failed with token ghp_ABC1234567890abcdef1234567890 and url https://user:secretpassword123@github.com/test.git and Authorization: Bearer secret_bearer_token and AIzaSyD-1234567890123456789012345678901''); exit 1"'
  $manifest8 = Setup-MockRun $case8.LocalDir 'run-008' $baseCommit8 $integBranch8 @('test8.txt') @($secretCommand) 'PASS'

  $out8 = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-008' -Repository $case8.LocalDir -AutoDeliver -SkipCodexReview 2>&1)

  $diagJsonPath8 = Join-Path $case8.LocalDir '.agent\runs\run-008\delivery-diagnostic.json'
  Assert-Test "Diagnostic JSON exists" (Test-Path -LiteralPath $diagJsonPath8)
  $diagRaw8 = Get-Content -Raw -LiteralPath $diagJsonPath8

  Assert-Test "GitHub PAT is redacted" (-not ($diagRaw8.Contains('ghp_ABC1234567890abcdef1234567890')))
  Assert-Test "URL credentials are redacted" (-not ($diagRaw8.Contains('secretpassword123')))
  Assert-Test "Bearer token is redacted" (-not ($diagRaw8.Contains('secret_bearer_token')))
  Assert-Test "Google API key is redacted" (-not ($diagRaw8.Contains('AIzaSyD-1234567890123456789012345678901')))
  Assert-Test "Redaction placeholders are present" ($diagRaw8.Contains('[REDACTED_TOKEN]') -and $diagRaw8.Contains('[REDACTED_CREDENTIALS]'))
  $diagFileInfo = Get-Item -LiteralPath $diagJsonPath8
  Assert-Test "Diagnostic artifact is compact (< 10KB)" ($diagFileInfo.Length -lt 10240) "Size was $($diagFileInfo.Length) bytes"

  # 9. Hard Guarantee: No Force-Push Form Is Invoked
  Write-Host "`n9. Hard Guarantee: Zero force-push forms in any control plane script" -ForegroundColor Yellow
  $scriptsToCheck = @(
    (Join-Path $repoRoot 'review-integration.ps1'),
    (Join-Path $repoRoot 'codex-router.ps1'),
    (Join-Path $repoRoot 'run-parallel-workers.ps1')
  )

  $forcePushDetected = $false
  foreach ($s in $scriptsToCheck) {
    $content = Get-Content -Raw -LiteralPath $s
    if ($content -match 'git\s+(?:-[^ ]+\s+)*push\s+[^;`r`n]*?(?:--force|-f\b|--force-with-lease|\+[a-zA-Z0-9_/]+)') {
      $forcePushDetected = $true
      Write-Host "Force push pattern detected in: $(Split-Path -Leaf $s)" -ForegroundColor Red
    }
    if ($content -match 'git\s+reset\s+--hard') {
      $forcePushDetected = $true
      Write-Host "git reset --hard detected in: $(Split-Path -Leaf $s)" -ForegroundColor Red
    }
  }
  Assert-Test "Hard guarantee: zero force-push or destructive reset invocations" (-not $forcePushDetected)

  # 10. Configuration & CLI Switches
  Write-Host "`n10. Configuration & CLI Switches: AutoDeliver toggle and default behavior" -ForegroundColor Yellow
  $case10Dir = Join-Path $testTempRoot 'case10-toggle'
  $case10 = New-IsolatedTestRepo $case10Dir
  $baseCommit10 = (& git -C $case10.LocalDir rev-parse HEAD).Trim()

  $integBranch10 = 'integration/run-010'
  & git -C $case10.LocalDir switch -c $integBranch10 $baseCommit10 2>$null | Out-Null
  [IO.File]::WriteAllText((Join-Path $case10.LocalDir 'toggle.txt'), 'Toggle test', [Text.Encoding]::UTF8)
  & git -C $case10.LocalDir add toggle.txt
  & git -C $case10.LocalDir commit -m "toggle test" 2>$null | Out-Null
  & git -C $case10.LocalDir switch main 2>$null | Out-Null

  # 10A: With autoDeliver: false in worker-settings.json, review-integration stops at awaiting_human_approval
  $noDeliverSettings = @{ tier = 'normal'; autoDeliver = $false }
  [IO.File]::WriteAllText((Join-Path $case10.LocalDir 'worker-settings.json'), ($noDeliverSettings | ConvertTo-Json), [Text.Encoding]::UTF8)

  $manifest10a = Setup-MockRun $case10.LocalDir 'run-010' $baseCommit10 $integBranch10 @('toggle.txt') @('pwsh -NoProfile -Command exit 0') 'PASS'
  $out10a = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-010' -Repository $case10.LocalDir -SkipCodexReview 2>&1)
  $exit10a = $LASTEXITCODE

  Assert-Test "Review succeeds without delivery when autoDeliver is false" ($exit10a -eq 0) ($out10a -join "`n")
  $manifestAfter10a = Get-Content -Raw -LiteralPath (Join-Path $case10.LocalDir '.agent\runs\run-010\run.json') | ConvertFrom-Json
  Assert-Test "Status remains awaiting_human_approval when autoDeliver is false" ($manifestAfter10a.status -eq 'awaiting_human_approval') "Got $($manifestAfter10a.status)"
  $mainCurrent10a = (& git -C $case10.LocalDir rev-parse refs/heads/main).Trim()
  Assert-Test "Main branch was NOT modified when autoDeliver is false" ($mainCurrent10a -eq $baseCommit10)

  # 10B: Explicit CLI switch -AutoDeliver overrides worker-settings.json: false
  $out10b = @(& pwsh -NoProfile -File $reviewScript -RunId 'run-010' -Repository $case10.LocalDir -AutoDeliver -SkipCodexReview 2>&1)
  $exit10b = $LASTEXITCODE

  Assert-Test "Explicit -AutoDeliver switch delivers even if settings is false" ($exit10b -eq 0) ($out10b -join "`n")
  $manifestAfter10b = Get-Content -Raw -LiteralPath (Join-Path $case10.LocalDir '.agent\runs\run-010\run.json') | ConvertFrom-Json
  Assert-Test "Status is completed after explicit -AutoDeliver" ($manifestAfter10b.status -eq 'completed') "Got $($manifestAfter10b.status)"
  $mainCurrent10b = (& git -C $case10.LocalDir rev-parse refs/heads/main).Trim()
  $candCommit10 = (& git -C $case10.LocalDir rev-parse refs/heads/$integBranch10).Trim()
  Assert-Test "Main branch is merged with candidate commit" ($mainCurrent10b -eq $candCommit10)

  Write-Host "`n======================================================" -ForegroundColor Cyan
  Write-Host "   테스트 완료: $passCount 통과 / $failCount 실패" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
  Write-Host "======================================================" -ForegroundColor Cyan

  if ($failCount -gt 0) {
    exit 1
  }
  exit 0
}
finally {
  if (Test-Path -LiteralPath $testTempRoot) {
    try { Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}