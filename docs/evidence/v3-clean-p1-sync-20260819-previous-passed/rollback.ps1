param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Evidence '..\..\..')).Path
$Patch = Join-Path $Evidence 'change.patch'
Push-Location $Root
try {
  git apply --reverse --check $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }
  if ($Apply) { git apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }
  [ordered]@{ schema_version='aiws.v3-clean.rollback-receipt.v2'; status=($(if ($Apply) { 'applied' } else { 'dry_run_passed' })); patch='change.patch'; volume_policy='seal and retain deployment volumes; no down migration'; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5
} finally { Pop-Location }
