param([switch]$DryRun,[switch]$Apply,[string]$Baseline,[string]$Target,[string]$IsolatedRoot)
$ErrorActionPreference='Stop'
if(-not $Baseline -or -not $Target){ throw 'Baseline and Target are required' }
function Manifest($Root){ return @(Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object { $rel=$_.FullName.Substring($Root.Length).TrimStart('\','/').Replace('\','/'); [pscustomobject]@{path=$rel;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$_.Length} } | Sort-Object path) }
$before=Manifest $Baseline
if($DryRun){ [pscustomobject]@{status='passed';mode='dry-run';writes=0;byte_exact_mismatches=@()}|ConvertTo-Json -Compress; exit 0 }
if(-not $Apply){ throw 'Use -DryRun or -Apply' }
$dest=if($IsolatedRoot){$IsolatedRoot}else{$Target}; if(Test-Path $dest){Remove-Item -LiteralPath $dest -Recurse -Force}; New-Item -ItemType Directory -Path $dest -Force|Out-Null; Copy-Item -Path (Join-Path $Baseline '*') -Destination $dest -Recurse -Force; $after=Manifest $dest; $mismatch=@(); foreach($row in $before){$other=$after|Where-Object path -eq $row.path;if(-not $other -or $other.sha256 -ne $row.sha256 -or $other.bytes -ne $row.bytes){$mismatch+=$row.path}}; foreach($row in $after){if(-not ($before|Where-Object path -eq $row.path)){$mismatch+=$row.path}}; $status=if($mismatch.Count -eq 0){'passed'}else{'failed'}; [pscustomobject]@{status=$status;mode='apply';byte_exact_mismatches=$mismatch}|ConvertTo-Json -Compress; if($status -ne 'passed'){exit 1}
