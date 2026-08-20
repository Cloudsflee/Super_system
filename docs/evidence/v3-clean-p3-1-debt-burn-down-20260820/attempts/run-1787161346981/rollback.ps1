param([switch]$DryRun,[switch]$Apply,[string]$IsolatedRoot)
$ErrorActionPreference='Stop'
if(-not $DryRun -and -not $Apply){ throw 'choose -DryRun or -Apply' }
$OriginalRoot='E:\00_desktop\毕业设计\.ai-workspace\p31-original-20260820'
if(-not (Test-Path -LiteralPath $OriginalRoot)){ throw 'rollback_snapshot_missing' }
if($DryRun){ Write-Output 'rollback dry-run passed; no source or runtime volume changed'; exit 0 }
if([string]::IsNullOrWhiteSpace($IsolatedRoot)){ $IsolatedRoot=Join-Path $env:TEMP ('aiws-p31-rollback-'+[guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $OriginalRoot '*') -Destination $IsolatedRoot -Recurse -Force
$mismatches=@()
foreach($source in Get-ChildItem -LiteralPath $OriginalRoot -Recurse -File){ $relative=$source.FullName.Substring($OriginalRoot.Length).TrimStart('\'); $target=Join-Path $IsolatedRoot $relative; if(-not (Test-Path -LiteralPath $target)){ $mismatches += $relative; continue }; $a=(Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash; $b=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash; if($a -ne $b){ $mismatches += $relative } }
if($mismatches.Count -ne 0){ throw ('byte_exact_mismatches='+($mismatches -join ',')) }
Write-Output ('rollback applied in isolated root '+$IsolatedRoot+'; byte_exact_mismatches=[]')
