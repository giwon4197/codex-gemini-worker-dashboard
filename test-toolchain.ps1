$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'bounded-process-runner.ps1')

$passed = 0
$failed = 0
function Assert-ToolchainTest([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) {
    $script:passed++
    Write-Host "  [PASS] $Name" -ForegroundColor Green
  } else {
    $script:failed++
    Write-Host "  [FAIL] $Name" -ForegroundColor Red
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
  }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('toolchain-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$originalPath = $env:PATH
try {
  Write-Host 'Node/npm toolchain deterministic tests' -ForegroundColor Cyan
  $actualNode = Get-Command node.exe -ErrorAction Stop | Select-Object -First 1
  $mockNpm = Join-Path $tempRoot 'npm.cmd'
  $mockNpmContent = @'
@echo off
if "%1"=="--version" echo 10.9.0
exit /b 0
'@
  [IO.File]::WriteAllText($mockNpm, $mockNpmContent, [Text.Encoding]::ASCII)
  $packageJson = Join-Path $tempRoot 'package.json'
  [IO.File]::WriteAllText($packageJson, '{"engines":{"node":">=22.13.0"}}', [Text.Encoding]::UTF8)

  $minimalPath = [Environment]::GetFolderPath('System')
  $overrideEnvironment = @{
    PATH = $minimalPath
    CODEX_GEMINI_NODE_PATH = $actualNode.Source
    CODEX_GEMINI_NPM_PATH = $mockNpm
  }
  $resolved = Resolve-NodeNpmToolchain -Environment $overrideEnvironment
  Assert-ToolchainTest 'incomplete PATH resolves explicit node.exe' ($resolved.nodePath -eq $actualNode.Source)
  Assert-ToolchainTest 'incomplete PATH resolves explicit npm.cmd' ($resolved.npmPath -eq $mockNpm)
  Assert-ToolchainTest 'resolved tool directories are prepended to PATH' ($resolved.augmentedPath.StartsWith((Split-Path -Parent $actualNode.Source), [StringComparison]::OrdinalIgnoreCase))

  $preflight = Invoke-NodeNpmPreflight -WorkingDirectory $tempRoot -PackageJsonPath $packageJson -Environment $overrideEnvironment
  Assert-ToolchainTest 'node/npm preflight passes with incomplete parent PATH' $preflight.success $preflight.error
  Assert-ToolchainTest 'preflight captures npm version' ($preflight.npmVersion -eq '10.9.0') $preflight.npmVersion
  Assert-ToolchainTest 'preflight enforces package Node engine' ([version]$preflight.nodeVersion -ge [version]'22.13.0') $preflight.nodeVersion

  $child = Invoke-BoundedCommand -Command 'npm --version' -WorkingDirectory $tempRoot -EnvironmentVariables @{
    PATH = $resolved.augmentedPath
    CODEX_GEMINI_NODE_PATH = $resolved.nodePath
    CODEX_GEMINI_NPM_PATH = $resolved.npmPath
  }
  Assert-ToolchainTest 'verification child receives augmented PATH' ($child.status -eq 'PASS' -and $child.output.Trim() -eq '10.9.0') $child.output

  $missing = Resolve-NodeNpmToolchain -NodePath (Join-Path $tempRoot 'missing-node.exe') -NpmPath (Join-Path $tempRoot 'missing-npm.cmd') -Environment @{ PATH = $minimalPath; CODEX_GEMINI_NODE_PATH = (Join-Path $tempRoot 'missing-node.exe'); CODEX_GEMINI_NPM_PATH = (Join-Path $tempRoot 'missing-npm.cmd') }
  Assert-ToolchainTest 'missing tools return ENVIRONMENT_ERROR' (-not $missing.success -and $missing.status -eq 'ENVIRONMENT_ERROR' -and $missing.errorCategory -eq 'environment_error')
  Assert-ToolchainTest 'missing tool evidence names node and npm' (($missing.missing -contains 'node') -and ($missing.missing -contains 'npm'))

  $moduleProbe = Join-Path $tempRoot 'bounded-process-runner.ps1'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bounded-process-runner.ps1') -Destination $moduleProbe
  $moduleFailure = & pwsh -NoProfile -File $moduleProbe 2>&1
  Assert-ToolchainTest 'missing orchestration module fails explicitly' ($LASTEXITCODE -ne 0 -and ($moduleFailure -join "`n") -match 'Required orchestration module not found:')
  $jsonTarget = Join-Path $tempRoot 'atomic.json'
  Write-AtomicJson $jsonTarget ([pscustomobject]@{ nested = @{ value = 42 } })
  Assert-ToolchainTest 'common JSON writer preserves nested values' ((Get-Content -Raw -LiteralPath $jsonTarget | ConvertFrom-Json).nested.value -eq 42)
  $blockedTarget = Join-Path $tempRoot 'directory-target'
  New-Item -ItemType Directory -Path $blockedTarget | Out-Null
  $writeThrew = $false
  try { Write-AtomicJson $blockedTarget @{ value = 1 } } catch { $writeThrew = $true }
  Assert-ToolchainTest 'common JSON writer propagates failures by default' $writeThrew
  Write-AtomicJson $blockedTarget @{ value = 1 } -Depth 8 -BestEffort
  Assert-ToolchainTest 'best effort JSON failure removes temporary file' (@(Get-ChildItem -LiteralPath $tempRoot -Filter '*.tmp').Count -eq 0)
  foreach ($secret in @(
    ('ghp_' + ('a' * 30)), ('github_pat_' + ('b' * 30)), ('AIza' + ('c' * 35)),
    'Bearer token.value', 'Authorization: Basic abcdefg', 'https://user:password@example.invalid',
    '?token=hidden-value', '-----BEGIN RSA PRIVATE KEY-----secret-----END RSA PRIVATE KEY-----',
    ('sk-' + ('d' * 25)), 'password=abcdefghij'
  )) {
    $redacted = Redact-Text $secret
    Assert-ToolchainTest 'canonical redaction protects legacy and broader patterns' ($redacted -ne $secret -and (Redact-Secrets $secret) -eq $redacted)
  }
  Write-Host "`nToolchain tests: $passed passed / $failed failed" -ForegroundColor Cyan
  if ($failed -gt 0) { exit 1 }
} finally {
  $env:PATH = $originalPath
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
