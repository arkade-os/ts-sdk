# Migration notes for `@arkade-os/swap`

Two migrations live here. **Upgrading past `0.0.9`** is what every consumer of the package needs;
the **wallet extraction** below it is history for anyone but `arkade-os/wallet`.

## Upgrading past `0.0.9` — the operator and contract rename

`ark`/`server` as names for the operator-run server became `operator`; `vtxoScript`/`treeParams`
as names for a covenant became `contract`/`contractParams`; and `arkTxid` became `txid` on every
field this package owns. **Identifiers only.** No covenant construction, signing path, refund
locktime or forfeit logic changed, and every address a previous version derived is byte-identical
under the new names — the golden `ArkAddress` test pins that.

### Renamed exports

| `0.0.9`                     | now                              |
| --------------------------- | -------------------------------- |
| `offerVtxoScript`           | `offerContract`                  |
| `lightningSendVtxoScript`   | `lightningSendContract`          |
| `receiveVtxoScript`         | `lightningReceiveContract`       |
| `LightningSendTreeParams`   | `LightningSendContractParams`    |
| `LightningReceiveTreeParams`| `LightningReceiveContractParams` |

### Removed exports — `ClaimArkProvider`, `RefundArkProvider`

Gone rather than renamed, and no alias replaces them. Both were
`Pick<RestArkProvider, "getInfo" | "submitTx" | "finalizeTx">`; `pushClaim`, `claimReceiveLockup`,
`pushRefundWithoutReceiver` and `ArkadeRefunderDeps.operator` now take the SDK's full
`ArkProvider`. A `RestArkProvider` satisfies that unchanged — only a hand-built three-method fake
has to grow, and widening the parameter is the point of the change.

### Renamed properties

| where                                                                | `0.0.9`                      | now                            |
| -------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| `pushClaim` / `claimReceiveLockup` / `pushRefundWithoutReceiver` input | `script`                     | `contract`                     |
| …and their results                                                    | `{ arkTxid }`                | `{ txid }`                     |
| `ArkadeRefundResult`                                                  | `arkTxid`                    | `txid`                         |
| `RfqSwapManagerCallbacks.claimLockup` result                          | `arkTxid`                    | `txid`                         |
| `RefundOutcome` (`refunded` variant)                                  | `arkTxid`                    | `txid`                         |
| `LockupSpend`                                                         | `arkTxid`                    | `txid`                         |
| `requestLightningSend` / `requestLightningReceive` / `deriveLightningReceive` results | `treeParams` | `contractParams`               |
| `WatchOfferSwapsParams`                                              | `arkServerUrl`               | `operatorUrl`                  |
| `restoreAssetSwaps` options                                          | `serverPubkey`               | `operatorPubkey`               |
| `offerContract` / `cancelOffer`                                      | `serverPubkey`               | `operatorPubkey`               |

Deliberately **unchanged**, because the SDK owns them and this package only passes them through:
`ArkAddress.serverPubKey`, `client.serverKey`, `verifyServerSignatures.serverPubkey`,
`ReadonlyWallet.create({ arkServerUrl })`, `vtxo.arkTxId` / `tx.key.arkTxid`, and the `server`
slot in the swap program JSON — that one sits inside the hashed program bytes and renaming it
would change every derived address.

### Stored records migrate themselves

`RfqSwapRecord.fundingArkTxid` / `refundArkTxid` / `lockupSpendArkTxids`, and the receive
corridor's `profile.claimArkTxid`, were renamed with the rest. Backends store the record whole,
so a store written under the old names still holds them on disk. That is `0.0.8` and `0.0.9`
only — RFQ record persistence landed in `0.0.8` (`rfqRecord.ts` and the repository's
`saveRfqSwap`), and all four names arrived with it, so nothing earlier wrote a record at all.

**No consumer action is required.** `rebuildRfqSwap`, `rfqSwapOriginOf`, `updateRfqSwapRecord` and
`rfqSwapActivityInputs` all read through `normalizeRfqSwapRecord`, which is exported for a
consumer that reads records by hand. The first write after the upgrade persists the new names and
drops the old ones, so the compatibility read costs one pass and nothing after it.

### `arkade-os/wallet` call sites

The wallet pins `0.0.7`, so nothing breaks until it upgrades. Six edits when it does:

- `src/lib/lnReceive.ts` — `claimLnReceive`'s `args.ark` widens from
  `Pick<RestArkProvider, 'getInfo' | 'submitTx' | 'finalizeTx'>` to `ArkProvider`.
