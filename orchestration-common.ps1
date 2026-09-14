# Shared orchestration contracts; dot-sourcing performs no runtime work.
function Get-ModelTierConfiguration([string]$Root = $PSScriptRoot) {
  $configPath = Join-Path $Root 'model-tiers.json'
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Required model tier configuration not found: $configPath"
  }
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json -ErrorAction Stop
  if (-not $config.default_tier -or -not $config.tiers) { throw 'Invalid model tier configuration: default_tier and tiers are required' }
  $map = @{}
  foreach ($entry in $config.tiers) {
    foreach ($field in @('tier', 'model', 'description')) {
      if ($entry.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($entry.$field)) {
        throw "Invalid model tier configuration: $field is required"
      }
    }
    if ($map.ContainsKey($entry.tier)) { throw "Duplicate model tier: $($entry.tier)" }
    $map[$entry.tier] = $entry.model
  }
  if (-not $map.ContainsKey($config.default_tier)) { throw 'Unknown default_tier' }
  return [pscustomobject]@{ DefaultTier = $config.default_tier; TierMap = $map }
}

function Resolve-SharedDashboardPaths {
  param(
    [string]$ExplicitDataDir = '',
    [string]$ExplicitDashboardPath = '',
    [string]$RepoPath = ''
  )
  if (-not [string]::IsNullOrWhiteSpace($ExplicitDashboardPath)) {
    $dash = [System.IO.Path]::GetFullPath($ExplicitDashboardPath)
    return [pscustomobject]@{ DataDir = Split-Path -Parent $dash; DashboardPath = $dash }
  }
  if (-not [string]::IsNullOrWhiteSpace($ExplicitDataDir)) {
    $dDir = [System.IO.Path]::GetFullPath($ExplicitDataDir)
    return [pscustomobject]@{ DataDir = $dDir; DashboardPath = (Join-Path $dDir 'dashboard.json') }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_DASHBOARD_PATH)) {
    $dash = [System.IO.Path]::GetFullPath($env:CODEX_GEMINI_DASHBOARD_PATH)
    return [pscustomobject]@{ DataDir = Split-Path -Parent $dash; DashboardPath = $dash }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_DATA_DIR)) {
    $dDir = [System.IO.Path]::GetFullPath($env:CODEX_GEMINI_DATA_DIR)
    return [pscustomobject]@{ DataDir = $dDir; DashboardPath = (Join-Path $dDir 'dashboard.json') }
  }
  $checkDirs = @($PSScriptRoot, $RepoPath) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_) }
  foreach ($dir in $checkDirs) {
    $commonDir = (& git -C $dir rev-parse --git-common-dir 2>$null)
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($commonDir)) {
      $commonTrim = $commonDir.Trim()
      $mainGitRoot = if ([System.IO.Path]::IsPathRooted($commonTrim)) {
        [System.IO.Path]::GetFullPath((Join-Path $commonTrim '..'))
      } else {
        [System.IO.Path]::GetFullPath((Join-Path $dir (Join-Path $commonTrim '..')))
      }
      $candData = Join-Path $mainGitRoot 'gemini-dashboard\public\data'
      if (Test-Path -LiteralPath $candData) {
        return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
      }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_GEMINI_INSTALL_ROOT)) {
    $candData = Join-Path $env:CODEX_GEMINI_INSTALL_ROOT 'gemini-dashboard\public\data'
    if (Test-Path -LiteralPath $candData) {
      return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $candData = Join-Path $env:LOCALAPPDATA 'codex-gemini-worker-dashboard\gemini-dashboard\public\data'
    if (Test-Path -LiteralPath $candData) {
      return [pscustomobject]@{ DataDir = $candData; DashboardPath = (Join-Path $candData 'dashboard.json') }
    }
  }
  $fallbackData = Join-Path $PSScriptRoot 'gemini-dashboard\public\data'
  return [pscustomobject]@{ DataDir = $fallbackData; DashboardPath = (Join-Path $fallbackData 'dashboard.json') }
}

function Set-ObjectProperty($Object, [string]$Name, $Value) {
  if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
  else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Invoke-Verification([string]$Worktree, $Commands, [int]$DefaultTimeoutSeconds = 120) {
  return @(Invoke-BoundedVerification -Worktree $Worktree -Commands $Commands -DefaultTimeoutSeconds $DefaultTimeoutSeconds)
}

function Redact-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $result = $text
  $result = [regex]::Replace($result, '(?i)(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}', '[REDACTED_TOKEN]')
  $result = [regex]::Replace($result, '(?i)github_pat_[A-Za-z0-9_]{20,}', '[REDACTED_TOKEN]')
  $result = [regex]::Replace($result, 'AIza[0-9A-Za-z-_]{30,40}', '[REDACTED_API_KEY]')
  $result = [regex]::Replace($result, '(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*', 'Bearer [REDACTED]')
  $result = [regex]::Replace($result, '(?i)Authorization:\s*[^\r\n]+', 'Authorization: [REDACTED]')
  $result = [regex]::Replace($result, 'https?://[^/@\s\r\n]+(?::[^/@\s\r\n]+)?@', 'https://[REDACTED_CREDENTIALS]@')
  $result = [regex]::Replace($result, '([?&](?:token|access_token|secret|password|api_key|apiKey)=)[^&\s\r\n]+', '$1[REDACTED]')
  $result = [regex]::Replace($result, '-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----', '[REDACTED_PRIVATE_KEY]')
  # Preserve the worker's additional standalone OpenAI/key-value coverage.
  $result = $result -replace 'sk-[a-zA-Z0-9]{20,}', '[REDACTED_SECRET]'
  $result = $result -replace '(?i)(key|token|secret|password|auth)=([a-zA-Z0-9_\-\.]{8,})', '$1=[REDACTED]'
  return $result
}

function Redact-Secrets([string]$Text) { return (Redact-Text $Text) }

# Parallel/review writes throw and serialize to depth 16. Worker telemetry uses
# explicit -Depth 8 -BestEffort to retain its existing observable failure policy.
function Write-AtomicJson {
  param([string]$Path, $Data, [int]$Depth = 16, [switch]$BestEffort)
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($Data | ConvertTo-Json -Depth $Depth), [Text.Encoding]::UTF8)
    try { [IO.File]::Move($temp, $Path, $true) }
    catch {
      [IO.File]::Copy($temp, $Path, $true)
      [IO.File]::Delete($temp)
    }
  } catch {
    if (-not $BestEffort) { throw }
  } finally {
    if (Test-Path -LiteralPath $temp) {
      try { [IO.File]::Delete($temp) } catch {}
    }
  }
}
