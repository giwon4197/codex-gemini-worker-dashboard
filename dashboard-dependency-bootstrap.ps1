[CmdletBinding()]
param(
  [Parameter(Mandatory = $false, Position = 0)][string]$Worktree = (Get-Location).Path,
  [Parameter(Mandatory = $false)][string]$SourceWorktree = '',
  [Parameter(Mandatory = $false)][int]$TimeoutSeconds = 180,
  [Parameter(Mandatory = $false)][switch]$ThrowOnError
)

$ErrorActionPreference = 'Stop'

$runnerScript = Join-Path $PSScriptRoot 'bounded-process-runner.ps1'
if (Test-Path -LiteralPath $runnerScript) {
  . $runnerScript
}

function Get-WorktreeTscPath([string]$WorktreePath) {
  $isWin = $IsWindows -or ($env:OS -like '*Windows*')
  $binDir = Join-Path $WorktreePath 'gemini-dashboard\node_modules\.bin'
  if ($isWin) {
    $cmd = Join-Path $binDir 'tsc.cmd'
    if (Test-Path -LiteralPath $cmd) { return $cmd }
    $exe = Join-Path $binDir 'tsc.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
    return $cmd
  }
  return Join-Path $binDir 'tsc'
}

function Test-DashboardDependenciesValid([string]$WorktreePath) {
  $dashDir = Join-Path $WorktreePath 'gemini-dashboard'
  if (-not (Test-Path -LiteralPath $dashDir)) {
    return $true
  }

  $nm = Join-Path $dashDir 'node_modules'
  if (-not (Test-Path -LiteralPath $nm)) {
    return $false
  }

  try {
    $null = Get-ChildItem -LiteralPath $nm -ErrorAction Stop | Select-Object -First 1
  } catch {
    return $false
  }

  $tscPath = Get-WorktreeTscPath $WorktreePath
  if (-not (Test-Path -LiteralPath $tscPath)) {
    return $false
  }

  try {
    $tscItem = Get-Item -LiteralPath $tscPath -ErrorAction Stop
    if ($tscItem.Length -le 0) {
      return $false
    }
    if ($tscItem.Length -lt 2000) {
      $txt = [IO.File]::ReadAllText($tscPath)
      if ($txt -match '(?i)This is not the tsc command|dummy|placeholder') {
        return $false
      }
    }
  } catch {
    return $false
  }

  return $true
}

