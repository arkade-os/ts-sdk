#!/usr/bin/env bash
# Per-package regtest controller.
#
# All packages share the regtest submodule at ./regtest but use distinct
# .env.regtest overrides (packages/<pkg>/.env.regtest). This script wires the
# right override file into the regtest Node CLI via --env.
#
# Usage: scripts/regtest.sh <ts-sdk|boltz-swap|banco> <up|down|reset|setup|test|cycle>
#   up     – clean + start with the package's .env.regtest
#   down   – stop the stack (preserves data)
#   reset  – clean (remove containers, volumes)
#   setup  – run the package's test/setup waiter
#   test   – run the package's vitest e2e suite (assumes stack is up)
#   cycle  – reset + up + setup + test (full integration run)

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REGTEST_DIR="$ROOT_DIR/regtest"
# Emulator co-signing service used by the ts-sdk and banco Arkade e2e suites.
# It joins the external "nigiri" network created by start-env.sh, so it must
# start after the regtest stack is up.
EMULATOR_COMPOSE="$ROOT_DIR/docker-compose.emulator.yml"

emulator_up() {
  docker compose -f "$EMULATOR_COMPOSE" up -d
}

emulator_down() {
  docker compose -f "$EMULATOR_COMPOSE" down -v 2>/dev/null || true
}

# Packages whose e2e suites require the emulator co-signing service.
needs_emulator() {
  [ "$PKG" = "ts-sdk" ] || [ "$PKG" = "banco" ]
}

PKG="${1:-}"
CMD="${2:-}"

usage() {
  echo "Usage: $0 <ts-sdk|boltz-swap|banco> <up|down|reset|setup|test|cycle>" >&2
  exit 1
}

case "$PKG" in
  ts-sdk|boltz-swap|banco) ;;
  *) usage ;;
esac

ENV_FILE="$ROOT_DIR/packages/$PKG/.env.regtest"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

# The package e2e suites + setup waiter invoke `node regtest/regtest.mjs ...`
# with a path relative to the package directory (their cwd under `pnpm -C`).
# The submodule itself lives at the repo root, so expose it inside the package
# via a symlink (git-ignored, recreated idempotently on every run) so that the
# relative path resolves regardless of the package the controller targets.
ln -sfn "$REGTEST_DIR" "$ROOT_DIR/packages/$PKG/regtest"

cmd_up() {
  bash "$REGTEST_DIR/start-env.sh" --env "$ENV_FILE"
  if needs_emulator; then
    emulator_up
  fi
}

cmd_down() {
  if needs_emulator; then
    emulator_down
  fi
  USER_ENV="$ENV_FILE" bash "$REGTEST_DIR/stop-env.sh"
}

cmd_reset() {
  if needs_emulator; then
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
    banco)
      pnpm -C "$ROOT_DIR/packages/banco" exec node test/e2e/setup.mjs
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
    banco)
      pnpm -C "$ROOT_DIR/packages/banco" run test:integration
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
