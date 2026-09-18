param([ValidateSet('dry-run','apply')][string]$Mode='dry-run')
$root = Resolve-Path (Join-Path $PSScriptRoot '../../../../../../')
$manifest = Join-Path $PSScriptRoot 'modified-files.json'
$rows = (Get-Content $manifest -Raw | ConvertFrom-Json).files
$ErrorActionPreference = 'Stop'
$mismatches = @()
foreach ($row in $rows) {
  $path = Join-Path $root $row.path
  if (!(Test-Path -LiteralPath $path)) { $mismatches += $row.path; continue }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actual -ne $row.sha256) { $mismatches += $row.path }
}
if ($Mode -eq 'dry-run') { [pscustomobject]@{mode='dry-run'; writes=0; byte_exact_mismatches=$mismatches; status=if($mismatches.Count){'failed'}else{'passed'}} | ConvertTo-Json -Compress; exit $(if($mismatches.Count){1}else{0}) }
[pscustomobject]@{mode='apply'; writes=0; byte_exact_mismatches=$mismatches; status=if($mismatches.Count){'failed'}else{'passed'}} | ConvertTo-Json -Compress; exit $(if($mismatches.Count){1}else{0})
