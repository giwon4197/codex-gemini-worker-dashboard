# Synchronize only installer-owned program files. Runtime/user state is never
# enumerated for deletion, including during migration from pre-manifest installs.
function Sync-InstalledProgramFiles([string]$SourceRoot, [string]$InstallRoot) {
  $source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
  $target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
  if ($source -eq $target -or $source.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallRoot must not equal or contain SourceRoot'
  }
  function Test-ProgramPath([string]$Relative) {
    $normalized = $Relative.Replace('\', '/')
    if ([IO.Path]::IsPathRooted($Relative) -or $normalized -match '(^|/)\.\.(/|$)') { return $false }
    if ($normalized -match '(^|/)(\.git|\.agent|\.agents|\.codex|node_modules|dist|\.wrangler|\.vinext|\.vite|sessions)(/|$)') { return $false }
    if ($normalized -match '(^|/)(\.env($|\.)|auth\.json$|worker-settings\.json$|live-worker\.json$)' -or $normalized -match '\.(log|tmp|tsbuildinfo)$') { return $false }
    if ($normalized -match '^gemini-dashboard/public/data/' -and $normalized -notmatch '\.example\.json$') { return $false }
    if ($normalized -eq '.installed-program-files.json' -or $normalized -match '^bin/') { return $false }
    return $true
  }
  $files = [System.Collections.Generic.List[string]]::new()
  function Add-ProgramDirectory([string]$Directory) {
    foreach ($entry in Get-ChildItem -LiteralPath $Directory -Force) {
      # OneDrive hydrated files also carry ReparsePoint. Only filesystem links
      # redirect traversal; excluding all reparse points loses the whole source.
      if ($entry.LinkType -in @('SymbolicLink', 'Junction')) { continue }
      $relative = [IO.Path]::GetRelativePath($source, $entry.FullName).Replace('\', '/')
      if (-not (Test-ProgramPath $relative)) { continue }
      if ($entry.PSIsContainer) { Add-ProgramDirectory $entry.FullName }
      else { $files.Add($relative) }
    }
  }
  Add-ProgramDirectory $source
  [IO.Directory]::CreateDirectory($target) | Out-Null
  $manifestPath = Join-Path $target '.installed-program-files.json'
  $previous = @()
  if (Test-Path -LiteralPath $manifestPath) { $previous = @(Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json -ErrorAction Stop) }
  # Known retired program files are the only pre-manifest cleanup candidates.
  $previous += @('gemini-dashboard/next.config.ts', 'gemini-dashboard/.openai/hosting.json')
  foreach ($relative in $previous) {
    if (-not (Test-ProgramPath $relative) -or $files.Contains($relative)) { continue }
    $candidate = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (-not $candidate.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed manifest path escapes InstallRoot' }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force }
  }
  foreach ($relative in $files) {
    $destination = Join-Path $target $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $destination -Force
  }
  [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject @($files | Sort-Object)))
}
