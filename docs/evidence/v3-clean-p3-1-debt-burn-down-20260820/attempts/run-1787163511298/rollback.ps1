param(
  [switch]$DryRun,
  [switch]$Apply,
  [int[]]$ProcessId = @(),
  [string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if (-not $DryRun -and -not $Apply) { throw 'choose -DryRun or -Apply' }
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$OriginalRoot = Join-Path $RepoRoot '.ai-workspace\p31-original-20260820'
$Patch = Join-Path $RepoRoot 'docs\evidence\v3-clean-p3-1-debt-burn-down-20260820\change.patch'
if (-not (Test-Path -LiteralPath $OriginalRoot)) { throw 'rollback_snapshot_missing' }
if ($DryRun) {
  if (-not (Test-Path -LiteralPath $Patch)) { throw 'rollback_patch_missing' }
  Write-Output 'rollback dry-run passed; no source or runtime volume changed'
  exit 0
}
foreach ($Id in $ProcessId) {
  $Process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($Process) { Stop-Process -Id $Id -Force -ErrorAction Stop }
}
if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p31-rollback-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
Copy-Item -Path (Join-Path $OriginalRoot '*') -Destination $IsolatedRoot -Recurse -Force
& git -C $RepoRoot apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
$Mismatches = @()
foreach ($Source in Get-ChildItem -LiteralPath $OriginalRoot -Recurse -File) {
  $Relative = $Source.FullName.Substring($OriginalRoot.Length).TrimStart('\')
  $Target = Join-Path $IsolatedRoot $Relative
  if (-not (Test-Path -LiteralPath $Target)) { $Mismatches += $Relative; continue }
  $A = (Get-FileHash -LiteralPath $Source.FullName -Algorithm SHA256).Hash
  $B = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash
  if ($A -ne $B) { $Mismatches += $Relative }
}
if ($Mismatches.Count -ne 0) { throw ('byte_exact_mismatches=' + ($Mismatches -join ',')) }
Write-Output ('rollback applied in isolated root ' + $IsolatedRoot + '; byte_exact_mismatches=[]')
