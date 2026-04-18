# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Project Overview

**arkade-monorepo** — A pnpm workspace monorepo for the Arkade Bitcoin wallet ecosystem. Contains two published packages: `@arkade-os/sdk` (Bitcoin wallet SDK with Taproot/Ark protocol) and `@arkade-os/boltz-swap` (Lightning/chain swaps via Boltz). Both target browser, Node.js, and React Native (Expo).

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

# Single test file
pnpm -C packages/ts-sdk vitest run test/wallet.test.ts
pnpm -C packages/boltz-swap vitest run test/swap-manager.test.ts

# Single test by name
pnpm -C packages/ts-sdk vitest run -t "test name pattern"

# Integration tests (require Docker regtest stack)
pnpm run regtest:up           # Start nigiri + Docker services
pnpm run regtest:setup        # Initialize wallets and shared test fixtures
pnpm run test:integration     # Run integration tests for both packages
pnpm run regtest:test         # Run setup + integration tests for both packages
pnpm run regtest:down         # Stop Docker services
pnpm run regtest:reset        # Reset Docker volumes

# Release
pnpm run release              # Release all (ts-sdk first, then boltz-swap)
pnpm run release:ts-sdk       # Release SDK only
pnpm run release:boltz-swap   # Release boltz-swap only
```

## Code Style

- **Prettier**: double quotes, semicolons, trailing commas (all), 100 char width, 4-space indent
- **Package manager**: pnpm 10.25.x only (enforced). Node >=22.12.0
- **TypeScript**: 5.9, strict mode, target ES2022, module resolution "bundler"

## Architecture

### Workspace Structure

```
config/              # Shared configs (tsconfig.base.json, vitest.base.ts, eslint.base.cjs)
packages/
  ts-sdk/            # @arkade-os/sdk — core Bitcoin wallet SDK
  boltz-swap/        # @arkade-os/boltz-swap — Boltz submarine swaps (depends on ts-sdk)
regtest/             # Git submodule (arkade-regtest) — shared regtest environment
scripts/
  release.sh         # Root release orchestrator (enforces ts-sdk → boltz-swap order)
```

### `@arkade-os/sdk` (packages/ts-sdk)

Dual ESM/CJS build via `tsc` (separate tsconfig per format) with post-processing (`add-extensions.js` for ESM imports, `generate-package-files.js` for subpath exports).

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

### Integration Testing Stack (regtest/)

Git submodule pointing to [arkade-regtest](https://github.com/ArkLabsHQ/arkade-regtest). Manages nigiri, arkd, boltz, LND, fulmine, and supporting services. Uses `start-env.sh` / `stop-env.sh` / `clean-env.sh`. Run `git submodule update --init` after cloning.

### Shared Config Pattern

Packages extend shared base configs from `config/`:
- `tsconfig.json` extends `../../config/tsconfig.base.json`
- `vitest.config.ts` merges with `../../config/vitest.base.ts`
- ESLint configs extend `../../config/eslint.base.cjs`

### Testing

- Vitest with `globals: true`, `fileParallelism: false`
- ts-sdk uses `test/polyfill.js` (IndexedDB shim + EventSource polyfill for Node)
- boltz-swap uses `test/setup.ts`
- Integration tests live in `test/e2e/` within each package and require the Docker regtest stack
