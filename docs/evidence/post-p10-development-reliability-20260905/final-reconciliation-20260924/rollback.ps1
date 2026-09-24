param(
  [switch]$DryRun,
  [switch]$Apply,
  [Parameter(Mandatory=$true)][string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if ($DryRun -eq $Apply) { throw 'rollback_choose_dry_run_or_apply' }
$root = [IO.Path]::GetFullPath($IsolatedRoot)
$marker = Join-Path $root '.ai-workspace/reconciliation-rollback-sandbox'
if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'rollback_isolated_marker_required' }
$baseline = '3e33067fc6ea205f07b590e076ac35f1040a21aa'
if ($DryRun) {
  & git -C $root diff --stat $baseline HEAD
  if ($LASTEXITCODE -ne 0) { throw 'rollback_dry_run_git_failed' }
  exit 0
}
& git -C $root checkout --quiet $baseline -- .
if ($LASTEXITCODE -ne 0) { throw 'rollback_apply_git_failed' }
& git -C $root diff --quiet $baseline -- .
if ($LASTEXITCODE -ne 0) { throw 'rollback_byte_mismatch' }
exit 0


