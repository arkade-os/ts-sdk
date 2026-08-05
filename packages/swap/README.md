# @arkade-os/swap

Maker-side [Arkade Intents](https://arkade.money) atomic swaps: discover markets, quote and
validate, create offers, track them, cancel them, and rebuild the whole record set from chain after
a wallet restore. Framework-free TypeScript over `@arkade-os/sdk`: the core API and
`InMemoryAssetSwapRepository` use no DOM and no Node-specific APIs, so they run in Node, the
browser, and React Native alike. `IndexedDbAssetSwapRepository` is the one exception — it needs a
platform-provided or polyfilled IndexedDB.

## The five layers

1. **`offer`** — the swap covenant itself. Two program JSONs (want-BTC / want-asset), the
   `Offer` type, the TLV wire codec (`encodeOffer`/`decodeOffer`, `OFFER_PACKET_TYPE`), address
   derivation (`offerVtxoScript`), and the maker operations `createOffer`/`cancelOffer`. Identical
   offers always derive identical swap addresses — the program JSONs are hashed into the address,
   so their bytes are frozen (guarded by a golden test).
2. **`markets`** — solver discovery and pricing guardrails: `discoverMarkets` (1-hour cached
   registry fetch with stale-cache fallback), `findMarket`, `validatePlan` (balance, both-side
   limits, BTC-leg dust), `QUOTE_OPTIONS`, and `makeCachedFeedFetch` for rate-limited price feeds.
3. **`store`** — the persisted `AssetSwap` records (`getAssetSwaps`/`addAssetSwap`/
   `updateAssetSwap`), thin helpers over an `AssetSwapRepository`. Persistence failures never
   throw: by the time a swap is stored its funding tx is broadcast, and everything stays
   recoverable from chain.
4. **`restore`** — `restoreAssetSwaps` rebuilds lost records by scanning sent virtual txs for
   offer packets and binding each funding vtxo to its spend. Incremental: answered txids are
   remembered in the repository (`getScannedTxids`/`markTxidsScanned`) so nothing is fetched
   twice.
5. **`rfq`** — the taker / intent-submitter side of quoted swaps: RFQ negotiation over HTTP or a
   relay, then non-interactive filling (see below). Covers `arkade:BTC|asset -> lightning:BTC`
   (implemented against the reference solver) and `arkade:BTC|asset -> arkade:BTC|asset` (quote,
   then take by funding an offer from layer 1).

Everything the package persists — swap records, the restore-scan cursor, and the markets cache —
goes through a single `AssetSwapRepository`, following the Arkade repository convention
(versioned interface, `AsyncDisposable`, one backend per platform). Two backends ship here:
`InMemoryAssetSwapRepository` and `IndexedDbAssetSwapRepository` (built on the SDK's shared
IndexedDB manager, like the Boltz plugin's repositories). Construct one and pass it wherever the
package asks for a repository; `discoverMarkets` also accepts none, for a one-shot uncached
discovery.

## Creating an offer

Fund the returned address with the side you deposit, embedding the payload, and the solver does
the rest:

```ts
// BTC -> asset
const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, wantAsset });
await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] });

// asset -> BTC (the sats are the VTXO carrier for the asset)
const o = await createOffer(wallet, ARK, EMU, { wantAmount: 1000n, offerAsset });
await wallet.send({
    address: o.address,
    amount: 500,
    assets: [{ assetId, amount: 1000n }],
    extensions: [o.extension],
});
```

### What `createOffer` gives you back

`createOffer` is pure derivation — it broadcasts nothing. The offer only becomes real when the
deposit lands at `address`.

| Field          | What it is                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`      | The swap address to fund with your deposit. Identical offers derive an identical address, so the **funding txid**, not the address, identifies one deposit. |
| `extension`    | Pass straight to `wallet.send`'s `extensions`. It carries the offer inside the funding tx so the solver can discover the offer from the txid alone. |
| `offerHex`     | The encoded offer. **Persist this** — it is the only input `cancelOffer` needs to rebuild the covenant.                                        |
| `swapPkScript` | The covenant's scriptPubKey: the key an indexer watches to spot the deposit and its later spend.                                               |

The minimum a maker must keep to stay in control of a swap is `offerHex` plus the funding txid.
Everything else — status, amounts, timestamps — `restoreAssetSwaps` rebuilds from chain, and the
offer bytes themselves are recoverable from the funding tx if the record is lost.

## Cancelling an offer no taker filled

```ts
const txid = await cancelOffer(wallet, ARK, swap.offerHex, swap.fundingTxid, swap.swapAddress);
```

**An unfilled offer never expires.** Neither program carries a timelock, so a deposit no taker
picked up sits at the swap address indefinitely — nothing reclaims it for the maker, and there is
no "expired" state to wait for. Cancelling is the only way out, and the maker has to ask.

The two ways out of the covenant are deliberately asymmetric:

- **`fulfill`** is signed by the **server alone**, but the covenant constrains it to pay output 0
  to the maker's script for at least `wantAmount`. A taker cannot take the deposit without
  delivering the other side.
- **`cancel`** is a **2-of-2 of the maker and the server**. Cancelling is cooperative, not a
  unilateral withdrawal.

So cancel *races* a fill rather than pre-empting it. If the solver fills in the same moment,
`cancelOffer` throws `no spendable VTXO at the swap address` — that means the swap **completed**,
not that anything went wrong. Re-read the swap's state before treating it as an error;
`restoreAssetSwaps` tells the two spends apart afterwards and marks the record `fulfilled` rather
than `cancelled`.

Pass `fundingTxid` whenever you have it. Identical offers share an address, so without it cancel
spends whichever deposit is first at that address — not necessarily the one you meant. Every
`AssetSwap` carries the txid, so the call above is the shape to prefer. `swapAddress` pins the
server key the covenant was built with, keeping cancel working across a server signer rotation.

## RFQ: quote first, then fill without talking

`rfq` is the trader's side of a quoted swap. The negotiation is the ONLY interactive part —
after the quote, both corridors fill non-interactively, and there is deliberately no accept
message anywhere: **acceptance is funding**.

- **Arkade → Lightning** (`arkade:BTC->lightning:BTC`, implemented): the trader derives the
  lightning-send covenant LOCALLY from the quote's binding fields plus its own data, refuses to
  fund on any address mismatch, funds its own derivation before `valid_until`, and may go
  offline. The solver observes the funding on-chain, pays the invoice, and claims with the
  preimage — which lands publicly in the claim witness as the receipt. A failed swap refunds by
  covenant to the trader's address, pushable by anyone, no trader keys or state.
- **Arkade ↔ arkade** (BTC↔asset, asset↔asset): the trader takes a quote by creating and funding
  an **offer** (layer 1) bound to the quoted terms before `valid_until`. The offer covenant only
  releases the deposit to a fill that delivers the quoted amount, so the solver fills or nothing
  moves; an unfilled offer is cancelled cooperatively. The quote wire shape ships here; the
  reference solver serves the Lightning pair today.

```ts
import { httpTransport, requestLightningSend } from "@arkade-os/swap";

// invoice facts from YOUR OWN decoder — the module takes facts, not a decoder
const swap = await requestLightningSend(wallet, arkServerUrl, emulatorUrl,
    httpTransport(solverUrl), {
        invoice: { raw: bolt11, paymentHash, amountSats, expiresAt },
    });
// quote verified against the LOCAL derivation and gated; now fund and go offline:
await wallet.send({ address: swap.address, amount: BigInt(swap.fundAmount) });
```

The trust model is the offer side's, applied to quotes: only `solver_pubkey`,
`refund_locktime`, `valid_until` and the amounts are used from a quote; every other contract
parameter is the trader's own data, and anything address-shaped from the solver is compare-only
(`AddressMismatch` means refuse-to-fund). Refusals carry a closed reason set (`SwapRefusal`);
unknown reasons are a generic decline. The `swap-lightning-send.program.json` bytes are frozen
the same way the offer programs are — a golden test pins the compiled leaves and scriptPubKey to
the reference solver's exact script.

Transports are symmetric-outbound: `httpTransport` (POST `/v1/swap`, GET `/v1/rfq/<rfq_id>`) and
`relayTransport` (the dev broker framing; the production target is Nostr — a directed kind with
NIP-44 content — which swaps only the transport function). Status by `rfq_id` reaches terminal
states `settled / refused / expired / refunded / stuck`; receipts (the preimage) appear only in
`settled`, and the chain itself is always the fallback nobody can withhold.
