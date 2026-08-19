param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$patch = Join-Path $PSScriptRoot 'change.patch'
$modified = Get-Content -Raw (Join-Path $PSScriptRoot 'modified-artifact.json') | ConvertFrom-Json
$original = Get-Content -Raw (Join-Path $PSScriptRoot 'original-hashes.json') | ConvertFrom-Json

foreach ($entry in $modified.files) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $root $entry.path) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.modified_sha256) {
    throw "rollback precondition failed for $($entry.path): expected $($entry.modified_sha256), got $actual"
  }
}

& git -C $root apply --reverse --check $patch
if ($LASTEXITCODE -ne 0) { throw "rollback reverse patch check failed with exit code $LASTEXITCODE" }

if (-not $Apply) {
  Write-Output 'rollback reverse patch check passed; no files changed'
  exit 0
}

& git -C $root apply --reverse $patch
if ($LASTEXITCODE -ne 0) { throw "rollback apply failed with exit code $LASTEXITCODE" }

foreach ($property in $original.files.PSObject.Properties) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $root $property.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $property.Value) {
    throw "rollback verification failed for $($property.Name): expected $($property.Value), got $actual"
  }
}

Write-Output 'governance synchronization rollback applied and original hashes verified'
