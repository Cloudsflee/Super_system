# Keep this file UTF-8 with BOM for Windows PowerShell 5.1 compatibility.
# V2.2 rollback compatibility identifiers retained intentionally:
# aiws-app:2.2.0, aiws-codex-runner:2.2.0-codex-0.144.0, aiws-data-v21,
# aiws-data-v22, v22-release.mjs, pnpm-lock.yaml, codex-cli 0.144.0,
# windows-bridge-export.
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'logs', 'status', 'verify', 'backup', 'restore', 'reset', 'bridge')][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Path,
  [string]$ProjectsRoot,
  [string]$CodexHome,
  [string]$CcSwitchRoot,
  [switch]$Confirm,
  [string]$PairingCode
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root 'compose.yml'
$SourceVolume = 'aiws-data-v22'
$Volume = 'aiws-data-v23'
$AppImage = if ($env:AIWS_APP_IMAGE) { $env:AIWS_APP_IMAGE } else { 'aiws-app:2.3.0' }
$RunnerImage = if ($env:AIWS_RUNNER_IMAGE) { $env:AIWS_RUNNER_IMAGE } else { 'aiws-codex-runner:2.3.0-codex-0.144.0' }
$Port = if ($env:AIWS_PORT) { [int]$env:AIWS_PORT } else { 4317 }
$env:AIWS_DOCKER_DATA_VOLUME = $Volume
$env:AIWS_DOCKER_INSTANCE = 'aiws-v23'
$env:AIWS_APP_IMAGE = $AppImage
$env:AIWS_RUNNER_IMAGE = $RunnerImage

function Invoke-Compose([string[]]$Arguments, [string]$Override) {
  $files = @('-f', $ComposeFile)
  if ($Override) { $files += @('-f', $Override) }
  & docker compose @files @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker_cli_required' }
  & docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_engine_unavailable' }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_compose_required' }
}

function Resolve-Import([string]$Explicit, [string]$EnvironmentValue, [string]$Fallback) {
  foreach ($candidate in @($Explicit, $EnvironmentValue, $Fallback)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Quote-Yaml([string]$Value) { return "'$(($Value -replace "'", "''"))'" }

function New-ImportOverride {
  $codex = Resolve-Import $CodexHome $env:CODEX_HOME (Join-Path $HOME '.codex')
  $cc = Resolve-Import $CcSwitchRoot $env:CC_SWITCH_CONFIG_DIR (Join-Path $HOME '.cc-switch')
  $projects = Resolve-Import $ProjectsRoot $null $null
  if (-not ($codex -or $cc -or $projects)) { return $null }
  $file = Join-Path ([System.IO.Path]::GetTempPath()) "aiws-compose-$([guid]::NewGuid().ToString('N')).yml"
  $lines = @('services:', '  app:', '    environment:')
  if ($codex) { $lines += '      AIWS_HOST_CODEX_HOME: /host/codex' }
  if ($cc) { $lines += '      AIWS_HOST_CC_SWITCH_CONFIG_DIR: /host/cc-switch' }
  if ($projects) { $lines += '      AIWS_HOST_PROJECTS_ROOT: /host/projects' }
  $lines += '    volumes:'
  foreach ($item in @(@($codex, '/host/codex'), @($cc, '/host/cc-switch'), @($projects, '/host/projects'))) {
    if (-not $item[0]) { continue }
    $lines += @('      - type: bind', "        source: $(Quote-Yaml $item[0])", "        target: $($item[1])", '        read_only: true')
  }
  [IO.File]::WriteAllLines($file, $lines, [Text.UTF8Encoding]::new($false))
  Write-Host '只读导入能力已按现有来源配置。'
  return $file
}

function Get-SourceIdentity {
  $status = & git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'source_git_status_failed' }
  if ($status) { throw 'source_worktree_not_clean' }
  $head = (& git rev-parse --verify HEAD).Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { throw 'source_head_missing' }
  if ($env:AIWS_TEST_HEAD_SHA -and $env:AIWS_TEST_HEAD_SHA.ToLowerInvariant() -ne $head) { throw 'source_head_mismatch' }
  $baseCandidate = if ($env:AIWS_TEST_BASE_SHA) { $env:AIWS_TEST_BASE_SHA.ToLowerInvariant() } else { 'HEAD^' }
  $base = (& git rev-parse --verify "${baseCandidate}^{commit}").Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { throw 'source_base_missing' }
  $tree = (& git rev-parse --verify 'HEAD^{tree}').Trim().ToLowerInvariant()
  if ($LASTEXITCODE -ne 0) { throw 'source_tree_missing' }
  foreach ($value in @($base, $head, $tree)) { if ($value -notmatch '^[a-f0-9]{40}$') { throw 'source_identity_invalid' } }
  return [pscustomobject]@{ Base = $base; Head = $head; Tree = $tree }
}

function New-ImpactSnapshotContext($Source) {
  $directory = Join-Path ([IO.Path]::GetTempPath()) "aiws-impact-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $directory | Out-Null
  $output = Join-Path $directory 'impact-snapshot.json'
  $result = & node (Join-Path $Root 'scripts\source-snapshot.mjs') --git-root $Root --output $output --base $Source.Base --head $Source.Head --tree $Source.Tree 2>&1
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $directory -Recurse -Force
    throw "impact_snapshot_generation_failed: $($result -join ' ')"
  }
  return $directory
}

function Build-Images {
  $source = Get-SourceIdentity
  $labels = @('--label', 'org.opencontainers.image.version=2.3.0', '--label', "org.opencontainers.image.revision=$($source.Head)", '--label', "aiws.source_tree=$($source.Tree)", '--label', 'aiws.state_schema=23')
  & docker build -f (Join-Path $Root 'docker/codex-runner.Dockerfile') --build-arg CODEX_VERSION=0.144.0 @labels -t $RunnerImage $Root
  if ($LASTEXITCODE -ne 0) { throw 'runner_image_build_failed' }
  & docker build --target production @labels -t $AppImage $Root
  if ($LASTEXITCODE -ne 0) { throw 'app_image_build_failed' }
}

function Preserve-RollbackImage {
  if ($env:AIWS_ROLLBACK_IMAGE) {
    & docker image inspect $env:AIWS_ROLLBACK_IMAGE *> $null
    if ($LASTEXITCODE -ne 0) { throw 'v23_rollback_image_missing' }
    return $env:AIWS_ROLLBACK_IMAGE
  }
  $containerId = & docker ps -a -q --filter 'label=com.docker.compose.project=aiws-v22' --filter 'label=com.docker.compose.service=app' | Select-Object -First 1
  if (-not $containerId) { return $null }
  $imageId = & docker inspect --format '{{.Image}}' $containerId
  if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw 'v23_rollback_image_inspect_failed' }
  $tag = "aiws-app:v22-rollback-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  & docker image tag $imageId $tag
  if ($LASTEXITCODE -ne 0) { throw 'v23_rollback_image_preserve_failed' }
  return $tag
}

