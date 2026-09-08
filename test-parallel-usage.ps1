[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$workerScript = Join-Path $repoRoot 'run-gemini-worker.ps1'
$singleScript = $workerScript
$parallelScript = Join-Path $repoRoot 'run-parallel-workers.ps1'

if (-not (Test-Path -LiteralPath $workerScript)) {
    Write-Error "run-gemini-worker.ps1을 찾을 수 없습니다: $workerScript"
    exit 1
}
if (-not (Test-Path -LiteralPath $parallelScript)) {
    Write-Error "run-parallel-workers.ps1을 찾을 수 없습니다: $parallelScript"
    exit 1
}

$testTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("test-parallel-usage-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testTempRoot -Force | Out-Null

$passCount = 0
$failCount = 0

function Assert-Test([string]$testName, [bool]$condition, [string]$detail = '') {
    if ($condition) {
        Write-Host "  [PASS] $testName" -ForegroundColor Green
        $script:passCount++
    } else {
        Write-Host "  [FAIL] $testName" -ForegroundColor Red
        if ($detail) {
            Write-Host "         상세: $detail" -ForegroundColor Yellow
        }
        $script:failCount++
    }
}

function New-InitialDashboard([string]$Path, [bool]$IncludeProcessedKeys = $true) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $obj = [ordered]@{
        updatedAt = (Get-Date).ToString('o')
        summary = [ordered]@{
            tokens           = 0
            requests         = 0
            completed        = 0
            failed           = 0
            averageLatencyMs = 0
        }
        tokens = [ordered]@{
            prompt     = 0
            candidates = 0
            cached     = 0
            thoughts   = 0
        }
        codexDaily = @()
        jobs = @()
    }
    if ($IncludeProcessedKeys) {
        $obj['processedKeys'] = @()
    }
    $json = $obj | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($Path, $json, [System.Text.Encoding]::UTF8)
    return $Path
}

function New-MockWorkerState(
    [string]$WorkersDir,
    [string]$RunId,
    [string]$TaskId,
    [string]$TaskName,
    [string]$Model = 'gemini-3.8-flash-medium',
    [string]$Status = 'completed',
    [int64]$Prompt = 100,
    [int64]$Candidates = 50,
    [int64]$Cached = 20,
    [int64]$Thoughts = 10,
    [int64]$Total = 160,
    [int64]$Requests = 1,
    [int64]$LatencyMs = 1000,
    [double]$Elapsed = 1.0,
    [string]$FinalResponse = '성공',
    [string]$Error = $null
) {
    if (-not (Test-Path -LiteralPath $WorkersDir)) {
        New-Item -ItemType Directory -Path $WorkersDir -Force | Out-Null
    }
    $state = [ordered]@{
        runId          = $RunId
        taskId         = $TaskId
        attempt        = 1
        task           = $TaskName
        model          = $Model
        status         = $Status
        startedAt      = (Get-Date).AddSeconds(-$Elapsed).ToString('o')
        updatedAt      = (Get-Date).ToString('o')
        elapsedSeconds = $Elapsed
        recentLogs     = @(
            [pscustomobject]@{ timestamp = '10:00:00'; message = '시작'; type = 'system' },
            [pscustomobject]@{ timestamp = '10:00:01'; message = '완료'; type = 'result' }
        )
        partialUsage   = [ordered]@{
            prompt     = $Prompt
            candidates = $Candidates
            cached     = $Cached
            thoughts   = $Thoughts
            total      = $Total
            requests   = $Requests
            latencyMs  = $LatencyMs
        }
        finalResponse  = $FinalResponse
        error          = $Error
    }
    $filePath = Join-Path $WorkersDir "$TaskId.json"
    $json = $state | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($filePath, $json, [System.Text.Encoding]::UTF8)
    return $filePath
}

try {
    Write-Host '======================================================' -ForegroundColor Cyan
    Write-Host '   병렬 워커 중앙 dashboard.json 적산 검증 테스트 suite   ' -ForegroundColor Cyan
    Write-Host '======================================================' -ForegroundColor Cyan

    # ---------------------------------------------------------------
    # 1. 두 워커 완료 합산 테스트 (Two completed workers aggregated)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '1. 두 워커 완료 확정 partialUsage 합산 검증' -ForegroundColor Cyan
    $test1Dir = Join-Path $testTempRoot 'test1'
    $dash1 = Join-Path $test1Dir 'data\dashboard.json'
    New-InitialDashboard -Path $dash1 -IncludeProcessedKeys $true | Out-Null

    $run1Root = Join-Path $test1Dir 'runs\RUN-001'
    $workers1Dir = Join-Path $run1Root 'workers'
    New-MockWorkerState -WorkersDir $workers1Dir -RunId 'RUN-001' -TaskId 'TASK-01' -TaskName '헤더 구현' `
        -Model 'gemini-3.8-flash-medium' -Status 'completed' `
        -Prompt 1200 -Candidates 450 -Cached 300 -Thoughts 50 -Total 1700 -Requests 2 -LatencyMs 12500 -Elapsed 12.5 -FinalResponse '헤더 완료' | Out-Null

    New-MockWorkerState -WorkersDir $workers1Dir -RunId 'RUN-001' -TaskId 'TASK-02' -TaskName '푸터 구현' `
        -Model 'gemini-3.8-flash-high' -Status 'completed' `
        -Prompt 800 -Candidates 250 -Cached 100 -Thoughts 30 -Total 1080 -Requests 1 -LatencyMs 8000 -Elapsed 8.0 -FinalResponse '푸터 완료' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $run1Root -DashboardPath $dash1
    Assert-Test '동기화 종료 코드 0' ($LASTEXITCODE -eq 0) "실제 종료 코드: $LASTEXITCODE"

    $d1 = Get-Content -Raw -LiteralPath $dash1 | ConvertFrom-Json
    Assert-Test 'summary.tokens 합산 (1700 + 1080 = 2780)' ($d1.summary.tokens -eq 2780) "실제 값: $($d1.summary.tokens)"
    Assert-Test 'summary.requests 합산 (2 + 1 = 3)' ($d1.summary.requests -eq 3) "실제 값: $($d1.summary.requests)"
    Assert-Test 'summary.completed 증가 (2)' ($d1.summary.completed -eq 2) "실제 값: $($d1.summary.completed)"
    Assert-Test 'summary.failed 유지 (0)' ($d1.summary.failed -eq 0) "실제 값: $($d1.summary.failed)"
    Assert-Test 'tokens.prompt 합산 (1200 + 800 = 2000)' ($d1.tokens.prompt -eq 2000) "실제 값: $($d1.tokens.prompt)"
    Assert-Test 'tokens.candidates 합산 (450 + 250 = 700)' ($d1.tokens.candidates -eq 700) "실제 값: $($d1.tokens.candidates)"
    Assert-Test 'tokens.cached 합산 (300 + 100 = 400)' ($d1.tokens.cached -eq 400) "실제 값: $($d1.tokens.cached)"
    Assert-Test 'tokens.thoughts 합산 (50 + 30 = 80)' ($d1.tokens.thoughts -eq 80) "실제 값: $($d1.tokens.thoughts)"
    Assert-Test 'jobs 내역 2건 추가' ($d1.jobs.Count -eq 2) "실제 건수: $($d1.jobs.Count)"
    Assert-Test 'processedKeys에 RUN-001+TASK-01 등록' (@($d1.processedKeys) -contains 'RUN-001+TASK-01')
    Assert-Test 'processedKeys에 RUN-001+TASK-02 등록' (@($d1.processedKeys) -contains 'RUN-001+TASK-02')

    # ---------------------------------------------------------------
    # 2. 같은 runId+taskId 재처리 방지 테스트 (Exactly-once deduplication)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '2. 동일 runId+taskId 재관측/재동기화 시 중복 적산 방지 검증' -ForegroundColor Cyan
    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $run1Root -DashboardPath $dash1
    Assert-Test '재동기화 종료 코드 0' ($LASTEXITCODE -eq 0)

    $d1Re = Get-Content -Raw -LiteralPath $dash1 | ConvertFrom-Json
    Assert-Test '재동기화 후 summary.tokens 불변 (2780 유지)' ($d1Re.summary.tokens -eq 2780) "실제 값: $($d1Re.summary.tokens)"
    Assert-Test '재동기화 후 summary.requests 불변 (3 유지)' ($d1Re.summary.requests -eq 3) "실제 값: $($d1Re.summary.requests)"
    Assert-Test '재동기화 후 summary.completed 불변 (2 유지)' ($d1Re.summary.completed -eq 2) "실제 값: $($d1Re.summary.completed)"
    Assert-Test '재동기화 후 jobs 건수 불변 (2건 유지)' ($d1Re.jobs.Count -eq 2) "실제 건수: $($d1Re.jobs.Count)"

    # ---------------------------------------------------------------
    # 3. 서로 다른 taskId 합산 테스트 (New taskId correctly aggregated)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '3. 새로운 taskId 추가 시 신규 작업만 정확히 합산 검증' -ForegroundColor Cyan
    New-MockWorkerState -WorkersDir $workers1Dir -RunId 'RUN-001' -TaskId 'TASK-03' -TaskName '사이드바 구현' `
        -Model 'gemini-3.8-flash-low' -Status 'completed' `
        -Prompt 500 -Candidates 200 -Cached 50 -Thoughts 10 -Total 710 -Requests 1 -LatencyMs 5000 -Elapsed 5.0 -FinalResponse '사이드바 완료' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $run1Root -DashboardPath $dash1
    Assert-Test '신규 작업 동기화 종료 코드 0' ($LASTEXITCODE -eq 0)

    $d1New = Get-Content -Raw -LiteralPath $dash1 | ConvertFrom-Json
    Assert-Test 'summary.tokens 신규 합산 (2780 + 710 = 3490)' ($d1New.summary.tokens -eq 3490) "실제 값: $($d1New.summary.tokens)"
    Assert-Test 'summary.requests 합산 (3 + 1 = 4)' ($d1New.summary.requests -eq 4) "실제 값: $($d1New.summary.requests)"
    Assert-Test 'summary.completed 증가 (3)' ($d1New.summary.completed -eq 3) "실제 값: $($d1New.summary.completed)"
    Assert-Test 'tokens.prompt 합산 (2000 + 500 = 2500)' ($d1New.tokens.prompt -eq 2500) "실제 값: $($d1New.tokens.prompt)"
    Assert-Test 'jobs 내역 3건으로 증가' ($d1New.jobs.Count -eq 3) "실제 건수: $($d1New.jobs.Count)"
    Assert-Test 'processedKeys에 RUN-001+TASK-03 등록' (@($d1New.processedKeys) -contains 'RUN-001+TASK-03')

    # ---------------------------------------------------------------
    # 4. 실패한 워커 처리 테스트 (Failed worker accumulation)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '4. 실패한 워커 확정 usage 및 상태 반영 검증' -ForegroundColor Cyan
    New-MockWorkerState -WorkersDir $workers1Dir -RunId 'RUN-001' -TaskId 'TASK-FAIL' -TaskName '컴파일 검증' `
        -Model 'gemini-3.8-flash-medium' -Status 'failed' `
        -Prompt 300 -Candidates 50 -Cached 0 -Thoughts 0 -Total 350 -Requests 1 -LatencyMs 3000 -Elapsed 3.0 `
        -FinalResponse $null -Error '빌드 실패: 타입 오류' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $run1Root -DashboardPath $dash1
    $d1Fail = Get-Content -Raw -LiteralPath $dash1 | ConvertFrom-Json
    Assert-Test 'summary.failed 증가 (1)' ($d1Fail.summary.failed -eq 1) "실제 값: $($d1Fail.summary.failed)"
    Assert-Test 'summary.completed 불변 (3)' ($d1Fail.summary.completed -eq 3) "실제 값: $($d1Fail.summary.completed)"
    Assert-Test '실패 작업 토큰도 summary.tokens에 적산 (3490 + 350 = 3840)' ($d1Fail.summary.tokens -eq 3840) "실제 값: $($d1Fail.summary.tokens)"
    Assert-Test '최신 job 상태가 실패' ($d1Fail.jobs[0].status -eq '실패')
    Assert-Test '최신 job snippet에 에러 메시지 포함' ($d1Fail.jobs[0].snippet -like '*타입 오류*')

    # ---------------------------------------------------------------
    # 5. 단일 워커 기존 적산과의 양방향 중복 방지 검증 (Single worker compatibility)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '5. 단일 워커 기존 적산과의 양방향 중복 방지 검증' -ForegroundColor Cyan
    $test2Dir = Join-Path $testTempRoot 'test2'
    $dash2 = Join-Path $test2Dir 'data\dashboard.json'
    New-InitialDashboard -Path $dash2 -IncludeProcessedKeys $true | Out-Null

    $mockLinesSingle = @(
        '{"event":"init","init":{"model":"gemini-3.8-flash-medium"}}',
        '{"event":"step_update","step_update":{"text_delta":"단일 워커 작업 완료"}}',
        '{"event":"result","result":{"response":"단일 워커 작업 완료","usage":{"input_tokens":200,"output_tokens":50,"cache_read_tokens":10,"thinking_tokens":5,"total_tokens":255},"num_turns":1,"duration_seconds":1.0,"status":"SUCCESS"}}'
    )
    $mockJsonSingle = ($mockLinesSingle -join "`n")

    # Run single worker standalone (StateRoot not provided -> single worker mode)
    & pwsh.exe -NoProfile -File $singleScript -Task '단일 워커 작업' -Prompt '테스트' `
        -OrchestrationRunId 'RUN-SINGLE' -TaskId 'TASK-S1' `
        -DashboardPath $dash2 -DataDir (Split-Path -Parent $dash2) `
        -MockOutputJson $mockJsonSingle -MockExitCode 0
    Assert-Test '단일 워커 단독 실행 성공' ($LASTEXITCODE -eq 0)

    $d2 = Get-Content -Raw -LiteralPath $dash2 | ConvertFrom-Json
    Assert-Test '단일 워커 summary.tokens 적산 확인 (255)' ($d2.summary.tokens -eq 255) "실제 값: $($d2.summary.tokens)"
    Assert-Test '단일 워커 processedKeys에 RUN-SINGLE+TASK-S1 등록' (@($d2.processedKeys) -contains 'RUN-SINGLE+TASK-S1')

    # 단일 워커 재실행 시 (동일 runId+taskId) 중복 적산 방지 검증
    & pwsh.exe -NoProfile -File $singleScript -Task '단일 워커 중복 작업' -Prompt '테스트' `
        -OrchestrationRunId 'RUN-SINGLE' -TaskId 'TASK-S1' `
        -DashboardPath $dash2 -DataDir (Split-Path -Parent $dash2) `
        -MockOutputJson $mockJsonSingle -MockExitCode 0
    Assert-Test '단일 워커 중복 실행 종료 코드 0' ($LASTEXITCODE -eq 0)

    $d2Dup = Get-Content -Raw -LiteralPath $dash2 | ConvertFrom-Json
    Assert-Test '단일 워커 중복 실행 후 summary.tokens 불변 (255 유지)' ($d2Dup.summary.tokens -eq 255) "실제 값: $($d2Dup.summary.tokens)"
    Assert-Test '단일 워커 중복 실행 후 jobs 건수 1건 유지' ($d2Dup.jobs.Count -eq 1)

    # 오케스트레이터가 동일 runId+taskId를 관측했을 때도 중복 적산 방지 검증
    $runSingleRoot = Join-Path $test2Dir 'runs\RUN-SINGLE'
    $workersSingleDir = Join-Path $runSingleRoot 'workers'
    New-MockWorkerState -WorkersDir $workersSingleDir -RunId 'RUN-SINGLE' -TaskId 'TASK-S1' -TaskName '단일 워커 작업' `
        -Prompt 200 -Candidates 50 -Cached 10 -Thoughts 5 -Total 255 -Requests 1 -LatencyMs 1000 -Elapsed 1.0 -FinalResponse '완료' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runSingleRoot -DashboardPath $dash2
    $d2Orch = Get-Content -Raw -LiteralPath $dash2 | ConvertFrom-Json
    Assert-Test '오케스트레이터 동기화 후에도 summary.tokens 불변 (255 유지)' ($d2Orch.summary.tokens -eq 255) "실제 값: $($d2Orch.summary.tokens)"

    # ---------------------------------------------------------------
    # 6. 병렬 워커의 dashboard.json 직접 갱신 금지 및 상태/이벤트 기록 검증 (Criterion 1)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '6. 병렬 워커의 dashboard.json 직접 갱신 금지 및 상태/이벤트 기록 검증' -ForegroundColor Cyan
    $test3Dir = Join-Path $testTempRoot 'test3'
    $dash3 = Join-Path $test3Dir 'data\dashboard.json'
    New-InitialDashboard -Path $dash3 -IncludeProcessedKeys $true | Out-Null
    $runParRoot = Join-Path $test3Dir 'runs\RUN-PAR'

    $mockLinesPar = @(
        '{"event":"init","init":{"model":"gemini-3.8-flash-medium"}}',
        '{"event":"step_update","step_update":{"text_delta":"병렬 워커 작업 완료"}}',
        '{"event":"result","result":{"response":"병렬 워커 작업 완료","usage":{"input_tokens":350,"output_tokens":60,"cache_read_tokens":0,"thinking_tokens":0,"total_tokens":410},"num_turns":1,"duration_seconds":1.2,"status":"SUCCESS"}}'
    )
    $mockJsonPar = ($mockLinesPar -join "`n")

    # Run gemini worker in parallel mode (StateRoot specified)
    & pwsh.exe -NoProfile -File $singleScript -Task '병렬 독립 작업' -Prompt '테스트' `
        -OrchestrationRunId 'RUN-PAR' -TaskId 'PAR-TASK-01' `
        -StateRoot $runParRoot `
        -DashboardPath $dash3 -DataDir (Split-Path -Parent $dash3) `
        -MockOutputJson $mockJsonPar -MockExitCode 0
    Assert-Test '병렬 모드 워커 실행 성공' ($LASTEXITCODE -eq 0)

    # Acceptance Criterion 1: Parallel worker must NOT directly modify dashboard.json
    $d3BeforeSync = Get-Content -Raw -LiteralPath $dash3 | ConvertFrom-Json
    Assert-Test '병렬 워커 단독 완료 후 대시보드 summary.tokens는 0 유지 (직접 수정 안함)' ($d3BeforeSync.summary.tokens -eq 0) "실제 값: $($d3BeforeSync.summary.tokens)"
    Assert-Test '대시보드 jobs는 빈 배열 유지' ($d3BeforeSync.jobs.Count -eq 0)

    # Acceptance Criterion 1: Confirmed usage is recorded in worker state and events
    $parWorkerState = Get-Content -Raw -LiteralPath (Join-Path $runParRoot 'workers\PAR-TASK-01.json') | ConvertFrom-Json
    Assert-Test '상태 파일에 확정 partialUsage.total 기록 확인 (410)' ($parWorkerState.partialUsage.total -eq 410)
    Assert-Test '상태 파일에 partialUsage.requests 기록 확인 (1)' ($parWorkerState.partialUsage.requests -eq 1)

    $parEventFile = Join-Path $runParRoot 'events\PAR-TASK-01.ndjson'
    Assert-Test '병렬 워커 이벤트 파일 생성 확인' (Test-Path -LiteralPath $parEventFile)
    $eventContent = Get-Content -Raw -LiteralPath $parEventFile -Encoding utf8
    Assert-Test '이벤트 파일에 confirmed_usage 이벤트 기록 확인' ($eventContent -like '*confirmed_usage*')

    # ---------------------------------------------------------------
    # 7. 공유 경로 전달 및 worktree 오염 방지 검증 (Criterion 5)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '7. 공유 경로 명시적 전달 및 worktree 오염 방지 검증' -ForegroundColor Cyan
    $explicitDataDir = Join-Path $testTempRoot 'custom-data'
    $explicitDashboard = Join-Path $explicitDataDir 'dashboard.json'
    New-InitialDashboard -Path $explicitDashboard -IncludeProcessedKeys $true | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runParRoot -DashboardPath $explicitDashboard -DataDir $explicitDataDir
    Assert-Test '명시적 경로 대상 동기화 성공' ($LASTEXITCODE -eq 0)

    $dCustom = Get-Content -Raw -LiteralPath $explicitDashboard | ConvertFrom-Json
    Assert-Test '명시적 지정 대시보드에 토큰 적산 성공 (410)' ($dCustom.summary.tokens -eq 410)

    # ---------------------------------------------------------------
    # 8. 기존 dashboard.json 필드 부재/빈 파일 호환성 및 Atomic Replace 검증 (Criterion 4)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '8. 빈 파일 / 구버전 dashboard.json 호환성 및 Atomic 갱신 검증' -ForegroundColor Cyan
    $test4Dir = Join-Path $testTempRoot 'test4'
    $dashNoProcessed = Join-Path $test4Dir 'data\dashboard.json'
    New-InitialDashboard -Path $dashNoProcessed -IncludeProcessedKeys $false | Out-Null

    $rawPre = Get-Content -Raw -LiteralPath $dashNoProcessed
    Assert-Test '초기 파일에 processedKeys 없음' ($rawPre -notlike '*processedKeys*')

    $runCompatRoot = Join-Path $test4Dir 'runs\RUN-COMPAT'
    $workersCompatDir = Join-Path $runCompatRoot 'workers'
    New-MockWorkerState -WorkersDir $workersCompatDir -RunId 'RUN-COMPAT' -TaskId 'TASK-C1' -TaskName '호환 작업' `
        -Prompt 100 -Candidates 50 -Cached 10 -Thoughts 0 -Total 150 | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runCompatRoot -DashboardPath $dashNoProcessed
    Assert-Test '구버전 호환 동기화 성공 (종료 코드 0)' ($LASTEXITCODE -eq 0)

    $dCompat = Get-Content -Raw -LiteralPath $dashNoProcessed | ConvertFrom-Json
    Assert-Test 'summary.tokens 적산 확인 (150)' ($dCompat.summary.tokens -eq 150)
    Assert-Test '새 processedKeys 필드가 정상 생성되어 기록됨' (@($dCompat.processedKeys) -contains 'RUN-COMPAT+TASK-C1')

    # Atomic test: ensure no leftover tmp files
    $tmpFiles = @(Get-ChildItem -LiteralPath (Split-Path -Parent $dashNoProcessed) -Filter '*.tmp' -ErrorAction SilentlyContinue)
    Assert-Test '원자적 교체 후 임시 파일(.tmp) 잔존 없음' ($tmpFiles.Count -eq 0)

    # ---------------------------------------------------------------
    # 9. 변경 파일들에 대한 PowerShell Parser (Lint) 검사
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '9. 수정 및 생성된 모든 PowerShell 스크립트 문법(Lint) 검사' -ForegroundColor Cyan
    $filesToLint = @(
        (Join-Path $repoRoot 'run-parallel-workers.ps1'),
        (Join-Path $repoRoot 'run-gemini-worker.ps1'),
        (Join-Path $repoRoot 'install.ps1'),
        (Join-Path $repoRoot 'test-parallel-usage.ps1')
    )

    foreach ($file in $filesToLint) {
        $shortName = Split-Path -Leaf $file
        if (Test-Path -LiteralPath $file) {
            $parseErrors = $null
            $tokens = $null
            $ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $file).Path, [ref]$tokens, [ref]$parseErrors)
            $hasErrors = ($parseErrors -and $parseErrors.Count -gt 0)
            Assert-Test "Parser Lint: $shortName" (-not $hasErrors) $(if ($hasErrors) { ($parseErrors | ForEach-Object { $_.Message }) -join '; ' } else { '' })
        } else {
            Assert-Test "Parser Lint: $shortName (파일 존재)" $false "파일을 찾을 수 없음"
        }
    }

    Write-Host ''
    Write-Host '======================================================' -ForegroundColor Cyan
    Write-Host "   테스트 완료: $passCount 통과 / $failCount 실패" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Red' })
    Write-Host '======================================================' -ForegroundColor Cyan

    if ($failCount -gt 0) {
        exit 1
    }
} finally {
    if (Test-Path -LiteralPath $testTempRoot) {
        try {
            Remove-Item -LiteralPath $testTempRoot -Recurse -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}
