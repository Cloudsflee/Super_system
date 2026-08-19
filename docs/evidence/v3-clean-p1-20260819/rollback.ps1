$ErrorActionPreference = 'Stop'
$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Evidence '..\..\..')).Path
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $Root (Join-Path '.ai-workspace' ("v3-clean-p1-rollback-$Stamp"))
New-Item -ItemType Directory -Force -Path $Backup | Out-Null

# Stop an explicitly supplied clean process before moving its deployment volume.
if ($env:AIWS_CLEAN_PID) {
  $process = Get-Process -Id ([int]$env:AIWS_CLEAN_PID) -ErrorAction SilentlyContinue
  if ($process) { Stop-Process -Id $process.Id -Force }
}

$targets = @(
  'apps/api/clean-server.mjs',
  'apps/api/server-clean.mjs',
  'apps/api/server-legacy.mjs',
  'apps/api/src/clean',
  'tests/p1',
  'tests/integration/v3-clean-p1.test.mjs',
  'tests/security/v3-clean-p1.test.mjs',
  'scripts/v3-clean-p1-evidence.mjs',
  'scripts/v3-clean-architecture-scan.mjs'
)
foreach ($relative in $targets) {
  $source = Join-Path $Root $relative
  if (Test-Path -LiteralPath $source) {
    $destination = Join-Path $Backup $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  }
}

# Preserve a deployment volume as an artifact; rollback never runs a down migration.
foreach ($volume in @($env:AIWS_CLEAN_DATABASE, $env:AIWS_CLEAN_CAS)) {
  if ($volume -and (Test-Path -LiteralPath $volume)) {
    Move-Item -LiteralPath $volume -Destination (Join-Path $Backup ([IO.Path]::GetFileName($volume)))
  }
}

Push-Location $Root
try {
  git apply --reverse --whitespace=nowarn (Join-Path $Evidence 'change.patch')
  $status = git status --short --branch
  $status | Set-Content -LiteralPath (Join-Path $Backup 'git-status.txt') -Encoding utf8
} finally {
  Pop-Location
}

[ordered]@{
  schema_version = 'aiws.v3-clean.rollback-receipt.v1'
  status = 'applied'
  backup = (Resolve-Path $Backup).Path
  restored_patch = (Join-Path $Evidence 'change.patch')
  volume_policy = 'deployment volume sealed and retained; no down migration'
  verified_at = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Backup 'rollback-receipt.json') -Encoding utf8
Write-Output (Join-Path $Backup 'rollback-receipt.json')
