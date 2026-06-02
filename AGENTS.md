# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Project Overview

**arkade-monorepo** — A pnpm workspace monorepo for the Arkade Bitcoin wallet ecosystem. Contains three published packages: `@arkade-os/sdk` (Bitcoin wallet SDK with Taproot/Ark protocol), `@arkade-os/boltz-swap` (Lightning/chain swaps via Boltz), and `@arkade-os/banco` (non interactive swap protocol). All depend on `@arkade-os/sdk` and target browser, Node.js, and React Native (Expo).

## Commands

```bash
# Monorepo-wide
pnpm run build                # Build all packages (ts-sdk must build before boltz-swap)
pnpm test                     # Run all unit and integration tests
pnpm run test:unit            # Run all unit tests
pnpm run test:integration     # Run all integration tests against the root regtest stack
pnpm run lint                 # Check formatting (prettier)

# Per-package (from repo root)
pnpm -C packages/ts-sdk test              # Unit tests for SDK
pnpm -C packages/ts-sdk test:unit         # Unit tests excluding e2e
pnpm -C packages/boltz-swap test          # Unit tests for boltz-swap
pnpm -C packages/boltz-swap test:unit     # Unit tests excluding e2e
pnpm -C packages/banco test               # Unit tests for banco (e2e only; passes with no unit tests)
pnpm -C packages/banco test:unit          # Unit tests excluding e2e

# Single test file
pnpm -C packages/ts-sdk vitest run test/wallet.test.ts
pnpm -C packages/boltz-swap vitest run test/swap-manager.test.ts

# Single test by name
pnpm -C packages/ts-sdk vitest run -t "test name pattern"

# Integration tests (require Docker regtest stack)
# `test:integration` runs each package's full cycle (reset + up + setup + test)
# via `scripts/regtest.sh <pkg> cycle`, using packages/<pkg>/.env.regtest.
pnpm run test:integration              # All packages, end-to-end
pnpm run test:integration:ts-sdk       # ts-sdk only
pnpm run test:integration:boltz-swap   # boltz-swap only
pnpm run test:integration:banco        # banco only

# Per-package stack control (replace :ts-sdk with :boltz-swap or :banco for the others)
pnpm run regtest:up:ts-sdk
pnpm run regtest:setup:ts-sdk
pnpm run regtest:test:ts-sdk
pnpm run regtest:down:ts-sdk
pnpm run regtest:reset:ts-sdk

# Release (package-scoped; target = sdk | boltz-swap | banco | all)
pnpm run release -- boltz-swap patch          # Boltz bugfix only
pnpm run release -- banco patch               # banco only
pnpm run release -- sdk patch                 # SDK + dependent boltz-swap patch
pnpm run release -- sdk prepatch --preid beta # Mirrors prerelease into boltz-swap
pnpm run release -- all patch                 # Bump sdk, boltz-swap, and banco
pnpm run release:dry-run -- sdk patch         # Preview without changes
pnpm run release:cleanup                      # Auto-detect dirty release artifacts
```

Tags are `@arkade-os/sdk/<version>`, `@arkade-os/boltz-swap/<version>`, and `@arkade-os/banco/<version>` (no `v<version>`). Releasing SDK implies a dependent boltz-swap release because boltz-swap depends on SDK via `workspace:*`; override with `--boltz-bump <bump-or-version>`. banco is released independently (included in `all` but not auto-bumped by an SDK release); its `workspace:*` SDK dependency is still pinned on pack/publish. The script runs tests, builds, commits, tags, publishes to npm (requires local npm credentials), and pushes commit + tags to `origin`.

## Code Style

- **Prettier**: double quotes, semicolons, trailing commas (all), 100 char width, 4-space indent
- **Package manager**: pnpm 10.25.x only (enforced). Node >=24.15.0 (see `.nvmrc`)
- **TypeScript**: 5.9, strict mode, target ES2022, module resolution "bundler"

## Architecture

### Workspace Structure

```
config/              # Shared configs (tsconfig.base.json, vitest.base.ts)
packages/
  ts-sdk/            # @arkade-os/sdk — core Bitcoin wallet SDK
  boltz-swap/        # @arkade-os/boltz-swap — Boltz submarine swaps (depends on ts-sdk)
  banco/             # @arkade-os/banco — banco swap protocol (depends on ts-sdk)
regtest/             # Git submodule (arkade-regtest) — shared regtest environment
scripts/
  release.mjs        # Root package-scoped release orchestrator (SDK first, then boltz-swap, then banco)
  release.sh         # Thin wrapper that execs release.mjs
```

