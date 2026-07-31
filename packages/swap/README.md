# @arkade-os/swap

Maker-side [Arkade Intents](https://arkade.money) atomic swaps: discover markets, quote and
validate, create offers, track them, cancel them, and rebuild the whole record set from chain after
a wallet restore. Pure TypeScript over `@arkade-os/sdk` — no framework, no DOM, no Node-specific
APIs; usable from Node, the browser, or React Native.

## The four layers

1. **`offer`** — the swap covenant itself. Two program JSONs (want-BTC / want-asset), the
   `Offer` type, the TLV wire codec (`encodeOffer`/`decodeOffer`, `OFFER_PACKET_TYPE`), address
   derivation (`offerVtxoScript`), and the maker operations `createOffer`/`cancelOffer`. Identical
   offers always derive identical swap addresses — the program JSONs are hashed into the address,
   so their bytes are frozen (guarded by a golden test).
2. **`markets`** — solver discovery and pricing guardrails: `discoverMarkets` (1-hour cached
   registry fetch with stale-cache fallback), `findMarket`, `validatePlan` (balance, both-side
   limits, BTC-leg dust), `QUOTE_OPTIONS`, and `makeCachedFeedFetch` for rate-limited price feeds.
3. **`store`** — the persisted `AssetSwap` records (`getAssetSwaps`/`addAssetSwap`/
   `updateAssetSwap`). Persistence failures never throw: by the time a swap is stored its funding
   tx is broadcast, and everything stays recoverable from chain.
4. **`restore`** — `restoreAssetSwaps` rebuilds lost records by scanning sent virtual txs for
   offer packets and binding each funding vtxo to its spend. Incremental: answered txids are
   remembered (`getScannedTxids`/`markTxidsScanned`) so nothing is fetched twice.

All persistence goes through the tiny injected `SwapStorage` interface
(`{ get(key): string | null; set(key, value): void }`) — back it with `localStorage`, MMKV, or a
`Map`.

## Creating an offer

Fund the returned address with the side you deposit, embedding the payload, and the solver does
the rest:

```ts
// BTC -> asset
const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, wantAsset });
await wallet.send({
    address: o.address,
    amount: 1000,
    extensions: [{ type: OFFER_PACKET_TYPE, payload: o.payload }],
});

// asset -> BTC (the sats are the VTXO carrier for the asset)
const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, offerAsset });
await wallet.send({
    address: o.address,
    amount: 500,
    assets: [{ assetId, amount: 1000n }],
    extensions: [{ type: OFFER_PACKET_TYPE, payload: o.payload }],
});
```

`cancelOffer(wallet, ARK, offerHex, fundingTxid?, swapAddress?)` spends the deposit back to the
maker.