function Build-VerifyImage {
  $verifyImage = 'aiws-verify:2.3.0'
  $source = Get-SourceIdentity
  $snapshotContext = New-ImpactSnapshotContext $source
  $sourceArgs = @(
    '--build-arg', "AIWS_SOURCE_BASE_SHA=$($source.Base)",
    '--build-arg', "AIWS_SOURCE_HEAD_SHA=$($source.Head)",
    '--build-arg', "AIWS_SOURCE_TREE_SHA=$($source.Tree)",
    '--build-context', "aiws-impact-snapshot=$snapshotContext"
  )
  $labels = @('--label', 'org.opencontainers.image.version=2.3.0', '--label', "org.opencontainers.image.revision=$($source.Head)", '--label', "aiws.source_tree=$($source.Tree)", '--label', 'aiws.state_schema=23')
  try {
    $compatible = $false
    $revision = & docker image inspect $verifyImage --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $revision -eq $source.Head) {
      & docker run --rm --entrypoint sh --mount "type=bind,src=$Root,dst=/source,readonly" $verifyImage -c 'test -d /app/node_modules && test -d "$(corepack pnpm store path)" && cmp -s /app/pnpm-lock.yaml /source/pnpm-lock.yaml && test "$(codex --version)" = "codex-cli 0.144.0" && (command -v chromium-browser >/dev/null || command -v chromium >/dev/null) && test -n "$AIWS_IMPACT_SNAPSHOT" && test -f "$AIWS_IMPACT_SNAPSHOT" && node scripts/v23-impact.mjs --audit >/dev/null && node scripts/v22-impact.mjs --audit >/dev/null && node scripts/v21-impact.mjs --audit >/dev/null && node scripts/v20-impact.mjs --audit >/dev/null && node scripts/v18-impact.mjs --audit >/dev/null'
      $compatible = $LASTEXITCODE -eq 0
    }
    if (-not $compatible) {
      & docker build --target verify --build-arg CODEX_VERSION=0.144.0 @sourceArgs @labels -t $verifyImage $Root
      if ($LASTEXITCODE -ne 0) { throw 'verify_image_build_failed' }
      return
    }
    $cacheImage = "aiws-verify-toolchain:$([guid]::NewGuid().ToString('N'))"
    & docker tag $verifyImage $cacheImage
    if ($LASTEXITCODE -ne 0) { throw 'verify_toolchain_tag_failed' }
    try {
      & docker build -f (Join-Path $Root 'docker\verify-refresh.Dockerfile') --build-arg "VERIFY_BASE_IMAGE=$cacheImage" @sourceArgs @labels -t $verifyImage $Root
      if ($LASTEXITCODE -ne 0) { throw 'verify_image_refresh_failed' }
    } finally {
      & docker image rm $cacheImage *> $null
    }
  } finally {
    Remove-Item -LiteralPath $snapshotContext -Recurse -Force
  }
}

