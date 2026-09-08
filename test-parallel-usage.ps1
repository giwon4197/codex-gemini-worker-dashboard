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
    [string]$Error = $null,
    [int]$Attempt = 1
) {
    if (-not (Test-Path -LiteralPath $WorkersDir)) {
        New-Item -ItemType Directory -Path $WorkersDir -Force | Out-Null
    }
    $state = [ordered]@{
        runId          = $RunId
        taskId         = $TaskId
        attempt        = $Attempt
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
    $runRoot = Split-Path -Parent $WorkersDir
    $filePath = Join-Path $WorkersDir "$TaskId.json"
    $json = $state | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($filePath, $json, [System.Text.Encoding]::UTF8)

    $attemptsDir = Join-Path $runRoot 'attempts'
    if (-not (Test-Path -LiteralPath $attemptsDir)) {
        New-Item -ItemType Directory -Path $attemptsDir -Force | Out-Null
    }
    $attemptFilePath = Join-Path $attemptsDir "$TaskId.attempt-$Attempt.json"
    [System.IO.File]::WriteAllText($attemptFilePath, $json, [System.Text.Encoding]::UTF8)

    $eventsDir = Join-Path $runRoot 'events'
    if (-not (Test-Path -LiteralPath $eventsDir)) {
        New-Item -ItemType Directory -Path $eventsDir -Force | Out-Null
    }
    $eventFilePath = Join-Path $eventsDir "$TaskId.ndjson"
    $evt = [pscustomobject]@{
        timestamp = (Get-Date).ToString('o')
        runId     = $RunId
        taskId    = $TaskId
        attempt   = $Attempt
        type      = 'confirmed_usage'
        status    = $Status
        usage     = [pscustomobject]@{
            prompt     = $Prompt
            candidates = $Candidates
            cached     = $Cached
            thoughts   = $Thoughts
            total      = $Total
            requests   = $Requests
            latencyMs  = $LatencyMs
        }
    }
    Add-Content -LiteralPath $eventFilePath -Value ($evt | ConvertTo-Json -Compress) -Encoding utf8

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
    # 9. 재시도 워커 확정 사용량 합산 및 단일 논리 작업 카운트 검증 (Criterion 1, 3, 7)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '9. 재시도 워커 확정 사용량 합산 및 단일 논리 작업 카운트 검증' -ForegroundColor Cyan
    $testRetryDir = Join-Path $testTempRoot 'test-retry'
    $dashRetry = Join-Path $testRetryDir 'data\dashboard.json'
    New-InitialDashboard -Path $dashRetry -IncludeProcessedKeys $true | Out-Null

    $runRetryRoot = Join-Path $testRetryDir 'runs\RUN-RETRY-01'
    $workersRetryDir = Join-Path $runRetryRoot 'workers'

    # Attempt 1: Failed during tests, confirmed usage: 400 prompt + 100 cand = 500 total
    New-MockWorkerState -WorkersDir $workersRetryDir -RunId 'RUN-RETRY-01' -TaskId 'TASK-RETRY' -TaskName '재시도 테스트' `
        -Attempt 1 -Status 'failed' `
        -Prompt 400 -Candidates 100 -Cached 50 -Thoughts 20 -Total 500 -Requests 1 -LatencyMs 4000 -Elapsed 4.0 `
        -FinalResponse $null -Error '테스트 실패' | Out-Null

    # Attempt 2: Succeeded, confirmed usage: 600 prompt + 200 cand = 800 total
    New-MockWorkerState -WorkersDir $workersRetryDir -RunId 'RUN-RETRY-01' -TaskId 'TASK-RETRY' -TaskName '재시도 테스트' `
        -Attempt 2 -Status 'completed' `
        -Prompt 600 -Candidates 200 -Cached 80 -Thoughts 30 -Total 800 -Requests 1 -LatencyMs 5500 -Elapsed 5.5 `
        -FinalResponse '재시도 성공 완료' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runRetryRoot -DashboardPath $dashRetry
    Assert-Test '재시도 작업 동기화 성공' ($LASTEXITCODE -eq 0)

    $dRetry = Get-Content -Raw -LiteralPath $dashRetry | ConvertFrom-Json
    # 1) Confirmed usage from both attempts is summed: 500 + 800 = 1300
    Assert-Test '두 시도의 확정 사용량 합산 (500 + 800 = 1300)' ($dRetry.summary.tokens -eq 1300) "실제 값: $($dRetry.summary.tokens)"
    Assert-Test 'tokens.prompt 합산 (400 + 600 = 1000)' ($dRetry.tokens.prompt -eq 1000) "실제 값: $($dRetry.tokens.prompt)"
    Assert-Test 'tokens.candidates 합산 (100 + 200 = 300)' ($dRetry.tokens.candidates -eq 300) "실제 값: $($dRetry.tokens.candidates)"
    Assert-Test 'tokens.cached 합산 (50 + 80 = 130)' ($dRetry.tokens.cached -eq 130) "실제 값: $($dRetry.tokens.cached)"
    Assert-Test 'tokens.thoughts 합산 (20 + 30 = 50)' ($dRetry.tokens.thoughts -eq 50) "실제 값: $($dRetry.tokens.thoughts)"
    Assert-Test 'summary.requests 합산 (1 + 1 = 2)' ($dRetry.summary.requests -eq 2) "실제 값: $($dRetry.summary.requests)"

    # 2) Logical task count changes once: 1 completed, 0 failed
    Assert-Test '논리적 작업 완료 수 1회만 반영 (1)' ($dRetry.summary.completed -eq 1) "실제 값: $($dRetry.summary.completed)"
    Assert-Test '논리적 작업 실패 수 0 유지 (0)' ($dRetry.summary.failed -eq 0) "실제 값: $($dRetry.summary.failed)"
    Assert-Test 'jobs 내역 1건만 등록' ($dRetry.jobs.Count -eq 1) "실제 값: $($dRetry.jobs.Count)"
    Assert-Test 'jobs 최종 상태 완료' ($dRetry.jobs[0].status -eq '완료')
    Assert-Test 'jobs 총 토큰 합산 표기 (1,300)' ($dRetry.jobs[0].tokens -eq '1,300')

    # Re-sync idempotency test
    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runRetryRoot -DashboardPath $dashRetry
    $dRetryResync = Get-Content -Raw -LiteralPath $dashRetry | ConvertFrom-Json
    Assert-Test '재동기화 후 summary.tokens 불변 (1300)' ($dRetryResync.summary.tokens -eq 1300)
    Assert-Test '재동기화 후 summary.completed 불변 (1)' ($dRetryResync.summary.completed -eq 1)
    Assert-Test '재동기화 후 summary.failed 불변 (0)' ($dRetryResync.summary.failed -eq 0)
    Assert-Test '재동기화 후 jobs 건수 1건 유지' ($dRetryResync.jobs.Count -eq 1)

    # ---------------------------------------------------------------
    # 10. 타임아웃 및 실패 시도의 확정 사용량 보존 검증 (Criterion 2, 7)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '10. 타임아웃 및 실패 시도의 확정 사용량 보존 검증' -ForegroundColor Cyan
    $testTimeoutDir = Join-Path $testTempRoot 'test-timeout'
    $dashTimeout = Join-Path $testTimeoutDir 'data\dashboard.json'
    New-InitialDashboard -Path $dashTimeout -IncludeProcessedKeys $true | Out-Null

    $runTimeoutRoot = Join-Path $testTimeoutDir 'runs\RUN-TIMEOUT-01'
    $workersTimeoutDir = Join-Path $runTimeoutRoot 'workers'

    # Worker timed out after partial streaming: 350 prompt + 70 cand = 420 total
    New-MockWorkerState -WorkersDir $workersTimeoutDir -RunId 'RUN-TIMEOUT-01' -TaskId 'TASK-TIMEDOUT' -TaskName '시간 초과 작업' `
        -Attempt 1 -Status 'timed_out' `
        -Prompt 350 -Candidates 70 -Cached 30 -Thoughts 10 -Total 420 -Requests 1 -LatencyMs 10000 -Elapsed 10.0 `
        -FinalResponse $null -Error '작업 시간 초과 (오케스트레이터 강제 종료)' | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runTimeoutRoot -DashboardPath $dashTimeout
    Assert-Test '타임아웃 작업 동기화 성공' ($LASTEXITCODE -eq 0)

    $dTimeout = Get-Content -Raw -LiteralPath $dashTimeout | ConvertFrom-Json
    Assert-Test '타임아웃 작업 확정 summary.tokens 적산 확인 (420)' ($dTimeout.summary.tokens -eq 420) "실제 값: $($dTimeout.summary.tokens)"
    Assert-Test 'tokens.prompt 적산 (350)' ($dTimeout.tokens.prompt -eq 350)
    Assert-Test 'tokens.candidates 적산 (70)' ($dTimeout.tokens.candidates -eq 70)
    Assert-Test 'tokens.cached 적산 (30)' ($dTimeout.tokens.cached -eq 30)
    Assert-Test 'summary.failed 증가 (1)' ($dTimeout.summary.failed -eq 1) "실제 값: $($dTimeout.summary.failed)"
    Assert-Test 'summary.completed 유지 (0)' ($dTimeout.summary.completed -eq 0)
    Assert-Test 'jobs에 타임아웃 실패 내역 기록' ($dTimeout.jobs[0].status -eq '실패')

    # ---------------------------------------------------------------
    # 11. 기존 runId+taskId 레거시 데이터 호환 및 재동기화 중복 방지 검증 (Criterion 4, 7)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '11. 기존 runId+taskId 레거시 데이터 호환 및 재동기화 중복 방지 검증' -ForegroundColor Cyan
    $testLegacyDir = Join-Path $testTempRoot 'test-legacy'
    $dashLegacy = Join-Path $testLegacyDir 'data\dashboard.json'
    New-InitialDashboard -Path $dashLegacy -IncludeProcessedKeys $true | Out-Null

    # Pre-populate dashboard with legacy format (key is runId+taskId, no attempt suffix)
    $dLegInit = Get-Content -Raw -LiteralPath $dashLegacy | ConvertFrom-Json
    $dLegInit.summary.tokens = 500
    $dLegInit.summary.requests = 1
    $dLegInit.summary.completed = 1
    $dLegInit.tokens.prompt = 300
    $dLegInit.tokens.candidates = 200
    $dLegInit.processedKeys = @('RUN-LEGACY+TASK-L1')
    $dLegInit.jobs = @([pscustomobject]@{
        name = '레거시 작업'; model = 'gemini-3.8-flash-medium'; status = '완료'
        tokens = '500'; duration = '5초'; time = '10:00'; timestamp = (Get-Date).ToString('o')
        snippet = '레거시 완료'; runId = 'RUN-LEGACY'; taskId = 'TASK-L1'; stats = $null
    })
    $dLegInit | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $dashLegacy -Encoding utf8

    # Now observe the same run in orchestrator sync (legacy state without attempt or attempt=1)
    $runLegRoot = Join-Path $testLegacyDir 'runs\RUN-LEGACY'
    $workersLegDir = Join-Path $runLegRoot 'workers'
    New-MockWorkerState -WorkersDir $workersLegDir -RunId 'RUN-LEGACY' -TaskId 'TASK-L1' -TaskName '레거시 작업' `
        -Attempt 1 -Status 'completed' -Prompt 300 -Candidates 200 -Total 500 | Out-Null

    & pwsh.exe -NoProfile -File $parallelScript -SyncStateRoot $runLegRoot -DashboardPath $dashLegacy
    Assert-Test '레거시 데이터 동기화 종료 코드 0' ($LASTEXITCODE -eq 0)

    $dLegAfter = Get-Content -Raw -LiteralPath $dashLegacy | ConvertFrom-Json
    Assert-Test '레거시 데이터 summary.tokens 중복 적산 안됨 (500 유지)' ($dLegAfter.summary.tokens -eq 500) "실제 값: $($dLegAfter.summary.tokens)"
    Assert-Test '레거시 데이터 summary.completed 중복 적산 안됨 (1 유지)' ($dLegAfter.summary.completed -eq 1) "실제 값: $($dLegAfter.summary.completed)"
    Assert-Test '레거시 데이터 jobs 건수 1건 유지' ($dLegAfter.jobs.Count -eq 1)

    # ---------------------------------------------------------------
    # 12. 동시 실행 단독 워커 간 크로스 프로세스 락 및 Lost Update 방지 검증 (Criterion 5, 7)
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '12. 동시 실행 단독 워커 간 크로스 프로세스 락 및 Lost Update 방지 검증' -ForegroundColor Cyan
    $testConcDir = Join-Path $testTempRoot 'test-concurrent'
    $dashConc = Join-Path $testConcDir 'data\dashboard.json'
    New-InitialDashboard -Path $dashConc -IncludeProcessedKeys $true | Out-Null

    $mock1Lines = @(
        '{"event":"init","init":{"model":"gemini-3.8-flash-medium"}}',
        '{"event":"step_update","step_update":{"text_delta":"워커1 완료"}}',
        '{"event":"result","result":{"response":"워커1 완료","usage":{"input_tokens":150,"output_tokens":50,"cache_read_tokens":0,"thinking_tokens":0,"total_tokens":200},"num_turns":1,"duration_seconds":0.5,"status":"SUCCESS"}}'
    )
    $mock1Json = ($mock1Lines -join "`n")

    $mock2Lines = @(
        '{"event":"init","init":{"model":"gemini-3.8-flash-medium"}}',
        '{"event":"step_update","step_update":{"text_delta":"워커2 완료"}}',
        '{"event":"result","result":{"response":"워커2 완료","usage":{"input_tokens":250,"output_tokens":100,"cache_read_tokens":0,"thinking_tokens":0,"total_tokens":350},"num_turns":1,"duration_seconds":0.5,"status":"SUCCESS"}}'
    )
    $mock2Json = ($mock2Lines -join "`n")

    # Start two concurrent standalone pwsh worker processes targeting the same dashboard.json
    $pwshExe = (Get-Process -Id $PID).Path
    if (-not $pwshExe) { $pwshExe = 'pwsh.exe' }

    $job1 = Start-Job -ScriptBlock {
        param($exe, $script, $dash, $dataDir, $json)
        $out = & $exe -NoProfile -File $script -Task '동시 워커 1' -Prompt '테스트1' `
            -OrchestrationRunId 'RUN-CONCURRENT' -TaskId 'TASK-CONC-1' `
            -DashboardPath $dash -DataDir $dataDir `
            -MockOutputJson $json -MockExitCode 0
        return [int]$LASTEXITCODE
    } -ArgumentList $pwshExe, $singleScript, $dashConc, (Split-Path -Parent $dashConc), $mock1Json

    $job2 = Start-Job -ScriptBlock {
        param($exe, $script, $dash, $dataDir, $json)
        $out = & $exe -NoProfile -File $script -Task '동시 워커 2' -Prompt '테스트2' `
            -OrchestrationRunId 'RUN-CONCURRENT' -TaskId 'TASK-CONC-2' `
            -DashboardPath $dash -DataDir $dataDir `
            -MockOutputJson $json -MockExitCode 0
        return [int]$LASTEXITCODE
    } -ArgumentList $pwshExe, $singleScript, $dashConc, (Split-Path -Parent $dashConc), $mock2Json

    $null = Wait-Job $job1, $job2
    $out1 = Receive-Job -Job $job1
    $out2 = Receive-Job -Job $job2
    $exit1 = [int]($out1 | Select-Object -Last 1)
    $exit2 = [int]($out2 | Select-Object -Last 1)
    Remove-Job -Job $job1, $job2 -Force

    Assert-Test '동시 워커 1 정상 종료 (ExitCode 0)' ($exit1 -eq 0 -and $job1.State -eq 'Completed')
    Assert-Test '동시 워커 2 정상 종료 (ExitCode 0)' ($exit2 -eq 0 -and $job2.State -eq 'Completed')

    $dConc = Get-Content -Raw -LiteralPath $dashConc | ConvertFrom-Json
    # Verify NO LOST UPDATE: both 200 and 350 must be reflected = 550!
    Assert-Test '동시 실행 후 Lost Update 없이 summary.tokens 합산 (200 + 350 = 550)' ($dConc.summary.tokens -eq 550) "실제 값: $($dConc.summary.tokens)"
    Assert-Test '동시 실행 후 summary.requests 합산 (1 + 1 = 2)' ($dConc.summary.requests -eq 2) "실제 값: $($dConc.summary.requests)"
    Assert-Test '동시 실행 후 summary.completed 합산 (2)' ($dConc.summary.completed -eq 2) "실제 값: $($dConc.summary.completed)"
    Assert-Test '동시 실행 후 jobs 건수 2건 모두 포함' ($dConc.jobs.Count -eq 2) "실제 건수: $($dConc.jobs.Count)"
    Assert-Test 'processedKeys에 TASK-CONC-1 포함' (@($dConc.processedKeys) -contains 'RUN-CONCURRENT+TASK-CONC-1')
    Assert-Test 'processedKeys에 TASK-CONC-2 포함' (@($dConc.processedKeys) -contains 'RUN-CONCURRENT+TASK-CONC-2')

    # ---------------------------------------------------------------
    # 13. 수정 및 생성된 모든 PowerShell 스크립트 문법(Lint) 검사
    # ---------------------------------------------------------------
    Write-Host ''
    Write-Host '13. 수정 및 생성된 모든 PowerShell 스크립트 문법(Lint) 검사' -ForegroundColor Cyan
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