- `src/lib/lnReceive.ts` — its declared return becomes `Promise<{ txid: string; amount: number }>`.
- `src/lib/lnReceive.ts` — `pushClaim(args.ark, { script: request.script, … })` becomes
  `{ contract: request.script, … }`.
- `src/lib/lnReceive.ts` — `LnReceiveRequest.script` is typed
  `Parameters<typeof pushClaim>[1]['script']`, which stops resolving once that key is
  `contract`; the indexed access becomes `[1]['contract']`. The wallet's own field name can
  stay `script` — only the lookup follows the rename.
- `src/providers/assetSwaps.tsx` — `restoreAssetSwaps(…, { serverPubkey })` becomes
  `{ operatorPubkey }`.
- `src/providers/assetSwaps.tsx` — `watchOfferSwaps({ arkServerUrl })` becomes `{ operatorUrl }`.

`requestLightningReceive` takes its URL positionally, so `lnReceive.ts`'s own `arkServerUrl`
argument name is a wallet-local choice and needs no change.

## Migrating `arkade-os/wallet` to `@arkade-os/swap`

Wallet-side changes to consume this package (extracted from wallet commit `60b0834`,
`src/lib/swap/`). Everything below is mechanical unless marked.

### 1. Dependency and imports

Add `"@arkade-os/swap"` to the wallet's dependencies and delete `src/lib/swap/` plus the two
`banco-*.program.json` files. Swap every `from '../lib/swap/…'` import for
`from '@arkade-os/swap'`.

### 2. Symbol renames

| wallet                           | package                           |
| -------------------------------- | --------------------------------- |
| `bancoPrograms`                  | `swapPrograms`                    |
| `bancoProgramBinding` (internal) | not exported (unchanged behavior) |
| `banco-want-btc.program.json`    | `swap-want-btc.program.json`      |
| `banco-want-asset.program.json`  | `swap-want-asset.program.json`    |

The program JSON **contents** are byte-identical (verified by sha256 and the address golden
test), so all previously derived swap addresses remain valid. Note their internal `"name"`
fields still read `banco-*` — they are inside the hashed program bytes and cannot be renamed.

### 3. Swap records: `IndexedDbAssetSwapRepository`

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
  `assetSwapsScanned` and write them into the repository with `saveSwap`/`markTxidsScanned`.
  ~15 lines next to the existing Boltz migration call in `providers/wallet.tsx`. Order matters,
  because the package's persistence deliberately never throws:
    - `await` the migration before the first repository read, or the UI renders an empty list
      and the restore scan re-fetches history it already had.
    - Delete the legacy keys **only after reading back what you wrote** — `saveSwap` swallows
      backend failures, so a successful-looking write is not proof the data landed. If any
      record or txid is missing, leave both keys in place and let the next boot retry.
    - Both writes are keyed upserts (`saveSwap` by id, `markTxidsScanned` into a set), so a
      retried migration is idempotent — it can neither duplicate nor lose records.
- Ordering note: newest-first is by `createdAt` alone; equal-timestamp insertion order is no
  longer guaranteed (records stamp `Date.now()` ms, so this never bites in practice).

### 3b. Markets discovery

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
- The emulator co-signer key positional is gone from every covenant-building entrypoint:
  `createOffer(wallet, arkUrl, emulatorPubkey, params)` → `createOffer(wallet, arkUrl, params)`,
  and `request*(wallet, arkUrl, emulatorPubkey, transport, params)` →
  `request*(wallet, arkUrl, transport, params)`. The SDK resolves the key from its per-network
  pin; `params.emulatorPubkey` overrides it (see the README).
- The Arkade server URL positional is gone from those same five entrypoints:
  `createOffer(wallet, arkUrl, params)` → `createOffer(wallet, params)`, and
  `request*(wallet, arkUrl, transport, params)` → `request*(wallet, transport, params)` for
  `requestLightningSend`, `requestLightningReceive`, `requestOnchainSend` and
  `requestOnchainReceive`. Each reads the server's info from the wallet itself — the new
  `wallet.getArkadeInfo()` on `IReadonlyWallet` — instead of building a `RestArkProvider` from a
  URL, so a caller holding a wallet holds everything these need and pays no second `/v1/info`
  round-trip.
