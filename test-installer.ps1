$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-common.ps1')
. (Join-Path $PSScriptRoot 'test-common.ps1') -AssertDetailLabel 'Detail'
$passCount = 0; $failCount = 0
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('installer-sync-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $testRoot 'source'
$target = Join-Path $testRoot 'install'
try {
  [IO.Directory]::CreateDirectory($source) | Out-Null
  [IO.Directory]::CreateDirectory((Join-Path $target 'gemini-dashboard')) | Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'program.ps1'), '# program v1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'model-tiers.json') -Destination $source
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'orchestration-common.ps1') -Destination $source
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dashboard-launcher.cmd') -Destination $source
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'dashboard-launcher.ps1') -Destination $source
  [IO.File]::WriteAllText((Join-Path $target 'gemini-dashboard/next.config.ts'), 'stale')
  $stateFiles = @('worker-settings.json', '.agent/runs/user.json', 'gemini-dashboard/public/data/dashboard.json', 'local-notes.txt', '.env.local')
  foreach ($file in $stateFiles) {
    $filePath = Join-Path $target $file
    [IO.Directory]::CreateDirectory((Split-Path -Parent $filePath)) | Out-Null
    [IO.File]::WriteAllText($filePath, 'user-state')
  }
  [IO.File]::WriteAllText((Join-Path $source 'worker-settings.json'), 'source-state-must-not-overwrite')
  Sync-InstalledProgramFiles $source $target
  Assert-Test 'program copied' ((Get-Content -Raw -LiteralPath (Join-Path $target 'program.ps1')) -eq '# program v1')
  Assert-Test 'dashboard-launcher.cmd copied' (Test-Path -LiteralPath (Join-Path $target 'dashboard-launcher.cmd'))
  Assert-Test 'dashboard-launcher.ps1 copied' (Test-Path -LiteralPath (Join-Path $target 'dashboard-launcher.ps1'))
  Assert-Test 'pre-manifest retired next.config removed' (-not (Test-Path -LiteralPath (Join-Path $target 'gemini-dashboard/next.config.ts')))
  foreach ($file in $stateFiles) {
    Assert-Test "preserves $file" ((Get-Content -Raw -LiteralPath (Join-Path $target $file)) -eq 'user-state')
  }
  . (Join-Path $target 'orchestration-common.ps1')
  Assert-Test 'installed model configuration resolves from PSScriptRoot' ((Get-ModelTierConfiguration).TierMap.normal -eq 'gemini-3.8-flash-medium')
  Remove-Item -LiteralPath (Join-Path $source 'program.ps1')
  Sync-InstalledProgramFiles $source $target
  Assert-Test 'manifest-owned removed program disappears on update' (-not (Test-Path -LiteralPath (Join-Path $target 'program.ps1')))
  $manifest = @('../outside.txt', '.agent/runs/user.json', 'worker-settings.json')
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target '.installed-program-files.json')
  [IO.File]::WriteAllText((Join-Path $testRoot 'outside.txt'), 'outside')
  Sync-InstalledProgramFiles $source $target
  Assert-Test 'manifest traversal cannot delete outside InstallRoot' (Test-Path -LiteralPath (Join-Path $testRoot 'outside.txt'))
  Assert-Test 'manifest cannot claim user execution data' ((Get-Content -Raw -LiteralPath (Join-Path $target '.agent/runs/user.json')) -eq 'user-state')
  Assert-Test 'manifest cannot claim settings' ((Get-Content -Raw -LiteralPath (Join-Path $target 'worker-settings.json')) -eq 'user-state')
  $refused = $false
  try { Sync-InstalledProgramFiles $source $source } catch { $refused = $true }
  Assert-Test 'source cannot be its own install target' $refused
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedTestRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
Write-Host "Installer tests: $passCount passed / $failCount failed"
if ($failCount) { exit 1 }
