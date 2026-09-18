param(
  [string]$Workspace = (Get-Location).Path,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Workspace = [IO.Path]::GetFullPath($Workspace)
$Evidence = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '.'))
$ManifestPath = Join-Path $Evidence 'modified-files.json'
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

function SafeTarget([string]$Relative) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $Workspace ($Relative -replace '/', [IO.Path]::DirectorySeparatorChar)))
  $prefix = $Workspace.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if ($candidate -ne $Workspace -and -not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "rollback_path_escape:$Relative"
  }
  return $candidate
}

function HashFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

$writes = @()
$removes = @()
$mismatches = @()

foreach ($entry in @($Manifest.files)) {
  $target = SafeTarget ([string]$entry.path)
  $safeName = ([string]$entry.path) -replace '/', '__'
  $baseline = Join-Path $Evidence (Join-Path 'baseline' $safeName)
  $currentHash = HashFile $target
  if ($entry.baseline_present -eq $true) {
    if (-not (Test-Path -LiteralPath $baseline -PathType Leaf)) { throw "rollback_baseline_missing:$($entry.path)" }
    if ($DryRun) {
      if ($currentHash -ne [string]$entry.modified_sha256) { throw "rollback_target_drift:$($entry.path)" }
      $writes += [string]$entry.path
    } else {
      if ($currentHash -ne [string]$entry.modified_sha256) { throw "rollback_target_drift:$($entry.path)" }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $baseline -Destination $target -Force
      $writes += [string]$entry.path
    }
  } elseif (Test-Path -LiteralPath $target) {
    if ($currentHash -ne [string]$entry.modified_sha256) { throw "rollback_target_drift:$($entry.path)" }
    if ($DryRun) {
      $removes += [string]$entry.path
    } else {
      Remove-Item -LiteralPath $target -Force
      $removes += [string]$entry.path
    }
  }
}

foreach ($entry in @($Manifest.files)) {
  $target = SafeTarget ([string]$entry.path)
  $actual = HashFile $target
  $expected = if ($entry.baseline_present -eq $true) { [string]$entry.baseline_sha256 } else { $null }
  if (-not $DryRun -and $actual -ne $expected) { $mismatches += [string]$entry.path }
}

$result = [ordered]@{
  schema_version = 'aiws.post-p10.remote-workspace.rollback.v1'
  mode = if ($DryRun) { 'dry-run' } else { 'apply' }
  writes = if ($DryRun) { 0 } else { @($writes).Count }
  removes = if ($DryRun) { 0 } else { @($removes).Count }
  planned_writes = @($writes).Count
  planned_removes = @($removes).Count
  byte_exact_mismatches = @($mismatches)
}
if (-not $DryRun -and $mismatches.Count) { throw ('rollback_byte_mismatch:' + ($mismatches -join ',')) }
$result | ConvertTo-Json -Compress
