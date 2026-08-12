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

`@arkade-os/sdk` is the core package. `@arkade-os/boltz-swap` and `@arkade-os/swap` should be
treated as plugin-style extensions of that core, and as examples of the many integrations/plugins
expected to exist over time. Prefer reusing existing SDK utilities, types, primitives, and helper
functions from `packages/ts-sdk` instead of duplicating equivalent logic in a plugin. When shared
behavior is generally useful beyond one plugin and belongs to the wallet/protocol core, promote it
into `ts-sdk` rather than copying it outward.

Keep the dependency and ownership direction clear: plugins may depend on and consume `ts-sdk`, but
`ts-sdk` must remain independent of plugin packages and must not import from or special-case any of
them. Core capabilities flow from `ts-sdk` outward to plugins.

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

## Key Provisioning Ownership

Wallets own key material and key-derivation policy. Packages and plugins never generate signing
keys and never branch on wallet *type* — they ask the wallet and use what comes back:

- `wallet.getNextSigningDescriptor()` answers for every `Wallet`: an HD wallet allocates a fresh
  descriptor, a static wallet answers with its one `tr(pubkey)`. The policy decision (static vs
  fresh) lives inside the wallet, invisible to callers.
- `wallet.signerForDescriptor(descriptor)` returns the descriptor's `Identity` and **throws**
  (`ForeignDescriptorError`) for a key the wallet does not hold — it never silently substitutes
  the baseline identity, which would sign with the wrong key. The identity it returns must be a
  full signer (`sign`, `signMessage`, `signerSession`, `xOnlyPublicKey`); one carrying the right
  key but no ability to use it is refused as `WalletCannotSignError`, a distinct failure with a
  distinct remedy — attach the signer, rather than restore another seed.
- Structural probes (`isHDAllocationCapable`, `isHDWalletCapable`) are feature detection — "does
  this wallet speak the descriptor API" — never policy. Code that branches *behavior* on whether a
  wallet is HD, or calls `randomSecretKey()` for a signing/refund/claim key, is a defect: the
  wallet's identity key is the fallback, never a minted one.
- Per-artifact secrets (swap preimages) key off the **descriptor's shape**, not the wallet's type:
  an HD child descriptor is unique per artifact and can derive secrets deterministically; a bare
  `tr(pubkey)` repeats across artifacts, so derived-from-key secrets would collide and must be
  stored per artifact instead (see `packages/ts-sdk/src/wallet/contractSecrets.ts` and
  `swapSecretsToRecord` in `packages/swap/src/store.ts`).

## Local Scratch Files

`.gitignore` excludes `*.agents.md`, `TASKS.md`, `CLAUDE.md`, `REVIEW.md`, and `.claude/`. These are local scratch notes — drafts, review snapshots, AI session state — and are **not** authoritative project guidance. Authoritative guidance lives in this `AGENTS.md` (and the package READMEs); treat anything in an ignored file as transient context that may be stale or contradict the codebase.
