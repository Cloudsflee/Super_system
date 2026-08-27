$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'baseline-v7.sqlite'
$target = Join-Path $PSScriptRoot 'rollback-applied.sqlite'
Copy-Item -LiteralPath $source -Destination $target -Force
node (Join-Path $PSScriptRoot 'rollback-verify.mjs') $target $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output '{"status":"passed","byte_exact_mismatches":[]}'
