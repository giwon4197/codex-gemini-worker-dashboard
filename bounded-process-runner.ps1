[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$Command = '',
  [Parameter(Mandatory = $false)][string]$WorkingDirectory = (Get-Location).Path,
  [Parameter(Mandatory = $false)][int]$TimeoutSeconds = 120,
  [Parameter(Mandatory = $false)][int]$MaxOutputChars = 12000
)

$ErrorActionPreference = 'Stop'

function Redact-Text([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $result = $text
  $result = [regex]::Replace($result, '(?i)(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}', '[REDACTED_TOKEN]')
  $result = [regex]::Replace($result, '(?i)github_pat_[A-Za-z0-9_]{20,}', '[REDACTED_TOKEN]')
  $result = [regex]::Replace($result, 'AIza[0-9A-Za-z-_]{35}', '[REDACTED_API_KEY]')
  $result = [regex]::Replace($result, '(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*', 'Bearer [REDACTED]')
  $result = [regex]::Replace($result, '(?i)Authorization:\s*[^\r\n]+', 'Authorization: [REDACTED]')
  $result = [regex]::Replace($result, 'https?://[^/@\s\r\n]+(?::[^/@\s\r\n]+)?@', 'https://[REDACTED_CREDENTIALS]@')
  $result = [regex]::Replace($result, '([?&](?:token|access_token|secret|password|api_key|apiKey)=)[^&\s\r\n]+', '$1[REDACTED]')
  $result = [regex]::Replace($result, '-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----', '[REDACTED_PRIVATE_KEY]')
  return $result
}

if (-not ([System.Management.Automation.PSTypeName]'BoundedCommandRunner').Type) {
  Add-Type -TypeDefinition @"
  using System;
  using System.Collections.Concurrent;
  using System.Collections.Generic;
  using System.Diagnostics;
  using System.Text;

  public class BoundedCommandRunner {
      public ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
      public Process Process;

      public void Start(string fileName, string arguments, string workingDir, IDictionary<string, string> env) {
          Process = new Process();
          Process.StartInfo.FileName = fileName;
          Process.StartInfo.Arguments = arguments;
          if (!string.IsNullOrEmpty(workingDir)) {
              Process.StartInfo.WorkingDirectory = workingDir;
          }
          Process.StartInfo.UseShellExecute = false;
          Process.StartInfo.RedirectStandardOutput = true;
          Process.StartInfo.RedirectStandardError = true;
          Process.StartInfo.StandardOutputEncoding = Encoding.UTF8;
          Process.StartInfo.StandardErrorEncoding = Encoding.UTF8;
          Process.StartInfo.CreateNoWindow = true;

          if (env != null) {
              foreach (var kvp in env) {
                  Process.StartInfo.EnvironmentVariables[kvp.Key] = kvp.Value;
              }
          }

          Process.OutputDataReceived += (s, e) => {
              if (e.Data != null) Lines.Enqueue(e.Data);
          };
          Process.ErrorDataReceived += (s, e) => {
              if (e.Data != null) Lines.Enqueue(e.Data);
          };

          Process.Start();
          Process.BeginOutputReadLine();
          Process.BeginErrorReadLine();
      }

      public bool WaitForExit(int timeoutMs) {
          if (Process == null) return true;
          return Process.WaitForExit(timeoutMs);
      }

      public void Kill() {
          try {
              if (Process != null && !Process.HasExited) {
                  Process.Kill(true);
              }
          } catch {}
      }
  }
"@
}

function Get-ProcessTreeIds([int]$RootPid) {
  $treeIds = [System.Collections.Generic.List[int]]::new()
  $isWin = $IsWindows -or ($env:OS -like '*Windows*')
  if ($isWin) {
    try {
      $allProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
      $queue = [System.Collections.Generic.Queue[int]]::new()
      $queue.Enqueue($RootPid)
      while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($p in $allProcs) {
          if ([int]$p.ParentProcessId -eq $parent) {
            $childId = [int]$p.ProcessId
            if (-not $treeIds.Contains($childId)) {
              [void]$treeIds.Add($childId)
              $queue.Enqueue($childId)
            }
          }
        }
      }
    } catch {}
  } else {
    try {
      $pids = @(& pgrep -P $RootPid 2>$null)
      foreach ($p in $pids) {
        if ($p -match '^\d+$') {
          $cid = [int]$p
          if (-not $treeIds.Contains($cid)) {
            [void]$treeIds.Add($cid)
            foreach ($sub in Get-ProcessTreeIds $cid) {
              if (-not $treeIds.Contains($sub)) { [void]$treeIds.Add($sub) }
            }
          }
        }
      }
    } catch {}
  }
  return @($treeIds)
}

