$script:DefaultReadDeny = @(
  '.env',
  '.env.*',
  '**/secrets/**',
  '**/credentials/**',
  '**/*private-key*',
  '**/*.pem',
  '**/*.p12',
  '.git/**'
)

$script:DefaultSensitive = @(
  'tests/**',
  '**/*.test.*',
  '**/*.spec.*',
  'package.json',
  '**/package.json',
  'package-lock.json',
  '**/package-lock.json',
  'tsconfig.json',
  '**/tsconfig.json',
  '**/*.config.*',
  '**/migrations/**',
  '**/security/**',
  '.github/**'
)

$script:DefaultForbidden = @(
  '.env',
  '.env.*',
  '**/secrets/**',
  '**/credentials/**',
  '**/*private-key*',
  '**/*.pem',
  '**/*.p12',
  '.git/**',
  '.agent/**'
)

function ConvertTo-PolicyPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$AllowPattern
  )

  $normalized = $Path.Trim().Replace('\', '/')
  while ($normalized.StartsWith('./', [StringComparison]::Ordinal)) {
    $normalized = $normalized.Substring(2)
  }
  $normalized = $normalized.TrimEnd('/')

  if ([string]::IsNullOrWhiteSpace($normalized)) {
    throw '정책 경로는 비어 있을 수 없습니다.'
  }
  if ([IO.Path]::IsPathRooted($normalized) -or $normalized -match '^[A-Za-z]:' -or $normalized.StartsWith('/')) {
    throw "정책 경로는 저장소 상대 경로여야 합니다: $Path"
  }
  if ($normalized -match '(^|/)\.\.(/|$)' -or $normalized.IndexOf([char]0) -ge 0) {
    throw "정책 경로에 경로 이탈 문자를 사용할 수 없습니다: $Path"
  }
  if (-not $AllowPattern -and $normalized.IndexOf('*') -ge 0) {
    throw "실제 파일 경로에는 wildcard를 사용할 수 없습니다: $Path"
  }
  if ($normalized.IndexOf('?') -ge 0) {
    throw "지원하지 않는 정책 wildcard(?)입니다: $Path"
  }

  return $normalized
}

function ConvertTo-PolicyRegex {
  param([Parameter(Mandatory = $true)][string]$Pattern)

  $builder = [Text.StringBuilder]::new('^')
  for ($i = 0; $i -lt $Pattern.Length; $i++) {
    $char = $Pattern[$i]
    if ($char -ne '*') {
      [void]$builder.Append([regex]::Escape([string]$char))
      continue
    }

    $isDouble = ($i + 1 -lt $Pattern.Length -and $Pattern[$i + 1] -eq '*')
    if ($isDouble) {
      $i++
      if ($i + 1 -lt $Pattern.Length -and $Pattern[$i + 1] -eq '/') {
        $i++
        [void]$builder.Append('(?:.*/)?')
      } else {
        [void]$builder.Append('.*')
      }
    } else {
      [void]$builder.Append('[^/]*')
    }
  }
  [void]$builder.Append('$')
  return $builder.ToString()
}

function Get-PolicyPathMatch {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Patterns
  )

  $normalizedPath = ConvertTo-PolicyPath -Path $Path
  foreach ($patternValue in @($Patterns)) {
    if ([string]::IsNullOrWhiteSpace([string]$patternValue)) { continue }
    $pattern = ConvertTo-PolicyPath -Path ([string]$patternValue) -AllowPattern
    if ($pattern.IndexOf('*') -lt 0) {
      if ([string]::Equals($normalizedPath, $pattern, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject]@{
          matched = $true
          path = $normalizedPath
          matchedPattern = $pattern
          comparisonMode = 'literal_exact'
        }
      }
      continue
    }

    $regex = ConvertTo-PolicyRegex -Pattern $pattern
    if ([regex]::IsMatch($normalizedPath, $regex, [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant)) {
      return [pscustomobject]@{
        matched = $true
        path = $normalizedPath
        matchedPattern = $pattern
        comparisonMode = 'policy_glob'
      }
    }
  }

  return [pscustomobject]@{
    matched = $false
    path = $normalizedPath
    matchedPattern = $null
    comparisonMode = 'none'
  }
}

function Test-PolicyPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Patterns
  )
  return [bool](Get-PolicyPathMatch -Path $Path -Patterns $Patterns).matched
}