- The URL is gone from the last two as well: `cancelOffer(wallet, arkUrl, offerHex, opts)` →
  `cancelOffer(wallet, offerHex, opts)`, and `watchOfferSwaps({ wallet, arkServerUrl, repository })`
  → `watchOfferSwaps({ wallet, repository })`. These two need more than server info — cancel
  broadcasts and falls back to the indexer for a deposit made before contract registration
  existed, and the watcher reads spending transactions — so they take it from two new seams on
  the wallet: `getArkadeReader()` on `IReadonlyWallet` for chain reads, and
  `getArkadeBroadcaster()` on `IWallet` for `submitTx`/`finalizeTx`. No *offer* entrypoint
  takes a server URL now; `restoreAssetSwaps`, `arkadeRefunder` and `claim`/`refund` still
  take provider instances. An `ArkadeReader` satisfies their *indexer* parameter
  structurally; their ark-provider parameter wants `getInfo` plus the broadcast pair,
  buildable as `{ getInfo: () => wallet.getArkadeInfo(), ...(await
  wallet.getArkadeBroadcaster()) }`. Converting their callers is follow-up work.
- `createOffer` no longer returns `payload`; it returns the send-ready `extension` instead. In
  `providers/assetSwaps.tsx`: `extensions: [{ type: OFFER_PACKET_TYPE, payload: offer.payload }]`
  → `extensions: [offer.extension]` (the `OFFER_PACKET_TYPE` import can go).
- The `Network` type on these call sites is now `@arkade-os/solver-discovery`'s `Network`, not
  `@arkade-os/boltz-swap`'s — for the wallet's current networks they are the same strings.

### 3c. RFQ swaps: persist what the manager is driving

New, and not a move: RFQ swaps started by the released wallet were **never persisted anywhere**, so
a restart lost them. `AssetSwapRepository` gains three methods for them (`version` is `3`;
`DB_VERSION` is `2`, the database's first version increase — the `rfqSwaps` store is added and the
three existing stores are untouched), and the wallet writes the records.

- **On every manager pass that changed state**, `await repository.saveRfqSwap(record)` — build the
  first with `createRfqSwapRecord(origin, swap)` and every later one with
  `updateRfqSwapRecord(record, swap)`.
- **At boot**, `getAllRfqSwaps()`, then per record `lockupContractParams(contractManager,
  record.lockupAddress)` and `rebuildRfqSwap(record, params)`, and hand the results to
  `RfqSwapManager.start`.
- **Prune** with `shouldRetainRfqSwap(record, now)` → `removeRfqSwap(record.rfqId)`. `now` is unix
  **seconds** (`Math.floor(Date.now() / 1000)`); milliseconds against a seconds window retires every
  terminal record after ~43 minutes.

#### How to fill `profile`, per corridor

The record's corridor half is one opaque `Record<string, unknown>` that nothing in the package, the
repository or the store interprets — so the wallet is the only thing that can get it right, and
nothing will tell it when it does not.

