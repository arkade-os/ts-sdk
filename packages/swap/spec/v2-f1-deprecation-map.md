# v2 Roadmap — F1 Detail: Deprecation Map

Inventory of every root export of `@arkade-os/swap` (`src/index.ts`, 121 value
exports + ~90 type exports as of `master`), each with its v2 disposition.
M8 executes this table mechanically: P = re-export from `/protocol` for one
major version with `@deprecated` pointers, then remove from root (Q4's window);
I = internalize into the v2 client and stop exporting; D = delete outright;
S = stays on the root as part of the v2 surface.

Names grouped by area; the file-of-origin column is where the symbol lives
today.

---

## Root-stay (S) — the v2 client surface

None of today's exports stay as-is; the root becomes `createSwapClient` plus
its vocabulary types. This table lists only what the v1 export set *becomes*.

| v1 export(s) | v2 root surface |
|---|---|
| (new) | `createSwapClient`, `Quote`, `QuoteInput`, `Swap`, `SwapUpdate`, `Outcome`, `Route`, `AssetId`, `Artifact`, `SwapError` taxonomy, `Amount` |
| `InMemoryAssetSwapRepository`, `AssetSwapRepository` (type) | explicit ephemeral/test-mode repository interface |
| `SwapRefusal`, `AddressMismatch` | error taxonomy members |

## /protocol re-exports (P)

Solvers' and advanced integrators' floor; deprecated pointers, removed from
root per Q4.

| Exports | file |
|---|---|
| `createOffer`, `cancelOffer`, `encodeOffer`, `decodeOffer`, `offerVtxoScript`, `swapPrograms`, `OFFER_PACKET_TYPE`, `Offer` (type) | offer.ts |
| `discoverMarkets`, `findMarket`, `validatePlan`, `makeCachedFeedFetch`, `QUOTE_OPTIONS` | markets.ts |
| `requestLightningSend/Receive`, `requestOnchainSend/Receive`, `lightningSendRequest`, `lightningReceiveRequest`, `onchainSendRequest`, `onchainReceiveRequest`, `arkadeSwapRequest`, `rfqPair`, `newRfqId`, `httpTransport`, `relayTransport`, `RfqTransport` (type), `RfqQuote` (type), `RfqRefusalReason`, `RfqStatus` | rfq.ts |
| `lightningSendVtxoScript`, `receiveVtxoScript`, `offerTermsFromQuote`, `verifyLockupAddress`, `verifyReceiveInvoice`, `assertFundable`, `assertReceivable`, `arkadeAssetLeg`, `ARKADE_ASSET`(/`arkadeAssetLeg`), `ARKADE_BTC`, `LIGHTNING_BTC`, `ONCHAIN_BTC`, `LIGHTNING_SEND_PAIR`, `LIGHTNING_RECEIVE_PAIR`, `ONCHAIN_SEND_PAIR`, `ONCHAIN_RECEIVE_PAIR`, `BTC_ASSET_ID`, `AddressMismatch`, `SwapRefusal`, `InvoiceFacts` (type) | rfq.ts + store.ts |
| envelope/covenant helpers: `unilateralClaimDelay`, `unilateralRefundDelay`, `unilateralRefundWithoutReceiverDelay`, `MIN_HEADROOM_SECONDS`, `MIN_CLAIM_WINDOW_SECONDS`, `SOLO_REFUND_HEADROOM_SECONDS`, `LOCKTIME_THRESHOLD`, `RFQ_TERMINAL_STATES`, `RFQ_RESOLVED_STATES` | rfq.ts / refund.ts |
| onchain-HTLC toolkit: `onchainHtlcScript`, `buildHtlcClaim`, `buildHtlcRefund`, `extractPreimage`, `paymentHashOf`, `awaitOnchainFill`, `claimOnchainFill`, `classifyOnchainHtlc`, `newPreimage`, `ONCHAIN_DUST_SATS`, `ONCHAIN_SECONDS_PER_BLOCK`, `MAX_MIN_CONFIRMATIONS`, `ONCHAIN_CLAIM_MARGIN_SECONDS`, `ONCHAIN_ORDER_MARGIN_SECONDS`, `deriveOnchainSend`, `deriveLightningReceive`, `deriveOnchainReceive` | onchainHtlc.ts / rfq.ts |
| claim/refund plumbing: `awaitLockupFunding`, `pushClaim`, `claimReceiveLockup`, `LockupAmountMismatchError`, `refundIfUnresolved`, `readLockupFate`, `findLockupVtxos`, `pushRefundWithoutReceiver`, `isRfqTerminal`, `REFUND_MTP_LAG_SECONDS`, `RefundNotLocallyPossibleError`, `LockupNeedsRecoveryError`, `senderIdentityForSwapRecord` | claim.ts / refund.ts / refundBlocked.ts |
| `sealClaimPacket` (ClaimPacketInput/SealedClaimPacket types) | claimPacket.ts |
| manager + records: `RfqSwapManager`, `RfqSwapOriginRequired`, `isRfqSwapTerminal`, `nextOnchainAction`, `createRfqSwapRecord`, `rebuildRfqSwap`, `rfqSwapOriginOf`, `shouldRetainRfqSwap`, `updateRfqSwapRecord`, `RFQ_SWAP_RETENTION_SECONDS`, `RFQ_SWAP_TERMINAL_STATES`, `swapSecretsToRecord`, `preimageForSwapRecord`, `PreimageNotRecoverableError`, `rfqSecretsProfile`, `rfqSignerOf`, `rfqClaimSecretOf`, `onchainSendProfile` | swapManager.ts / rfqRecord.ts / rfqProfileParts.ts / rfqCorridors.ts / store.ts |
| offer store/watch/restore: `getAssetSwaps`, `getAssetSwapsOrThrow`, `addAssetSwap`, `updateAssetSwap`, `updateAssetSwapBestEffort`, `watchOfferSwaps`, `spendUpdate`, `restoreAssetSwaps`, `classifySpend`, `classifyDepositSpend`, `spendTxidsOf`, `retireSettledOfferContracts`, `arkadeRefunder` | store.ts / watch.ts / restore.ts / coverage.ts / arkadeRefunder.ts |
| lockup contract rows: `registerLockupContract`, `lockupContractParams`, `LockupContractMissing`, `LockupRegistrationFailed`, `SWAP_LOCKUP_CONTRACT_KIND/LABEL/TYPE` | lockupContract.ts |
| activity resolvers: `swapActivityResolver`, `rfqSwapActivityInputs` | activity.ts |
| repository family: `IndexedDbAssetSwapRepository`, `InMemoryAssetSwapRepository` | indexedDbRepository.ts / repository.ts |

All type-only exports with the same names follow their value. Disposition
changes for specific entries are recorded in the decisions column of §8 in
`v2-api-spec.md`.

## Internalized (I) — fold into the client, stop exporting

| Exports | Why |
|---|---|
| `createRfqSwapRecord`, `updateRfqSwapRecord`, `shouldRetainRfqSwap`, `swapSecretsToRecord`, `preimageForSwapRecord` | persist-first is the client's invariant, not the caller's plumbing |
| `rfqSecretsProfile`, `rfqSignerOf`, `rfqClaimSecretOf`, `onchainSendProfile` | profile wrangling is internal corridor code |
| `senderIdentityForSwapRecord` | key-provisioning policy lives in the wallet |
| `getAssetSwaps*`, `addAssetSwap`, `updateAssetSwap*` | client is the sole repository writer (contracts-subsystem ownership) |
| `watchOfferSwaps`, `spendUpdate`, `nextOnchainAction` | drive-layer internal |
| `retireSettledOfferContracts`, `arkadeRefunder` | manager-owned coverage |
| `restoreAssetSwaps`, `classifySpend`, `classifyDepositSpend`, `spendTxidsOf` | restore/spend classification behind `client.restore` |
| `registerLockupContract`, `lockupContractParams`, `SWAP_LOCKUP_CONTRACT_*`, `LockupContractMissing`, `LockupRegistrationFailed` | the client owns lockup registration |
| `arkadeAssetLeg`, `rfqPair`, `offerTermsFromQuote` | request/pair building behind `quote()` |
| `unilateral*Delay`, `*MARGIN/HEADROOM/WINDOW_SECONDS`, `*TERMINAL/RESOLVED_STATES`, `LOCKTIME_THRESHOLD` | constants the expert floor still reaches via `/protocol` if it must — but v2 should internalize first; P only if the deprecation inventory shows external use |

Notes: entries marked "P only if external use" start as I and are promoted to
P during M8 only when the sweep (grep the monorepo + known consumers) shows a
consumer. This is the escape valve that keeps I from breaking solvers.

## Deleted (D)

| Exports | Why |
|---|---|
| `SwapQuoteInput` kinds, `resolveKind` (only in open PR #793) | replaced by `QuoteInput` + closed `Route` union; land nowhere outside that PR |
| `family` on updates | replaced by `Outcome` + `detail` |
| `amountSide: "to"` | replaced by `amountOn: "take"` |
| `ARKADE_ASSET` (deprecated alias of `arkadeAssetLeg`) | the alias goes; the underlying helper moves to `/protocol` |
| top-level `nostrRfqTransport` (also reachable via `./nostr` subpath) | `/protocol` carries it if promoted, otherwise `./nostr` subpath remains the transport floor |

## Type exports

~90 type exports shadow their value group's disposition. Notables:
- P: `DiscoveredMarket`, `DiscoverMarketsOptions`, `PlanError`, `AssetSwap`,
  `AssetSwapStatus`, `SwapSecretsProjection`, `Offer`, `RfqSwap*` (12 types),
  `RfqSwapManager*` (8 types), `RfqRecord`, `PersistableRfqSwap`, `RfqSwapOrigin`,
  `Lockup*` (8 types), `ChainSource`, `ChainUtxo`, `HtlcUtxo`, `OnchainHtlc*`,
  `AvailableRfqSwapManagerCallbacks`, `SpendKind`, `Tx`, `RestoreIndexer`,
  `OfferSwapWatcher`, `WatchOfferSwapsParams`, `ClaimArkProvider`,
  `RefundArkProvider`, `RefundIndexer`, `LockupSpendIndexer`,
  `RefundOutcome`, `RefundBlockedReason`, `PreimageBlockedReason`, `RelaySocket`,
  `LightningSend/ReceiveTreeParams`, `LightningSend/ReceiveProfile`,
  `OnchainSendProfile`, `RfqClaimSecretProjection`, `RfqHashlockProjection`,
  `RfqSignerProjection`, `SwapContractRegistry`, `MarketsCacheEntry`,
  `SwapActivityInput`, `RfqSwapActivityDeps`, `ArkadeRefunderDeps`,
  `OfferContractRetirer`, `LockupContractReader/Writer`,
  `ClaimPacketInput`, `SealedClaimPacket`.
- I: `AssetSwapRepository` shape (superseded by the v2 repository interface),
  `RfqSwapRecordStore`, `RfqRestore*`, `PreimageBlockedReason` (absorbed into
  error taxonomy).
- D: `SwapQuoteInput` kinds as named above.

---

## M8 execution checklist (mechanical once M1–M7 land)

1. Sweep the monorepo + known consumers for imports of each I-candidate;
   promote to P where usage exists (`rg "from \"@arkade-os/swap\""`).
2. Create `src/protocol.ts` re-exporting every P entry with `@deprecated`
   JSDoc pointing at the v2 replacement (or "internal; no replacement").
3. Add the `./protocol` subpath to `package.json` exports (mirrors the
   existing `./nostr` and `./repositories/*` subpaths — same tsup entry).
4. Root `src/index.ts` shrinks to S entries + P re-exports marked deprecated.
5. `MIGRATION.md` gains the import-change table; README integration section
   shrinks to the RFC-lite four lines.
6. Removal pass one major version later (Q4 window): delete P re-exports from
   root; `/protocol` stays.

Open sub-decision for M8, recorded here: whether `/protocol` is a barrel of
the same files with no duplication (preferred) or carve-outs per area. Default
to the barrel; split only if tree-shaking complaints show up.
