# Migration notes for `@arkade-os/swap`

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

`requestLightningReceive` no longer takes a URL at all (the positional was removed), so
`lnReceive.ts`'s wallet-local `arkServerUrl` argument simply disappears with that migration
rather than being renamed.