function Assert-SafePolicyPattern {
  param(
    [Parameter(Mandatory = $true)][string]$Pattern,
    [Parameter(Mandatory = $true)][string]$Field,
    [string]$TaskId = '',
    [switch]$AllowProtected
  )

  $prefix = if ($TaskId) { "$TaskId`: " } else { '' }
  try {
    $normalized = ConvertTo-PolicyPath -Path $Pattern -AllowPattern
  } catch {
    throw "$prefix$Field 경로가 안전하지 않습니다: $($_.Exception.Message)"
  }
  if ($normalized -in @('*', '**', '**/*', '.')) {
    throw "$prefix$Field 경로가 저장소 전체를 허용할 수 없습니다: $Pattern"
  }
  if ($Field -in @('write_scope.expected', 'write_scope.derived_approved', 'merge_scope.expected') -and $normalized.IndexOf('*') -ge 0 -and -not $normalized.EndsWith('/**', [StringComparison]::Ordinal)) {
    throw "$prefix$Field에서는 literal 경로와 /** 재귀 패턴만 지원합니다: $Pattern"
  }
  if (-not $AllowProtected -and ((Test-PolicyPath -Path '.git/config' -Patterns @($normalized)) -or (Test-PolicyPath -Path '.agent/run.json' -Patterns @($normalized)))) {
    throw "$prefix$Field 경로가 보호 영역을 포함합니다: $Pattern"
  }
  return $normalized
}

function Add-UniquePolicyPatterns {
  param([Collections.Generic.List[string]]$Target, $Values, [string]$Field, [string]$TaskId, [switch]$AllowProtected)
  foreach ($value in @($Values)) {
    if ([string]::IsNullOrWhiteSpace([string]$value)) { continue }
    $item = Assert-SafePolicyPattern -Pattern ([string]$value) -Field $Field -TaskId $TaskId -AllowProtected:$AllowProtected
    if (-not ($Target | Where-Object { [string]::Equals($_, $item, [StringComparison]::OrdinalIgnoreCase) })) {
      $Target.Add($item)
    }
  }
}

