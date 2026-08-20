param(
  [switch]$DryRun,
  [switch]$Apply,
  [int[]]$ProcessId = @(),
  [string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if (-not $DryRun -and -not $Apply) { throw 'choose -DryRun or -Apply' }
$Probe = (Resolve-Path $PSScriptRoot).Path
while ($Probe -and -not (Test-Path -LiteralPath (Join-Path $Probe '.ai-workspace'))) {
  $Parent = Split-Path -Parent $Probe
  if ($Parent -eq $Probe) { $Probe = $null } else { $Probe = $Parent }
}
$RepoRoot = $Probe
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { throw 'rollback_repo_root_missing' }
$RepoRoot = (Resolve-Path $RepoRoot).Path
$OriginalRoot = Join-Path $RepoRoot '.ai-workspace\p31-original-20260820'
$Patch = Join-Path $PSScriptRoot 'change.patch'
if (-not (Test-Path -LiteralPath $Patch)) { $Patch = Join-Path $RepoRoot 'docs\evidence\v3-clean-p3-1-debt-burn-down-20260820\change.patch' }
if (-not (Test-Path -LiteralPath $OriginalRoot)) { throw 'rollback_snapshot_missing' }
if (-not (Test-Path -LiteralPath $Patch)) { throw 'rollback_patch_missing' }
function Get-Sha256([string]$Path) {
  $Algorithm = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Algorithm.Dispose() }
}
if ($DryRun) {
  & git -C $RepoRoot apply --reverse --check $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
  Write-Output 'rollback dry-run passed; no source or runtime volume changed'
  exit 0
}
foreach ($Id in $ProcessId) {
  $Process = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($Process) { Stop-Process -Id $Id -Force -ErrorAction Stop }
}
if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p31-rollback-' + [guid]::NewGuid().ToString('N')) }
$IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot)
New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
Copy-Item -Path (Join-Path $OriginalRoot '*') -Destination $IsolatedRoot -Recurse -Force
& git -C $RepoRoot apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
$OriginalFiles = @(Get-ChildItem -LiteralPath $OriginalRoot -Recurse -File -Force)
$TargetFiles = @(Get-ChildItem -LiteralPath $IsolatedRoot -Recurse -File -Force)
$OriginalSet = @{}
$Mismatches = @()
foreach ($Source in $OriginalFiles) {
  $Relative = $Source.FullName.Substring($OriginalRoot.Length).TrimStart('\')
  $OriginalSet[$Relative] = $true
  $Target = Join-Path $IsolatedRoot $Relative
  if (-not (Test-Path -LiteralPath $Target)) { $Mismatches += $Relative; continue }
  $A = Get-Sha256 $Source.FullName
  $B = Get-Sha256 $Target
  if ($A -ne $B) { $Mismatches += $Relative }
}
foreach ($Target in $TargetFiles) {
  $Relative = $Target.FullName.Substring($IsolatedRoot.Length).TrimStart('\')
  if (-not $OriginalSet.ContainsKey($Relative)) { $Mismatches += $Relative }
}
$Mismatches = @($Mismatches | Sort-Object -Unique)
if ($Mismatches.Count -ne 0) { throw ('byte_exact_mismatches=' + ($Mismatches -join ',')) }
Write-Output ('rollback applied in isolated root ' + $IsolatedRoot + '; byte_exact_mismatches=[]')
