# Wallet Restore Hooks Design

## Purpose

An explicit `wallet.restore()` recovers the core wallet contracts and VTXOs for an imported identity, but plugin-owned state currently requires a second consumer-composed recovery call. Asset swaps are the first concrete example: `@arkade-os/swap` can rebuild offer records, restore pending records, advance its durable scan cursor, and restore covenant coverage, but an application must remember to run that orchestration after core wallet recovery.

The SDK should let optional plugins participate in explicit wallet restore without making `@arkade-os/sdk` depend on or special-case a plugin package. Ordinary `Wallet.create()` startup remains unchanged.

## Ownership Boundary

`@arkade-os/sdk` owns a generic restore-hook registry and invokes it after core recovery. It knows only the hook identifier and callback contract.

`@arkade-os/swap` owns the asset-swap hook. It obtains the recovered wallet history and delegates the durable swap work to `restoreAssetSwapRepository`. The application supplies the plugin repository and any application-owned record decoration or result notification.

The dependency direction remains one-way: swap imports core SDK utilities; core never imports swap.

## Core API

Core exports a registry function with this conceptual shape:

```ts
interface WalletRestoreHook {
  id: string
  restore(wallet: IWallet): Promise<void>
}

function registerWalletRestoreHook(
  wallet: IWallet,
  hook: WalletRestoreHook,
): () => void
```

Registration is stored in a module-owned `WeakMap` keyed by wallet instance. This avoids adding a required member to `IWallet`, which would break structural wallet implementations and test doubles. Registering the same `id` again replaces the callback without changing its position. The returned function removes that exact registration and is safe to call more than once.

The hook runner is an internal core function used by both direct and service-worker wallets. It snapshots the registered hooks at the start of a run, executes every snapshot entry in registration order, and collects failures so one plugin cannot prevent another plugin from restoring. After all hooks have run, failures are surfaced as an `AggregateError` containing the original causes.

## Restore Lifecycle

`Wallet.restore()` keeps its existing validation and coalescing contract, but the coalesced promise now covers both phases:

1. Run core contract discovery, watermark advancement, look-ahead refill, and the full-history VTXO refresh.
2. If core recovery succeeds, run the registered plugin restore hooks.
3. Resolve only when both phases complete; reject on core failure or after collecting plugin failures.

Hooks do not run after a core recovery failure because their history and contract inputs may be incomplete. A later call is safe: both core recovery and plugin recovery are required to be idempotent.

A hook registered during an in-flight restore waits for the next explicit restore because the active run uses a snapshot. A hook removed during an in-flight restore may finish the active callback; removal affects subsequent restores.

`Wallet.create()` and `ReadonlyWallet.create()` do not invoke restore hooks.

## Service-Worker Wallet

Callbacks cannot cross `postMessage`, so hooks register on the main-thread `ServiceWorkerWallet` proxy. `ServiceWorkerWallet.restore()` first waits for the existing worker-side core recovery message and then runs the same core hook runner against the proxy instance.

The proxy adds a local in-flight guard covering the worker request and local hooks together. Concurrent calls therefore return the same promise and cannot run plugin recovery twice after the worker has coalesced its own scan. The first call's `gapLimit` continues to govern the active restore.

## Asset-Swap Integration

`@arkade-os/swap` exports `registerAssetSwapRestore` with the following responsibilities:

1. Register one stable hook id through `registerWalletRestoreHook`.
2. After core restore, call `wallet.getTransactionHistory()` so the scan sees the newly recovered history.
3. Normalize the SDK's recovered `ArkTransaction` history into the scan's compact `Tx` shape, then call `restoreAssetSwapRepository` with the wallet, plugin repository, wallet indexer, current operator key, configured operator URL, and optional `prepareNew` callback.
4. Deliver the complete `RestoreAssetSwapRepositoryResult` to an optional `onResult` callback for application state and notifications.

Conceptual usage:

```ts
const unregisterSwapRestore = registerAssetSwapRestore(wallet, {
  arkServerUrl,
  repository,
  prepareNew,
  onResult,
})

await wallet.restore({ gapLimit: 100 })
```

