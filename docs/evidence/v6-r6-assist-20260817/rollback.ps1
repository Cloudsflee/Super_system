param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$patch = Join-Path $PSScriptRoot 'change.patch'
if (-not $Apply) { git -C $root apply --check -R $patch; Write-Output 'rollback reverse patch check passed'; exit 0 }
git -C $root apply -R $patch
Write-Output 'R6 tracked and untracked patch rolled back'
