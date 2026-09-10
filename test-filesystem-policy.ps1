[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$orchestrator = Join-Path $repoRoot 'run-parallel-workers.ps1'
$routerScript = Join-Path $repoRoot 'codex-router.ps1'
$schemaPath   = Join-Path $repoRoot 'router-plan.schema.json'
$exampleTasks = Join-Path $repoRoot 'parallel-tasks.example.json'

if (-not (Test-Path -LiteralPath $orchestrator)) {
  Write-Error "run-parallel-workers.ps1 not found: $orchestrator"
  exit 1
}

# Dot-source orchestrator functions without executing runner
. $orchestrator -ExportFunctionsOnly

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-fs-policy-" + [guid]::NewGuid().ToString('N'))
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

try {
  Write-Host "======================================================" -ForegroundColor Cyan
  Write-Host "  Codex x Gemini Worker v2.1 Filesystem Policy Tests  " -ForegroundColor Cyan
  Write-Host "======================================================" -ForegroundColor Cyan

  # -----------------------------------------------------------------
  # 1. Schema Contract Support
  # -----------------------------------------------------------------
  Write-Host "`n1. Schema Contract Support: router-plan.schema.json & example" -ForegroundColor Cyan
  $schemaJson = Get-Content -Raw -LiteralPath $schemaPath | ConvertFrom-Json
  Assert-Test "Schema specifies Draft 2020-12" ($schemaJson.'$schema' -like '*draft/2020-12*')
  $taskItemProps = $schemaJson.properties.tasks.items.properties
  Assert-Test "Schema defines read_scope property" ($null -ne $taskItemProps.read_scope)
  Assert-Test "Schema defines write_scope property" ($null -ne $taskItemProps.write_scope)
  Assert-Test "Schema defines merge_scope property" ($null -ne $taskItemProps.merge_scope)
  Assert-Test "Schema defines forbidden_operations property" ($null -ne $taskItemProps.forbidden_operations)
  Assert-Test "Schema defines expected_change_scope property" ($null -ne $taskItemProps.expected_change_scope)
  Assert-Test "read_scope has root/mode/deny" ($null -ne $taskItemProps.read_scope.properties.root -and $null -ne $taskItemProps.read_scope.properties.mode -and $null -ne $taskItemProps.read_scope.properties.deny)
  Assert-Test "write_scope has expected/derived_auto_expand/sensitive/forbidden" ($null -ne $taskItemProps.write_scope.properties.expected -and $null -ne $taskItemProps.write_scope.properties.derived_auto_expand -and $null -ne $taskItemProps.write_scope.properties.sensitive -and $null -ne $taskItemProps.write_scope.properties.forbidden)
  Assert-Test "write_scope requires expected" (@($taskItemProps.write_scope.required) -contains 'expected')

  # Validate parallel-tasks.example.json content
  $exampleJson = Get-Content -Raw -LiteralPath $exampleTasks | ConvertFrom-Json
  Assert-Test "parallel-tasks.example.json has tasks" (@($exampleJson.tasks).Count -ge 2)
  $exTask1 = $exampleJson.tasks[0]
  Assert-Test "Example task 1 has write_scope" ($null -ne $exTask1.write_scope -and @($exTask1.write_scope.expected).Count -gt 0)
  Assert-Test "Example task 1 has read_scope" ($null -ne $exTask1.read_scope -and $exTask1.read_scope.root -eq 'task_worktree')
  Assert-Test "Example task 1 has merge_scope" ($null -ne $exTask1.merge_scope -and @($exTask1.merge_scope).Count -gt 0)
  Assert-Test "Example task 1 has forbidden_operations" ($null -ne $exTask1.forbidden_operations -and @($exTask1.forbidden_operations).Count -gt 0)
  Assert-Test "Example task 1 has expected_change_scope" ($null -ne $exTask1.expected_change_scope -and $exTask1.expected_change_scope.files -gt 0)

  # -----------------------------------------------------------------
  # 2. Exact Legacy Equivalence & Deterministic Defaults
  # -----------------------------------------------------------------
  Write-Host "`n2. Exact Legacy Equivalence & Deterministic Defaults" -ForegroundColor Cyan
  $legacyTask = [pscustomobject]@{
    id            = 'TASK-001'
    name          = 'Legacy task'
    prompt        = 'Do work'
    allowed_files = @('docs/worker-a.md', 'src/utils.ts')
    test_commands = @('npm test')
    tier          = 'fast'
  }
  $normLegacy = Normalize-FilesystemPolicy $legacyTask
  Assert-Test "Legacy policy marked filesystem_policy v2.1" ($normLegacy.filesystem_policy -eq 'v2.1')
  Assert-Test "Legacy allowed_files normalizes exactly to write_scope.expected" (
    $normLegacy.write_scope.expected.Count -eq 2 -and
    $normLegacy.write_scope.expected[0] -eq 'docs/worker-a.md' -and
    $normLegacy.write_scope.expected[1] -eq 'src/utils.ts'
  )
  Assert-Test "Legacy allowedFiles property preserved on normalized object" (
    $normLegacy.allowedFiles.Count -eq 2 -and
    $normLegacy.allowedFiles[0] -eq 'docs/worker-a.md'
  )
  Assert-Test "merge_scope defaults exactly to write_scope.expected" (
    $normLegacy.merge_scope.expected.Count -eq 2 -and
    $normLegacy.merge_scope.expected[0] -eq 'docs/worker-a.md' -and
    $normLegacy.merge_scope.expected[1] -eq 'src/utils.ts'
  )
  Assert-Test "read_scope defaults to task_worktree / project_wide_search" (
    $normLegacy.read_scope.root -eq 'task_worktree' -and
    $normLegacy.read_scope.mode -eq 'project_wide_search'
  )
  Assert-Test "read_scope defaults include secrets, .env*, .git/** deny patterns" (
    @($normLegacy.read_scope.deny) -contains '.env*' -and
    @($normLegacy.read_scope.deny) -contains '**/secrets/**' -and
    @($normLegacy.read_scope.deny) -contains '.git/**'
  )
  Assert-Test "write_scope defaults: derived_auto_expand is false" ($normLegacy.write_scope.derived_auto_expand -eq $false)
  Assert-Test "write_scope defaults: sensitive includes tests/** and package.json" (
    @($normLegacy.write_scope.sensitive) -contains 'tests/**' -and
    @($normLegacy.write_scope.sensitive) -contains 'package.json'
  )
  Assert-Test "write_scope defaults: forbidden includes secrets and .git/**" (
    @($normLegacy.write_scope.forbidden) -contains '.env*' -and
    @($normLegacy.write_scope.forbidden) -contains '**/secrets/**' -and
    @($normLegacy.write_scope.forbidden) -contains '.git/**'
  )
  Assert-Test "forbidden_operations has safe defaults" (
    @($normLegacy.forbidden_operations) -contains 'git push' -and
    @($normLegacy.forbidden_operations) -contains 'force push'
  )
  Assert-Test "expected_change_scope defaults to null" ($null -eq $normLegacy.expected_change_scope)

  # -----------------------------------------------------------------
  # 3. Invalid / Rooted / Path-Traversal and Protected Path Rejection
  # -----------------------------------------------------------------
  Write-Host "`n3. Invalid, Rooted, Traversal, and Protected Path Rejection" -ForegroundColor Cyan
  $invalidCases = @(
    @{ Name = 'Windows rooted path (C:\)'; Task = @{ id = 'TASK-01'; allowed_files = @('C:\Windows\System32\notepad.exe') } }
    @{ Name = 'Unix rooted path (/etc)';   Task = @{ id = 'TASK-02'; allowed_files = @('/etc/passwd') } }
    @{ Name = 'UNC share path (\\server)'; Task = @{ id = 'TASK-03'; allowed_files = @('\\server\share\file.txt') } }
    @{ Name = 'Parent traversal (..)';     Task = @{ id = 'TASK-04'; allowed_files = @('../outside.ts') } }
    @{ Name = 'Embedded traversal';        Task = @{ id = 'TASK-05'; allowed_files = @('src/../../secrets.json') } }
    @{ Name = 'Git protected directory';   Task = @{ id = 'TASK-06'; allowed_files = @('.git/config') } }
    @{ Name = 'Agent protected directory'; Task = @{ id = 'TASK-07'; allowed_files = @('.agent/protected.json') } }
    @{ Name = 'Broad wildcard *';          Task = @{ id = 'TASK-08'; allowed_files = @('*') } }
    @{ Name = 'Broad wildcard **';         Task = @{ id = 'TASK-09'; allowed_files = @('**') } }
    @{ Name = 'Repository root ./';        Task = @{ id = 'TASK-10'; allowed_files = @('./') } }
    @{ Name = 'Empty path';                Task = @{ id = 'TASK-11'; allowed_files = @('') } }
    @{ Name = 'Whitespace path';           Task = @{ id = 'TASK-12'; allowed_files = @('   ') } }
  )

  foreach ($tc in $invalidCases) {
    $threw = $false
    $err = ''
    try {
      Normalize-FilesystemPolicy ([pscustomobject]$tc.Task) | Out-Null
    } catch {
      $threw = $true
      $err = $_.Exception.Message
    }
    Assert-Test "Rejects $($tc.Name)" ($threw -and ($err -match '안전하지 않은')) "Message: $err"
  }

  # v2.1 write_scope invalid paths
  $v2InvalidCases = @(
    @{ Name = 'v2.1 Rooted path in write_scope'; Task = @{ id = 'TASK-21'; write_scope = @{ expected = @('C:/app/file.ts') } } }
    @{ Name = 'v2.1 Traversal in write_scope';   Task = @{ id = 'TASK-22'; write_scope = @{ expected = @('../secret.ts') } } }
    @{ Name = 'v2.1 .git in write_scope';        Task = @{ id = 'TASK-23'; write_scope = @{ expected = @('.git/HEAD') } } }
    @{ Name = 'v2.1 Traversal in read_scope.root'; Task = @{ id = 'TASK-24'; write_scope = @{ expected = @('src/a.ts') }; read_scope = @{ root = '../external' } } }
    @{ Name = 'v2.1 Rooted in read_scope.root';    Task = @{ id = 'TASK-25'; write_scope = @{ expected = @('src/a.ts') }; read_scope = @{ root = 'C:/Windows' } } }
    @{ Name = 'v2.1 Traversal in read_scope.deny'; Task = @{ id = 'TASK-26'; write_scope = @{ expected = @('src/a.ts') }; read_scope = @{ deny = @('../secrets') } } }
    @{ Name = 'v2.1 Traversal in merge_scope';     Task = @{ id = 'TASK-27'; write_scope = @{ expected = @('src/a.ts') }; merge_scope = @('../main.ts') } }
    @{ Name = 'v2.1 .git in merge_scope';          Task = @{ id = 'TASK-28'; write_scope = @{ expected = @('src/a.ts') }; merge_scope = @('.git/HEAD') } }
    @{ Name = 'Empty write_scope.expected';        Task = @{ id = 'TASK-29'; write_scope = @{ expected = @() } } }
    @{ Name = 'Missing write_scope.expected';      Task = @{ id = 'TASK-30'; write_scope = @{ sensitive = @('tests/**') } } }
  )

  foreach ($tc in $v2InvalidCases) {
    $threw = $false
    $err = ''
    try {
      Normalize-FilesystemPolicy ([pscustomobject]$tc.Task) | Out-Null
    } catch {
      $threw = $true
      $err = $_.Exception.Message
    }
    Assert-Test "Rejects $($tc.Name)" $threw "Message: $err"
  }

  # -----------------------------------------------------------------
  # 4. Ownership Overlap Detection
  # -----------------------------------------------------------------
  Write-Host "`n4. Ownership Overlap Detection" -ForegroundColor Cyan
  $overlapPlan = [pscustomobject]@{
    tasks = @(
      [pscustomobject]@{ id = 'TASK-001'; write_scope = [pscustomobject]@{ expected = @('src/shared/config.ts', 'src/a.ts') } }
      [pscustomobject]@{ id = 'TASK-002'; write_scope = [pscustomobject]@{ expected = @('src/shared/CONFIG.ts', 'src/b.ts') } }
    )
  }
  $overlapThrew = $false
  $overlapErr = ''
  try {
    $allOwnership = @{}
    foreach ($t in $overlapPlan.tasks) {
      $norm = Normalize-FilesystemPolicy $t
      foreach ($pVal in @($norm.write_scope.expected)) {
        $key = ([string]$pVal).Replace('\', '/').ToLowerInvariant()
        if ($allOwnership.ContainsKey($key)) { throw "OWNERSHIP_OVERLAP: $key ($($allOwnership[$key]), $($t.id))" }
        $allOwnership[$key] = $t.id
      }
    }
  } catch {
    $overlapThrew = $true
    $overlapErr = $_.Exception.Message
  }
  Assert-Test "Rejects ownership overlap case-insensitively" ($overlapThrew -and ($overlapErr -like 'OWNERSHIP_OVERLAP*')) "Message: $overlapErr"

  # Disjoint ownership succeeds
  $disjointPlan = [pscustomobject]@{
    tasks = @(
      [pscustomobject]@{ id = 'TASK-001'; write_scope = [pscustomobject]@{ expected = @('src/feature-a.ts') } }
      [pscustomobject]@{ id = 'TASK-002'; write_scope = [pscustomobject]@{ expected = @('src/feature-b.ts') } }
    )
  }
  $disjointThrew = $false
  try {
    $allOwnership = @{}
    foreach ($t in $disjointPlan.tasks) {
      $norm = Normalize-FilesystemPolicy $t
      foreach ($pVal in @($norm.write_scope.expected)) {
        $key = ([string]$pVal).Replace('\', '/').ToLowerInvariant()
        if ($allOwnership.ContainsKey($key)) { throw "OWNERSHIP_OVERLAP: $key ($($allOwnership[$key]), $($t.id))" }
        $allOwnership[$key] = $t.id
      }
    }
  } catch {
    $disjointThrew = $true
  }
  Assert-Test "Allows disjoint write ownership across tasks" (-not $disjointThrew)

  # -----------------------------------------------------------------
  # 5. Independent Read, Write, and Merge Scope Enforcement
  # -----------------------------------------------------------------
  Write-Host "`n5. Independent Read, Write, and Merge Scope Enforcement" -ForegroundColor Cyan
  $contractV21 = [pscustomobject]@{
    id          = 'TASK-001'
    name        = 'Scope Isolation Task'
    prompt      = 'Fix auth service'
    read_scope  = [pscustomobject]@{
      root = 'task_worktree'
      mode = 'project_wide_search'
      deny = @('.env*', '**/secrets/**', '.git/**')
    }
    write_scope = [pscustomobject]@{
      expected            = @('src/auth/service.ts')
      derived_auto_expand = $false
      sensitive           = @('tests/**', 'package.json')
      forbidden           = @('.env*', '**/secrets/**', '.git/**')
    }
    merge_scope = @('src/auth/service.ts')
  }
  $normV21 = Normalize-FilesystemPolicy $contractV21

  # Read Scope behavior
  Assert-Test "Read allowed for workspace repository file" (Test-ReadScopePermission 'src/domain/User.ts' $normV21)
  Assert-Test "Read denied for secret file (.env)" (-not (Test-ReadScopePermission '.env' $normV21))
  Assert-Test "Read denied for credentials (secrets/key.pem)" (-not (Test-ReadScopePermission 'secrets/key.pem' $normV21))
  Assert-Test "Read denied for git metadata (.git/config)" (-not (Test-ReadScopePermission '.git/config' $normV21))
  Assert-Test "Read denied for traversal attempts" (-not (Test-ReadScopePermission '../secret.txt' $normV21))

  # Read Scope must NEVER authorize changed files (Criterion 4 & 5)
  $violationsReadOnlyChange = Get-PolicyViolations -ChangedFiles @('src/domain/User.ts') -Policy $normV21
  Assert-Test "Modifying a file in read_scope but not in write_scope is a POLICY VIOLATION" (
    $violationsReadOnlyChange.Count -eq 1 -and $violationsReadOnlyChange[0] -eq 'src/domain/User.ts'
  )

  # Write Scope behavior
  Assert-Test "Write allowed for expected write file" (Test-WriteScopePermission 'src/auth/service.ts' $normV21)
  Assert-Test "Write denied for unlisted file (even if readable)" (-not (Test-WriteScopePermission 'src/domain/User.ts' $normV21))
  Assert-Test "Write denied for forbidden file" (-not (Test-WriteScopePermission '.env' $normV21))

  # Merge Scope independence: merge scope does NOT grant read or write permission (Criterion 5)
  $restrictedMergeTask = [pscustomobject]@{
    id          = 'TASK-002'
    write_scope = [pscustomobject]@{
      expected = @('src/a.ts', 'src/b.ts')
    }
    merge_scope = @('src/a.ts') # b.ts is excluded from merge!
  }
  $normRestrictedMerge = Normalize-FilesystemPolicy $restrictedMergeTask
  Assert-Test "b.ts is in write_scope.expected" (Test-WriteScopePermission 'src/b.ts' $normRestrictedMerge)
  Assert-Test "b.ts is NOT in merge_scope" (-not (Test-MergeScopePermission 'src/b.ts' $normRestrictedMerge))

  # Modifying b.ts triggers policy violation because merge_scope restricts it
  $mergeViolations = Get-PolicyViolations -ChangedFiles @('src/b.ts') -Policy $normRestrictedMerge
  Assert-Test "File excluded by merge_scope is rejected as violation" (@($mergeViolations) -contains 'src/b.ts')

  # Merge scope does NOT grant write permission
  $extraMergeTask = [pscustomobject]@{
    id          = 'TASK-003'
    write_scope = [pscustomobject]@{ expected = @('src/a.ts') }
    merge_scope = @('src/a.ts', 'src/extra.ts')
  }
  $normExtraMerge = Normalize-FilesystemPolicy $extraMergeTask
  Assert-Test "extra.ts in merge_scope does NOT grant write permission" (-not (Test-WriteScopePermission 'src/extra.ts' $normExtraMerge))
  $extraWriteViolations = Get-PolicyViolations -ChangedFiles @('src/extra.ts') -Policy $normExtraMerge
  Assert-Test "Modifying extra.ts is violation despite being in merge_scope" (@($extraWriteViolations) -contains 'src/extra.ts')

  # -----------------------------------------------------------------
  # 6. Unsupported Dynamic Expansion Denial in Step 1 (Criterion 6)
  # -----------------------------------------------------------------
  Write-Host "`n6. Dynamic Expansion Denial in Step 1" -ForegroundColor Cyan
  $expandTask = [pscustomobject]@{
    id          = 'TASK-EXPAND'
    write_scope = [pscustomobject]@{
      expected            = @('src/auth/service.ts')
      derived_auto_expand = $true # Requested expansion mode
    }
  }
  $normExpand = Normalize-FilesystemPolicy $expandTask
  Assert-Test "derived_auto_expand flag parsed" ($normExpand.write_scope.derived_auto_expand -eq $true)
  # Changes outside expected write scope remain denied in Step 1
  $expandViolations = Get-PolicyViolations -ChangedFiles @('src/auth/service.ts', 'src/domain/User.ts') -Policy $normExpand
  Assert-Test "Dynamic expansion is not approved in Step 1: unexpected file denied" (
    $expandViolations.Count -eq 1 -and $expandViolations[0] -eq 'src/domain/User.ts'
  )

  # -----------------------------------------------------------------
  # 7. Compact Worker and Run State Recording (Criterion 7)
  # -----------------------------------------------------------------
  Write-Host "`n7. Compact Worker and Run State Recording" -ForegroundColor Cyan
  $compact = Get-CompactPolicyState -Policy $normV21 -ChangedFiles @('src/auth/service.ts', 'package.json') -Violations @('package.json')
  Assert-Test "Compact state has filesystem_policy v2.1" ($compact.filesystem_policy -eq 'v2.1')
  Assert-Test "Compact state tracks expected count (1)" ($compact.write_scope.expected -eq 1)
  Assert-Test "Compact state tracks sensitive touched count (1)" ($compact.write_scope.sensitive_touched -eq 1)
  Assert-Test "Compact state tracks violations count (1)" ($compact.write_scope.violations -eq 1)
  Assert-Test "Compact state derived_approved is 0 in Step 1" ($compact.write_scope.derived_approved -eq 0)
  Assert-Test "Compact state expansion counts are integers" (
    $compact.expansion.requested -eq 0 -and
    $compact.expansion.approved -eq 0 -and
    $compact.expansion.denied -eq 0 -and
    $compact.expansion.codex_escalated -eq 0
  )

  # Verify no file content leakage in compact state
  $compactJson = $compact | ConvertTo-Json -Depth 5
  Assert-Test "Compact JSON is concise (< 1KB)" ($compactJson.Length -lt 1024)
  Assert-Test "Compact JSON does not contain file contents" ($compactJson -notmatch 'password|secret|function')

  # -----------------------------------------------------------------
  # 8. End-to-End Execution Simulation with Mock Worktree
  # -----------------------------------------------------------------
  Write-Host "`n8. Orchestrator End-to-End Policy Verification with v2.1 Tasks" -ForegroundColor Cyan
  $simRepo = Join-Path $testTempRoot 'mock-repo'
  New-Item -ItemType Directory -Path $simRepo -Force | Out-Null
  & git -C $simRepo init -b main 2>$null | Out-Null
  & git -C $simRepo config user.name 'Test Runner'
  & git -C $simRepo config user.email 'test@local'
  & git -C $simRepo config commit.gpgSign false

  [IO.File]::WriteAllText((Join-Path $simRepo 'README.md'), "# Mock Repo`n", [Text.Encoding]::UTF8)
  & git -C $simRepo add README.md
  & git -C $simRepo commit -m "init" 2>$null | Out-Null
  $baseCommit = (& git -C $simRepo rev-parse HEAD).Trim()

  # Test task file using v2.1 contract format
  $simTaskFile = Join-Path $testTempRoot 'v21-tasks.json'
  $v21Plan = [ordered]@{
    integration_test_commands = @("if (-not (Test-Path 'file-a.txt')) { exit 1 }")
    tasks = @(
      [ordered]@{
        id            = 'TASK-001'
        name          = 'v2.1 Test Task'
        objective     = 'Create file-a'
        prompt        = 'Write file-a.txt'
        tier          = 'fast'
        read_scope    = [ordered]@{
          root = 'task_worktree'
          mode = 'project_wide_search'
          deny = @('.env*', '**/secrets/**', '.git/**')
        }
        write_scope   = [ordered]@{
          expected            = @('file-a.txt')
          derived_auto_expand = $false
          sensitive           = @('tests/**')
          forbidden           = @('.env*', '.git/**')
        }
        merge_scope   = @('file-a.txt')
        test_commands = @("if (-not (Test-Path 'file-a.txt')) { exit 1 }")
      }
    )
  }
  [IO.File]::WriteAllText($simTaskFile, ($v21Plan | ConvertTo-Json -Depth 8), [Text.Encoding]::UTF8)

  # Verify normalization on the plan
  $simTasksParsed = Get-Content -Raw -LiteralPath $simTaskFile | ConvertFrom-Json
  $simNorm = Normalize-FilesystemPolicy $simTasksParsed.tasks[0]
  Assert-Test "Parsed task normalized to filesystem_policy v2.1" ($simNorm.filesystem_policy -eq 'v2.1')
  Assert-Test "write_scope.expected matches file-a.txt" ($simNorm.write_scope.expected[0] -eq 'file-a.txt')
  Assert-Test "allowedFiles matches file-a.txt" ($simNorm.allowedFiles[0] -eq 'file-a.txt')

  # Simulate policy check on clean change vs violation
  $cleanViolations = Get-PolicyViolations -ChangedFiles @('file-a.txt') -Policy $simNorm
  Assert-Test "Valid change produces zero violations" ($cleanViolations.Count -eq 0)

  $dirtyViolations = Get-PolicyViolations -ChangedFiles @('file-a.txt', 'unallowed.txt') -Policy $simNorm
  Assert-Test "Unallowed change produces violation for unallowed.txt" (
    $dirtyViolations.Count -eq 1 -and $dirtyViolations[0] -eq 'unallowed.txt'
  )

  $forbiddenViolations = Get-PolicyViolations -ChangedFiles @('.env') -Policy $simNorm
  Assert-Test "Forbidden change (.env) produces violation" (
    $forbiddenViolations.Count -eq 1 -and $forbiddenViolations[0] -eq '.env'
  )

  # -----------------------------------------------------------------
  # 9. AST Parser Lint on all modified and created files
  # -----------------------------------------------------------------
  Write-Host "`n9. Parser Lint Check" -ForegroundColor Cyan
  $scriptsToLint = @(
    (Join-Path $repoRoot 'run-parallel-workers.ps1'),
    (Join-Path $repoRoot 'codex-router.ps1'),
    (Join-Path $repoRoot 'test-parallel-usage.ps1'),
    (Join-Path $repoRoot 'test-filesystem-policy.ps1')
  )
  foreach ($s in $scriptsToLint) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $s).Path, [ref]$tokens, [ref]$errors)
    $hasErr = ($errors -and $errors.Count -gt 0)
    $name = Split-Path -Leaf $s
    Assert-Test "AST Parser Lint: $name" (-not $hasErr) $(if ($hasErr) { ($errors | ForEach-Object { $_.Message }) -join '; ' } else { '' })
  }

  Write-Host "`n======================================================" -ForegroundColor Cyan
  Write-Host "   Filesystem Policy Tests: $passCount Passed / $failCount Failed" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
  Write-Host "======================================================" -ForegroundColor Cyan

  if ($failCount -gt 0) { exit 1 }
} finally {
  if (Test-Path -LiteralPath $testTempRoot) {
    try { Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
}
