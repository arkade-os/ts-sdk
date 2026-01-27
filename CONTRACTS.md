# Contracts subsystem responsibilities

This document records the intended responsibilities and data flow between
`ContractManager`, `ContractWatcher`, `Wallet`, repositories, and the
`IndexerProvider`. It is the baseline for upcoming refactors.

## Goals

- **Single source of truth:** Repositories are the primary store for contract
  and VTXO state.
- **Minimal network coupling:** `Wallet` and `ContractWatcher` should avoid
  direct reads from `IndexerProvider` for VTXO data.
- **Clear ownership:** `ContractManager` owns monitoring and synchronization of
  VTXO changes, and updates repositories accordingly.

## Roles and responsibilities

### ContractManager
- **Owns monitoring orchestration.** Subscribes to contract events via
  `ContractWatcher` and reacts to `vtxo_received` and `vtxo_spent`.
- **Repository updates.** On contract events, fetches fresh VTXO data from
  `IndexerProvider` and updates the relevant repositories.
- **Cache invalidation.** Drives any cache invalidation logic based on wallet
  activity and contract events.
- **Contract expiry checks.** Centralizes expiration checks (even if triggered
  by watcher activity).

### ContractWatcher
- **Event-only component.** Detects changes (watcher subscription + polling)
  and emits `vtxo_received` / `vtxo_spent` / `contract_expired` events.
- **No repository writes.** Must not mutate repositories directly.
- **No VTXO reads from indexer for state.** Its role is to notify, not to fetch
  detailed state for persistence.

### Wallet / ReadonlyWallet
- **Repository-first reads.** Queries balance/VTXO state from repositories.
- **No direct IndexerProvider VTXO reads.** Any synchronization with the
  indexer is delegated to `ContractManager`.
- **Offline-first behavior.** The wallet operates with cached data and relies
  on `ContractManager` to keep repositories up to date.

### Repositories
- **System of record.** Persist all contract and VTXO data.
- **Updated only through ContractManager.** Other components read from the
  repositories but do not mutate them directly.

## Data flow (high level)

1. **ContractWatcher** observes activity (subscriptions + polling).
2. **ContractWatcher** emits `vtxo_received` / `vtxo_spent` events.
3. **ContractManager** handles events and fetches fresh VTXO data from
   `IndexerProvider`.
4. **ContractManager** writes updated VTXO/contract state to repositories.
5. **Wallet / ReadonlyWallet** reads from repositories for balances and VTXO
   lists (offline-first).

## Implications for TODOs

- Move any contract expiration checks or cache invalidation logic into
  `ContractManager`, triggered by watcher events.
- Remove or refactor any direct `IndexerProvider` VTXO reads in `Wallet` and
  `ContractWatcher` in favor of repository reads.
- Ensure `ContractManager` is the only component performing indexer fetches to
  refresh persisted VTXO state.