- **All three corridors, first:** `...rfqSecretsProfile(result.secrets, result.contractParams.paymentHash)`.
  One call per leg, writing two keys and only what that leg's provisioning actually produced:
  `signer.signingDescriptor` always, `hashlock.paymentHash` whenever a payment hash is passed, and —
  on a **claim** leg only — at most one of `preimageHex` (P itself, when the wallet cannot re-derive
  it) or `preimageSaltHex` (the public input a static wallet's derivation needs). **Never hand-map
  these fields.** A caller that copies `signingDescriptor` and `preimageHex` across by hand drops the
  salt on a static wallet, and the swap is unclaimable with nothing to say so until claim time.
- **Reading it back is two different questions, and the corridor decides which.** For the signer —
  every leg here, since every leg is one this wallet signs — `senderIdentityForSwapRecord(wallet,
  rfqSignerOf(record))`. For the preimage, only on a claim leg (`lightning_receive`, `onchain_send`)
  — `rfqClaimSecretOf(record)` yields the projection and `preimageForSwapRecord(wallet, …)` yields P,
  hash-checked. **Both readers validate**: they answer `undefined` only when the corridor has no such
  half, and throw on a stored half that is present and unusable — so "this leg never had a preimage"
  and "this record lost its payment hash" stay distinguishable, and the second never reaches
  `preimageForSwapRecord`, which skips its hash check on a falsy `paymentHash`. On `lightning_send`
  the claim reader answers `undefined`: **that leg has no local preimage** (P belongs to the payee)
  and its descriptor is a *refund* key. Wiring the claim helper to all three legs does not degrade
  gracefully — the salted arm derives *some* P off the refund descriptor and the payment-hash check
  rejects it, so the wallet reads a correct record as corrupt.
- `lightning_send` — nothing beyond `signer` and `hashlock`, and no preimage inside either. The
  covenant describes the rest of the leg.
- `lightning_receive` — `{ expectedAmount, payoutAddress }` off the request result.
  `expectedAmount` is the quote's `to_amount` captured at **request** time and is the value gate;
  `payoutAddress` is persistence-only (the rebuild never returns it), so it is there for the
  wallet's own display and correlation.
- `onchain_send` — build the L1 half with `onchainSendProfile(result)`, exported for this purpose.
  Copying its fields by hand is how that half is lost: `htlcParams.refundLocktime` has to be written
  as `htlcLocktime` because the record's `refundLocktime` is the arkade lockup's, a different
  deadline; the keys go bytes → hex; and `htlcAddress` is a *derived* value the rebuild checks the
  inputs against, so it is the easiest to skip and impossible to reconstruct later. Without this
  profile a restored swap watches nothing and its L1 refund window passes unwatched.

#### Not every corridor has a hashlock

The three corridors shipping today all lock to a preimage, so all three carry `profile.hashlock` —
but that is a fact about them, not about RFQ. A corridor that settles without a hashlock
(banco-style) has **no payment hash and no preimage material at all**, and its profile simply omits
the key; there is no placeholder to fill, and a fabricated `paymentHash` would be a value nothing can
check. It still writes `profile.signer` — signing a leg is not a hashlock question — which is exactly
why `rfqSecretsProfile` takes the payment hash as an *optional* second argument. Worth knowing now,
so the wallet does not grow a "every swap has a paymentHash" assumption of its own.

#### A partial profile throws — at boot AND at read

Deliberate, and it decides how the wallet handles both a failed restore and a failed claim-secret
read. `rebuildRfqSwap` refuses a hashlock profile with no usable `paymentHash`, a missing
`expectedAmount`, missing L1 keys, an unusable `minConfirmations`, and inputs that do not reproduce
`htlcAddress`. Each of those is a swap that will not restore **at all** rather than one that restores
half-armed, since every one of them is a gate whose absence reads as "passed" rather than "failed".
The readers behave the same way: `undefined` means "this corridor has none", a throw means "the half
is there and unusable".

#### No backfill exists

RFQ swaps started by the released wallet were never persisted, so the upgrade recovers none of them;
records begin at swaps started after it. Refunds for in-flight pre-upgrade swaps stay manual. Worth
stating plainly, because "we shipped persistence" reads as "old swaps are safe now".

The interface bump costs the wallet nothing structurally — it constructs `IndexedDbAssetSwapRepository`
rather than implementing `AssetSwapRepository`. One thing is **not** reversible: once a browser's
database is at `DB_VERSION` 2, rolling the app back to `@arkade-os/swap@0.0.5` opens it at version 1
and fails `VersionError` across the whole swap store, not just the RFQ half.

### 4. Not mechanical — cut with ponytail markers

- **`preFeeDisplayRate`** was not ported (display-only). Keep it in the wallet (e.g. move to
  `src/lib/swapDisplay.ts`) together with its two tests from `markets.test.ts`.
- **`AssetSwapQuoteSnapshot` / `AssetSwap.quote`** was not ported. The wallet should keep its own
  record type: `type WalletAssetSwap = AssetSwap & { quote?: AssetSwapQuoteSnapshot }` and cast at
  the store boundary — the repository persists whole records, so extra fields like `quote`
  survive untouched **provided they are JSON-safe**. The SQLite and Realm backends serialize to
  JSON, so a `quotedAt` `Date` comes back an ISO string and a `bigint` amount throws on save; only
  the IndexedDB backend (structured clone) round-trips those. (Or restore the field upstream if a
  second consumer wants it.)
- `restore.ts` no longer documents the wallet's feeBps/fiat backfill behavior; that logic already
  lives in the wallet caller and is unaffected.

### 5. Tests

Delete `src/test/lib/swap/` except the pieces that test wallet display code
(`swapPriceRateLabel` / `mergeAssetSwapActivity` cases in `restore.test.ts` / `store.test.ts`)
— keep those in the wallet next to `swapDisplay.ts`.

---

### TODO — ready-to-paste prompt for the next PR

> In `arkade-os/wallet`, migrate the app to `@arkade-os/swap` (see
> `packages/swap/MIGRATION.md` in arkade-os/ts-sdk, added by
> arkade-os/ts-sdk#679). Smallest possible PR: add the dependency,
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
