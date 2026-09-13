#!/usr/bin/env bash
# Local dev stack: Postgres (Docker), API, both workers, admin web and Metro.
#
#   ./dev.sh up          start everything in the background (the default)
#   ./dev.sh android     boot the emulator, then build and install the app
#   ./dev.sh status      show what is running
#   ./dev.sh logs <name> follow a log: api | worker-general | worker-report | admin-web | metro
#   ./dev.sh down        stop everything (the database volume is kept)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE="$ROOT/infra/.local/dev"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.dev.yml")
ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
AVD="${AVD:-Pixel_10a}"
SERVICES="api worker-general worker-report admin-web metro"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# wait_for <seconds> <what> <command...>
wait_for() {
  local seconds=$1 what=$2
  shift 2
  for ((i = 0; i < seconds; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "Timed out after ${seconds}s waiting for $what"
}

# Nothing in the repo reads .env on its own; every Node process needs it exported.
load_env() {
  [ -f "$ROOT/.env" ] || die "Missing $ROOT/.env (copy .env.example and fill it in)"
  set -a
  . "$ROOT/.env"
  set +a
}

free_port() {
  local pids
  pids=$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    say "Port $1 is taken; stopping the process holding it"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

stop_service() {
  local pidfile="$STATE/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid
  pid=$(cat "$pidfile")
  # Each service runs in its own process group, so this also stops pnpm's children.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}

start_service() {
  local name=$1
  shift
  stop_service "$name"
  say "Starting $name (log: infra/.local/dev/$name.log)"
  (cd "$ROOT" && exec nohup "$@") >"$STATE/$name.log" 2>&1 </dev/null &
  echo $! >"$STATE/$name.pid"
}

stop_stale_workers() {
  pkill -f 'dist/worker\.(general|report)\.js' 2>/dev/null || true
}

cmd_up() {
  mkdir -p "$STATE"
  for tool in node pnpm docker; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
  done

  # A Homebrew Postgres on 5432 takes the connections meant for Docker.
  local brew_pg
  brew_pg=$(brew services list 2>/dev/null | awk '/^postgresql(@[0-9]+)? +started/ {print $1}' || true)
  for formula in $brew_pg; do
    say "Stopping Homebrew $formula (it collides with Docker on port 5432)"
    brew services stop "$formula"
  done

  if ! docker info >/dev/null 2>&1; then
    say "Starting Docker Desktop"
    open -a Docker
    wait_for 120 "Docker Desktop" docker info
  fi

  say "Starting Postgres"
  "${COMPOSE[@]}" up -d postgres
  wait_for 60 "Postgres" "${COMPOSE[@]}" exec -T postgres pg_isready -U postgres -d audit5s

  load_env
  cd "$ROOT"

  say "Installing dependencies"
  pnpm install

  say "Migrating and seeding (both are safe to repeat)"
  pnpm db:migrate
  pnpm seed

  if [ -z "${CHROMIUM_EXECUTABLE_PATH:-}" ]; then
    say "Making sure the report worker's Chromium is installed"
    pnpm --filter @audit5s/api exec playwright install chromium
  fi

  for service in $SERVICES; do stop_service "$service"; done
  stop_stale_workers
  free_port 3000
  free_port 5173
  free_port 8081

  start_service api pnpm --filter @audit5s/api start:dev
  wait_for 120 "the API on port 3000" curl -fsS http://localhost:3000/api/v1/health

  start_service worker-general pnpm --filter @audit5s/api exec node dist/worker.general.js
  start_service worker-report pnpm --filter @audit5s/api exec node dist/worker.report.js
  start_service admin-web pnpm --filter @audit5s/admin-web dev
  start_service metro pnpm --filter @audit5s/field-mobile start

  wait_for 60 "the admin web on port 5173" curl -fsS http://localhost:5173
  wait_for 90 "Metro on port 8081" curl -fsS http://localhost:8081/status

  echo
  cmd_status
  echo
  say "Ready. Next: ./dev.sh android (or press Run in Android Studio)"
}

cmd_android() {
  local adb="$ANDROID_SDK/platform-tools/adb"
  local emulator="$ANDROID_SDK/emulator/emulator"
  local android_dir="$ROOT/apps/field-mobile/android"
  [ -x "$adb" ] || die "Android SDK not found at $ANDROID_SDK (set ANDROID_HOME)"
  mkdir -p "$STATE"
  load_env
  cd "$ROOT"

  if [ ! -d "$android_dir" ]; then
    say "Generating the native Android project"
    pnpm --filter @audit5s/field-mobile prebuild
  fi
  [ -f "$android_dir/local.properties" ] || echo "sdk.dir=$ANDROID_SDK" >"$android_dir/local.properties"

  if ! "$adb" devices | grep 'emulator-' >/dev/null; then
    say "Booting emulator $AVD"
    nohup "$emulator" -avd "$AVD" >"$STATE/emulator.log" 2>&1 </dev/null &
  fi
  booted() { [ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; }
  wait_for 240 "the emulator to boot" booted

  say "Building and installing the app (the first build takes several minutes)"
  pnpm --filter @audit5s/field-mobile android
}

cmd_status() {
  local postgres
  postgres=$("${COMPOSE[@]}" ps --format '{{.Status}}' postgres 2>/dev/null || true)
  printf '%-15s %s\n' postgres "${postgres:-not running}"
  # Probe what is actually up, not just what this script started.
  local pids
  for service in $SERVICES; do
    case $service in
      api) pids=$(lsof -nP -tiTCP:3000 -sTCP:LISTEN 2>/dev/null || true) ;;
      admin-web) pids=$(lsof -nP -tiTCP:5173 -sTCP:LISTEN 2>/dev/null || true) ;;
      metro) pids=$(lsof -nP -tiTCP:8081 -sTCP:LISTEN 2>/dev/null || true) ;;
      worker-general) pids=$(pgrep -f 'dist/worker\.general\.js' || true) ;;
      worker-report) pids=$(pgrep -f 'dist/worker\.report\.js' || true) ;;
    esac
    printf '%-15s %s\n' "$service" "$([ -n "$pids" ] && echo "running (pid $(echo $pids | tr ' ' ','))" || echo stopped)"
  done
  echo
  echo "API        http://localhost:3000/api/v1/health"
  echo "Admin web  http://localhost:5173"
  echo "Metro      http://localhost:8081"
}

cmd_logs() {
  local log="$STATE/$1.log"
  [ -f "$log" ] || die "No log for '$1'. Pick one of: $SERVICES"
  tail -n 100 -f "$log"
}

cmd_down() {
  for service in $SERVICES; do stop_service "$service"; done
  stop_stale_workers
  if docker info >/dev/null 2>&1; then
    say "Stopping Postgres (the data is kept)"
    "${COMPOSE[@]}" down
  fi
  say "Stopped"
}

# Job control gives every background service its own process group (see stop_service).
set -m

case "${1:-up}" in
  up) cmd_up ;;
  android) cmd_android ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-api}" ;;
  down) cmd_down ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
