# Migrating `arkade-os/wallet` to `@arkade-os/swap`

Wallet-side changes to consume this package (extracted from wallet commit `60b0834`,
`src/lib/swap/`). Everything below is mechanical unless marked.

## 1. Dependency and imports

Add `"@arkade-os/swap"` to the wallet's dependencies and delete `src/lib/swap/` plus the two
`banco-*.program.json` files. Swap every `from '../lib/swap/…'` import for
`from '@arkade-os/swap'`.

## 2. Symbol renames

| wallet | package |
| ------------------------------ | ---------------------------- |
| `bancoPrograms` | `swapPrograms` |
| `bancoProgramBinding` (internal) | not exported (unchanged behavior) |
| `banco-want-btc.program.json` | `swap-want-btc.program.json` |
| `banco-want-asset.program.json` | `swap-want-asset.program.json` |

The program JSON **contents** are byte-identical (verified by sha256 and the address golden
test), so all previously derived swap addresses remain valid. Note their internal `"name"`
fields still read `banco-*` — they are inside the hashed program bytes and cannot be renamed.

## 3. Storage adapter (~10 lines)

The package takes an injected `SwapStorage` instead of touching `localStorage`:

```ts
// src/lib/swapStorage.ts
import type { SwapStorage } from "@arkade-os/swap";

export const swapStorage: SwapStorage = {
    get: (key) => localStorage.getItem(key),
    set: (key, value) => localStorage.setItem(key, value),
};
```

Then thread it through the call sites:

- `getAssetSwaps()` → `getAssetSwaps(swapStorage)`; same for `addAssetSwap(swapStorage, swap)`,
  `updateAssetSwap(swapStorage, id, changes)`, `getScannedTxids(swapStorage)`,
  `markTxidsScanned(swapStorage, txids)`.
- `discoverMarkets(network, useCache)` →
  ```ts
  discoverMarkets({
      network,
      registryUrl: getSolverRegistryUrl(network),
      storage: swapStorage,
      localCards: readSolverCardsFromStorage().filter((c) => c.network === network),
      logger: consoleLog,
      useCache,
  });
  ```
  (The `network`-card filtering and registry-URL lookup stay wallet concerns.)
- `makeCachedFeedFetch()` is unchanged (it now also accepts `(ttlMs, fetchImpl)`).
- The `Network` type on these call sites is now `@arkade-os/solver-discovery`'s `Network`, not
  `@arkade-os/boltz-swap`'s — for the wallet's current networks they are the same strings.

## 4. Not mechanical — cut with ponytail markers

- **`preFeeDisplayRate`** was not ported (display-only). Keep it in the wallet (e.g. move to
  `src/lib/swapDisplay.ts`) together with its two tests from `markets.test.ts`.
- **`AssetSwapQuoteSnapshot` / `AssetSwap.quote`** was not ported. The wallet should keep its own
  record type: `type WalletAssetSwap = AssetSwap & { quote?: AssetSwapQuoteSnapshot }` and cast at
  the store boundary — the store functions JSON-round-trip unknown fields, so persisted `quote`
  data survives untouched. (Or restore the field upstream if a second consumer wants it.)
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
> delete `src/lib/swap/`, swap imports, rename `bancoPrograms` → `swapPrograms`, add the ~10-line
> localStorage `SwapStorage` adapter, thread it plus
> `{ registryUrl, localCards, logger }` through the `discoverMarkets` call in
> `providers/assetSwaps.tsx`, keep `preFeeDisplayRate` and the quote-snapshot typing wallet-side
> as described in the note, and move the display-only tests next to `swapDisplay.ts`. Acceptance:
> wallet tests pass unchanged (especially the swap screen flat-feedCalls test), and
> `grep -rn "lib/swap" src/` returns nothing. Keep /ponytail discipline: no new abstractions, no
> behavior changes.
