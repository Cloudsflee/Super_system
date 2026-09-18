param(
  [string]$Workspace = (Get-Location).Path,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Evidence = Split-Path -Parent $MyInvocation.MyCommand.Path
$Mappings = @(
  @('apps/api/src/clean/p8/github-adapter.mjs','apps__api__src__clean__p8__github-adapter.mjs'),
  @('apps/api/src/clean/runtime.mjs','apps__api__src__clean__runtime.mjs'),
  @('apps/api/src/clean/project-workflow.mjs','apps__api__src__clean__project-workflow.mjs'),
  @('packages/contracts/src/clean-v2.mjs','packages__contracts__src__clean-v2.mjs'),
  @('feature-catalog.clean.json','feature-catalog.clean.json'),
  @('feature-catalog.json','feature-catalog.json')
)
if ($DryRun) { Write-Output (@{ mode='dry-run'; files=$Mappings.Count; remove=@('apps/api/src/clean/github-repository-adapter.mjs') } | ConvertTo-Json -Compress); exit 0 }
foreach ($mapping in $Mappings) {
  $target = Join-Path $Workspace ($mapping[0] -replace '/', [IO.Path]::DirectorySeparatorChar)
  $source = Join-Path $Evidence ('baseline/' + $mapping[1])
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}
$newFile = Join-Path $Workspace ('apps/api/src/clean/github-repository-adapter.mjs' -replace '/', [IO.Path]::DirectorySeparatorChar)
if (Test-Path -LiteralPath $newFile) { Remove-Item -LiteralPath $newFile -Force }
Write-Output (@{ mode='apply'; files=$Mappings.Count; removed='apps/api/src/clean/github-repository-adapter.mjs' } | ConvertTo-Json -Compress)
