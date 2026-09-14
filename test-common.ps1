param([string]$AssertDetailLabel = '상세')

function Assert-Test([string]$testName, [bool]$condition, [string]$detail = '') {
    if ($condition) {
        Write-Host "  [PASS] $testName" -ForegroundColor Green
        $script:passCount++
    } else {
        Write-Host "  [FAIL] $testName" -ForegroundColor Red
        if ($detail) {
            Write-Host "         ${AssertDetailLabel}: $detail" -ForegroundColor Yellow
        }
        $script:failCount++
    }
}
