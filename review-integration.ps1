[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$RunId,
  [string]$Repository = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$repoRoot = $repoRoot.Trim()
$runRoot = Join-Path $repoRoot ".agent\runs\$RunId"
$manifestPath = Join-Path $runRoot 'run.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "run을 찾을 수 없습니다: $RunId" }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if (-not $manifest.integration -or -not (Test-Path -LiteralPath $manifest.integration.worktree)) { throw '검토할 integration worktree가 없습니다.' }
if ($manifest.integration.mainModified) { throw 'mainModified=true인 실행은 자동 리뷰하지 않습니다.' }

$reviewJsonPath = Join-Path $runRoot 'codex-review.json'
$reviewPath = Join-Path $runRoot 'codex-review.md'
$reviewSchema = Join-Path $PSScriptRoot 'codex-review.schema.json'
$reviewPrompt = @"
Review only the committed diff from base commit $($manifest.integration.baseCommit) through HEAD.
Focus on correctness, regressions, security, test gaps, documentation/API mismatches, and contract violations.
Do not edit files or merge branches. Run relevant read-only tests when useful.
Return verdict REQUEST_FIX when any actionable finding exists; otherwise return PASS. Use repository-relative file paths.
"@
Push-Location ([string]$manifest.integration.worktree)
try {
  & codex.exe exec --sandbox read-only --ephemeral --color never --output-schema $reviewSchema --output-last-message $reviewJsonPath --cd $manifest.integration.worktree $reviewPrompt
  $reviewExit = $LASTEXITCODE
} finally { Pop-Location }

$review = if ($reviewExit -eq 0 -and (Test-Path -LiteralPath $reviewJsonPath)) { Get-Content -Raw -LiteralPath $reviewJsonPath | ConvertFrom-Json } else { $null }
$reviewStatus = if ($reviewExit -ne 0 -or -not $review) { 'codex_review_failed' } elseif ($review.verdict -eq 'PASS') { 'awaiting_human_approval' } else { 'changes_requested' }
if ($review) {
  $lines = @("# Codex Review: $RunId", '', "- Verdict: $($review.verdict)", '', $review.summary, '', '## Findings', '')
  if (@($review.findings).Count -eq 0) { $lines += '- No actionable findings.' }
  else { foreach ($finding in @($review.findings)) { $lines += "- [$($finding.severity)] $($finding.title) — $($finding.file):$($finding.line)`n  $($finding.body)" } }
  [IO.File]::WriteAllText($reviewPath, ($lines -join "`n"), [Text.Encoding]::UTF8)
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest.status = $reviewStatus
$manifest | Add-Member -NotePropertyName codexReview -NotePropertyValue ([pscustomobject]@{
  status = if ($reviewExit -eq 0 -and $review) { 'completed' } else { 'failed' }
  verdict = if ($review) { $review.verdict } else { $null }
  findingsCount = if ($review) { @($review.findings).Count } else { $null }
  artifact = $reviewPath
  jsonArtifact = $reviewJsonPath
  reviewedAt = (Get-Date).ToString('o')
  mainModified = $false
}) -Force
$temp = "$manifestPath.$([guid]::NewGuid().ToString('N')).tmp"
[IO.File]::WriteAllText($temp, ($manifest | ConvertTo-Json -Depth 16), [Text.Encoding]::UTF8)
[IO.File]::Move($temp, $manifestPath, $true)
Write-Output "Codex review: $reviewPath"
Write-Output "Final status: $($manifest.status)"
exit $(if ($reviewExit -eq 0 -and $review) { 0 } else { 1 })
