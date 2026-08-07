param(
  [Parameter(Mandatory=$true)][string]$Commit,
  [switch]$ValidateOnly,
  [switch]$SkipVerify
)
$ErrorActionPreference = 'Stop'
$ExpectedBranch = 'recovery/v3-feature-restore'
$Branch = (git branch --show-current).Trim()
if ($Branch -ne $ExpectedBranch) { throw "Run rollback on $ExpectedBranch" }
$Resolved = (git rev-parse "$Commit^{commit}").Trim()
$Parent = (git rev-parse "$Resolved^1").Trim()
$Changed = @(git diff-tree --no-commit-id --name-only -r $Resolved)
$ExpectedFiles = @('scripts/release-rehearsal-compose.mjs', 'tests/release/release-rehearsal-compose.test.mjs')
foreach ($File in $ExpectedFiles) { if ($Changed -notcontains $File) { throw "rollback_commit_missing:$File" } }
if ($ValidateOnly) {
  Write-Output "rollback validation passed: $Resolved parent $Parent"
  exit 0
}
git revert --no-edit $Resolved
if ($LASTEXITCODE -ne 0) { throw "rollback_revert_failed:$LASTEXITCODE" }
if (-not $SkipVerify) { corepack pnpm verify; if ($LASTEXITCODE -ne 0) { throw "rollback_verify_failed:$LASTEXITCODE" } }
Write-Output "rollback complete: reverted $Resolved"
