param([string]$Commit = "HEAD")
$branch = git branch --show-current
if ($branch -ne "recovery/v3-feature-restore") { throw "Run rollback on recovery/v3-feature-restore" }
git revert --no-edit $Commit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm verify
