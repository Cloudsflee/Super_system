param(
  [string]$Workspace = '.',
  [string]$DatabaseFile = '',
  [string]$MigrationManifest = '',
  [switch]$SkipVerify
)
$ErrorActionPreference = 'Stop'
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$Patch = Join-Path $PSScriptRoot 'change.patch'
$PatchBytes = [System.IO.File]::ReadAllBytes($Patch)
$PatchDigest = [System.Security.Cryptography.SHA256]::Create()
try { $PatchHash = [System.BitConverter]::ToString($PatchDigest.ComputeHash($PatchBytes)).Replace('-', '').ToLowerInvariant() } finally { $PatchDigest.Dispose() }
if ($PatchHash -ne '3f9aa7aa15e6a8923a7c17fbe4c1f6914d4ac01a3a9beaebdfbf364f180bb77a') { throw 'rollback_patch_hash_mismatch' }
if ($DatabaseFile -or $MigrationManifest) { if (-not ($DatabaseFile -and $MigrationManifest)) { throw 'rollback_database_inputs_incomplete' }; & node (Join-Path $Workspace 'scripts/restore-migration-snapshot.mjs') --database $DatabaseFile --manifest $MigrationManifest; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
& git -C $Workspace apply --reverse --check $Patch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git -C $Workspace apply --reverse $Patch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $SkipVerify) { & corepack pnpm --dir $Workspace verify; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
Write-Output 'rollback passed'
