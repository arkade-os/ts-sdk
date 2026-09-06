# Migration notes for `@arkade-os/swap`

Newest first. Each section is one upgrade; nothing below `0.1.0` auto-upgrades into anything above
it under npm's `0.0.x` rules, so a consumer arriving from an old pin meets several of these in one
jump and should read down until the version it left.

## `0.1.0-rc.1` → `0.1.0` — the v2 client takes the root

The root export is now the v2 client. `createSwapClient`, the three verbs, the closed `Route`
union, the asset-id vocabulary, the amount law and the sixteen-member error taxonomy are all on
`@arkade-os/swap`, and the v1 building blocks moved to `@arkade-os/swap/protocol` under
`@deprecated` pointers.

### The root `createSwapClient` is a different function

`0.1.0-rc.1` published a v1 facade under that name (ts-sdk #793). The v2 client took it. This is
the one break in this release that a compiler cannot always catch for you, so it is first.

| `0.1.0-rc.1`                                   | `0.1.0`                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `createSwapClient(deps: SwapClientDeps)`        | `createSwapClient(config: SwapClientConfig)`                   |
| `client.quote(market, input)`                   | `client.quote(input)` — the market is resolved for you         |
| `SwapQuoteInput.give: "base" \| "quote"`        | `QuoteInput.give?: AssetId` — a CAIP-19 id, not a leg word     |
| `client.cancel(fundingTxid: string)`            | `client.cancel(swapId: AssetSwapId)`                           |
| `client.onUpdate((swap: UnifiedSwap) => …)`     | `client.onUpdate(({ swap, outcome, detail }) => …)`            |
| `client.manager: RfqSwapManager`                | gone — the drive is internal, and `client.swaps()` is the read |

`quote(market, input)` → `quote(input)` is an arity change and fails loudly. `give: "base"` is the
quiet one: `AssetId` is a string alias rather than a branded type, so `give: "base"` still
compiles and now means an asset id spelled `base`, which `quote()` refuses at runtime with
`UnsupportedRoute`. Grep for `give: "base"` and `give: "quote"` before upgrading.

If you were on `@arkade-os/swap/client`, that subpath is gone and the fix is one line: import from
`@arkade-os/swap` instead. It existed for one release, to publish the v2 client while the root
name was still occupied.

### Everything below the client: `@arkade-os/swap/protocol`

200 v1 names moved off the root to a subpath, in this release. Each is one specifier edit:

```ts
import { requestLightningSend, RfqSwapManager } from "@arkade-os/swap";           // 0.1.0-rc.1
import { requestLightningSend, RfqSwapManager } from "@arkade-os/swap/protocol";  // 0.1.0
```

There is deliberately no window in which both spellings work. `0.1.0` breaks against
`0.1.0-rc.1` regardless — the client took the `createSwapClient` name and `./client` is gone — so
a period of root re-exports would not have spared anyone a migration, only split it into two,
while leaving 200 v1 names on a root whose whole claim is to be the v2 surface. One break, one
migration, and your compiler finds every site.

The subpath is a floor, not a staging area. Nothing on it is scheduled to be removed: if you are
building requests, deriving covenants or driving records by hand, `@arkade-os/swap/protocol` is
where that lives now and is expected to keep living. The `@deprecated` tags mean "the client does
this for you now", not "this goes away next release".

| Area                                            | Names                                                             | What replaces them                              |
| ----------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| RFQ requests, pairs, covenants, verification     | `requestLightning*`, `requestOnchain*`, `derive*`, `verify*`, the `*_PAIR` and `*_BTC` constants | `client.quote()` and `client.accept()`          |
| Offers                                           | `createOffer`, `cancelOffer`, `offerContract`, `encodeOffer`, `decodeOffer`, `swapPrograms` | `client.accept()`; `client.cancel()` for cancel |
| The RFQ manager and its record types             | `RfqSwapManager`, `RfqSwap*`, `nextOnchainAction`                  | `createSwapClient`, `client.onUpdate()`         |
| Records and the asset-swap store                 | `AssetSwap`, `addAssetSwap`, `getAssetSwaps`, `updateAssetSwap`, `createRfqSwapRecord`, `rebuildRfqSwap` | `accept()` writes; `client.swaps()` reads       |
| Watching, restoring, refunding, claiming         | `watchOfferSwaps`, `restoreAssetSwaps`, `refundIfUnresolved`, `arkadeRefunder`, `pushClaim`, `awaitLockupFunding` | the drive; `await client.ready`, `client.recover()` |
| Markets and pricing                              | `discoverMarkets`, `findMarket`, `validatePlan`, `QUOTE_OPTIONS`, `makeCachedFeedFetch` | `client.markets()`; pricing is inside `quote()` |
| The onchain HTLC and its chain source            | `onchainHtlcScript`, `buildHtlcClaim`, `buildHtlcRefund`, `classifyOnchainHtlc`, `chainSourceFrom` | internal to the onchain corridor                |
| Lockup contracts and secrets profiles            | `lockupContractParams`, `registerLockupContract`, `rfqSecretsProfile`, `rfqClaimSecretOf`, `rfqSignerOf` | internal to `accept()` and the corridor modules |
| The v1 payment rails                             | `solverLightningRail`, `solverOnchainRail`, `crossAssetRail`, `solverRendezvous` | `lightningRail`, `onchainSwapRail`, `createSwapPaymentRouter` |
| The dev transports and their types               | `httpTransport`, `relayTransport`, `RfqTransport`, `RelaySocket`, `InvoiceFacts` | `client.quote()` opens the rendezvous; `@arkade-os/swap/nostr` to hand-build one |

`scripts/dispositions.json` in this package is the complete, machine-checked list — every name,
with its disposition — and `test/exports.test.ts` diffs it against the barrels on every run. It is
the list to grep, rather than this table, when you want to know about a specific symbol. Each
deprecated declaration also carries an `@deprecated` tag naming its replacement, so your editor
will tell you in place.

### Removed with no `/protocol` floor

Two small sets. Both are deliberate: a floor under them would keep alive the exact thing v2
exists to end.

The `0.1.0-rc.1` facade's vocabulary, replaced by the closed route union:

| Gone                                                                    | Use                                        |
| ----------------------------------------------------------------------- | ------------------------------------------ |
| `SwapQuoteInput`                                                         | `QuoteInput` plus the closed `Route` union |
| `UnifiedSwap` (and its `family` field on updates)                        | `Swap`, and `Outcome` on updates           |
| `SwapClientDeps`                                                         | `SwapClientConfig`                         |
| `SwapQuote`, `SpotQuote`, `LightningSendQuote`, `LightningReceiveQuote`, `OnchainSendQuote` | `Quote`                                    |
| `ARKADE_ASSET`                                                           | nothing — no solver served the coarse leg  |

`ARKADE_ASSET` was already deprecated in favour of `arkadeAssetLeg` before this release, and
giving a deprecated alias a `/protocol` floor would deprecate a deprecation. It was the coarse RFQ
pair leg `arkade:ASSET`, which no solver serves; if you were building a leg by hand,
`arkadeAssetLeg` is on `/protocol`, and the v2 answer is to name the asset — `arkadeAsset(network,
id)` — and let `client.quote()` build the pair.

And seventeen internals the client absorbed, none of which had a consumer in the sweep taken at
this release: `assertFundable`, `assertReceivable`, `offerTermsFromQuote`, `newRfqId`, `rfqPair`,
`MIN_CLAIM_WINDOW_SECONDS`, `MIN_HEADROOM_SECONDS`, `SOLO_REFUND_HEADROOM_SECONDS`,
`REFUND_MTP_LAG_SECONDS`, `RFQ_TERMINAL_STATES`, `RFQ_RESOLVED_STATES`,
`RFQ_SWAP_TERMINAL_STATES`, `retireSettledOfferContracts`, `OfferContractRetirer`, `spendUpdate`,
`getAssetSwapsOrThrow`, `updateAssetSwapBestEffort`. If you import one of these, say so and it
gets a `/protocol` floor in a patch: internalizing is a finding about who uses what, not a
decision to break you.


## `0.0.9` → `0.1.0` — the operator and contract rename

`ark`/`server` as names for the operator-run server became `operator`; `vtxoScript`/`treeParams`
as names for a covenant became `contract`/`contractParams`; and `arkTxid` became `txid` on every
field this package owns. Identifiers only. No covenant construction, signing path, refund
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

All five are now on `@arkade-os/swap/protocol` rather than the root; see the section above.

### Removed exports — `ClaimArkProvider`, `RefundArkProvider`

Gone rather than renamed. Both were `Pick<RestArkProvider, "getInfo" | "submitTx" |
"finalizeTx">`; `pushClaim`, `claimReceiveLockup`, `pushRefundWithoutReceiver` and
`ArkadeRefunderDeps.operator` now take the SDK's full `ArkProvider`. A `RestArkProvider` satisfies
that unchanged — only a hand-built three-method fake has to grow, and widening the parameter is
the point of the change.

An earlier version of this note said no alias replaces them. One does now: `SwapOperator` is
`Pick<ArkProvider, "getInfo" | "submitTx" | "finalizeTx">` — the same narrow shape, on the full
provider rather than the REST one. It is a root export and the type `SwapClientConfig.operator`
takes, and `walletOperator(wallet)` builds one from a wallet without opening a second connection.

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

Deliberately unchanged, because the SDK owns them and this package only passes them through:
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

No consumer action is required. `rebuildRfqSwap`, `rfqSwapOriginOf`, `updateRfqSwapRecord` and
`rfqSwapActivityInputs` all read through `normalizeRfqSwapRecord`, which is exported for a
consumer that reads records by hand. The first write after the upgrade persists the new names and
drops the old ones, so the compatibility read costs one pass and nothing after it.

## `0.0.3` → `0.0.4` — key provisioning moved into the SDK

`packages/swap/src/secrets.ts` is gone. `deriveSwapSecrets`, `randomSwapSecrets`,
`preimageForRfqSecrets`, `senderIdentityForRfqSecrets`, `rfqSecretsToRecord`, `rfqSecretsOfRecord`,
`isPerSwapDescriptor`, `RFQ_PREIMAGE_TAG` and `SwapSecrets` no longer exist. Import
`provisionRefundKey`, `provisionClaimSecret`, `contractSigner`, `contractPreimage`,
`isPerArtifactDescriptor` and `ARKADE_SWAP_PREIMAGE_TAG` from `@arkade-os/sdk` instead;
`swapSecretsToRecord` and `senderIdentityForSwapRecord` stay in this package. No consumer branches
on wallet type any more, and no swap record can carry a private key.

`contractPreimage(wallet, descriptor, stored?)` became
`contractPreimage(wallet, descriptor, { stored?, salt? })`. Prefer `preimageForSwapRecord`, which
reads both fields off the record and verifies against `paymentHash`.

Static wallets derive their preimage instead of storing it: new records from such wallets carry
`preimageSaltHex` and no `preimageHex`, and `mustPersistPreimage` is `false` for them. Nothing at
rest is secret unless the signer cannot sign deterministically at all.

`AssetSwap` gained `preimageSaltHex?` and `AssetSwapRepository.version` became `2`. External
repository implementations must recompile — deliberately, because a field-mapped backend that
drops `preimageSaltHex` leaves the swap unclaimable exactly as one dropping `preimageHex` does.
Records written by `0.0.1`–`0.0.3` need no rewrite and no migration: the field is optional, older
rows resolve through their stored `preimageHex` or their HD descriptor, and `DB_VERSION` is
unchanged.

## Appendix — adopting the package from wallet-local swap code

`origin/master` carries a document under this filename covering a different migration: moving
`arkade-os/wallet` off its own `src/lib/swap/` onto this package (ts-sdk #679). That adoption has
happened, and the v2 client supersedes the API it targets, so it is not repeated here in full —
`git show origin/master:packages/swap/MIGRATION.md` has it. Three of its rules outlived it and are
worth keeping in one place:

- A one-time move of records out of `localStorage` must be awaited before the first repository
  read, or the UI renders an empty list and the restore scan re-fetches history it already had.
  Delete the legacy keys only after reading back what you wrote: persistence here deliberately
  never throws, so a successful-looking write is not proof the data landed. Both writes are keyed
  upserts, so a retried migration can neither duplicate nor lose records.
- Extra fields you add to a stored record survive, provided they are JSON-safe. The SQLite and
  Realm backends serialize to JSON, so a `Date` comes back an ISO string and a `bigint` throws on
  save; only IndexedDB's structured clone round-trips those.
- Display-only derivations — rate labels, fiat backfill — were deliberately not ported and belong
  in the consumer, next to the code that renders them.
