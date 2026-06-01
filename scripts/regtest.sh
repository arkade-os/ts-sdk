#!/usr/bin/env bash
# Per-package regtest controller.
#
# Both packages share the regtest submodule at ./regtest but use distinct
# .env.regtest overrides (packages/<pkg>/.env.regtest). This script wires the
# right override file into the regtest Node CLI via --env.
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
  node "$REGTEST_DIR/regtest.mjs" start --env "$ENV_FILE"
}

cmd_down() {
  node "$REGTEST_DIR/regtest.mjs" stop --env "$ENV_FILE"
}

cmd_reset() {
  node "$REGTEST_DIR/regtest.mjs" clean --env "$ENV_FILE"
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
