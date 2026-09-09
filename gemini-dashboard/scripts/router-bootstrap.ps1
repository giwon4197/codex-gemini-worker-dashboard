[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$InputFile,
  [Parameter(Mandatory = $false)][string]$Request,
  [Parameter(Mandatory = $false)][string]$Repository
)

$ErrorActionPreference = 'Stop'

# 1. Ensure console input/output and pipeline encodings are strictly UTF-8 before anything else (Criterion 1)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 2. Configuration resolution from InputFile (recommended) or parameters
$config = $null
$repoRoot = $null
$dashboardRunId = $null
$promptText = $null
$routerScript = $null
$metaPath = $null
$logPath = $null

if ($InputFile) {
  if (-not (Test-Path -LiteralPath $InputFile)) {
    throw "입력 설정 파일을 찾을 수 없습니다: $InputFile"
  }
  $raw = [System.IO.File]::ReadAllText($InputFile, [System.Text.Encoding]::UTF8)
  $config = ConvertFrom-Json -InputObject $raw

  $dashboardRunId = [string]$config.dashboardRunId
  $repoRoot = [System.IO.Path]::GetFullPath([string]$config.repoRoot)
  $promptText = [string]$config.prompt
  $routerScript = if ($config.routerScript) { [System.IO.Path]::GetFullPath([string]$config.routerScript) } else { [System.IO.Path]::Combine($repoRoot, 'codex-router.ps1') }
  $metaPath = if ($config.metaPath) { [string]$config.metaPath } else { $null }
  $logPath = if ($config.logPath) { [string]$config.logPath } else { $null }

  # Repository Confinement and Validation
  $resolvedInput = [System.IO.Path]::GetFullPath($InputFile)
  if (-not $resolvedInput.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "입력 파일이 저장소 경계 외부에 있습니다: $InputFile"
  }
} else {
  $promptText = $Request
  $repoRoot = if ($Repository) { [System.IO.Path]::GetFullPath($Repository) } else { (Get-Location).Path }
  $routerScript = [System.IO.Path]::Combine($repoRoot, 'codex-router.ps1')
  $dashboardRunId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-bootstrap'
}

if (-not $dashboardRunId -or $dashboardRunId -notmatch '^[0-9a-zA-Z_-]+$') {
  throw "유효하지 않은 dashboardRunId 형식입니다: $dashboardRunId"
}

if (-not (Test-Path -LiteralPath $repoRoot)) {
  throw "저장소 디렉터리를 찾을 수 없습니다: $repoRoot"
}

# Router script confinement check
if (-not $routerScript.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "라우터 스크립트가 저장소 경계 외부에 있습니다: $routerScript"
}

if (-not (Test-Path -LiteralPath $routerScript)) {
  throw "라우터 스크립트를 찾을 수 없습니다: $routerScript"
}

function Write-AtomicMeta($metaObj) {
  if (-not $metaPath) { return }
  try {
    $dir = [System.IO.Path]::GetDirectoryName($metaPath)
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $tmp = "$metaPath.$PID.$([System.Guid]::NewGuid().ToString('N')).tmp"
    $json = ConvertTo-Json -InputObject $metaObj -Depth 5
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::UTF8)
    [System.IO.File]::Move($tmp, $metaPath, $true)
  } catch {
    try {
      [System.IO.File]::Copy($tmp, $metaPath, $true)
      [System.IO.File]::Delete($tmp)
    } catch {}
  }
}

$exitCode = 0
$errorMsg = $null
$startedAt = (Get-Date).ToString('o')

$meta = [pscustomobject]@{
  dashboardRunId = $dashboardRunId
  orchestratorProcessId = $PID
  startedAt = $startedAt
  status = 'running'
  exitCode = $null
  endedAt = $null
  actualRunId = $null
  error = $null
  logPath = $logPath
}

Write-AtomicMeta $meta

try {
  Write-Output "BOOTSTRAP_START: dashboardRunId=$dashboardRunId pid=$PID"

  # Execute the target router script
  # We do NOT concatenate shell strings; we invoke the script file directly with argument array
  & $routerScript -Request $promptText -Repository $repoRoot
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq $null) { $exitCode = 0 }
} catch {
  $exitCode = if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 1 }
  $errorMsg = $_.Exception.Message
  [Console]::Error.WriteLine("BOOTSTRAP_ERROR: $errorMsg")
} finally {
  $endedAt = (Get-Date).ToString('o')
  $meta.exitCode = $exitCode
  $meta.endedAt = $endedAt
  $meta.status = if ($exitCode -eq 0) { 'completed' } else { 'failed' }
  if ($errorMsg) {
    $meta.error = $errorMsg
  }
  Write-AtomicMeta $meta
  Write-Output "BOOTSTRAP_EXIT: exitCode=$exitCode endedAt=$endedAt"
}

exit $exitCode