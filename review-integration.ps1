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

$reviewPath = Join-Path $runRoot 'codex-review.md'
$reviewPrompt = 'Review only the integration branch diff against main. Focus on correctness, regressions, security, test gaps, and contract violations. Do not edit files or merge branches. Give concise findings with file paths and severity; say explicitly when there are no blocking findings.'
Push-Location ([string]$manifest.integration.worktree)
try {
  $reviewPrompt | & codex.exe exec review --base main --ephemeral --output-last-message $reviewPath
  $reviewExit = $LASTEXITCODE
} finally { Pop-Location }

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest.status = if ($reviewExit -eq 0) { 'awaiting_human_approval' } else { 'codex_review_failed' }
$manifest | Add-Member -NotePropertyName codexReview -NotePropertyValue ([pscustomobject]@{
  status = if ($reviewExit -eq 0) { 'completed' } else { 'failed' }
  artifact = $reviewPath
  reviewedAt = (Get-Date).ToString('o')
  mainModified = $false
}) -Force
$temp = "$manifestPath.$([guid]::NewGuid().ToString('N')).tmp"
[IO.File]::WriteAllText($temp, ($manifest | ConvertTo-Json -Depth 16), [Text.Encoding]::UTF8)
[IO.File]::Move($temp, $manifestPath, $true)
Write-Output "Codex review: $reviewPath"
Write-Output "Final status: $($manifest.status)"
exit $(if ($reviewExit -eq 0) { 0 } else { 1 })
