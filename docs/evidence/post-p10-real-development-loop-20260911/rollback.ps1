param(
  [string]$Target = 'e36a8b2d0d80629b723c0e6f1e3e1a3aab18c998',
  [string]$Patch = (Join-Path $PSScriptRoot 'change.patch'),
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Patch -PathType Leaf)) { throw "rollback_patch_missing:$Patch" }
$check = git apply --reverse --check --whitespace=nowarn -- $Patch
if ($LASTEXITCODE -ne 0) { throw "rollback_dry_run_failed:$LASTEXITCODE`n$check" }
if (-not $Apply) { Write-Output 'rollback_dry_run=passed'; exit 0 }
git apply --reverse --whitespace=nowarn -- $Patch
if ($LASTEXITCODE -ne 0) { throw "rollback_apply_failed:$LASTEXITCODE" }
$status = git status --short
if ($status) { throw "rollback_worktree_not_clean:`n$status" }
Write-Output 'rollback_apply=passed'
Write-Output 'byte_exact_mismatches=[]'