function Stop-ProcessTree([int]$ProcessId, [System.Diagnostics.Process]$ProcessObject = $null) {
  if (-not $ProcessId -or $ProcessId -le 0) { return }
  $isWin = $IsWindows -or ($env:OS -like '*Windows*')
  $treeIds = @(Get-ProcessTreeIds $ProcessId)

  # 1. Kill via taskkill on Windows (with /T tree and /F force)
  if ($isWin) {
    try {
      & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
    } catch {}
  }

  # 2. Kill via Process.Kill(true) if process object provided
  if ($ProcessObject) {
    try {
      if (-not $ProcessObject.HasExited) {
        $ProcessObject.Kill($true)
      }
    } catch {}
  }

  # 3. Kill all discovered tree descendants in reverse (leaf first)
  $revTreeIds = @($treeIds)
  [array]::Reverse($revTreeIds)
  foreach ($cid in $revTreeIds) {
    try {
      $proc = Get-Process -Id $cid -ErrorAction SilentlyContinue
      if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $cid -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }

  # 4. If root process is still alive
  try {
    $rootProc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($rootProc -and -not $rootProc.HasExited) {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    }
  } catch {}

  # 5. Non-Windows fallback
  if (-not $isWin) {
    try { & kill -9 $ProcessId 2>$null | Out-Null } catch {}
    foreach ($cid in $treeIds) {
      try { & kill -9 $cid 2>$null | Out-Null } catch {}
    }
  }
}

function Invoke-BoundedCommand {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $false)][string]$WorkingDirectory = (Get-Location).Path,
    [Parameter(Mandatory = $false)][int]$TimeoutSeconds = 120,
    [Parameter(Mandatory = $false)][int]$MaxOutputChars = 12000,
    [Parameter(Mandatory = $false)][hashtable]$EnvironmentVariables = @{}
  )

  if ($TimeoutSeconds -le 0) { $TimeoutSeconds = 120 }
  $isWin = $IsWindows -or ($env:OS -like '*Windows*')

  $fileName = if ($isWin) {
    if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
  } else {
    '/bin/sh'
  }

  $arguments = if ($isWin) {
    "/d /s /c `"$Command`""
  } else {
    "-c `"$Command`""
  }

  $targetDir = if (Test-Path -LiteralPath $WorkingDirectory) { $WorkingDirectory } else { (Get-Location).Path }

  $envDict = [System.Collections.Generic.Dictionary[string, string]]::new()
  $envDict['CI'] = 'true'
  $envDict['npm_config_yes'] = 'true'
  $envDict['NPM_CONFIG_YES'] = 'true'
  $envDict['GIT_TERMINAL_PROMPT'] = '0'
  $envDict['NO_COLOR'] = '1'
  $envDict['DEBIAN_FRONTEND'] = 'noninteractive'

  if ($EnvironmentVariables) {
    foreach ($k in $EnvironmentVariables.Keys) {
      $envDict[[string]$k] = [string]$EnvironmentVariables[$k]
    }
  }

  $runner = [BoundedCommandRunner]::new()
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $runner.Start($fileName, $arguments, $targetDir, $envDict)
    $spawnedPid = $runner.Process.Id
    $timeoutMs = [int]($TimeoutSeconds * 1000)

    $exited = $runner.WaitForExit($timeoutMs)
    $timedOut = -not $exited

    if ($timedOut) {
      Stop-ProcessTree -ProcessId $spawnedPid -ProcessObject $runner.Process
      $runner.Kill()
      [void]$runner.WaitForExit(1500)
    } else {
      # Flush async buffers
      $runner.Process.WaitForExit()
    }
    $sw.Stop()

    $exitCode = if ($timedOut) { $null } else { try { $runner.Process.ExitCode } catch { -1 } }
    $status = if ($timedOut) { 'TIMED_OUT' } elseif ($exitCode -eq 0) { 'PASS' } else { 'FAIL' }

    $allLines = [System.Collections.Generic.List[string]]::new()
    $line = $null
    while ($runner.Lines.TryDequeue([ref]$line)) {
      [void]$allLines.Add($line)
    }

    $redactedLines = @($allLines | ForEach-Object { Redact-Text $_ })
    if ($timedOut) {
      $redactedLines += "[TIMEOUT] Command timed out after ${TimeoutSeconds}s and process tree was terminated."
    }

    $joined = $redactedLines -join "`n"
    if ($joined.Length -gt $MaxOutputChars) {
      $joined = $joined.Substring(0, $MaxOutputChars)
    }

    return [pscustomobject]@{
      command         = Redact-Text $Command
      exitCode        = $exitCode
      durationSeconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
      output          = $joined
      status          = $status
      timedOut        = $timedOut
      timeoutSeconds  = $TimeoutSeconds
    }
  } finally {
    try { if ($runner.Process) { $runner.Process.Dispose() } } catch {}
  }
}

function Invoke-BoundedVerification {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Worktree,
    [Parameter(Mandatory = $true)]$Commands,
    [Parameter(Mandatory = $false)][int]$DefaultTimeoutSeconds = 120
  )

  $results = @()
  foreach ($cmdItem in @($Commands)) {
    if ($null -eq $cmdItem) { continue }
    $cmdStr = ''
    $cmdTimeout = $DefaultTimeoutSeconds

    if ($cmdItem -is [string]) {
      $cmdStr = [string]$cmdItem
    } elseif ($cmdItem.PSObject.Properties.Name -contains 'command') {
      $cmdStr = [string]$cmdItem.command
      if ($cmdItem.PSObject.Properties.Name -contains 'timeoutSeconds' -and $cmdItem.timeoutSeconds) {
        $cmdTimeout = [int]$cmdItem.timeoutSeconds
      } elseif ($cmdItem.PSObject.Properties.Name -contains 'timeout_seconds' -and $cmdItem.timeout_seconds) {
        $cmdTimeout = [int]$cmdItem.timeout_seconds
      }
    } else {
      $cmdStr = [string]$cmdItem
    }

    if ([string]::IsNullOrWhiteSpace($cmdStr)) { continue }

    $res = Invoke-BoundedCommand -Command $cmdStr -WorkingDirectory $Worktree -TimeoutSeconds $cmdTimeout
    $results += $res
  }
  return $results
}

if ($MyInvocation.InvocationName -ne '.' -and $Command) {
  $singleResult = Invoke-BoundedCommand -Command $Command -WorkingDirectory $WorkingDirectory -TimeoutSeconds $TimeoutSeconds -MaxOutputChars $MaxOutputChars
  Write-Output ($singleResult | ConvertTo-Json -Depth 4)
}