The hook does not duplicate the lower-level orchestration. `restoreAssetSwapRepository` remains the single owner of record reads, skip lists, chain scanning, durable writes, cursor advancement, and offer covenant coverage.

The existing standalone function remains public for applications that need manual scheduling outside an explicit wallet import. Hook registration affects only `wallet.restore()`; it does not run during ordinary wallet creation or every application boot.

### Dependencies Derived from the Wallet

The swap helper reads `indexerProvider` and `arkServerPublicKey` from a concrete wallet by default rather than asking applications to pass duplicate values that could disagree with it. The operator URL remains explicit because an injected `ArkProvider` is not guaranteed to expose a URL.

The helper accepts wallets that implement the current `IWallet` restore and history surface, including `ServiceWorkerWallet`. Since those dependencies are not part of the structural `IWallet` contract, a proxy or custom wallet that does not expose them passes explicit `indexer` and `serverPubkey` overrides; wallet-derived values remain the default.

## Errors and Results

Chain scan and persistence failures from `restoreAssetSwapRepository` reject the hook and therefore make `wallet.restore()` reject after other hooks have had a chance to run. This keeps an incomplete import loud and retryable.

An offer-coverage failure is already returned as `coverageError` after durable records are safe. `registerAssetSwapRestore` passes that result to `onResult` and does not reinterpret it as a rejected scan. Applications can display or log it, and a later restore retries coverage idempotently.

If `onResult` rejects, the hook rejects: an explicitly awaited lifecycle callback must not claim completion when its consumer-side state transition failed. The durable swap records remain safe and retrying is allowed.

## Documentation

The core SDK README adds a concise section describing restore hooks as the plugin extension point, including ordering and explicit-restore-only semantics.

The swap README adds a complete “Restore an imported wallet” section near its storage and restore documentation. It explains:

- register the hook after creating the wallet and repository but before calling `wallet.restore()`;
- core contracts and VTXOs recover before the swap scan runs;
- the repository and scan cursor are durable and the operation is idempotent;
- `onResult` is for presentation/state work, not duplicate persistence;
- normal `Wallet.create()` does not trigger the scan;
- `restoreAssetSwapRepository` remains available for manual boot-time or scheduled reconciliation.

The README's layer summary is updated so the restore layer names both the lower-level scanner and the repository-level/import integration rather than presenting `restoreAssetSwaps` as the consumer entrypoint.

## Reference Wallet Adoption

The reference wallet registers the asset-swap hook on the newly created `ServiceWorkerWallet` inside `WalletProvider`, before its existing `if (restoring) await svcWallet.restore()` branch. That is the only point where the hook can participate in an imported-wallet restore because `AssetSwapsProvider` mounts later.

The hook uses the existing asset-swap repository and the same Arkade indexer configuration as the wallet. It needs no presentation callback: after restore, `AssetSwapsProvider` reads the rebuilt durable records during its normal initialization. Its existing incremental reconciliation remains in place for ordinary boot, late-arriving history, and watcher coverage outside an explicit wallet import; that is separate from the restore hook and remains idempotent against records the hook already rebuilt.

## Testing

Core unit tests cover:

- core recovery completes before hooks run;
- hooks run in registration order;
- duplicate ids replace rather than double-run;
- unregister is exact and idempotent;
- all hooks run before failures are aggregated;
- hooks do not run after core recovery fails;
- concurrent direct-wallet restores coalesce across hooks;
- hooks registered during a run wait for the next restore.

Service-worker tests cover:

- the worker restore response precedes local hook execution;
- concurrent proxy restores run local hooks once;
- hook failures are surfaced to the caller without crossing the worker protocol.

Swap tests cover:

- recovered history is fetched after core restore invokes the hook;
- wallet-derived indexer and operator key are passed to repository recovery;
- explicit indexer and server-key overrides work for proxy/custom wallets;
- `prepareNew` and `onResult` are forwarded once;
- duplicate registration does not duplicate scans;
- standalone `restoreAssetSwapRepository` behavior remains unchanged.

Reference-wallet tests cover registration before the explicit restore call and confirm that ordinary non-restoring startup does not invoke the registered hook.

The full ts-sdk build, unit suite, swap integration suite, and publish-shape checks must remain green.