function Test-VolumeSubpath {
  $preflight = "aiws-v23-preflight-$([guid]::NewGuid().ToString('N'))"
  & docker volume create --label 'aiws.owner=aiws-v23-release' --label 'aiws.role=preflight' $preflight *> $null
  if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_create_failed' }
  try {
    & docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/data" $RunnerImage -c 'mkdir -p /data/.aiws-preflight'
    if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_failed' }
    & docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/probe,volume-subpath=.aiws-preflight" $RunnerImage -c 'test -d /probe'
    if ($LASTEXITCODE -ne 0) { throw 'volume_subpath_unsupported' }
  } finally {
    & docker volume rm -f $preflight *> $null
    if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_cleanup_failed' }
  }
  & docker run --rm -v /var/run/docker.sock:/var/run/docker.sock $AppImage docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_socket_unavailable_to_app' }
}

function Invoke-Bridge([string]$Action) {
  if ($Action -notin @('install','start','stop','status','uninstall')) { throw 'bridge_action_required' }
  $bridgeRoot = Join-Path $env:LOCALAPPDATA 'AIWS\bridge'; $exe = Join-Path $bridgeRoot 'aiws-bridge.exe'; $pidFile = Join-Path $bridgeRoot 'bridge.pid'; $taskName = 'AIWS Windows Bridge'
  if ($Action -eq 'install') {
    New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
    $export = Join-Path ([IO.Path]::GetTempPath()) "aiws-bridge-$([guid]::NewGuid().ToString('N'))"
    try {
      & docker build --target windows-bridge-export --output "type=local,dest=$export" $Root
      if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_build_failed' }
      Copy-Item -LiteralPath (Join-Path $export 'aiws-bridge.exe') -Destination $exe -Force
    } finally { if (Test-Path -LiteralPath $export) { Remove-Item -LiteralPath $export -Recurse -Force } }
    & schtasks.exe /Create /TN $taskName /SC ONLOGON /TR "`"$exe`" run" /F *> $null
    if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_task_install_failed' }
    $code = if ($PairingCode) { $PairingCode } else { $env:AIWS_PAIRING_CODE }
    if ($code) { & $exe pair $code; if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_pairing_failed' } }
    Write-Host "Bridge 已安装：$exe"; return
  }
  if ($Action -eq 'start') {
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'windows_bridge_not_installed' }
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) { Write-Host 'Bridge 已运行。'; return } }
    $process = Start-Process -FilePath $exe -ArgumentList 'run' -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($pidFile, [string]$process.Id, [Text.UTF8Encoding]::new($false)); Write-Host "Bridge 已启动 (PID $($process.Id))。"; return
  }
  if ($Action -eq 'stop') {
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); $process = Get-Process -Id $runningPid -ErrorAction SilentlyContinue; if ($process -and $process.Path -eq $exe) { Stop-Process -Id $runningPid -Force; $process.WaitForExit(5000) }; Remove-Item -LiteralPath $pidFile -Force }
    Write-Host 'Bridge 已停止。'; return
  }
  if ($Action -eq 'status') {
    if (-not (Test-Path -LiteralPath $exe)) { Write-Host 'Bridge 未安装。'; return }
    & $exe status; if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_not_paired' }
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) { Write-Host "running PID $runningPid"; return } }
    Write-Host 'paired but offline'; return
  }
  if ($Action -eq 'uninstall') {
    Invoke-Bridge 'stop'; & schtasks.exe /Delete /TN $taskName /F *> $null
    if (Test-Path -LiteralPath $bridgeRoot) { Remove-Item -LiteralPath $bridgeRoot -Recurse -Force }
    Write-Host 'Bridge 已卸载；Codex Home 与项目未修改。'
  }
}

function Invoke-Backup([string]$Destination) {
  if (-not $Destination) { throw 'backup_path_required' }
  $full = [IO.Path]::GetFullPath($Destination)
  if (Test-Path -LiteralPath $full) { throw 'backup_target_exists' }
  $parent = Split-Path -Parent $full
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'backup_parent_missing' }
  $temporary = ".aiws-backup-$([guid]::NewGuid().ToString('N')).tar.gz"
  $running = & docker compose -f $ComposeFile ps --status running -q app 2>$null
  try {
    if ($running) { Invoke-Compose @('stop', 'app') }
    & docker run --rm --mount "type=volume,src=$Volume,dst=/data,readonly" --volume "${parent}:/backup" $AppImage python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
    if ($LASTEXITCODE -ne 0) { throw 'backup_failed' }
    & docker run --rm --volume "${parent}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
    if ($LASTEXITCODE -ne 0) { throw 'backup_validation_failed' }
    Move-Item -LiteralPath (Join-Path $parent $temporary) -Destination $full
    Write-Host '备份已完成。'
  } finally {
    if ($running) { Invoke-Compose @('up', '-d', 'app') }
  }
}

function Invoke-Restore([string]$Archive) {
  if (-not $Confirm) { throw 'restore_requires_confirm' }
  if (-not $Archive -or -not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'restore_archive_missing' }
  if (& docker compose -f $ComposeFile ps --status running -q app 2>$null) { throw 'restore_requires_stopped_app' }
  & docker volume inspect $Volume *> $null
  if ($LASTEXITCODE -ne 0) { & docker volume create $Volume *> $null }
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data" $AppImage -c 'test -z "$(ls -A /data)"'
  if ($LASTEXITCODE -ne 0) { throw 'restore_target_not_empty' }
  $full = (Resolve-Path -LiteralPath $Archive).Path
  $parent = Split-Path -Parent $full
  $leaf = Split-Path -Leaf $full
  & docker run --rm --volume "${parent}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  if ($LASTEXITCODE -ne 0) { throw 'restore_archive_invalid' }
  & docker run --rm --volume "${parent}:/backup:ro" --mount "type=volume,src=$Volume,dst=/data" $AppImage python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  if ($LASTEXITCODE -ne 0) { throw 'restore_failed' }
  Write-Host '恢复已完成；应用保持停止状态。'
}

Set-Location $Root
Assert-Docker
switch ($Command) {
  'up' {
    $rollbackImage = Preserve-RollbackImage
    Build-Images
    Test-VolumeSubpath
    $override = New-ImportOverride
    try {
      $releaseArgs = @(
        (Join-Path $Root 'scripts\v23-release.mjs'),
        '--compose-file', $ComposeFile,
        '--source-volume', $SourceVolume,
        '--target-volume', $Volume,
        '--project-name', 'aiws-v23',
        '--app-image', $AppImage,
        '--runner-image', $RunnerImage,
        '--port', [string]$Port
      )
      if ($rollbackImage) { $releaseArgs += @('--rollback-image', $rollbackImage) }
      if ($override) { $releaseArgs += @('--override', $override) }
      & node @releaseArgs
      if ($LASTEXITCODE -ne 0) { throw 'v23_release_up_failed' }
    } finally { if ($override) { Remove-Item -LiteralPath $override -Force } }
  }
  'down' { Invoke-Compose @('down', '--remove-orphans'); Write-Host "数据卷 $Volume 已保留。" }
  'logs' { Invoke-Compose @('logs', '-f', '--tail', '200', 'app') }
  'status' { Invoke-Compose @('ps'); & docker volume inspect $Volume --format 'data volume: {{.Name}}' 2>$null; & docker volume inspect $SourceVolume --format 'retained V2.2 volume: {{.Name}}' 2>$null }
  'verify' {
    Invoke-Compose @('config', '--quiet')
    Build-Images
    Build-VerifyImage
    & docker run --rm $RunnerImage --version
    if ($LASTEXITCODE -ne 0) { throw 'runner_version_failed' }
    $bridgeVerify = Join-Path ([IO.Path]::GetTempPath()) 'aiws-bridge-verify'
    if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force }
    try {
      & docker build --target windows-bridge-export --output "type=local,dest=$bridgeVerify" $Root
      if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_export_failed' }
      if (-not (Test-Path -LiteralPath (Join-Path $bridgeVerify 'aiws-bridge.exe') -PathType Leaf)) { throw 'windows_bridge_export_missing' }
    } finally { if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force } }
    & docker run --rm aiws-verify:2.3.0 corepack pnpm verify
    if ($LASTEXITCODE -ne 0) { throw 'container_verify_failed' }
  }
  'backup' { Invoke-Backup $Path }
  'restore' { Invoke-Restore $Path }
  'reset' {
    if (-not $Confirm) { throw 'reset_requires_confirm' }
    Invoke-Compose @('down', '--remove-orphans')
    & docker volume rm $Volume
    if ($LASTEXITCODE -ne 0) { throw 'reset_volume_remove_failed' }
    Write-Host "仅数据卷 $Volume 已删除。"
  }
  'bridge' { Invoke-Bridge $Path }
}
