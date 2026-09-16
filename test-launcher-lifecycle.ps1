[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'test-common.ps1') -AssertDetailLabel 'Detail'
$passCount = 0
$failCount = 0
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('launcher-lifecycle-' + [guid]::NewGuid().ToString('N'))
$parentProcess = $null
$childProcess = $null
$probeProcess = $null
$script:taskkillCalls = 0
$script:taskkillTargets = @()
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source

function New-ProbeInfo([string]$ScriptPath, [string[]]$ProbeArguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($pwshPath)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-File', $ScriptPath) + $ProbeArguments) {
        $info.ArgumentList.Add($argument)
    }
    return $info
}

try {
    [IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
    $tokens = $null
    $parseErrors = $null
    $launcherAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'dashboard-launcher.ps1'), [ref]$tokens, [ref]$parseErrors)
    Assert-Test 'production launcher parses before helper extraction' ($parseErrors.Count -eq 0)
    foreach ($functionName in @('Record-Action', 'Stop-ServerProcess')) {
        $functionAst = $launcherAst.Find({ param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
        }, $false)
        if (-not $functionAst) { throw "Required production function not found: $functionName" }
        # Load only these production definitions; do not execute the launcher body.
        . ([scriptblock]::Create($functionAst.Extent.Text))
    }

    $parentScript = Join-Path $fixtureRoot 'sleep-parent.ps1'
    [IO.File]::WriteAllText($parentScript, @'
param([string]$ChildPidPath)
$ErrorActionPreference = 'Stop'
$encodedSleep = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 30'))
$child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList @('-NoProfile', '-EncodedCommand', $encodedSleep) -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($ChildPidPath, [string]$child.Id)
Start-Sleep -Seconds 30
'@, [Text.Encoding]::UTF8)
    $childPidPath = Join-Path $fixtureRoot 'child.pid'
    $parentProcess = [Diagnostics.Process]::Start((New-ProbeInfo $parentScript @('-ChildPidPath', $childPidPath)))
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $childPidPath) -and [DateTime]::UtcNow -lt $deadline -and -not $parentProcess.HasExited) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $childPidPath)) { throw 'Fixture parent did not publish its child PID' }
    $childId = [int][IO.File]::ReadAllText($childPidPath)
    $childProcess = Get-Process -Id $childId -ErrorAction Stop
    $childRecord = Get-CimInstance Win32_Process -Filter "ProcessId = $childId" -ErrorAction Stop
    Assert-Test 'fixture has a live parent and its own real child' (-not $parentProcess.HasExited -and [int]$childRecord.ParentProcessId -eq $parentProcess.Id)
    Write-Host "Fixture parent PID=$($parentProcess.Id), child PID=$childId"

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $Port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $RecordFile = Join-Path $fixtureRoot 'cleanup-actions.txt'
    $MockProcessMode = ''
    # Force the real fallback branch without ever calling taskkill on a user process.
    function script:taskkill.exe {
        $script:taskkillCalls++
        $script:taskkillTargets += [int]$args[1]
        $global:LASTEXITCODE = 1
    }
    try { Stop-ServerProcess $parentProcess }
    finally { Remove-Item -LiteralPath Function:\taskkill.exe -ErrorAction SilentlyContinue }
    Assert-Test 'taskkill failure stub was called only for the fixture parent' ($script:taskkillCalls -eq 1 -and $script:taskkillTargets[0] -eq $parentProcess.Id)
    $parentProcess.Refresh()
    $childProcess.Refresh()
    Assert-Test 'fallback terminates the real parent process' $parentProcess.HasExited
    Assert-Test 'fallback terminates the recorded real child process' $childProcess.HasExited
    Assert-Test 'production cleanup records successful tree termination' ((Get-Content -Raw -LiteralPath $RecordFile).Contains('PROCESS_TREE_STOPPED'))

    $missingParentId = [int]::MaxValue
    if (Get-Process -Id $missingParentId -ErrorAction SilentlyContinue) { throw 'Expected nonexistent probe parent PID is in use' }
    $blockedCli = Join-Path $fixtureRoot 'blocked-quota.cmd'
    $cliMarker = Join-Path $fixtureRoot 'unexpected-cli-call.txt'
    [IO.File]::WriteAllText($blockedCli, "@echo off`r`necho CALLED > `"%~dp0unexpected-cli-call.txt`"`r`nexit /b 99`r`n", [Text.Encoding]::ASCII)
    foreach ($updaterName in @('refresh-gemini-quota.ps1', 'refresh-codex-rate-limits.ps1')) {
        $dashboardRoot = Join-Path $fixtureRoot ($updaterName + '-dashboard')
        $probeInfo = New-ProbeInfo (Join-Path $PSScriptRoot $updaterName) @('-DashboardDir', $dashboardRoot, '-ParentProcessId', [string]$missingParentId)
        # A regression must never reach an authenticated CLI: use an inert AGY
        # target and a child-only PATH/LOCALAPPDATA that cannot resolve Codex/agy.
        $probeInfo.Environment['AGY_BIN'] = $blockedCli
        $probeInfo.Environment['LOCALAPPDATA'] = $fixtureRoot
        $probeInfo.Environment['PATH'] = (Split-Path -Parent $pwshPath) + ';' + (Join-Path $env:SystemRoot 'System32')
        $probeProcess = [Diagnostics.Process]::Start($probeInfo)
        $stdoutTask = $probeProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $probeProcess.StandardError.ReadToEndAsync()
        if (-not $probeProcess.WaitForExit(10000)) {
            $probeProcess.Kill($true)
            $probeProcess.WaitForExit()
            throw "$updaterName did not exit after its parent was absent"
        }
        $probeOutput = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
        Assert-Test "$updaterName exits normally for an absent parent" ($probeProcess.ExitCode -eq 0) $probeOutput
        $snapshots = @(Get-ChildItem -LiteralPath $dashboardRoot -Recurse -File -ErrorAction SilentlyContinue)
        Assert-Test "$updaterName performs no quota snapshot write" ($snapshots.Count -eq 0)
        Assert-Test "$updaterName does not invoke the quota CLI" (-not (Test-Path -LiteralPath $cliMarker))
        $probeProcess.Dispose()
        $probeProcess = $null
    }
} catch {
    Assert-Test 'launcher lifecycle execution completes' $false $_.Exception.Message
} finally {
    Remove-Item -LiteralPath Function:\taskkill.exe -ErrorAction SilentlyContinue
    foreach ($ownedProcess in @($probeProcess, $parentProcess, $childProcess)) {
        if ($ownedProcess) {
            try { if (-not $ownedProcess.HasExited) { $ownedProcess.Kill($true); [void]$ownedProcess.WaitForExit(5000) } }
            finally { $ownedProcess.Dispose() }
        }
    }
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedFixture) -notlike 'launcher-lifecycle-*') {
        throw 'Refusing cleanup outside the lifecycle fixture directory'
    }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
Write-Host "Launcher lifecycle tests: $passCount passed / $failCount failed"
if ($failCount -gt 0) { exit 1 }
exit 0