function Resolve-FilesystemPolicy {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Task)

  $taskId = [string]$Task.id
  $hasWriteScope = $null -ne $Task.PSObject.Properties['write_scope'] -and $null -ne $Task.write_scope
  $legacyAllowed = @(if ($null -ne $Task.PSObject.Properties['allowed_files']) { @($Task.allowed_files) })
  $expectedInput = @(if ($hasWriteScope -and $null -ne $Task.write_scope.PSObject.Properties['expected']) {
    @($Task.write_scope.expected)
  } else {
    $legacyAllowed
  })
  if (@($expectedInput).Count -eq 0) {
    throw "$taskId`: allowed_files 또는 write_scope.expected가 최소 하나 필요합니다."
  }

  $expected = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $expected $expectedInput 'write_scope.expected' $taskId

  $readDeny = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $readDeny $script:DefaultReadDeny 'read_scope.deny' $taskId -AllowProtected
  if ($null -ne $Task.PSObject.Properties['read_scope'] -and $Task.read_scope -and $null -ne $Task.read_scope.PSObject.Properties['deny']) {
    Add-UniquePolicyPatterns $readDeny @($Task.read_scope.deny) 'read_scope.deny' $taskId -AllowProtected
  }

  $sensitive = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $sensitive $script:DefaultSensitive 'write_scope.sensitive' $taskId -AllowProtected
  if ($hasWriteScope -and $null -ne $Task.write_scope.PSObject.Properties['sensitive']) {
    Add-UniquePolicyPatterns $sensitive @($Task.write_scope.sensitive) 'write_scope.sensitive' $taskId -AllowProtected
  }

  $forbidden = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $forbidden $script:DefaultForbidden 'write_scope.forbidden' $taskId -AllowProtected
  if ($hasWriteScope -and $null -ne $Task.write_scope.PSObject.Properties['forbidden']) {
    Add-UniquePolicyPatterns $forbidden @($Task.write_scope.forbidden) 'write_scope.forbidden' $taskId -AllowProtected
  }

  $derivedApproved = [Collections.Generic.List[string]]::new()
  if ($hasWriteScope -and $null -ne $Task.write_scope.PSObject.Properties['derived_approved']) {
    Add-UniquePolicyPatterns $derivedApproved @($Task.write_scope.derived_approved) 'write_scope.derived_approved' $taskId
  }

  $mergeExpectedInput = @($expected)
  $mergeDenyInput = @()
  if ($null -ne $Task.PSObject.Properties['merge_scope'] -and $Task.merge_scope) {
    if ($Task.merge_scope -is [array]) {
      $mergeExpectedInput = @($Task.merge_scope)
    } elseif ($Task.merge_scope -is [string]) {
      $mergeExpectedInput = @([string]$Task.merge_scope)
    } else {
      if ($null -ne $Task.merge_scope.PSObject.Properties['expected']) { $mergeExpectedInput = @($Task.merge_scope.expected) }
      elseif ($null -ne $Task.merge_scope.PSObject.Properties['patterns']) { $mergeExpectedInput = @($Task.merge_scope.patterns) }
      if ($null -ne $Task.merge_scope.PSObject.Properties['deny']) { $mergeDenyInput = @($Task.merge_scope.deny) }
    }
  }
  $mergeExpected = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $mergeExpected $mergeExpectedInput 'merge_scope.expected' $taskId
  $mergeDeny = [Collections.Generic.List[string]]::new()
  Add-UniquePolicyPatterns $mergeDeny $forbidden 'merge_scope.deny' $taskId -AllowProtected
  Add-UniquePolicyPatterns $mergeDeny $mergeDenyInput 'merge_scope.deny' $taskId -AllowProtected

  $readRoot = 'task_worktree'
  $readMode = 'project_wide_search'
  if ($null -ne $Task.PSObject.Properties['read_scope'] -and $Task.read_scope) {
    if ($Task.read_scope.root) { $readRoot = [string]$Task.read_scope.root }
    if ($Task.read_scope.mode) { $readMode = [string]$Task.read_scope.mode }
  }
  if ($readRoot -ne 'task_worktree' -or $readMode -ne 'project_wide_search') {
    throw "$taskId`: 지원되는 read_scope는 task_worktree/project_wide_search뿐입니다."
  }

  return [pscustomobject]@{
    filesystem_policy = 'v2.1'
    legacy_allowed_files = (@($legacyAllowed).Count -gt 0 -and -not $hasWriteScope)
    allowedFiles = @($expected)
    read_scope = [pscustomobject]@{
      root = $readRoot
      mode = $readMode
      deny = @($readDeny)
    }
    write_scope = [pscustomobject]@{
      expected = @($expected)
      derived_auto_expand = if ($hasWriteScope -and $null -ne $Task.write_scope.PSObject.Properties['derived_auto_expand']) { [bool]$Task.write_scope.derived_auto_expand } else { $false }
      derived_approved = @($derivedApproved)
      sensitive = @($sensitive)
      forbidden = @($forbidden)
    }
    merge_scope = [pscustomobject]@{
      expected = @($mergeExpected)
      deny = @($mergeDeny)
    }
  }
}

function Get-FilesystemScopeVerification {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string[]]$ChangedFiles,
    [Parameter(Mandatory = $true)]$Policy
  )

  $entries = @()
  foreach ($file in @($ChangedFiles)) {
    if ([string]::IsNullOrWhiteSpace($file)) { continue }
    $path = ConvertTo-PolicyPath -Path $file
    $forbiddenMatch = Get-PolicyPathMatch $path $Policy.write_scope.forbidden
    $expectedMatch = Get-PolicyPathMatch $path $Policy.write_scope.expected
    $derivedMatch = Get-PolicyPathMatch $path $Policy.write_scope.derived_approved
    $sensitiveMatch = Get-PolicyPathMatch $path $Policy.write_scope.sensitive
    $mergeMatch = Get-PolicyPathMatch $path $Policy.merge_scope.expected
    $mergeDenyMatch = Get-PolicyPathMatch $path $Policy.merge_scope.deny

    $classification = 'DERIVED_UNAPPROVED'
    $authorized = $false
    $match = $null
    if ($forbiddenMatch.matched) {
      $classification = 'FORBIDDEN'
      $match = $forbiddenMatch
    } elseif ($mergeDenyMatch.matched) {
      $classification = 'MERGE_DENIED'
      $match = $mergeDenyMatch
    } elseif ($expectedMatch.matched -and $mergeMatch.matched) {
      $classification = 'EXPECTED'
      $authorized = $true
      $match = $expectedMatch
    } elseif ($derivedMatch.matched -and $mergeMatch.matched) {
      $classification = 'DERIVED_APPROVED'
      $authorized = $true
      $match = $derivedMatch
    } elseif (($expectedMatch.matched -or $derivedMatch.matched) -and -not $mergeMatch.matched) {
      $classification = 'MERGE_SCOPE_VIOLATION'
      $match = if ($expectedMatch.matched) { $expectedMatch } else { $derivedMatch }
    } elseif ($sensitiveMatch.matched) {
      $classification = 'SENSITIVE_UNAPPROVED'
      $match = $sensitiveMatch
    }

    $entries += [pscustomobject]@{
      path = $path
      classification = $classification
      authorized = $authorized
      sensitive = [bool]$sensitiveMatch.matched
      matchedPattern = if ($match) { $match.matchedPattern } else { $null }
      comparisonMode = if ($match) { $match.comparisonMode } else { 'none' }
    }
  }

  $violations = @($entries | Where-Object { -not $_.authorized })
  return [pscustomobject]@{
    filesystem_policy = 'v2.1'
    status = if ($violations.Count -eq 0) { 'PASS' } else { 'FAIL' }
    entries = @($entries)
    violations = @($violations | ForEach-Object { $_.path })
    sensitiveTouched = @($entries | Where-Object sensitive).Count
  }
}