### `@arkade-os/sdk` (packages/ts-sdk)

Multi-entry dual ESM/CJS build via `tsup` (see `tsup.config.ts`). Subpath exports cover adapters, repositories (sqlite/realm), the Expo worker, and the Expo wallet (including its background-task entry).

Key layers:
- **Wallet** (`src/wallet/`) — `Wallet` (signing), `ReadonlyWallet` (watch-only), `OnchainWallet` (on-chain UTXOs). Service worker variants communicate via `MessageBus`.
- **Providers** (`src/providers/`) — `ArkProvider` (Ark server/SSE), `IndexerProvider` (VTXO queries), `OnchainProvider` (Esplora). Each has REST and Expo-compatible implementations.
- **Repositories** (`src/repositories/`) — `WalletRepository` and `ContractRepository` interfaces with IndexedDB, InMemory, FileSystem, AsyncStorage, SQLite, and Realm backends. Interfaces carry `readonly version: N` to force compile-time updates on schema changes.
- **Contracts** (`src/contracts/`) — Event-driven: ContractWatcher detects changes → ContractManager handles events/updates repos → Wallet reads repos (offline-first).
- **Service Worker** (`src/worker/`) — `MessageBus` orchestrator with pluggable `MessageHandler`s and tick-based scheduling.
- **Bitcoin primitives** — `src/script/` (tapscript, VHTLC, Ark addresses), `src/musig2/` (MuSig2), `src/tree/` (transaction trees), `src/forfeit.ts` (unilateral exit).

### `@arkade-os/boltz-swap` (packages/boltz-swap)

Built with `tsup` (multi-entry ESM+CJS+dts). Depends on `@arkade-os/sdk` via `workspace:*`.

Key components:
- **ArkadeSwaps** (`src/arkade-swaps.ts`) — Main class orchestrating swap lifecycle.
- **BoltzSwapProvider** (`src/boltz-swap-provider.ts`) — Boltz API integration for swap creation/monitoring.
- **SwapManager** (`src/swap-manager.ts`) — Autonomous background swap monitoring and execution.
- **Repositories** (`src/repositories/`) — `SwapRepository` interface with IndexedDB, InMemory, SQLite, and Realm implementations.
- Swap types: Reverse (Lightning→Ark), Submarine (Ark→Lightning), Chain (ARK↔BTC on-chain).

### `@arkade-os/banco` (packages/banco)

Single-entry `tsup` build (ESM+CJS+dts). Depends on `@arkade-os/sdk` via `workspace:*`. Implements the banco swap protocol (asset ↔ BTC offers).

Key components:
- **Offer** (`src/offer.ts`) — Offer construction/decoding.
- **Maker** (`src/maker.ts`) — Offer creation and lifecycle (`createOffer`, `OfferStatus`).
- **Taker** (`src/taker.ts`) — Offer fulfillment (`fulfill`).

Integration e2e (`test/e2e/`) requires the regtest stack plus the emulator co-signing service (same one the ts-sdk Arkade suite uses); `scripts/regtest.sh banco` brings the emulator up automatically.

### Integration Testing Stack (regtest/)

Git submodule pointing to [arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest). Manages nigiri, arkd, boltz, LND, fulmine, and supporting services. Uses `start-env.sh` / `stop-env.sh` / `clean-env.sh`. Run `git submodule update --init` after cloning.

### Shared Config Pattern

Packages extend shared base configs from `config/`:
- `tsconfig.json` extends `../../config/tsconfig.base.json`
- `vitest.config.ts` merges with `../../config/vitest.base.ts`

### Testing

- Vitest with `globals: true`, `fileParallelism: false`
- ts-sdk uses `test/polyfill.js` (IndexedDB shim + EventSource polyfill for Node)
- boltz-swap uses `test/setup.ts`
- Integration tests live in `test/e2e/` within each package and require the Docker regtest stack

## Local Scratch Files

`.gitignore` excludes `*.agents.md`, `TASKS.md`, `CLAUDE.md`, `REVIEW.md`, and `.claude/`. These are local scratch notes — drafts, review snapshots, AI session state — and are **not** authoritative project guidance. Authoritative guidance lives in this `AGENTS.md` (and the package READMEs); treat anything in an ignored file as transient context that may be stale or contradict the codebase.
