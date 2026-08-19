param(
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$baseline = '8edefc7d110dca80958e3ef0fe9115dd62a8751a'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Set-Location $root

$actualRoot = (git rev-parse --show-toplevel).Trim()
if ((Resolve-Path $actualRoot).Path -ne (Resolve-Path $root).Path) {
  throw "rollback_root_mismatch"
}

$status = git status --porcelain
if (-not $WhatIf -and $status) {
  throw "rollback_requires_clean_worktree"
}

$restore = @(
  'README.md',
  'docs/testing.md',
  'docs/threat-model.md',
  'docs/requirements-traceability.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/data-model.md',
  'docs/开发计划v3功能恢复.md',
  'docs/测试计划v3功能恢复.md',
  'docs/runbook.md',
  'V3功能恢复与架构治理判断.md',
  '探索-1/01_记忆机制与上下文包头脑风暴.md'
)

$remove = @(
  'docs/document-index.md',
  'docs/architecture/v3-clean-development-plan.md',
  'docs/archive/legacy-code-docs'
)

if ($WhatIf) {
  Write-Output "git restore --source=$baseline -- $($restore -join ' ')"
  Write-Output "git rm -r --ignore-unmatch $($remove -join ' ')"
  Write-Output 'evidence directory is retained as the rollback record'
  exit 0
}

git restore --source=$baseline -- $restore
git rm -r --ignore-unmatch -- $remove
Write-Output "rollback_restored_baseline=$baseline"
Write-Output 'rollback_evidence_retained=true'
