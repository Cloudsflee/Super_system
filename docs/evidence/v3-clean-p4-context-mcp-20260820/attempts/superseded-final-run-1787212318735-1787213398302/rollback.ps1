param(
  [switch]$DryRun,
  [switch]$Apply,
  [string]$IsolatedRoot,
  [string]$SourceRoot,
  [string]$VerificationPath
)
$ErrorActionPreference = 'Stop'
if (($DryRun -and $Apply) -or (-not $DryRun -and -not $Apply)) { throw 'choose exactly one of -DryRun or -Apply' }
$Evidence = (Resolve-Path $PSScriptRoot).Path
$Probe = $Evidence
while ($Probe -and -not (Test-Path -LiteralPath (Join-Path $Probe '.git'))) {
  $Parent = Split-Path -Parent $Probe
  if ($Parent -eq $Probe) { $Probe = $null } else { $Probe = $Parent }
}
if ([string]::IsNullOrWhiteSpace($Probe)) { throw 'rollback_repo_root_missing' }
$RepoRoot = (Resolve-Path $Probe).Path
if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = $RepoRoot }
$SourceRoot = [IO.Path]::GetFullPath($SourceRoot)
$Patch = Join-Path $Evidence 'change.patch'
$Original = Join-Path $Evidence 'original-hashes.json'
$Modified = Join-Path $Evidence 'modified-artifact.json'
$Rollback = Join-Path $Evidence 'rollback.ps1'
if ([string]::IsNullOrWhiteSpace($VerificationPath)) {
  $Verification = Join-Path $Evidence 'verification.json'
  if (-not (Test-Path -LiteralPath $Verification)) { $Verification = Join-Path $Evidence 'catalog-staging.json' }
} else { $Verification = [IO.Path]::GetFullPath($VerificationPath) }
$Snapshot = Join-Path $Evidence 'rollback-v3.sqlite'
$SnapshotReceipt = Join-Path $Evidence 'rollback-snapshot.json'
$CasManifest = Join-Path $Evidence 'rollback-cas-v3-manifest.json'
$Required = @($Patch, $Original, $Modified, $Rollback, $Verification, $Snapshot, $SnapshotReceipt, $CasManifest)
foreach ($File in $Required) { if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw ('rollback_artifact_missing:' + (Split-Path -Leaf $File)) } }
function Get-Sha256([string]$Path) {
  $Algorithm = [Security.Cryptography.SHA256]::Create()
  $Stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($Algorithm.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Algorithm.Dispose() }
}
function Read-Json([string]$Path) { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
$OriginalReceipt = Read-Json $Original
$ModifiedReceipt = Read-Json $Modified
$SnapshotMetadata = Read-Json $SnapshotReceipt
$CasMetadata = Read-Json $CasManifest
$VerificationProbe = @'
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(receipt.status || ''));
'@
$VerificationStatus = $VerificationProbe | & node - $Verification
if ($LASTEXITCODE -ne 0) { throw 'rollback_verification_probe_failed' }
if (-not $OriginalReceipt.files -or -not $ModifiedReceipt.files) { throw 'rollback_hash_inventory_invalid' }
if ($VerificationStatus -notin @('staging','verified')) { throw 'rollback_verification_artifact_invalid' }
if ((Get-Item -LiteralPath $Patch).Length -le 0) { throw 'rollback_patch_empty' }
& git -C $SourceRoot -c core.autocrlf=false apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { throw 'rollback_source_reverse_check_failed' }
$Mismatches = New-Object System.Collections.Generic.List[string]
if ((Get-Sha256 $Snapshot) -ne [string]$SnapshotMetadata.database.sha256) { $Mismatches.Add('rollback-v3.sqlite') }
if ((Get-Sha256 $CasManifest) -ne [string]$SnapshotMetadata.cas.sha256) { $Mismatches.Add('rollback-cas-v3-manifest.json') }
$DatabaseProbe = @'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const normalize = (row) => Object.fromEntries(Object.entries(row).map(([key,value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
const receipt = {
  user_version: Number(db.prepare('PRAGMA user_version').get().user_version),
  foreign_key_check: db.prepare('PRAGMA foreign_key_check').all().map(normalize),
  migration_ledger: db.prepare('SELECT migration_id,version,checksum,snapshot_sha256 FROM schema_migrations ORDER BY version').all().map(normalize),
  p4_tables: Number(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('context_sources','context_nodes','context_document_versions','context_edges','context_policies','context_selections','context_packs','context_projection_jobs','context_index_snapshots','exchange_requests','mcp_clients','gateway_forward_receipts')").get().count)
};
db.close();
process.stdout.write(JSON.stringify(receipt));
'@
$DatabasePath = $Snapshot
if ($Apply) {
  if ([string]::IsNullOrWhiteSpace($IsolatedRoot)) { $IsolatedRoot = Join-Path $env:TEMP ('aiws-p4-rollback-' + [guid]::NewGuid().ToString('N')) }
  $IsolatedRoot = [IO.Path]::GetFullPath($IsolatedRoot)
  if ($IsolatedRoot -eq $RepoRoot -or $IsolatedRoot -eq [IO.Path]::GetPathRoot($IsolatedRoot)) { throw 'rollback_isolated_root_invalid' }
  if (Test-Path -LiteralPath $IsolatedRoot) {
    if (@(Get-ChildItem -LiteralPath $IsolatedRoot -Force).Count -ne 0) { throw 'rollback_isolated_root_not_empty' }
  } else { New-Item -ItemType Directory -Path $IsolatedRoot | Out-Null }
  $DataRoot = Join-Path $IsolatedRoot 'data'
  $CasRoot = Join-Path $IsolatedRoot 'cas'
  New-Item -ItemType Directory -Path $DataRoot,$CasRoot -Force | Out-Null
  $DatabasePath = Join-Path $DataRoot 'state.sqlite'
  Copy-Item -LiteralPath $Snapshot -Destination $DatabasePath
  foreach ($Object in @($CasMetadata.objects)) {
    $Relative = [string]$Object.relative_path
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains('..') -or [IO.Path]::IsPathRooted($Relative)) { throw 'rollback_cas_path_invalid' }
    $Source = Join-Path $Evidence ([string]$Object.source_file)
    $Target = Join-Path $CasRoot $Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target
    if ((Get-Sha256 $Target) -ne [string]$Object.sha256) { $Mismatches.Add(('cas/' + $Relative.Replace('\','/'))) }
  }
  & git -C $SourceRoot -c core.autocrlf=false apply --reverse --whitespace=nowarn $Patch
  if ($LASTEXITCODE -ne 0) { throw 'rollback_source_apply_failed' }
  $OriginalPaths = @{}
  foreach ($Entry in @($OriginalReceipt.files)) {
    $Relative = [string]$Entry.path
    $OriginalPaths[$Relative] = $true
    $Target = Join-Path $SourceRoot $Relative
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { $Mismatches.Add(('source/' + $Relative)); continue }
    if ((Get-Sha256 $Target) -ne [string]$Entry.sha256) { $Mismatches.Add(('source/' + $Relative)) }
  }
  foreach ($Entry in @($ModifiedReceipt.files)) {
    $Relative = [string]$Entry.path
    if (-not $OriginalPaths.ContainsKey($Relative) -and (Test-Path -LiteralPath (Join-Path $SourceRoot $Relative))) { $Mismatches.Add(('source/' + $Relative)) }
  }
  if ((Get-Sha256 $DatabasePath) -ne [string]$SnapshotMetadata.database.sha256) { $Mismatches.Add('data/state.sqlite') }
}
$DatabaseJson = $DatabaseProbe | & node - $DatabasePath
if ($LASTEXITCODE -ne 0) { throw 'rollback_database_probe_failed' }
$Database = $DatabaseJson | ConvertFrom-Json
if ([int]$Database.user_version -ne 3) { $Mismatches.Add('user_version') }
if (@($Database.foreign_key_check).Count -ne 0) { $Mismatches.Add('foreign_key_check') }
if ((@($Database.migration_ledger | ForEach-Object { [int]$_.version }) -join ',') -ne '1,2,3') { $Mismatches.Add('migration_ledger') }
if ([int]$Database.p4_tables -ne 0) { $Mismatches.Add('p4_tables') }
$Mismatches = @($Mismatches | Sort-Object -Unique)
$Roles = @('modified-artifact.json','change.patch',(Split-Path -Leaf $Verification),'rollback.ps1')
Write-Output ('rollback_mode=' + $(if ($Apply) { 'apply' } else { 'dry-run' }))
Write-Output 'source_reverse_check=passed'
Write-Output ('snapshot_sha256=' + (Get-Sha256 $Snapshot))
Write-Output ('user_version=' + [int]$Database.user_version)
Write-Output ('foreign_key_check=' + (ConvertTo-Json -InputObject @($Database.foreign_key_check) -Compress))
Write-Output ('migration_ledger=' + (ConvertTo-Json -InputObject @($Database.migration_ledger) -Compress -Depth 10))
Write-Output ('role_artifacts=' + (ConvertTo-Json -InputObject @($Roles) -Compress))
Write-Output ('byte_exact_mismatches=' + (ConvertTo-Json -InputObject @($Mismatches) -Compress))
if ($Mismatches.Count -ne 0) { throw 'rollback_byte_exact_mismatch' }