function Remove-WorktreeNodeModules([string]$WorktreePath) {
  $dashDir = Join-Path $WorktreePath 'gemini-dashboard'
  $nm = Join-Path $dashDir 'node_modules'
  if (-not (Test-Path -LiteralPath $dashDir)) { return }

  try {
    if (Test-Path -LiteralPath $nm) {
      $item = Get-Item -LiteralPath $nm -Force -ErrorAction SilentlyContinue
      if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        [IO.Directory]::Delete($nm, $false)
        return
      }
    } else {
      try {
        [IO.Directory]::Delete($nm, $false)
        return
      } catch {}
    }
  } catch {}

  if (Test-Path -LiteralPath $nm) {
    try {
      Remove-Item -LiteralPath $nm -Recurse -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}

function Ensure-DashboardDependencies {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Worktree,
    [Parameter(Mandatory = $false)][string]$SourceWorktree = '',
    [Parameter(Mandatory = $false)][int]$TimeoutSeconds = 180,
    [Parameter(Mandatory = $false)][switch]$ThrowOnError
  )

  $dashDir = Join-Path $Worktree 'gemini-dashboard'
  if (-not (Test-Path -LiteralPath $dashDir)) {
    return [pscustomobject]@{
      success       = $true
      status        = 'PASS'
      reused        = $true
      timedOut      = $false
      exitCode      = 0
      errorCategory = $null
      error         = $null
      output        = 'No gemini-dashboard directory present; dependency check passed.'
    }
  }

  # 1. Reuse existing valid dependency tree idempotently
  if (Test-DashboardDependenciesValid $Worktree) {
    return [pscustomobject]@{
      success       = $true
      status        = 'PASS'
      reused        = $true
      timedOut      = $false
      exitCode      = 0
      errorCategory = $null
      error         = $null
      output        = "Existing valid dashboard dependencies reused in '$Worktree'."
    }
  }

  # Remove existing invalid or broken node_modules in destination before retry/junction/npm
  Remove-WorktreeNodeModules $Worktree

  # 2. Check if a valid source tree junction can be reused
  if (-not [string]::IsNullOrWhiteSpace($SourceWorktree) -and ($SourceWorktree -ne $Worktree)) {
    $srcDash = Join-Path $SourceWorktree 'gemini-dashboard'
    $srcNm = Join-Path $srcDash 'node_modules'
    if (Test-DashboardDependenciesValid $SourceWorktree) {
      $dstNm = Join-Path $dashDir 'node_modules'
      try {
        New-Item -ItemType Junction -Path $dstNm -Target $srcNm -Force -ErrorAction Stop | Out-Null
        if (Test-DashboardDependenciesValid $Worktree) {
          return [pscustomobject]@{
            success       = $true
            status        = 'PASS'
            reused        = $true
            timedOut      = $false
            exitCode      = 0
            errorCategory = $null
            error         = $null
            output        = "Reused valid dependency tree via junction from '$SourceWorktree'."
          }
        } else {
          Remove-WorktreeNodeModules $Worktree
        }
      } catch {
        Remove-WorktreeNodeModules $Worktree
      }
    }
  }

  # 3. Deterministic bootstrap: Lockfile-pinned npm ci
  $lockfilePath = Join-Path $dashDir 'package-lock.json'
  if (-not (Test-Path -LiteralPath $lockfilePath)) {
    $errMsg = "Missing checked-in package-lock.json in '$dashDir'; lockfile-pinned npm ci cannot run."
    if ($ThrowOnError) { throw $errMsg }
    return [pscustomobject]@{
      success       = $false
      status        = 'ENVIRONMENT_ERROR'
      reused        = $false
      timedOut      = $false
      exitCode      = 1
      errorCategory = 'environment_error'
      error         = $errMsg
      output        = $errMsg
    }
  }

  # Run npm ci through bounded process runner
  $npmTimeout = if ($TimeoutSeconds -gt 0) { $TimeoutSeconds } else { 180 }
  $ciResult = Invoke-BoundedCommand -Command 'npm ci' -WorkingDirectory $dashDir -TimeoutSeconds $npmTimeout -MaxOutputChars 12000

  if ($ciResult.timedOut) {
    $errMsg = "npm ci timed out after ${npmTimeout}s in '$dashDir'."
    if ($ThrowOnError) { throw $errMsg }
    return [pscustomobject]@{
      success       = $false
      status        = 'ENVIRONMENT_ERROR'
      reused        = $false
      timedOut      = $true
      exitCode      = $null
      errorCategory = 'environment_error'
      error         = $errMsg
      output        = $ciResult.output
    }
  }

  if ($ciResult.exitCode -ne 0 -or $ciResult.status -ne 'PASS') {
    $errMsg = "npm ci failed with exit code $($ciResult.exitCode) in '$dashDir'."
    if ($ThrowOnError) { throw $errMsg }
    return [pscustomobject]@{
      success       = $false
      status        = 'ENVIRONMENT_ERROR'
      reused        = $false
      timedOut      = $false
      exitCode      = $ciResult.exitCode
      errorCategory = 'environment_error'
      error         = $errMsg
      output        = $ciResult.output
    }
  }

  # Post-install dependency verification
  if (-not (Test-DashboardDependenciesValid $Worktree)) {
    $errMsg = "Dashboard dependencies absent or invalid after npm ci in '$dashDir'."
    if ($ThrowOnError) { throw $errMsg }
    return [pscustomobject]@{
      success       = $false
      status        = 'ENVIRONMENT_ERROR'
      reused        = $false
      timedOut      = $false
      exitCode      = 1
      errorCategory = 'environment_error'
      error         = $errMsg
      output        = $ciResult.output
    }
  }

  return [pscustomobject]@{
    success       = $true
    status        = 'PASS'
    reused        = $false
    timedOut      = $false
    exitCode      = 0
    errorCategory = $null
    error         = $null
    output        = $ciResult.output
  }
}

if ($MyInvocation.InvocationName -ne '.' -and $Worktree) {
  $res = Ensure-DashboardDependencies -Worktree $Worktree -SourceWorktree $SourceWorktree -TimeoutSeconds $TimeoutSeconds -ThrowOnError:$ThrowOnError
  Write-Output ($res | ConvertTo-Json -Depth 4)
  if (-not $res.success) {
    exit 1
  }
  exit 0
}
