# Owner: Platform/Testing. Phase: P10+. Private ACL preservation and handle check.
param([string]$Action, [string]$Source, [string]$Destination, [string]$AclFile, [string]$CliScript, [string]$MutexKey, [string]$DryRun)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Action -eq 'Mutex') {
  $mutex = [Threading.Mutex]::new($false, ('Global\AIWS.Storage.' + $MutexKey))
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw 'storage_manifest_busy' }
    $env:AIWS_STORAGE_MUTEX_KEY = $MutexKey
    $arguments = @($CliScript, $Destination, '--manifest', $Source)
    if ($DryRun -eq 'true') { $arguments += '--dry-run' }
    # The mutex owner also owns the kill-on-close job. If this process dies,
    # the mutating child cannot outlive the OS lock and race a resumed apply.
    $request = @{command=$AclFile;args=$arguments;cwd=(Get-Location).Path;receipt=$null}
    . (Join-Path $PSScriptRoot 'workspace-process.ps1') -RequestJson ($request | ConvertTo-Json -Compress)
    $result = $LASTEXITCODE
  } finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  exit $result
}
$sourceRoot = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
function ComparableAcl([string]$sddl) {
  # Protect copied ACEs from the destination parent's inheritance. Compare the
  # exact owner/group/ACE rights and order while ignoring only inheritance state.
  $value = [regex]::Replace($sddl, 'D:(?:P|AI|AR)*', 'D:')
  $value = [regex]::Replace($value, '(\([^;]+;)([^;]*)(;)', { param($m) $m.Groups[1].Value + $m.Groups[2].Value.Replace('ID','') + $m.Groups[3].Value })
  $aces = @([regex]::Matches($value, '\([^()]+\)') | ForEach-Object { $_.Value })
  # Windows canonicalizes the ordering of simple allow ACEs when inheritance
  # becomes explicit. Their union is identical; deny/conditional ACLs keep order.
  if ($aces.Count -and @($aces | Where-Object { -not $_.StartsWith('(A;') }).Count -eq 0) {
    return ($value -replace '\([^()]+\)', '') + (($aces | Sort-Object) -join '')
  }
  return $value
}
function Inventory([string]$root) {
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($root)
  while ($pending.Count) {
    $full = $pending.Pop()
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'storage_link_requires_review' }
    $acl = Get-Acl -LiteralPath $full
    @{ path=$full.Substring($root.Length).TrimStart('\'); sddl=$acl.Sddl }
    if ($item.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $full -Force) { $pending.Push($child.FullName) }
    } else {
      $handle = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
      $handle.Dispose()
    }
  }
}
if ($Action -eq 'Capture') {
  if (Test-Path -LiteralPath $AclFile) { throw 'storage_acl_exists' }
  $rows = @(Inventory $sourceRoot | Sort-Object { $_.path })
  [IO.File]::WriteAllText($AclFile, (ConvertTo-Json -InputObject $rows -Depth 5))
} elseif ($Action -eq 'Check') {
  $expected = Get-Content -LiteralPath $AclFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $actual = @(Inventory $sourceRoot | Sort-Object { $_.path })
  if ($expected.Count -ne $actual.Count) { throw 'storage_acl_count_changed' }
  for ($i=0; $i -lt $actual.Count; $i++) {
    if ($expected[$i].path -cne $actual[$i].path -or (ComparableAcl $expected[$i].sddl) -cne (ComparableAcl $actual[$i].sddl)) { throw 'storage_acl_changed' }
  }
} elseif ($Action -eq 'Copy') {
  $rows = Get-Content -LiteralPath $AclFile -Raw -Encoding UTF8 | ConvertFrom-Json
  # Secure the staging root before copying any private bytes.
  $rootAcl = Get-Acl -LiteralPath $sourceRoot
  $rootAcl.SetAccessRuleProtection($true, $true)
  Set-Acl -LiteralPath $destinationRoot -AclObject $rootAcl
  & robocopy.exe $sourceRoot $destinationRoot /E /COPY:DATS /DCOPY:DAT /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw 'storage_copy_failed' }
  foreach ($row in $rows) {
    $target = if ($row.path) { Join-Path $destinationRoot $row.path } else { $destinationRoot }
    $acl = Get-Acl -LiteralPath $target
    $acl.SetSecurityDescriptorSddlForm($row.sddl)
    $acl.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $target -AclObject $acl
  }
} elseif ($Action -eq 'Restore' -or $Action -eq 'Protect') {
  $rows = Get-Content -LiteralPath $AclFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($row in $rows) {
    $target = if ($row.path) { Join-Path $sourceRoot $row.path } else { $sourceRoot }
    $acl = Get-Acl -LiteralPath $target
    $acl.SetSecurityDescriptorSddlForm($row.sddl)
    if ($Action -eq 'Protect') { $acl.SetAccessRuleProtection($true, $true) }
    Set-Acl -LiteralPath $target -AclObject $acl
    $actual = (Get-Acl -LiteralPath $target).Sddl
    if ($Action -eq 'Restore' -and $actual -cne $row.sddl) { throw 'storage_original_acl_restore_failed' }
    if ($Action -eq 'Protect' -and (ComparableAcl $actual) -cne (ComparableAcl $row.sddl)) { throw 'storage_acl_changed' }
  }
} else { throw 'storage_action_invalid' }
