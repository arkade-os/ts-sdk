# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Core Package, Plugins & Code Reuse

`@arkade-os/sdk` is the core package. `@arkade-os/swap` should be treated as a plugin-style
extension of that core, and as an example of the many integrations/plugins expected to exist over
time. Prefer reusing existing SDK utilities, types, primitives, and helper functions from
`packages/sdk` instead of duplicating equivalent logic in a plugin. When shared behavior is
generally useful beyond one plugin and belongs to the wallet/protocol core, promote it into
`sdk` rather than copying it outward.

Keep the dependency and ownership direction clear: plugins may depend on and consume `sdk`, but
`sdk` must remain independent of plugin packages and must not import from or special-case any of
them. Core capabilities flow from `sdk` outward to plugins.

## Commands

```bash
pnpm run build       # Build all packages — sdk must build before the plugins
pnpm run test:unit   # All unit tests
pnpm run lint        # Check formatting (biome)
pnpm -C packages/sdk vitest run test/wallet.test.ts   # Single test file
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
  an HD child descriptor is unique per artifact and derives secrets from the key alone; a bare
  `tr(pubkey)` repeats across artifacts, so that derivation would collide and the uniqueness comes
  from a public per-artifact **salt** stored with the artifact instead. Only a signer that cannot
  sign deterministically at all falls back to a stored secret. See
  `packages/sdk/src/wallet/contractSecrets.ts`.
- The ban is on **key material and on anything that signs** — not on public per-artifact values. A
  package may mint and store public material such as a derivation salt: it is an input the wallet
  needs back, not a capability, and knowing it grants nothing without the seed. Apply the same test
  to anything new: could a reader of the repository spend with it?

## Decoding PSBTs

Decode PSBTs only through the SDK's `Transaction` (`packages/sdk/src/utils/transaction.ts`,
exported as `Transaction` from `@arkade-os/sdk`), never through `@scure/btc-signer`'s own
`Transaction.fromPSBT`. This applies to both `sdk` and its plugins. Since scure 2.4, the raw
decoder strips unknown PSBT fields by default, which drops every Ark field (taptree, condition
witness, cosigner keys, ...). It also rejects the legacy output tap trees that older SDK releases
wrote, which the wrapper repairs. No lint enforces this, so the plan, code and review steps must
each check for it: any `fromPSBT` call that resolves to scure's class is a defect.

## Local Scratch Files

`.gitignore` excludes `*.agents.md`, `TASKS.md`, `CLAUDE.md`, `REVIEW.md`, and `.claude/`. These are local scratch notes — drafts, review snapshots, AI session state — and are **not** authoritative project guidance. Authoritative guidance lives in this `AGENTS.md` (and the package READMEs); treat anything in an ignored file as transient context that may be stale or contradict the codebase.
