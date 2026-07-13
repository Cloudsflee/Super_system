#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/compose.yml"
VOLUME=aiws-data-v14
APP_IMAGE=${AIWS_APP_IMAGE:-aiws-app:1.5.0}
RUNNER_IMAGE=${AIWS_RUNNER_IMAGE:-aiws-codex-runner:1.5.0-codex-0.144.0}
PORT=${AIWS_PORT:-4317}
COMMAND=${1:-status}
shift || true
PATH_ARG=
PROJECTS_ROOT=
CODEX_HOME_ARG=
CC_SWITCH_ROOT=
CONFIRM=0

while (($#)); do
  case "$1" in
    --projects-root) PROJECTS_ROOT=${2:?missing_projects_root}; shift 2 ;;
    --codex-home) CODEX_HOME_ARG=${2:?missing_codex_home}; shift 2 ;;
    --cc-switch-root) CC_SWITCH_ROOT=${2:?missing_cc_switch_root}; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) if [[ -n "$PATH_ARG" ]]; then echo "unexpected argument: $1" >&2; exit 2; fi; PATH_ARG=$1; shift ;;
  esac
done

export AIWS_DOCKER_DATA_VOLUME="$VOLUME" AIWS_APP_IMAGE="$APP_IMAGE" AIWS_RUNNER_IMAGE="$RUNNER_IMAGE"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
assert_docker() { command -v docker >/dev/null || { echo docker_cli_required >&2; exit 1; }; docker info --format '{{.ServerVersion}}' >/dev/null; docker compose version >/dev/null; }
assert_port_free() {
  [[ -n "$(compose ps --status running -q app 2>/dev/null || true)" ]] && return
  if (echo >/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then echo "port_${PORT}_in_use" >&2; return 1; fi
}
existing_dir() { local value=${1:-}; [[ -n "$value" && -d "$value" ]] && { cd "$value" && pwd -P; }; }
yaml_quote() { local value=${1//\'/\'\'}; printf "'%s'" "$value"; }

new_import_override() {
  local codex cc projects file
  codex=$(existing_dir "$CODEX_HOME_ARG" || existing_dir "${CODEX_HOME:-}" || existing_dir "$HOME/.codex" || true)
  cc=$(existing_dir "$CC_SWITCH_ROOT" || existing_dir "${CC_SWITCH_CONFIG_DIR:-}" || existing_dir "$HOME/.cc-switch" || true)
  projects=$(existing_dir "$PROJECTS_ROOT" || true)
  [[ -z "$codex$cc$projects" ]] && return
  file=$(mktemp "${TMPDIR:-/tmp}/aiws-compose-XXXXXX.yml")
  {
    echo services:; echo '  app:'; echo '    environment:'
    [[ -n "$codex" ]] && echo '      AIWS_HOST_CODEX_HOME: /host/codex'
    [[ -n "$cc" ]] && echo '      AIWS_HOST_CC_SWITCH_CONFIG_DIR: /host/cc-switch'
    [[ -n "$projects" ]] && echo '      AIWS_HOST_PROJECTS_ROOT: /host/projects'
    echo '    volumes:'
    if [[ -n "$codex" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$codex")"; echo '        target: /host/codex'; echo '        read_only: true'; fi
    if [[ -n "$cc" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$cc")"; echo '        target: /host/cc-switch'; echo '        read_only: true'; fi
    if [[ -n "$projects" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$projects")"; echo '        target: /host/projects'; echo '        read_only: true'; fi
  } >"$file"
  echo '只读导入能力已按现有来源配置。' >&2
  printf '%s' "$file"
}

build_images() {
  docker build -f "$ROOT/docker/codex-runner.Dockerfile" --build-arg CODEX_VERSION=0.144.0 -t "$RUNNER_IMAGE" "$ROOT"
  docker build --target production -t "$APP_IMAGE" "$ROOT"
}
test_volume_subpath() {
  docker volume create "$VOLUME" >/dev/null
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data" "$RUNNER_IMAGE" -c 'mkdir -p /data/.aiws-preflight'
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/probe,volume-subpath=.aiws-preflight" "$RUNNER_IMAGE" -c 'test -d /probe'
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data" "$RUNNER_IMAGE" -c 'rmdir /data/.aiws-preflight'
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$APP_IMAGE" docker info --format '{{.ServerVersion}}' >/dev/null
}
wait_healthy() {
  local container health
  for _ in $(seq 1 60); do
    container=$(compose ps -q app 2>/dev/null || true)
    if [[ -n "$container" ]]; then
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
      [[ "$health" == healthy ]] && { echo "AIWS 已启动：http://127.0.0.1:$PORT"; return; }
      [[ "$health" == unhealthy || "$health" == exited ]] && { echo "app_$health" >&2; return 1; }
    fi
    sleep 2
  done
  echo app_health_timeout >&2; return 1
}
file_sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
volume_state_sha256() {
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data,readonly" "$APP_IMAGE" -c 'test ! -f /data/data/state.json || sha256sum /data/data/state.json | cut -d" " -f1'
}
volume_state_hash() {
  docker run --rm --entrypoint node --mount "type=volume,src=$VOLUME,dst=/data,readonly" "$APP_IMAGE" --input-type=module -e \
    "import fs from 'node:fs'; import { canonicalStateHash } from './apps/api/src/state-migration-v14.mjs'; const file='/data/data/state.json'; if(fs.existsSync(file)) console.log(canonicalStateHash(JSON.parse(fs.readFileSync(file,'utf8'))));"
}
new_v15_migration_snapshot() {
  local backup_root="$ROOT/.ai-workspace/backups" stamp temporary archive archive_sha state_sha state_hash app_digest runner_digest facts_file stopped_file old_ids current_ids
  mkdir -p "$backup_root"; stamp=$(date -u +%Y%m%d-%H%M%S); temporary=".aiws-v15-$$-$RANDOM.tar.gz"; archive="$backup_root/aiws-v14-before-v15-$stamp.tar.gz"
  old_ids=$(docker ps -q --filter label=com.docker.compose.project=aiws-v14 --filter label=com.docker.compose.service=app)
  current_ids=$(docker ps -q --filter label=com.docker.compose.project=aiws-v15 --filter label=com.docker.compose.service=app)
  for container in $old_ids $current_ids; do docker stop --time 30 "$container" >/dev/null; done
  docker run --rm --mount "type=volume,src=$VOLUME,dst=/data,readonly" --volume "$backup_root:/backup" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
  docker run --rm --volume "$backup_root:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
  mv "$backup_root/$temporary" "$archive"; archive_sha=$(file_sha256 "$archive"); state_sha=$(volume_state_sha256); state_hash=$(volume_state_hash)
  app_digest=$(docker image inspect aiws-app:1.4.0 --format '{{.Id}}' 2>/dev/null || true); runner_digest=$(docker image inspect aiws-codex-runner:1.4.0-codex-0.144.0 --format '{{.Id}}' 2>/dev/null || true)
  facts_file=".state-facts-$$-$RANDOM.txt"; stopped_file=".containers-$$-$RANDOM.txt"
  docker run --rm --entrypoint node --mount "type=volume,src=$VOLUME,dst=/data,readonly" "$APP_IMAGE" -e 'const fs=require("node:fs"),file="/data/data/state.json"; if(fs.existsSync(file)){const bytes=fs.readFileSync(file),state=JSON.parse(bytes); console.log(JSON.stringify({bytes:bytes.length,schema_version:state.schema_version??null}));}' >"$backup_root/$facts_file"
  { docker ps -a --filter label=aiws.managed=true --format '{{.ID}}|{{.Image}}|{{.Status}}'; for container in $old_ids $current_ids; do docker inspect "$container" --format '{{.Id}}|{{.Config.Image}}|{{.State.Status}}' 2>/dev/null || true; done; } >"$backup_root/$stopped_file"
  docker run --rm --volume "$backup_root:/backup" --entrypoint node "$APP_IMAGE" -e \
    'const fs=require("node:fs"); const [archive,archiveSha,stateSha,stateHash,appImage,runnerImage,factsFile,containersFile]=process.argv.slice(1); const value={version:"1.5.0",created_at:new Date().toISOString(),source_project:"aiws-v14",target_project:"aiws-v15",archive,archive_sha256:archiveSha,state_sha256:stateSha||null,state_canonical_hash:stateHash||null,app_image:appImage||null,runner_image:runnerImage||null,state_facts:fs.readFileSync(`/backup/${factsFile}`,"utf8").split(/\r?\n/).filter(Boolean),containers:fs.readFileSync(`/backup/${containersFile}`,"utf8").split(/\r?\n/).filter(Boolean)}; fs.writeFileSync(`/backup/${archive}.manifest.json`,JSON.stringify(value,null,2));' \
    "$(basename "$archive")" "$archive_sha" "$state_sha" "$state_hash" "$app_digest" "$runner_digest" "$facts_file" "$stopped_file"
  rm -f "$backup_root/$facts_file" "$backup_root/$stopped_file"
  MIGRATION_ARCHIVE=$archive; MIGRATION_STATE_SHA=$state_sha
}
restore_v15_migration_snapshot() {
  local archive=$1 expected_sha=${2:-} parent leaf restored_sha
  parent=$(dirname "$archive"); leaf=$(basename "$archive")
  docker run --rm --volume "$parent:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" -c 'case "$1" in /data) find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + ;; *) exit 90 ;; esac' sh /data
  docker run --rm --volume "$parent:/backup:ro" --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  restored_sha=$(volume_state_sha256); [[ -z "$expected_sha" || "$restored_sha" == "$expected_sha" ]] || { echo v15_restore_hash_mismatch >&2; return 1; }
}
backup_data() {
  [[ -n "$PATH_ARG" ]] || { echo backup_path_required >&2; exit 2; }
  local full parent temporary running
  full=$(cd "$(dirname "$PATH_ARG")" && printf '%s/%s' "$PWD" "$(basename "$PATH_ARG")")
  [[ ! -e "$full" ]] || { echo backup_target_exists >&2; exit 1; }
  parent=$(dirname "$full"); temporary=".aiws-backup-$$-$RANDOM.tar.gz"
  running=$(compose ps --status running -q app 2>/dev/null || true)
  [[ -z "$running" ]] || compose stop app
  set +e
  docker run --rm --mount "type=volume,src=$VOLUME,dst=/data,readonly" --volume "$parent:/backup" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
  docker run --rm --volume "$parent:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
  result=$?
  set -e
  [[ -z "$running" ]] || compose up -d app
  if [[ "$result" != 0 ]]; then rm -f "$parent/$temporary"; return "$result"; fi
  mv "$parent/$temporary" "$full"
  echo '备份已完成。'
}
restore_data() {
  [[ "$CONFIRM" == 1 ]] || { echo restore_requires_confirm >&2; exit 2; }
  [[ -f "$PATH_ARG" ]] || { echo restore_archive_missing >&2; exit 2; }
  [[ -z "$(compose ps --status running -q app 2>/dev/null || true)" ]] || { echo restore_requires_stopped_app >&2; exit 1; }
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" -c 'test -z "$(ls -A /data)"' || { echo restore_target_not_empty >&2; exit 1; }
  local full parent leaf
  full=$(cd "$(dirname "$PATH_ARG")" && printf '%s/%s' "$PWD" "$(basename "$PATH_ARG")"); parent=$(dirname "$full"); leaf=$(basename "$full")
  docker run --rm --volume "$parent:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  docker run --rm --volume "$parent:/backup:ro" --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  echo '恢复已完成；应用保持停止状态。'
}

cd "$ROOT"
assert_docker
case "$COMMAND" in
  up)
    build_images; test_volume_subpath; override=$(new_import_override || true)
    trap '[[ -z "${override:-}" ]] || rm -f "$override"' EXIT
    new_v15_migration_snapshot
    set +e
    assert_port_free; result=$?
    if [[ "$result" == 0 ]]; then
      if [[ -n "$override" ]]; then docker compose -f "$COMPOSE_FILE" -f "$override" up -d --remove-orphans; else compose up -d --remove-orphans; fi
      result=$?
    fi
    if [[ "$result" == 0 ]]; then wait_healthy; result=$?; fi
    set -e
    if [[ "$result" != 0 ]]; then compose stop app >/dev/null 2>&1 || true; restore_v15_migration_snapshot "$MIGRATION_ARCHIVE" "$MIGRATION_STATE_SHA"; exit "$result"; fi ;;
  down) compose down --remove-orphans; echo "数据卷 $VOLUME 已保留。" ;;
  logs) compose logs -f --tail 200 app ;;
  status) compose ps; docker volume inspect "$VOLUME" --format 'data volume: {{.Name}}' 2>/dev/null || true ;;
  verify)
    compose config --quiet; build_images; docker build --target verify -t aiws-verify:1.5.0 "$ROOT"
    bridge_export=$(mktemp -d "${TMPDIR:-/tmp}/aiws-bridge-XXXXXX"); trap 'rm -rf "${bridge_export:-}"' EXIT
    docker build --target windows-bridge-export --output "type=local,dest=$bridge_export" "$ROOT"; test -f "$bridge_export/aiws-bridge.exe"
    docker run --rm "$RUNNER_IMAGE" --version; docker run --rm aiws-verify:1.5.0 corepack pnpm verify ;;
  backup) backup_data ;;
  restore) restore_data ;;
  reset)
    [[ "$CONFIRM" == 1 ]] || { echo reset_requires_confirm >&2; exit 2; }
    compose down --remove-orphans; docker volume rm "$VOLUME"; echo "仅数据卷 $VOLUME 已删除。" ;;
  *) echo 'usage: aiws.sh {up|down|logs|status|verify|backup|restore|reset}' >&2; exit 2 ;;
esac
