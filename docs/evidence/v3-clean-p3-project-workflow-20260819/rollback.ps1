param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Evidence '..\..\..')).Path
$Patch = Join-Path $Evidence 'change.patch'
Push-Location $Root
try { git -c core.autocrlf=false apply --reverse --check $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_failed' }; if ($Apply) { git -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch; if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_failed' } }; [ordered]@{ schema_version='aiws.v3-clean.p3-rollback.v1'; status=$(if ($Apply) { 'applied' } else { 'dry_run_passed' }); patch='change.patch'; parent='docs/evidence/v3-clean-p2-identity-acl-20260819'; down_migration=$false; verified_at=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 5 } finally { Pop-Location }