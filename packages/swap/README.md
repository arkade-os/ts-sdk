# @arkade-os/swap

Client-side [Arkade Intents](https://arkade.money) asset swaps: discover markets, quote and
validate, create offers, track them, cancel them, and rebuild the whole record set from chain after
a wallet restore. Framework-free TypeScript over `@arkade-os/sdk`: the core API and
`InMemoryAssetSwapRepository` use no DOM and no Node-specific APIs, so they run in Node, the
browser, and React Native alike. `IndexedDbAssetSwapRepository` is the one exception — it needs a
platform-provided or polyfilled IndexedDB.

## Roles

Arkade Intents names two participants:

- **user** — states an intent and, through a wallet or application, approves and funds it. That is
  the consumer of this package: it prices a swap against the registry's markets, funds the derived
  contract, and tracks it to a fill or a cancellation.
- **solver** — supplies inventory and pricing, and fills the funded contract by delivering
  `wantAmount` to the user's script over the covenant's `fulfill` path. Some specifications and
  repositories use *provider* or *market maker* as synonyms.

**`maker` and `taker` in this package name contract positions, not product roles.** The covenant
programs bind `makerWP`, and the `Offer` type carries `makerPkScript` and `makerPublicKey`; those
identify the side that funds the swap and receives `wantAmount`. Read them as script field names.

Arkade Intents documentation deliberately avoids maker and taker for the participants themselves.
A resting maker order is firm once taken, and nothing here is: the user funds first, and if no
solver fills, the deposit comes back through `cancelOffer` rather than through an executed trade.
Naming the sides *user* and *solver* says who does what without borrowing a guarantee the contract
does not make.

## Request for quote

Every Arkade Intents route is request-for-quote: the user states an intent, receives the solver's
terms as a quote, funds the contract it derives from those terms, and a solver fills it. This
route is no exception — what is specific to it is *where the quote is resolved*. `quoteOffer`
prices the swap client-side from the market card the solver publishes: its price feed and its fee,
the same two inputs a relay quote would carry. Same protocol, one fewer network hop, and a quote
that is ready before the user finishes typing an amount.

The card commits a solver to a price; a fill commits it to your swap. Nothing is signed and no
inventory is reserved until a solver lands on the funded contract, so treat the quote as terms to
show and validate — which is what `validatePlan` is for — rather than as a reservation.

Relay-negotiated quotes are where this is going, and not only here: every corridor — Lightning,
onchain, and intra-Arkade alike — converges on asking solvers for quotes over the relay, under one
message family. What stays specific to this route is the settlement script, not the negotiation:
both legs live in the same ledger, so a non-interactive swap covenant replaces the HTLC that
cross-ledger corridors need. The quote you resolve locally today is the quote a solver will answer
with then.

## Funding, then fill or cancel

Every swap has the same two beats, on this route and on the cross-ledger corridors:

1. **Funding** — the user funds the contract it derived from the quote. Funding *is* acceptance;
   there is no accept message to send, here or anywhere in Arkade Intents.
2. **Fill, or cancel** — a solver fills by delivering the other side, or the user takes the
   deposit back.

Cancel is this route's refund path. Where an HTLC corridor refunds through a timelocked leaf, this
covenant refunds through `cancelOffer` — a 2-of-2 with the Arkade server, **no solver signature
involved**. Same job, same guarantee that the money comes home, reached by a script that fits a
single-ledger swap.

The one thing to design for: the covenant carries no timelock, so an offer keeps its place until
it is filled or cancelled. There is no window to miss, no deadline to race, and no expired state
to recover from — the trade-off is that the deposit comes back when you ask for it, so a UI that
funds an offer should keep cancelling within reach.

## The four layers

1. **`offer`** — the swap covenant itself. Two program JSONs (want-BTC / want-asset), the
   `Offer` type, the TLV wire codec (`encodeOffer`/`decodeOffer`, `OFFER_PACKET_TYPE`), address
   derivation (`offerVtxoScript`), and the user-side operations `createOffer`/`cancelOffer`. Identical
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

The minimum you must keep to stay in control of a swap is `offerHex` plus the funding txid.
Everything else — status, amounts, timestamps — `restoreAssetSwaps` rebuilds from chain, and the
offer bytes themselves are recoverable from the funding tx if the record is lost.

## Cancelling: the refund path

```ts
const txid = await cancelOffer(wallet, ARK, swap.offerHex, swap.fundingTxid, swap.swapAddress);
```

**An unfilled offer never expires.** Neither program carries a timelock, so a deposit no solver
picked up keeps its place at the swap address — the terms stay open as long as you want them to,
with no deadline to miss and no "expired" state to unwind. Getting the deposit back is
`cancelOffer`, available from the moment funding lands and settling as soon as you ask.

The two ways out of the covenant are deliberately asymmetric:

- **`fulfill`** is signed by the **server alone**, but the covenant constrains it to pay output 0
  to your payout script for at least `wantAmount`. A solver cannot take the deposit without
  delivering the other side.
- **`cancel`** is a **2-of-2 of you and the server** — no solver signature. Your refund never
  depends on the counterparty being reachable or willing, which is the same property the HTLC
  corridors buy with a timelock, bought here with a cooperative path that needs no waiting.

So cancel *races* a fill rather than pre-empting it. If the solver fills in the same moment,
`cancelOffer` throws `no spendable VTXO at the swap address` — that means the swap **completed**,
not that anything went wrong. Re-read the swap's state before treating it as an error;
`restoreAssetSwaps` tells the two spends apart afterwards and marks the record `fulfilled` rather
than `cancelled`.

Pass `fundingTxid` whenever you have it. Identical offers share an address; when several deposits
sit there, `cancelOffer` refuses to guess and throws unless `fundingTxid` selects one. Every
`AssetSwap` carries the txid, so the call above is the shape to prefer. `swapAddress` pins the
server key the covenant was built with, keeping cancel working across a server signer rotation —
without it, a rotated key is detected and reported explicitly rather than surfacing as a missing
VTXO.
