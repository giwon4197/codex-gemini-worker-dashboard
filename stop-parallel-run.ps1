[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [string]$Repository = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$repoRoot = (& git -C $Repository rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw "Git 저장소가 아닙니다: $Repository" }
$runRoot = Join-Path $repoRoot.Trim() ".agent\runs\$RunId"
if (-not (Test-Path -LiteralPath $runRoot)) { throw "실행을 찾을 수 없습니다: $RunId" }
$cancelPath = Join-Path $runRoot 'cancel.requested'
[IO.File]::WriteAllText($cancelPath, (Get-Date).ToString('o'), [Text.Encoding]::UTF8)
foreach ($worker in Get-ChildItem -LiteralPath (Join-Path $runRoot 'workers') -Filter '*.json' -ErrorAction SilentlyContinue) {
  try {
    $state = Get-Content -Raw -LiteralPath $worker.FullName | ConvertFrom-Json
    foreach ($processId in @($state.agentProcessId, $state.runnerProcessId)) {
      if ($processId -and (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue)) {
        Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}
Write-Output "취소 요청 완료: $RunId"
