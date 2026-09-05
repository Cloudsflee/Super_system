# Owner: Platform Governance and Operations. Phase: D-040 post-P10 maintenance.
param(
  [switch]$DryRun,
  [switch]$Apply,
  [Parameter(Mandatory=$true)][string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if ($DryRun -eq $Apply) { throw 'rollback_choose_dry_run_or_apply' }
$Target = [IO.Path]::GetFullPath($IsolatedRoot)
if (-not (Test-Path -LiteralPath (Join-Path $Target '.post-p10-rollback-sandbox') -PathType Leaf)) {
  throw 'rollback_isolated_marker_required'
}
$Mode = if ($Apply) { '--apply' } else { '--dry-run' }
& node (Join-Path $PSScriptRoot 'package.mjs') '--rollback' $Mode $Target
exit $LASTEXITCODE
