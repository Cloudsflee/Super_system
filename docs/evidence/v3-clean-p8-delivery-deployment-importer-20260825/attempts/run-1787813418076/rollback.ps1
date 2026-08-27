param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot=(Join-Path $PSScriptRoot 'rollback-isolated'))
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot 'rollback-baseline'
if($DryRun){$result=@{status='passed';mode='dry-run';source=(Split-Path $source -Leaf);target=(Split-Path $IsolatedRoot -Leaf);writes=0};$result|ConvertTo-Json -Compress;exit 0}
if(-not $Apply){throw 'rollback_mode_required'}
$resolvedRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$resolvedTarget=[IO.Path]::GetFullPath($IsolatedRoot)
if(-not $resolvedTarget.StartsWith($resolvedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'rollback_target_outside_evidence'}
if(Test-Path -LiteralPath $resolvedTarget){Remove-Item -LiteralPath $resolvedTarget -Recurse -Force}
Copy-Item -LiteralPath $source -Destination $resolvedTarget -Recurse
node (Join-Path $PSScriptRoot 'rollback-verify.mjs') $resolvedTarget (Join-Path $PSScriptRoot 'rollback-manifest.json')
exit $LASTEXITCODE
