function Get-FirstExistingCommandPath {
  param([string[]]$Names, [string[]]$Candidates)

  foreach ($name in @($Names)) {
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
      return [IO.Path]::GetFullPath($command.Source)
    }
  }
  foreach ($candidate in @($Candidates)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return [IO.Path]::GetFullPath($candidate)
    }
  }
  return $null
}

function Resolve-NodeNpmToolchain {
  [CmdletBinding()]
  param(
    [string]$NodePath = '',
    [string]$NpmPath = '',
    [hashtable]$Environment = @{}
  )

  $envPath = if ($Environment.ContainsKey('PATH')) { [string]$Environment['PATH'] } else { [string]$env:PATH }
  $oldPath = $env:PATH
  try {
    if ($envPath) { $env:PATH = $envPath }

    $nodeOverride = if ($NodePath) { $NodePath } elseif ($Environment.ContainsKey('CODEX_GEMINI_NODE_PATH')) { [string]$Environment['CODEX_GEMINI_NODE_PATH'] } elseif ($env:CODEX_GEMINI_NODE_PATH) { [string]$env:CODEX_GEMINI_NODE_PATH } else { '' }
    $npmOverride = if ($NpmPath) { $NpmPath } elseif ($Environment.ContainsKey('CODEX_GEMINI_NPM_PATH')) { [string]$Environment['CODEX_GEMINI_NPM_PATH'] } elseif ($env:CODEX_GEMINI_NPM_PATH) { [string]$env:CODEX_GEMINI_NPM_PATH } else { '' }

    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $nodeCandidates = @(
      $nodeOverride,
      $(if ($programFiles) { Join-Path $programFiles 'nodejs\node.exe' }),
      $(if ($programFilesX86) { Join-Path $programFilesX86 'nodejs\node.exe' }),
      $(if ($localAppData) { Join-Path $localAppData 'Programs\nodejs\node.exe' })
    )
    $node = Get-FirstExistingCommandPath -Names @('node.exe', 'node') -Candidates $nodeCandidates

    $nodeDir = if ($node) { Split-Path -Parent $node } else { '' }
    $npmCandidates = @(
      $npmOverride,
      $(if ($nodeDir) { Join-Path $nodeDir 'npm.cmd' }),
      $(if ($programFiles) { Join-Path $programFiles 'nodejs\npm.cmd' }),
      $(if ($programFilesX86) { Join-Path $programFilesX86 'nodejs\npm.cmd' }),
      $(if ($localAppData) { Join-Path $localAppData 'Programs\nodejs\npm.cmd' })
    )
    $npmNames = if ($IsWindows -or $env:OS -like '*Windows*') { @('npm.cmd', 'npm.exe', 'npm') } else { @('npm') }
    $npm = Get-FirstExistingCommandPath -Names $npmNames -Candidates $npmCandidates

    $dirs = [Collections.Generic.List[string]]::new()
    foreach ($item in @($node, $npm)) {
      if ($item) {
        $dir = Split-Path -Parent $item
        if (-not ($dirs | Where-Object { [string]::Equals($_, $dir, [StringComparison]::OrdinalIgnoreCase) })) { $dirs.Add($dir) }
      }
    }
    foreach ($dir in @($envPath -split [IO.Path]::PathSeparator)) {
      if ($dir -and -not ($dirs | Where-Object { [string]::Equals($_, $dir, [StringComparison]::OrdinalIgnoreCase) })) { $dirs.Add($dir) }
    }

    $missing = @()
    if (-not $node) { $missing += 'node' }
    if (-not $npm) { $missing += 'npm' }
    return [pscustomobject]@{
      success = ($missing.Count -eq 0)
      status = if ($missing.Count -eq 0) { 'READY' } else { 'ENVIRONMENT_ERROR' }
      errorCategory = if ($missing.Count -eq 0) { $null } else { 'environment_error' }
      nodePath = $node
      npmPath = $npm
      augmentedPath = @($dirs) -join [IO.Path]::PathSeparator
      searchedPath = $envPath
      missing = @($missing)
      error = if ($missing.Count -eq 0) { $null } else { "Node/npm toolchain missing: $($missing -join ', ')" }
    }
  } finally {
    $env:PATH = $oldPath
  }
}

function Get-NodeEngineMinimumVersion {
  param([string]$PackageJsonPath)
  if (-not $PackageJsonPath -or -not (Test-Path -LiteralPath $PackageJsonPath)) { return $null }
  try {
    $package = Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json
    $engine = [string]$package.engines.node
    if ($engine -match '>=\s*(\d+(?:\.\d+){0,2})') { return [version]$Matches[1] }
  } catch {}
  return $null
}

function Invoke-NodeNpmPreflight {
  [CmdletBinding()]
  param(
    [string]$WorkingDirectory = (Get-Location).Path,
    [string]$PackageJsonPath = '',
    [string]$NodePath = '',
    [string]$NpmPath = '',
    [hashtable]$Environment = @{},
    [int]$TimeoutSeconds = 15
  )

  $resolved = Resolve-NodeNpmToolchain -NodePath $NodePath -NpmPath $NpmPath -Environment $Environment
  if (-not $resolved.success) { return $resolved }
  if (-not (Get-Command Invoke-BoundedCommand -ErrorAction SilentlyContinue)) {
    throw 'Invoke-NodeNpmPreflight requires bounded-process-runner.ps1.'
  }

  $envVars = @{
    PATH = $resolved.augmentedPath
    CODEX_GEMINI_NODE_PATH = $resolved.nodePath
    CODEX_GEMINI_NPM_PATH = $resolved.npmPath
  }
  $nodeCommand = '"' + $resolved.nodePath + '" --version'
  $npmCommand = '"' + $resolved.npmPath + '" --version'
  $nodeResult = Invoke-BoundedCommand -Command $nodeCommand -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds -EnvironmentVariables $envVars
  $npmResult = Invoke-BoundedCommand -Command $npmCommand -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds -EnvironmentVariables $envVars
  $nodeVersion = $null
  if ($nodeResult.output -match 'v?(\d+(?:\.\d+){1,2})') { $nodeVersion = [version]$Matches[1] }
  $minimumVersion = Get-NodeEngineMinimumVersion $PackageJsonPath
  $versionOk = ($null -eq $minimumVersion -or ($nodeVersion -and $nodeVersion -ge $minimumVersion))
  $success = ($nodeResult.status -eq 'PASS' -and $npmResult.status -eq 'PASS' -and $versionOk)

  $resolved.success = $success
  $resolved.status = if ($success) { 'READY' } else { 'ENVIRONMENT_ERROR' }
  $resolved.errorCategory = if ($success) { $null } else { 'environment_error' }
  $resolved | Add-Member -NotePropertyName nodeVersion -NotePropertyValue $(if ($nodeVersion) { $nodeVersion.ToString() } else { $null }) -Force
  $resolved | Add-Member -NotePropertyName npmVersion -NotePropertyValue $(if ($npmResult.status -eq 'PASS') { $npmResult.output.Trim() } else { $null }) -Force
  $resolved | Add-Member -NotePropertyName requiredNodeVersion -NotePropertyValue $(if ($minimumVersion) { $minimumVersion.ToString() } else { $null }) -Force
  $resolved | Add-Member -NotePropertyName nodeResult -NotePropertyValue $nodeResult -Force
  $resolved | Add-Member -NotePropertyName npmResult -NotePropertyValue $npmResult -Force
  $resolved.error = if ($success) { $null } elseif (-not $versionOk) { "Node version $nodeVersion does not satisfy >=$minimumVersion." } else { 'Node/npm executable preflight failed.' }
  return $resolved
}
