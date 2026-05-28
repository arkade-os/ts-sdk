#!/usr/bin/env bash
# Per-package regtest controller.
#
# Both packages share the regtest submodule at ./regtest but use distinct
# .env.regtest overrides (packages/<pkg>/.env.regtest). This script wires the
# right override file into the regtest scripts via --env / USER_ENV.
#
# Usage: scripts/regtest.sh <ts-sdk|boltz-swap> <up|down|reset|setup|test|cycle>
#   up     – clean + start with the package's .env.regtest
#   down   – stop the stack (preserves data)
#   reset  – clean (remove containers, volumes)
#   setup  – run the package's test/setup waiter
#   test   – run the package's vitest e2e suite (assumes stack is up)
#   cycle  – reset + up + setup + test (full integration run)

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REGTEST_DIR="$ROOT_DIR/regtest"
# Emulator co-signing service used by the ts-sdk Arkade e2e suite. It joins
# the external "nigiri" network created by start-env.sh, so it must start after
# the regtest stack is up.
EMULATOR_COMPOSE="$ROOT_DIR/docker-compose.emulator.yml"

emulator_up() {
  docker compose -f "$EMULATOR_COMPOSE" up -d
}

emulator_down() {
  docker compose -f "$EMULATOR_COMPOSE" down -v 2>/dev/null || true
}

PKG="${1:-}"
CMD="${2:-}"

usage() {
  echo "Usage: $0 <ts-sdk|boltz-swap> <up|down|reset|setup|test|cycle>" >&2
  exit 1
}

case "$PKG" in
  ts-sdk|boltz-swap) ;;
  *) usage ;;
esac

ENV_FILE="$ROOT_DIR/packages/$PKG/.env.regtest"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

cmd_up() {
  bash "$REGTEST_DIR/start-env.sh" --env "$ENV_FILE"
  if [ "$PKG" = "ts-sdk" ]; then
    emulator_up
  fi
}

cmd_down() {
  if [ "$PKG" = "ts-sdk" ]; then
    emulator_down
  fi
  USER_ENV="$ENV_FILE" bash "$REGTEST_DIR/stop-env.sh"
}

cmd_reset() {
  if [ "$PKG" = "ts-sdk" ]; then
    emulator_down
  fi
  USER_ENV="$ENV_FILE" bash "$REGTEST_DIR/clean-env.sh"
}

cmd_setup() {
  case "$PKG" in
    ts-sdk)
      pnpm -C "$ROOT_DIR/packages/ts-sdk" exec node test/setup.mjs
      ;;
    boltz-swap)
      pnpm -C "$ROOT_DIR/packages/boltz-swap" exec node test/e2e/setup.mjs
      ;;
  esac
}

cmd_test() {
  case "$PKG" in
    ts-sdk)
      ARK_ENV=docker pnpm -C "$ROOT_DIR/packages/ts-sdk" run test:integration
      ;;
    boltz-swap)
      pnpm -C "$ROOT_DIR/packages/boltz-swap" run test:integration
      ;;
  esac
}

case "$CMD" in
  up)    cmd_up ;;
  down)  cmd_down ;;
  reset) cmd_reset ;;
  setup) cmd_setup ;;
  test)  cmd_test ;;
  cycle)
    cmd_reset
    cmd_up
    cmd_setup
    cmd_test
    ;;
  *) usage ;;
esac
