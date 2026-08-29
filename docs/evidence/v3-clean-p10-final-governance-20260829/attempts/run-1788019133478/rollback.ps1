param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot=(Join-Path $PSScriptRoot 'rollback-isolated'))
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'rollback-baseline'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$target=[IO.Path]::GetFullPath($IsolatedRoot)
if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'rollback_target_outside_evidence'}
if($DryRun){ConvertTo-Json @{status='passed';mode='dry-run';writes=0} -Compress;exit 0}
if(-not $Apply){throw 'rollback_mode_required'}
if(Test-Path -LiteralPath $target){Remove-Item -LiteralPath $target -Recurse -Force}
Copy-Item -LiteralPath $source -Destination $target -Recurse
node (Join-Path $PSScriptRoot 'rollback-verify.mjs') $target (Join-Path $PSScriptRoot 'rollback-manifest.json')
exit $LASTEXITCODE
