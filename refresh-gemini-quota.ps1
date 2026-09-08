[CmdletBinding()]
param(
    [string]$DashboardDir = (Join-Path $PSScriptRoot 'gemini-dashboard'),
    [ValidateRange(15, 3600)][int]$IntervalSeconds = 60,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'
$quotaPath = Join-Path $DashboardDir 'public\data\gemini-quota.json'
$quotaDir = Split-Path -Parent $quotaPath
$agyPath = if ($env:AGY_BIN -and (Test-Path -LiteralPath $env:AGY_BIN)) {
    $env:AGY_BIN
} elseif ($env:LOCALAPPDATA -and (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'))) {
    Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
} else {
    $command = Get-Command agy.exe -ErrorAction SilentlyContinue
    if ($command) { $command.Source } else { $null }
}

New-Item -ItemType Directory -Path $quotaDir -Force | Out-Null

do {
    $now = [DateTimeOffset]::UtcNow
    $response = [ordered]@{
        ok = $false
        status = 'unavailable'
        quota = $null
        lastSyncedAt = $now.ToString('o')
        message = 'Gemini 쿼터 상태를 확인할 수 없습니다.'
    }

    try {
        if (-not $agyPath) { throw 'Antigravity CLI를 찾을 수 없습니다.' }
        $raw = & $agyPath --output-format json --print /quota 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $raw) { throw 'Antigravity CLI 쿼터 조회에 실패했습니다.' }
        $payload = ($raw -join "`n") | ConvertFrom-Json
        $groups = @($payload.command.data.groups)
        $geminiGroup = $groups | Where-Object { $_.name -match 'Gemini' } | Select-Object -First 1
        if (-not $geminiGroup) { throw 'Gemini 쿼터 그룹이 없습니다.' }

        function Convert-QuotaPool($Bucket, [string]$Window) {
            if (-not $Bucket -or $null -eq $Bucket.remaining_fraction) { return $null }
            $remaining = [Math]::Round([Math]::Max(0, [Math]::Min(100, ([double]$Bucket.remaining_fraction * 100))), 4)
            $reset = $null
            $durationMs = $null
            $durationText = $null
            if ($Bucket.reset_time) {
                $resetAt = [DateTimeOffset]::Parse(
                    [string]$Bucket.reset_time,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::AssumeUniversal
                )
                $reset = $resetAt.ToUniversalTime().ToString('o')
                $durationMs = [Math]::Max(0, [Math]::Floor(($resetAt - $now).TotalMilliseconds))
                $minutes = [Math]::Floor($durationMs / 60000)
                $days = [Math]::Floor($minutes / 1440)
                $hours = [Math]::Floor(($minutes % 1440) / 60)
                if ($days -gt 0) { $durationText = if ($hours -gt 0) { "$days`일 $hours`시간" } else { "$days`일" } }
                elseif ($hours -gt 0) { $durationText = "$hours`시간 $($minutes % 60)`분" }
                else { $durationText = "$([Math]::Max(0, $minutes))`분" }
            }
            [ordered]@{
                id = [string]$Bucket.id
                name = [string]$Bucket.name
                window = $Window
                usedPercent = [Math]::Round(100 - $remaining, 4)
                remainingPercent = $remaining
                resetTime = $reset
                remainingDurationMs = $durationMs
                remainingDurationText = $durationText
                isAvailable = $true
            }
        }

        $fiveHour = Convert-QuotaPool ($geminiGroup.buckets | Where-Object { $_.window -eq '5h' } | Select-Object -First 1) '5h'
        $weekly = Convert-QuotaPool ($geminiGroup.buckets | Where-Object { $_.window -eq 'weekly' } | Select-Object -First 1) 'weekly'
        if (-not $fiveHour -and -not $weekly) { throw '확인 가능한 Gemini 쿼터 풀이 없습니다.' }
        $response = [ordered]@{
            ok = $true
            status = 'available'
            quota = [ordered]@{ fiveHour = $fiveHour; weekly = $weekly; description = $null }
            lastSyncedAt = $now.ToString('o')
        }
    } catch {
        # Public output intentionally contains no raw CLI error, account, or auth data.
    }

    $tempPath = "$quotaPath.tmp"
    $response | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tempPath -Encoding utf8
    Move-Item -LiteralPath $tempPath -Destination $quotaPath -Force
    if (-not $Once) { Start-Sleep -Seconds $IntervalSeconds }
} while (-not $Once)
