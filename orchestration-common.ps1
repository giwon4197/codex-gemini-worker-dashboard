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
