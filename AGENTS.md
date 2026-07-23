# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Reference Implementation & Technical Direction

**The .NET Ark SDK (`NArk`, ArkLabsHQ) is the reference implementation for this TypeScript SDK** —
for feature parity and, more broadly, for technical direction and architecture. When designing a new
feature, refactoring, or resolving an ambiguity about how something *should* work, check how `NArk`
does it and align with it unless there's a TypeScript- or platform-specific reason to diverge (and
note the reason when you do). A local checkout typically lives alongside this repo at `../dotnet-sdk`.

Context for why this matters: this TypeScript SDK began as a fairly literal port of the Go SDK. That
origin left it carrying Go idioms and structural choices that don't fit TypeScript well, so parts of
the codebase are shaped by the translation rather than by what's idiomatic or best for this platform.
Treat such patterns as legacy to be improved, not as precedent to extend. The `NArk` codebase is the
better-architected, more deliberately designed expression of the same domain; prefer its structure
and naming when they conflict with the inherited Go-shaped patterns here.

## Core Package, Plugins & Code Reuse

`@arkade-os/sdk` is the core package. `@arkade-os/boltz-swap` should be treated as a plugin-style
extension of that core, and as one example of the many integrations/plugins expected to exist over
time. Prefer reusing existing SDK utilities, types, primitives, and helper functions from
`packages/ts-sdk` instead of duplicating equivalent logic in `boltz-swap` or future plugins. When
shared behavior is generally useful beyond one plugin and belongs to the wallet/protocol core,
promote it into `ts-sdk` rather than copying it outward.

Keep the dependency and ownership direction clear: plugins may depend on and consume `ts-sdk`, but
`ts-sdk` must remain independent of plugin packages and must not import from or special-case
`boltz-swap`. Core capabilities flow from `ts-sdk` outward to plugins.

## Commands

```bash
pnpm run build       # Build all packages — ts-sdk must build before boltz-swap
pnpm run test:unit   # All unit tests
pnpm run lint        # Check formatting (prettier)
pnpm -C packages/ts-sdk vitest run test/wallet.test.ts   # Single test file
```

Release and regtest/integration workflows are documented in `CONTRIBUTING.md`.

## Contracts Subsystem Ownership

The `src/contracts/` pipeline is event-driven with strict ownership rules:

- `ContractWatcher` is event-only: emits `vtxo_received`/`vtxo_spent`, never writes to repositories, never reads VTXO state from `IndexerProvider`.
- `ContractManager` owns orchestration: subscribes to watcher events, fetches fresh VTXO data from `IndexerProvider`, and is the **only** component that writes VTXO/contract state to repositories.
- `Wallet`/`ReadonlyWallet` read balance and VTXO state from repositories only (offline-first); any indexer synchronization is delegated to `ContractManager`.
- Repositories are the system of record and are mutated exclusively by `ContractManager`.

Repository interfaces carry `readonly version: N` to force compile-time updates on schema changes.

## Local Scratch Files

`.gitignore` excludes `*.agents.md`, `TASKS.md`, `CLAUDE.md`, `REVIEW.md`, and `.claude/`. These are local scratch notes — drafts, review snapshots, AI session state — and are **not** authoritative project guidance. Authoritative guidance lives in this `AGENTS.md` (and the package READMEs); treat anything in an ignored file as transient context that may be stale or contradict the codebase.
