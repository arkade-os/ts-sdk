#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:-all}
shift || true
ARGS=("$@")

ensure_boltz_dep() {
  node - <<'NODE'
    const fs = require('fs');
    const path = require('path');
    const pkgPath = path.resolve(__dirname, '../packages/boltz-swap/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const desired = 'workspace:*';
    if (!pkg.dependencies) pkg.dependencies = {};
    if (pkg.dependencies['@arkade-os/sdk'] !== desired) {
      pkg.dependencies['@arkade-os/sdk'] = desired;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
      console.log('updated @arkade-os/sdk dependency to workspace:*');
    }
  NODE
}

run_ts_sdk() {
  echo "🚀 Releasing ts-sdk";
  pnpm -C "$ROOT_DIR/packages/ts-sdk" run release "${ARGS[@]}";
}

run_boltz_swap() {
  ensure_boltz_dep
  echo "🚀 Releasing boltz-swap";
  pnpm -C "$ROOT_DIR/packages/boltz-swap" run release "${ARGS[@]}";
}

case "$TARGET" in
  all)
    run_ts_sdk
    run_boltz_swap
    ;;
  ts-sdk)
    run_ts_sdk
    ;;
  boltz-swap)
    run_boltz_swap
    ;;
  *)
    echo "Usage: $0 [all|ts-sdk|boltz-swap] [--dry-run]" >&2
    exit 1
    ;;
esac