function Get-WriteExpansionDecision {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)]$Policy
  )

  $target = ConvertTo-PolicyPath -Path ([string]$Request.target)
  $forbidden = Get-PolicyPathMatch $target $Policy.write_scope.forbidden
  if ($forbidden.matched) {
    return [pscustomobject]@{ decision = 'DENY_FORBIDDEN'; target = $target; matchedPattern = $forbidden.matchedPattern; reason = 'forbidden scope' }
  }
  $sensitive = Get-PolicyPathMatch $target $Policy.write_scope.sensitive
  if ($sensitive.matched) {
    return [pscustomobject]@{ decision = 'REQUIRE_REVIEW'; target = $target; matchedPattern = $sensitive.matchedPattern; reason = 'sensitive scope' }
  }
  if (-not $Policy.write_scope.derived_auto_expand) {
    return [pscustomobject]@{ decision = 'DENY_DERIVED'; target = $target; matchedPattern = $null; reason = 'automatic expansion disabled' }
  }

  $evidence = $Request.evidence
  $allowedRelations = @('direct_import', 'direct_export', 'direct_symbol_dependency', 'interface_implementation', 'feature_implementation_dependency', 'new_unit_test')
  $relation = if ($evidence) { [string]$evidence.relation } else { '' }
  $sourceFile = if ($evidence) { [string]$evidence.source_file } else { '' }
  if ($relation -notin $allowedRelations -or [string]::IsNullOrWhiteSpace($sourceFile)) {
    return [pscustomobject]@{ decision = 'DENY_DERIVED'; target = $target; matchedPattern = $null; reason = 'insufficient dependency evidence' }
  }
  $sourceAuthorized = (Test-PolicyPath $sourceFile $Policy.write_scope.expected) -or (Test-PolicyPath $sourceFile $Policy.write_scope.derived_approved)
  if (-not $sourceAuthorized) {
    return [pscustomobject]@{ decision = 'DENY_DERIVED'; target = $target; matchedPattern = $null; reason = 'evidence source is outside approved write scope' }
  }

  return [pscustomobject]@{ decision = 'ALLOW_DERIVED'; target = $target; matchedPattern = $null; reason = $relation }
}

function Test-PolicyPatternOverlap {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)
  $leftNorm = ConvertTo-PolicyPath $Left -AllowPattern
  $rightNorm = ConvertTo-PolicyPath $Right -AllowPattern
  if ([string]::Equals($leftNorm, $rightNorm, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  if ($leftNorm.EndsWith('/**')) {
    $leftPrefix = $leftNorm.Substring(0, $leftNorm.Length - 3)
    if (Test-PolicyPath $rightNorm.TrimEnd('*').TrimEnd('/') @("$leftPrefix/**")) { return $true }
  }
  if ($rightNorm.EndsWith('/**')) {
    $rightPrefix = $rightNorm.Substring(0, $rightNorm.Length - 3)
    if (Test-PolicyPath $leftNorm.TrimEnd('*').TrimEnd('/') @("$rightPrefix/**")) { return $true }
  }
  return $false
}
