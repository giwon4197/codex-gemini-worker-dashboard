$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'filesystem-policy.ps1')

$passed = 0
$failed = 0
function Assert-PolicyTest([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    $script:passed++
    Write-Host "  [PASS] $Name" -ForegroundColor Green
  } else {
    $script:failed++
    Write-Host "  [FAIL] $Name" -ForegroundColor Red
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
  }
}

Write-Host 'Filesystem Policy v2.1 deterministic tests' -ForegroundColor Cyan

$literalCases = @(
  'gemini-dashboard/app/api/runs/[runId]/route.ts',
  'gemini-dashboard/app/api/posts/[slug]/route.ts',
  'docs/파일 이름.md',
  'docs/file name.md',
  'docs/result(legacy).md'
)
foreach ($case in $literalCases) {
  $match = Get-PolicyPathMatch -Path $case.ToUpperInvariant() -Patterns @($case)
  Assert-PolicyTest "literal exact: $case" ($match.matched -and $match.comparisonMode -eq 'literal_exact' -and $match.matchedPattern -eq $case)
}

$bracketMismatch = Get-PolicyPathMatch 'gemini-dashboard/app/api/runs/r/route.ts' @('gemini-dashboard/app/api/runs/[runId]/route.ts')
Assert-PolicyTest 'brackets are literal, not a wildcard character class' (-not $bracketMismatch.matched)

$recursive = Get-PolicyPathMatch 'src/auth/nested/service.ts' @('src/auth/**')
Assert-PolicyTest '/** recursive policy glob matches descendants' ($recursive.matched -and $recursive.comparisonMode -eq 'policy_glob')
Assert-PolicyTest '/** recursive policy glob does not match sibling' (-not (Test-PolicyPath 'src/other/service.ts' @('src/auth/**')))
Assert-PolicyTest 'documented anywhere-directory glob works' (Test-PolicyPath 'packages/a/secrets/key.txt' @('**/secrets/**'))
Assert-PolicyTest 'documented extension glob works' (Test-PolicyPath 'src/app.config.ts' @('**/*.config.*'))

$legacyTask = [pscustomobject]@{
  id = 'TASK-001'
  allowed_files = @('src/a.ts', 'docs/[slug].md')
}
$legacy = Resolve-FilesystemPolicy $legacyTask
Assert-PolicyTest 'legacy allowed_files enables v2.1 policy' ($legacy.filesystem_policy -eq 'v2.1' -and $legacy.legacy_allowed_files)
Assert-PolicyTest 'legacy allowed_files maps to write_scope.expected' ($legacy.write_scope.expected.Count -eq 2 -and $legacy.write_scope.expected[0] -eq 'src/a.ts')
Assert-PolicyTest 'legacy merge scope defaults to expected write scope' ($legacy.merge_scope.expected.Count -eq 2)
Assert-PolicyTest 'legacy read scope defaults to project-wide search' ($legacy.read_scope.root -eq 'task_worktree' -and $legacy.read_scope.mode -eq 'project_wide_search')

$v21Task = [pscustomobject]@{
  id = 'TASK-002'
  read_scope = [pscustomobject]@{ root = 'task_worktree'; mode = 'project_wide_search'; deny = @('private/**') }
  write_scope = [pscustomobject]@{
    expected = @('src/auth/**', 'tests/new-auth.test.ts')
    derived_auto_expand = $true
    derived_approved = @('src/domain/User.ts')
    sensitive = @('src/public-api/**')
    forbidden = @('protected/**')
  }
  merge_scope = [pscustomobject]@{ expected = @('src/auth/**', 'src/domain/User.ts', 'tests/new-auth.test.ts'); deny = @('src/auth/no-merge.ts') }
}
$policy = Resolve-FilesystemPolicy $v21Task
Assert-PolicyTest 'v2.1 write scope contract is accepted' ($policy.write_scope.expected.Count -eq 2 -and $policy.write_scope.derived_auto_expand)
Assert-PolicyTest 'default secret deny rules cannot be removed' ((Test-PolicyPath '.env.local' $policy.read_scope.deny) -and (Test-PolicyPath '.git/config' $policy.write_scope.forbidden))

