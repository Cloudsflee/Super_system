param(
  [switch]$DryRun,
  [switch]$Apply,
  [string]$IsolatedRoot
)
$ErrorActionPreference = 'Stop'
if ($DryRun -eq $Apply) { throw 'choose exactly one of -DryRun or -Apply' }
$EvidenceRoot = (Resolve-Path $PSScriptRoot).Path
$Probe = $EvidenceRoot
while ($Probe -and -not (Test-Path -LiteralPath (Join-Path $Probe '.git'))) {
  $Parent = Split-Path -Parent $Probe
  if ($Parent -eq $Probe) { $Probe = $null } else { $Probe = $Parent }
}
if (-not $Probe) { throw 'rollback_repo_root_missing' }
$RepoRoot = (Resolve-Path $Probe).Path
$Patch = Join-Path $EvidenceRoot 'change.patch'
$Migration = Get-Content (Join-Path $EvidenceRoot 'receipt-migration.json') -Raw | ConvertFrom-Json
$Hashes = Get-Content (Join-Path $EvidenceRoot 'original-hashes.json') -Raw | ConvertFrom-Json
function Get-Sha256([string]$Path) {
  $Algorithm = [Security.Cryptography.SHA256]::Create(); $Stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Algorithm.Dispose() }
}
function CurrentMismatches([string]$Base) {
  $Mismatches = @()
  foreach ($Item in $Migration.receipts) {
    $Local = Join-Path $Base ($Item.local_path -replace '/', '\')
    $Source = Join-Path $Base ($Item.source_path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $Local)) { $Mismatches += $Item.local_path }
    elseif ((Get-Sha256 $Local) -ne $Item.sha256) { $Mismatches += $Item.local_path }
    if (Test-Path -LiteralPath $Source) { $Mismatches += $Item.source_path }
  }
  return @($Mismatches | Sort-Object -Unique)
}
if ($DryRun) {
  & git -C $RepoRoot apply --reverse --check $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
  $Mismatches = CurrentMismatches $RepoRoot
  if ($Mismatches.Count -ne 0) { throw ('byte_exact_mismatches=' + ($Mismatches -join ',')) }
  Write-Output 'rollback dry-run passed; byte_exact_mismatches=[]'
  exit 0
}
if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p31-hygiene-' + [guid]::NewGuid().ToString('N')) }
$IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot)
New-Item -ItemType Directory -Path $IsolatedRoot -Force | Out-Null
foreach ($File in $Hashes.files) {
  $Source = Join-Path $RepoRoot ($File.path -replace '/', '\')
  $Target = Join-Path $IsolatedRoot ($File.path -replace '/', '\')
  New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Target -Force
}
foreach ($Item in $Migration.receipts) {
  $Source = Join-Path $RepoRoot ($Item.local_path -replace '/', '\')
  $Target = Join-Path $IsolatedRoot ($Item.local_path -replace '/', '\')
  New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Target -Force
}
Push-Location $IsolatedRoot
try {
  & git -c core.autocrlf=false init -q
  & git -c core.autocrlf=false add -A
  & git -c core.autocrlf=false apply --reverse --check $Patch
  if ($LASTEXITCODE -ne 0) { throw 'isolated_reverse_check_failed' }
  & git -c core.autocrlf=false apply --reverse $Patch
  if ($LASTEXITCODE -ne 0) { throw 'isolated_reverse_apply_failed' }
} finally { Pop-Location }
foreach ($Item in $Migration.receipts) {
  $Local = Join-Path $IsolatedRoot ($Item.local_path -replace '/', '\')
  $Source = Join-Path $IsolatedRoot ($Item.source_path -replace '/', '\')
  New-Item -ItemType Directory -Path (Split-Path -Parent $Source) -Force | Out-Null
  Move-Item -LiteralPath $Local -Destination $Source -Force
}
$Mismatches = @()
foreach ($File in $Hashes.files) {
  $Target = Join-Path $IsolatedRoot ($File.path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $Target) -or (Get-Sha256 $Target) -ne $File.sha256) { $Mismatches += $File.path }
}
foreach ($Item in $Migration.receipts) {
  $Target = Join-Path $IsolatedRoot ($Item.source_path -replace '/', '\')
  if (-not (Test-Path -LiteralPath $Target) -or (Get-Sha256 $Target) -ne $Item.sha256) { $Mismatches += $Item.source_path }
}
$Mismatches = @($Mismatches | Sort-Object -Unique)
if ($Mismatches.Count -ne 0) { throw ('byte_exact_mismatches=' + ($Mismatches -join ',')) }
Write-Output 'rollback applied in isolated root; byte_exact_mismatches=[]'
