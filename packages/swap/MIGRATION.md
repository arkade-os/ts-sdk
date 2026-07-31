# Migrating `arkade-os/wallet` to `@arkade-os/swap`

Wallet-side changes to consume this package (extracted from wallet commit `60b0834`,
`src/lib/swap/`). Everything below is mechanical unless marked.

## 1. Dependency and imports

Add `"@arkade-os/swap"` to the wallet's dependencies and delete `src/lib/swap/` plus the two
`banco-*.program.json` files. Swap every `from '../lib/swap/…'` import for
`from '@arkade-os/swap'`.

## 2. Symbol renames

| wallet                           | package                           |
| -------------------------------- | --------------------------------- |
| `bancoPrograms`                  | `swapPrograms`                    |
| `bancoProgramBinding` (internal) | not exported (unchanged behavior) |
| `banco-want-btc.program.json`    | `swap-want-btc.program.json`      |
| `banco-want-asset.program.json`  | `swap-want-asset.program.json`    |

The program JSON **contents** are byte-identical (verified by sha256 and the address golden
test), so all previously derived swap addresses remain valid. Note their internal `"name"`
fields still read `banco-*` — they are inside the hashed program bytes and cannot be renamed.

## 3. Swap records: `IndexedDbAssetSwapRepository`

Swap records and the restore-scan cursor now live in an `AssetSwapRepository` — the same
repository system the wallet already uses for Boltz swaps (`IndexedDbSwapRepository`), built on
the SDK's shared IndexedDB manager:

```ts
import { IndexedDbAssetSwapRepository } from "@arkade-os/swap";
const assetSwapRepository = new IndexedDbAssetSwapRepository();
```

The store/scan calls become async and take the repository:

- `getAssetSwaps()` → `await getAssetSwaps(assetSwapRepository)`; same shape for
  `addAssetSwap(assetSwapRepository, swap)` and `updateAssetSwap(assetSwapRepository, id, changes)`
  — all still return the updated newest-first list, so `setSwaps(await addAssetSwap(...))` works.
- `getScannedTxids()` / `markTxidsScanned(txids)` →
  `await assetSwapRepository.getScannedTxids()` / `await assetSwapRepository.markTxidsScanned(txids)`
  (repository methods now; `SWAP_RESTORE_SCAN_KEY` is gone).
- **One-time data migration** (not written yet — the wallet owns it, like
  `migrateToSwapRepository` for Boltz): read the legacy `localStorage` keys `assetSwaps` and
  `assetSwapsScanned`, `saveSwap`/`markTxidsScanned` them into the repository, then remove the
  keys. ~15 lines next to the existing Boltz migration call in `providers/wallet.tsx`.
- Ordering note: newest-first is by `createdAt` alone; equal-timestamp insertion order is no
  longer guaranteed (records stamp `Date.now()` ms, so this never bites in practice).

## 3b. Markets discovery

`discoverMarkets` takes that same repository — there is no second storage seam, so no
localStorage adapter to write:

- `discoverMarkets(network, useCache)` →
    ```ts
    discoverMarkets({
        network,
        registryUrl: getSolverRegistryUrl(network),
        repository: assetSwapRepository, // omit for a one-shot, uncached discovery
        localCards: readSolverCardsFromStorage().filter((c) => c.network === network),
        logger: consoleLog,
        useCache,
    });
    ```
    (The `network`-card filtering and registry-URL lookup stay wallet concerns.)
    The markets cache moved out of localStorage into the repository, so the old
    `swapMarkets-*` entries are orphaned — one cold refetch, and the data migration in §3
    can delete them alongside the swap keys.
- `makeCachedFeedFetch()` is unchanged (it now also accepts `(ttlMs, fetchImpl)`).
- `createOffer` no longer returns `payload`; it returns the send-ready `extension` instead. In
  `providers/assetSwaps.tsx`: `extensions: [{ type: OFFER_PACKET_TYPE, payload: offer.payload }]`
  → `extensions: [offer.extension]` (the `OFFER_PACKET_TYPE` import can go).
- The `Network` type on these call sites is now `@arkade-os/solver-discovery`'s `Network`, not
  `@arkade-os/boltz-swap`'s — for the wallet's current networks they are the same strings.

## 4. Not mechanical — cut with ponytail markers

- **`preFeeDisplayRate`** was not ported (display-only). Keep it in the wallet (e.g. move to
  `src/lib/swapDisplay.ts`) together with its two tests from `markets.test.ts`.
- **`AssetSwapQuoteSnapshot` / `AssetSwap.quote`** was not ported. The wallet should keep its own
  record type: `type WalletAssetSwap = AssetSwap & { quote?: AssetSwapQuoteSnapshot }` and cast at
  the store boundary — the repository persists whole records, so extra fields like `quote`
  survive untouched. (Or restore the field upstream if a second consumer wants it.)
- `restore.ts` no longer documents the wallet's feeBps/fiat backfill behavior; that logic already
  lives in the wallet caller and is unaffected.

## 5. Tests

Delete `src/test/lib/swap/` except the pieces that test wallet display code
(`swapPriceRateLabel` / `mergeAssetSwapActivity` cases in `restore.test.ts` / `store.test.ts`)
— keep those in the wallet next to `swapDisplay.ts`.

---

## TODO — ready-to-paste prompt for the next PR

> In `arkade-os/wallet`, migrate the app to `@arkade-os/swap` (see
> `packages/swap/MIGRATION.md` in arkade-os/ts-sdk, branch
> `claude/arkade-intents-swap-extraction-nb5420`). Smallest possible PR: add the dependency,
> delete `src/lib/swap/`, swap imports, rename `bancoPrograms` → `swapPrograms`, construct one
> `IndexedDbAssetSwapRepository` and await the now-async store/scan calls, add the ~15-line
> one-time localStorage→repository data migration next to the existing Boltz
> `migrateToSwapRepository` call in `providers/wallet.tsx`, pass that same repository plus
> `{ registryUrl, localCards, logger }` through the `discoverMarkets`
> call in `providers/assetSwaps.tsx`, keep `preFeeDisplayRate` and the quote-snapshot typing
> wallet-side as described in the note, and move the display-only tests next to
> `swapDisplay.ts`. Acceptance: wallet tests pass unchanged (especially the swap screen
> flat-feedCalls test), a wallet with pre-existing localStorage swaps still lists them after
> upgrade, and `grep -rn "lib/swap" src/` returns nothing. Keep /ponytail discipline: no new
> abstractions, no behavior changes beyond the storage move.
