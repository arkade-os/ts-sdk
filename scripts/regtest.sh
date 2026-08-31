#!/usr/bin/env bash
# Per-package regtest controller.
#
# Each package shares the regtest submodule at ./regtest but uses its own
# .env.regtest override (packages/<pkg>/.env.regtest). This script wires the
# right override file into the regtest Node CLI via --env.
#
# `swap-rfq` is a second PROFILE of the swap package, not a fourth package: same
# sources and same setup waiter, but `.env.regtest.rfq` and the RFQ e2e files
# only. It exists because the two swap corridors need opposite arkd timelock
# types — see that file's header. The profiles share ports, so only one stack
# can be up at a time.
#
# Usage: scripts/regtest.sh <ts-sdk|boltz-swap|swap|swap-rfq> <up|down|reset|setup|test|cycle|groups> [test file...]
#   up     – clean + start with the package's .env.regtest
#   down   – stop the stack (preserves data)
#   reset  – clean (remove containers, volumes)
#   setup  – run the package's test/setup waiter
#   test   – run the package's vitest e2e suite or selected files (assumes stack is up)
#   cycle  – reset + up + setup + test (full integration run)
#   groups – ts-sdk only: run each CI group in turn, on a fresh stack per group
#
# `cycle` runs every e2e file in ONE vitest process against ONE long-lived stack.
# CI never does that — it splits the suite into groups, each with its own stack —
# and the shared arkd is what makes a whole-suite run flaky: server config a test
# mutates (fees, signer rotation) outlives it and breaks later files. Prefer
# `groups` for a full local run; keep `cycle` for a quick single-stack pass.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REGTEST_DIR="$ROOT_DIR/regtest"

usage() {
  echo "Usage: $0 <ts-sdk|boltz-swap|swap|swap-rfq> <up|down|reset|setup|test|cycle|groups> [test file...]" >&2
  exit 1
}

if [ "$#" -lt 2 ]; then
  usage
fi

PKG="$1"
CMD="$2"
shift 2
if [ "${1:-}" = "--" ]; then
  shift
fi
TEST_FILES=("$@")

# A profile resolves to a package directory plus an env-file suffix; a plain
# package name is the profile with no suffix.
case "$PKG" in
  ts-sdk|boltz-swap|swap) PKG_DIR="$PKG"; ENV_SUFFIX="" ;;
  swap-rfq)               PKG_DIR="swap"; ENV_SUFFIX=".rfq" ;;
  *) usage ;;
esac

ENV_FILE="$ROOT_DIR/packages/$PKG_DIR/.env.regtest$ENV_SUFFIX"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

# The package e2e suites + setup waiter invoke `node regtest/regtest.mjs ...`
# with a path relative to the package directory (their cwd under `pnpm -C`).
# The submodule itself lives at the repo root, so expose it inside the package
# via a symlink (git-ignored, recreated idempotently on every run) so that the
# relative path resolves regardless of the package the controller targets.
ln -sfn "$REGTEST_DIR" "$ROOT_DIR/packages/$PKG_DIR/regtest"

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
  case "$PKG_DIR" in
    ts-sdk)
      pnpm -C "$ROOT_DIR/packages/ts-sdk" exec node test/setup.mjs
      ;;
    boltz-swap)
      pnpm -C "$ROOT_DIR/packages/boltz-swap" exec node test/e2e/setup.mjs
      ;;
    swap)
      pnpm -C "$ROOT_DIR/packages/swap" exec node test/e2e/setup.mjs
      ;;
  esac
}

cmd_test() {
  case "$PKG" in
    ts-sdk)
      if [ "${#TEST_FILES[@]}" -gt 0 ]; then
        ARK_ENV=docker pnpm -C "$ROOT_DIR/packages/ts-sdk" exec vitest run "${TEST_FILES[@]}"
      else
        ARK_ENV=docker pnpm -C "$ROOT_DIR/packages/ts-sdk" run test:integration
      fi
      ;;
    boltz-swap)
      if [ "${#TEST_FILES[@]}" -gt 0 ]; then
        pnpm -C "$ROOT_DIR/packages/boltz-swap" exec vitest run "${TEST_FILES[@]}"
      else
        pnpm -C "$ROOT_DIR/packages/boltz-swap" run test:integration
      fi
      ;;
    swap)
      if [ "${#TEST_FILES[@]}" -gt 0 ]; then
        pnpm -C "$ROOT_DIR/packages/swap" exec vitest run "${TEST_FILES[@]}"
      else
        pnpm -C "$ROOT_DIR/packages/swap" run test:integration
      fi
      ;;
    swap-rfq)
      if [ "${#TEST_FILES[@]}" -gt 0 ]; then
        pnpm -C "$ROOT_DIR/packages/swap" exec vitest run "${TEST_FILES[@]}"
      else
        pnpm -C "$ROOT_DIR/packages/swap" run test:integration:rfq
      fi
      ;;
  esac
}

# Run each CI group on its own fresh stack, mirroring the integration matrix.
# Keeps going after a failing group so one bad group does not hide the rest;
# exits non-zero if any failed.
cmd_groups() {
  if [ "$PKG" != "ts-sdk" ]; then
    echo "groups: only defined for ts-sdk" >&2
    exit 1
  fi
  local failed=()
  while IFS=$'\t' read -r name files; do
    [ -n "$name" ] || continue
    echo "=== e2e group: $name ==="
    cmd_reset
    cmd_up
    cmd_setup
    # shellcheck disable=SC2086 -- $files is a deliberate word-split file list
    if ARK_ENV=docker pnpm -C "$ROOT_DIR/packages/ts-sdk" exec vitest run $files; then
      echo "=== group $name: PASS ==="
    else
      echo "=== group $name: FAIL ===" >&2
      failed+=("$name")
    fi
  done < <(node "$ROOT_DIR/scripts/e2e-groups.mjs")
  if [ "${#failed[@]}" -gt 0 ]; then
    echo "failed groups: ${failed[*]}" >&2
    exit 1
  fi
}

case "$CMD" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  setup)  cmd_setup ;;
  test)   cmd_test ;;
  groups) cmd_groups ;;
  cycle)
    cmd_reset
    cmd_up
    cmd_setup
    cmd_test
    ;;
  *) usage ;;
esac
