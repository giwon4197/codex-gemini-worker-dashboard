[CmdletBinding()]
param(
    [string]$DashboardDir = (Join-Path $PSScriptRoot 'gemini-dashboard'),
    [ValidateRange(5, 3600)][int]$IntervalSeconds = 15,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$outputPath = Join-Path $DashboardDir 'public\data\codex-rate-limits.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null

function Read-JsonLine($Reader, [int]$ExpectedId, [int]$TimeoutSeconds = 12) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $readTask = $Reader.ReadLineAsync()
        $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
        if (-not $readTask.Wait($remaining)) { return $null }
        $line = $readTask.Result
        if ($null -eq $line) { return $null }
        try {
            $message = $line | ConvertFrom-Json
            if ($message.id -eq $ExpectedId) { return $message }
        } catch {}
    }
    return $null
}

function Get-LiveRateLimits {
    $codex = Get-Command codex.exe -ErrorAction SilentlyContinue
    if (-not $codex) { throw 'Codex CLI를 찾을 수 없습니다.' }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $codex.Source
    $startInfo.Arguments = 'app-server --stdio'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { throw 'Codex app-server를 시작할 수 없습니다.' }
        $process.StandardInput.WriteLine('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"quota-dashboard","version":"1.0"},"capabilities":{}}}')
        $process.StandardInput.Flush()
        if (-not (Read-JsonLine $process.StandardOutput 1)) { throw 'Codex app-server 초기화 시간이 초과되었습니다.' }
        $process.StandardInput.WriteLine('{"id":2,"method":"account/rateLimits/read","params":null}')
        $process.StandardInput.Flush()
        $reply = Read-JsonLine $process.StandardOutput 2
        if (-not $reply.result.rateLimits) { throw 'Codex 한도 응답을 받지 못했습니다.' }
        return $reply.result.rateLimits
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

do {
    try {
        $limits = Get-LiveRateLimits
        $primary = $limits.primary
        $safe = [ordered]@{
            ok = $true
            rateLimits = [ordered]@{
                primary = if ($primary) { [ordered]@{
                    usedPercent = $primary.usedPercent
                    remainingPercent = if ($null -ne $primary.usedPercent) { 100 - [double]$primary.usedPercent } else { $null }
                    windowMinutes = $primary.windowDurationMins
                    resetsAt = $primary.resetsAt
                } } else { $null }
                secondary = $null
                credits = $null
                planType = $limits.planType
            }
            lastSyncedAt = [DateTimeOffset]::UtcNow.ToString('o')
        }
        $tempPath = "$outputPath.tmp"
        $safe | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $tempPath -Encoding utf8
        Move-Item -LiteralPath $tempPath -Destination $outputPath -Force
    } catch {
        # Keep the last known-good snapshot; never publish raw account errors.
    }
    if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