$verification = Get-FilesystemScopeVerification @(
  'src/auth/service.ts',
  'src/domain/User.ts',
  'src/public-api/index.ts',
  'outside/file.ts',
  '.env'
) $policy
$byPath = @{}; foreach ($entry in $verification.entries) { $byPath[$entry.path] = $entry }
Assert-PolicyTest 'expected change is authorized' ($byPath['src/auth/service.ts'].classification -eq 'EXPECTED' -and $byPath['src/auth/service.ts'].authorized)
Assert-PolicyTest 'approved derived change is authorized' ($byPath['src/domain/User.ts'].classification -eq 'DERIVED_APPROVED' -and $byPath['src/domain/User.ts'].authorized)
Assert-PolicyTest 'sensitive unapproved change is rejected' ($byPath['src/public-api/index.ts'].classification -eq 'SENSITIVE_UNAPPROVED' -and -not $byPath['src/public-api/index.ts'].authorized)
Assert-PolicyTest 'unexpected derived change is rejected' ($byPath['outside/file.ts'].classification -eq 'DERIVED_UNAPPROVED' -and -not $byPath['outside/file.ts'].authorized)
Assert-PolicyTest 'forbidden change is rejected' ($byPath['.env'].classification -eq 'FORBIDDEN' -and -not $byPath['.env'].authorized)
Assert-PolicyTest 'scope report fails when any unauthorized change exists' ($verification.status -eq 'FAIL' -and $verification.violations.Count -eq 3)

$mergeDenied = Get-FilesystemScopeVerification @('src/auth/no-merge.ts') $policy
Assert-PolicyTest 'merge deny is independent from expected write scope' ($mergeDenied.entries[0].classification -eq 'MERGE_DENIED')

$allowExpansion = Get-WriteExpansionDecision ([pscustomobject]@{
  target = 'src/domain/Session.ts'
  reason = 'direct type dependency'
  evidence = [pscustomobject]@{ source_file = 'src/auth/service.ts'; relation = 'direct_symbol_dependency'; symbol = 'Session' }
}) $policy
Assert-PolicyTest 'derived expansion foundation accepts structured direct dependency evidence' ($allowExpansion.decision -eq 'ALLOW_DERIVED')

$sensitiveExpansion = Get-WriteExpansionDecision ([pscustomobject]@{
  target = 'package.json'
  reason = 'dependency change'
  evidence = [pscustomobject]@{ source_file = 'src/auth/service.ts'; relation = 'direct_import' }
}) $policy
Assert-PolicyTest 'sensitive expansion requires review' ($sensitiveExpansion.decision -eq 'REQUIRE_REVIEW')

$forbiddenExpansion = Get-WriteExpansionDecision ([pscustomobject]@{ target = '.git/config'; reason = 'invalid'; evidence = $null }) $policy
Assert-PolicyTest 'forbidden expansion is denied' ($forbiddenExpansion.decision -eq 'DENY_FORBIDDEN')

Assert-PolicyTest 'identical ownership patterns overlap' (Test-PolicyPatternOverlap 'src/auth/**' 'src/auth/**')
Assert-PolicyTest 'recursive parent and child ownership overlap' (Test-PolicyPatternOverlap 'src/**' 'src/auth/**')
Assert-PolicyTest 'recursive ownership and exact file overlap' (Test-PolicyPatternOverlap 'src/auth/**' 'src/auth/service.ts')
Assert-PolicyTest 'disjoint ownership does not overlap' (-not (Test-PolicyPatternOverlap 'src/auth/**' 'src/payments/**'))

$unsafeRejected = $false
try { $null = Resolve-FilesystemPolicy ([pscustomobject]@{ id = 'TASK-003'; allowed_files = @('../outside.ts') }) } catch { $unsafeRejected = $true }
Assert-PolicyTest 'path traversal policy is rejected' $unsafeRejected

$protectedRejected = $false
try { $null = Resolve-FilesystemPolicy ([pscustomobject]@{ id = 'TASK-004'; allowed_files = @('.agent/**') }) } catch { $protectedRejected = $true }
Assert-PolicyTest 'protected orchestrator scope cannot be expected write scope' $protectedRejected

$protectedScriptRejected = $false
try {
  [void](Resolve-FilesystemPolicy ([pscustomobject]@{ id = 'TASK-PROTECTED-SCRIPT'; allowed_files = @('run-parallel-workers.ps1') }))
} catch { $protectedScriptRejected = $true }
Assert-PolicyTest 'protected orchestrator script cannot be expected write scope' $protectedScriptRejected

$unsupportedExpectedRejected = $false
try { $null = Resolve-FilesystemPolicy ([pscustomobject]@{ id = 'TASK-005'; allowed_files = @('src/*.ts') }) } catch { $unsupportedExpectedRejected = $true }
Assert-PolicyTest 'expected scope only accepts literal paths or /** recursion' $unsupportedExpectedRejected

$schema = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'router-plan.schema.json') | ConvertFrom-Json
$properties = $schema.properties.tasks.items.properties
Assert-PolicyTest 'router schema exposes v2.1 scopes' ($properties.read_scope -and $properties.write_scope -and $properties.merge_scope)
Assert-PolicyTest 'router schema preserves legacy allowed_files' ($properties.allowed_files -and $schema.properties.tasks.items.anyOf.Count -eq 2)

Write-Host "`nFilesystem Policy tests: $passed passed / $failed failed" -ForegroundColor Cyan
if ($failed -gt 0) { exit 1 }
