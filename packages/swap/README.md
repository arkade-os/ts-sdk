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
  repositories use _provider_ or _market maker_ as synonyms.

**`maker` and `taker` in this package name contract positions, not product roles.** The covenant
programs bind `makerWP`, and the `Offer` type carries `makerPkScript` and `makerPublicKey`; those
identify the side that funds the swap and receives `wantAmount`. Read them as script field names.

Arkade Intents documentation deliberately avoids maker and taker for the participants themselves.
A resting maker order is firm once taken, and nothing here is: the user funds first, and if no
solver fills, the deposit comes back through `cancelOffer` rather than through an executed trade.
Naming the sides _user_ and _solver_ says who does what without borrowing a guarantee the contract
does not make.

## Request for quote

Every Arkade Intents route is request-for-quote: the user states an intent, receives the solver's
terms as a quote, funds the contract it derives from those terms, and a solver fills it. This
route is no exception — what is specific to it is _where the quote is resolved_. `quoteOffer`
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

1. **Funding** — the user funds the contract it derived from the quote. Funding _is_ acceptance;
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

## The seven layers

1. **`offer`** — the swap covenant itself. Two program JSONs (want-BTC / want-asset), the
   `Offer` type, the TLV wire codec (`encodeOffer`/`decodeOffer`, `OFFER_PACKET_TYPE`), address
   derivation (`offerVtxoScript`), and the user-side operations `createOffer`/`cancelOffer`. Identical
   offers always derive identical swap addresses — the program JSONs are hashed into the address,
   so their bytes are frozen (guarded by a golden test).
2. **`markets`** — solver discovery and pricing guardrails: `discoverMarkets` (1-hour cached
   registry fetch with stale-cache fallback), `findMarket`, `validatePlan` (balance, both-side
   limits, BTC-leg dust), `QUOTE_OPTIONS`, and `makeCachedFeedFetch` for rate-limited price feeds.
3. **`store`** — the persisted `AssetSwap` records (`getAssetSwaps`/`addAssetSwap`/
   `updateAssetSwap`), thin helpers over an `AssetSwapRepository`. Read failures degrade to an
   empty list; write failures throw so pre-funding records can be retried before money is sent.
4. **`restore`** — `restoreAssetSwaps` rebuilds lost records by scanning sent virtual txs for
   offer packets and binding each funding vtxo to its spend. Incremental: answered txids are
   remembered in the repository (`getScannedTxids`/`markTxidsScanned`) so nothing is fetched
   twice.
5. **`watch`** — `watchOfferSwaps` drives swap status from the wallet's own contract events, so a
   fill shows up without re-running a scan. Registration is what makes it possible: only a
   registered covenant is watched. See "Live status" below.
6. **`rfq`** — the user side of quoted swaps: RFQ negotiation over HTTP or a
   relay, then non-interactive filling (see below). All four reference-solver corridors:
   `arkade:BTC -> lightning:BTC` and `arkade:BTC -> onchain:BTC` (send), `lightning:BTC ->
arkade:BTC` and `onchain:BTC -> arkade:BTC` (receive), plus `arkade:BTC|asset ->
arkade:BTC|asset` (quote, then take by funding an offer from layer 1).
7. **`onchainHtlc`** — the Bitcoin-L1 side of `arkade:BTC <-> onchain:BTC`: a NUMS-keyed taproot
   HTLC as pure local derivation (golden-pinned), claim/refund spend builders with signing as a
   callback, the injected `ChainSource` seam (the package holds no L1 backend and no keys),
   preimage extraction from a spend's witness, and crash-recovery classification.
   `claimPacket` seals P to covclaimd for the receive directions.

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
const o = await createOffer(wallet, ARK, { wantAmount: 1000n, wantAsset });
await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] });

// asset -> BTC (the sats are the VTXO carrier for the asset)
const o = await createOffer(wallet, ARK, { wantAmount: 1000n, offerAsset });
await wallet.send({
    address: o.address,
    amount: 500,
    assets: [{ assetId, amount: 1000n }],
    extensions: [o.extension],
});
```

The covenant co-signer ("emulator") key defaults to the SDK's per-network pin, resolved from the
network the Ark server reports — never fetched from the emulator itself. Pass
`params.emulatorPubkey` (33-byte compressed hex, the same contract as `Arkade.connect`'s option)
to override it for a self-hosted emulator, an unpinned network (signet, testnet), or a key
rotation the SDK hasn't shipped yet.

### What `createOffer` gives you back

`createOffer` is pure derivation — it broadcasts nothing. The offer only becomes real when the
deposit lands at `address`.

| Field          | What it is                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`      | The swap address to fund with your deposit. Identical offers derive an identical address, so the **funding txid**, not the address, identifies one deposit. |
| `extension`    | Pass straight to `wallet.send`'s `extensions`. It carries the offer inside the funding tx so the solver can discover the offer from the txid alone.         |
| `offerHex`     | The encoded offer. **Persist this** — it is the only input `cancelOffer` needs to rebuild the covenant.                                                     |
| `swapPkScript` | The covenant's scriptPubKey: the key an indexer watches to spot the deposit and its later spend.                                                            |

The minimum you must keep to stay in control of a swap is `offerHex` plus the funding txid.
Everything else — status, amounts, timestamps — `restoreAssetSwaps` rebuilds from chain, and the
offer bytes themselves are recoverable from the funding tx if the record is lost.

## Live status

```ts
const watcher = await watchOfferSwaps({ wallet, arkServerUrl: ARK, repository, onUpdate: render });
// later
watcher.stop();
```

Because `createOffer` registers the covenant, the wallet already watches that script and emits a
spend event when the deposit moves — so a **fill** reaches you without re-running a scan, which is
what `restoreAssetSwaps` alone could never do.

How a spend is classified, cheapest answer first: a cancel this device made is already recorded by
`cancelOffer`, so nothing needs deciding; anything else is read off the spending transaction's
covenant leaf (`cancel` vs `fulfill`), which is exact and stays exact when one transaction fills
several offers at once. A spend that cannot be classified — the indexer has not caught up, say —
**leaves the record untouched** for the restore scan to decide later. Nothing is written on a
guess: a stored swap is skipped by every later scan, so a guess here would be permanent.

`onUpdate` is a notification for UI reactivity, not a second store; every write goes through the
repository.

## Cancelling: the refund path

```ts
const txid = await cancelOffer(wallet, ARK, swap.offerHex, {
    repository,
    fundingTxid: swap.fundingTxid,
    swapAddress: swap.swapAddress,
});
```

The call records its own outcome — `cancelling` before submitting, `cancelled` plus the spend txid
after — so a cancel needs no follow-up write from the caller, and the live watcher above finds a
record already resolved rather than re-deriving it.

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

So cancel _races_ a fill rather than pre-empting it. If the solver fills in the same moment,
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
- **Arkade ↔ arkade** (BTC↔asset, asset↔asset): the trader accepts a quote by creating and funding
  an **offer** (layer 1) bound to the quoted terms before `valid_until`. The offer covenant only
  releases the deposit to a fill that delivers the quoted amount, so the solver fills or nothing
  moves; an unfilled offer is cancelled cooperatively. The quote wire shape ships here; the
  reference solver serves the Lightning pair today.

```ts
import { httpTransport, requestLightningSend } from "@arkade-os/swap";

// invoice facts from YOUR OWN decoder — the module takes facts, not a decoder
const swap = await requestLightningSend(wallet, arkServerUrl, httpTransport(solverUrl), {
    invoice: { raw: bolt11, paymentHash, amountSats, expiresAt },
});
// quote verified against the LOCAL derivation and gated; now fund and go offline:
await wallet.send({ address: swap.address, amount: swap.fundAmount });
```

Both `request*` functions register the lockup with the wallet's contract manager before returning
an address, the way `createOffer` registers its covenant: the lockup is watched from the moment it
lands and stays out of generic coin selection, so nothing can spend a live swap out from under
itself. A write failure throws `LockupRegistrationFailed` — the one throw here that does not mean
"walk away from this quote", since nothing is funded yet and the quote is still good. Keep
`swap.script`: it is the covenant object `RfqSwapManager` takes as a record's `lockup`, without
which the manager can only poll and cannot retire the row when the swap ends.

The trust model is the offer side's, applied to quotes: only `solver_pubkey`,
`refund_locktime`, `valid_until` and the amounts are used from a quote; every other contract
parameter is the trader's own data, and anything address-shaped from the solver is compare-only
(`AddressMismatch` means refuse-to-fund). The emulator key is neither: as above, it is a
per-network pin inside the SDK, not solver data.
Refusals carry a closed reason set (`SwapRefusal`); unknown reasons are a generic decline. The
`swap-lightning-send.program.json` bytes are frozen the same way the offer programs are — a
golden test pins the compiled leaves and scriptPubKey to the reference solver's exact script.

Transports are symmetric-outbound: `httpTransport` (POST `/v1/swap`, GET `/v1/rfq/<rfq_id>`),
`relayTransport` (the dev broker framing), and `nostrRfqTransport` — the production one a
deployed solver actually listens on. Status by `rfq_id` reaches terminal states
`settled / refused / expired / refunded / stuck`; receipts (the preimage) appear only in
`settled`, and the chain itself is always the fallback nobody can withhold.

### The Nostr transport is a separate entry point

```ts
import { nostrRfqTransport } from "@arkade-os/swap/nostr";

const transport = nostrRfqTransport({
    relays: card.transports.nostr.relays,
    solverPubkey: card.discovery_pubkey,
});
```

`nostr-tools` is an **optional peer dependency**, so it is only required if you import this
subpath — a consumer doing HTTP-only swaps never resolves it, and the package root pulls in
nothing Nostr-related. The trade is that importing `@arkade-os/swap/nostr` without `nostr-tools`
installed fails at resolution, which is the intended loud failure rather than a transport that
silently degrades.

Directed traffic rides kind `24859`, which is **ephemeral** (NIP-01's 20000–29999): a conforming
relay does not retain it. This must match the solver's `NOSTR_KIND_DIRECTED` — the two sides
subscribe by `kinds`, so a mismatch is not an error either can report. They simply never see each
other, and every request times out appearing to blame the solver.

## Onchain corridor: `arkade:BTC -> onchain:BTC` (and back)

The off-board direction is implemented end to end on the user side. The user generates `P`
itself — `sha256(P)` is the wire `payment_hash`, and the script commitment is
`ripemd160(sha256(P))` in BOTH contracts, so one preimage unlocks the Arkade leaf and the L1 leaf.
The Arkade lockup is byte-identical to the lightning-send program (`htlcSendProgram` is an alias —
one artifact, one golden test); the L1 side is a two-leaf taproot HTLC with the BIP-341 NUMS
internal key (no key-path spend, ever): claim = `HASH160 <h160> EQUALVERIFY <claimKey> CHECKSIG`,
refund = `<locktime> CLTV DROP <refundKey> CHECKSIG`.

```ts
import { hex } from "@scure/base";
import {
    httpTransport,
    requestOnchainSend,
    awaitOnchainFill,
    claimOnchainFill,
    addAssetSwap,
    swapSecretsToRecord,
} from "@arkade-os/swap";

const swap = await requestOnchainSend(wallet, arkServerUrl, httpTransport(solverUrl), {
    amount: 100_000,
    amountSide: "to",
    payoutPubkey,
});
// Persist the record, including secrets, BEFORE funding. This must succeed:
// if addAssetSwap throws, do not call wallet.send.
await addAssetSwap(repository, {
    ...record,
    id: swap.rfqId,
    pair: "arkade:BTC->onchain:BTC",
    paymentHash: swap.htlc.paymentHash,
    swapAddress: swap.address,
    swapPkScript: hex.encode(swap.swapPkScript),
    htlcPkScriptHex: hex.encode(swap.htlc.pkScript),
    htlcLocktime: swap.htlc.refundLocktime,
    ...swapSecretsToRecord(swap.secrets),
});
await wallet.send({ address: swap.address, amount: swap.fundAmount });

// Unlike lightning-send the user must STAY CLAIM-CAPABLE: watch for the fill
// and claim before the HTLC's refund leaf opens. chain is YOUR ChainSource.
const utxo = await awaitOnchainFill(chain, swap.htlc, minConfirmations);
await claimOnchainFill(chain, {
    htlc: swap.htlc,
    utxo,
    preimage: swap.secrets.preimage,
    payoutPkScript,
    feeRateSatVb,
    sign,
});
```

`requestOnchainSend` derives BOTH contracts locally from the quote's binding fields
(`solver_pubkey`, `refund_locktime`, `htlc_pubkey`, `htlc_locktime`, `min_confirmations`) and
refuses on any mismatch — `lockup_address` and `htlc_address` are compare-only. `assertFundable`
adds three onchain gates, run immediately before funding: `timelock_order` (the L1 locktime plus a
2 h reorg margin must fall before the Arkade refund, so the user's escape hatch opens LAST),
`claim_window_too_short`, and `confirmations_out_of_range`. `claimOnchainFill` refuses to
broadcast — publishing `P` — with less than 90 minutes before the refund leaf opens: past that
point the safe move is to let the swap die and take the Arkade covenant refund rather than race
the solver's refund with `P` exposed. If the solver never fills, there is nothing to do: the
covenant refund pays the user's address after `refund_locktime`, pushable by anyone.

Crash recovery is record-driven, not chain-driven: `classifyOnchainHtlc` re-derives the HTLC's
state (unfunded / awaiting confirmations / claimable / refundable / claimed-with-P / swept) from
`ChainSource` plus the stored outpoint — without the stored record a spent HTLC is
indistinguishable from an unfunded one, which is why persisting before funding is mandatory. The
`AssetSwap` record carries the onchain fields (`paymentHash`, `signingDescriptor`, `preimageHex`
for a P that cannot be re-derived, `htlcPkScriptHex`, `htlcLocktime`, `l1Txid`) and the statuses
`awaiting_fill / claimable / claimed / refunded_l1`.

**On-board corridors are covered.** `requestLightningReceive` (`lightning:BTC -> arkade:BTC`) and
`requestOnchainReceive` (`onchain:BTC -> arkade:BTC`) mirror the send-side flows: quote → derive
BOTH contracts locally (the role-inverted VHTLC, and the L1 HTLC for the onchain leg) → verify
against the quote's compare-only addresses → gate. `requestLightningReceive` returns the solver's
hold invoice to pay; `requestOnchainReceive` returns the L1 HTLC to fund — the payment/broadcast
itself is the trader's own wallet's job, exactly as on the send corridors.

The invoice on the lightning-receive leg is the _solver's_, so the SDK owns the comparison rather
than taking the caller's facts about it: `requestLightningReceive` requires a `decodeInvoice`
callback (no BOLT11 dependency is added) and `verifyReceiveInvoice` binds the decoded invoice to
this swap's `H` and to `quote.from_amount` — an invoice on another payment hash is the one attack
here with no on-chain trace, since the payer pays it in full and no lockup on `H` is ever funded.
`assertReceivable` replaces `assertFundable` on this leg: the refund CLTV is the solver's, so the
window that can run out is the hold invoice's, and the claim window is measured from
`payDeadline = min(invoice expiry, valid_until)` — returned as the absolute `invoiceExpiresAt`,
which is the deadline to show a payer, not `valid_until`. The optional `maxPayAmount` caps `from_amount`
(`price_too_high`). The trader-side
completion lands in `claim.ts`: `claimReceiveLockup` waits for the solver's funding and pushes the
collaborative claim with the swap's own `P` and receiver key (covclaimd optional). Both request
flows return `expectedAmount` (the quote's `to_amount`) — persist it: `pushClaim` requires it and
refuses, with `LockupAmountMismatchError`, to publish `P` for a lockup funded below it. Matching the
`pkScript` is not enough on this leg, since a solver that funds the correctly derived script with
dust still settles the payer's HTLC in full once `P` is out. The gate sums every live output and
runs before signing — `P` reaches the Ark server at submit — and is skipped only for a lockup we
have already partially claimed (`partiallyClaimed`), where `P` is public anyway. The push itself is
core's `signAndSubmitOffchainTx` plus `claimWithPreimageIdentity`, with `verifyServerSignatures`
on: the server's countersignature is checked per input, against the leaf the local build spends,
before finalizing. Until covclaimd's
reference vectors are cross-checked, the `sealClaimPacket` test vector is pinned from this
implementation and marked provisional (`TODO(claim-packet-vectors)`).

`RfqSwapManager` drives the lightning-receive leg too, as `kind: "lightning_receive"` records
carrying `expectedAmount` and wired to a `claimLockup` callback (`pushClaim`, with `expectedAmount`
and `partiallyClaimed` passed through — the manager's value check decides _when_ to act, the inner
one decides whether `P` is published). Nothing is asked of the solver: the reference solver's
`rfq_status_request` consults neither receive store, so a status poll answers `unknown` for every
one of these swaps and chain observation is the only workable design. States mean what they do on
the send legs with the roles swapped — `settled` is _our own_ claim landing, matched by a
hash-verified preimage spend rather than by the txid we submitted, so a claim that lands without us
still counts; `claimed` is a local belief and not terminal; and **`refunded` is a loss**, the solver
having taken back a lockup we failed to claim. A lockup funded below `expectedAmount` is reported
`needs_counterparty` and never claimed, which is non-terminal — a solver that tops it up before
the window shuts makes it claimable again, and a lockup funded piecemeal moves `claimed` →
`claimable` → `claimed` again, so `onSwapUpdate` states say what to do next rather than track
progress in one direction. A `refunded` outcome from `waitForSwapCompletion` reports no `txid` even
when a claim was submitted and recorded: the chain never took it, and the record still carries
`claimArkTxid` for anyone diagnosing the loss.

**There is no client-side refund on this leg, and that is the whole answer to "what if I cannot
claim in time".** Every non-claim leaf of the covenant is the solver's, so `refundArkade` is never
called for a receive record and no amount of waiting produces one. The deadline is the quote's
`refund_locktime`: the manager claims right up to it and stops there, because publishing `P` into
the solver's live refund window risks losing the race and giving away the preimage anyway. Wall
clock with no margin is already conservative — the solver's leaf is a CLTV maturing against
median-time-past, which trails, so the real window runs past that instant rather than ending before
it. Past it the outcome is not symmetric with a send: the solver reclaims the lockup, the held
Lightning HTLC lapses, and **the payer is refunded** — the trader loses the incoming payment, not
funds it was holding. Which is why staying online to claim is an obligation and not a preference:
covclaimd cannot claim this covenant today, so the claim packet's offline path does not yet run.

## Swap secrets come from the wallet, not from this package

This package holds no key logic at all. It names the leg it is building and the SDK answers:

```ts
// a leg we fund — all it needs is the key that refunds it
const { pubkey: refundPubkey, descriptor: refundDescriptor } = await provisionRefundKey(wallet);
// a leg we claim — the key that receives it, and the P that unlocks it
const { pubkey, descriptor, preimage, paymentHash, mustPersistPreimage } =
    await provisionClaimSecret(wallet);
```

Where the key comes from is the wallet's decision, invisible here: an HD wallet allocates a fresh
descriptor per swap, a static wallet answers with its one `tr(pubkey)`. The record keeps the
descriptor, which is public, and `contractSigner(wallet, descriptor)` recovers the signer.

What each swap stores, and what is recoverable:

| Wallet answers with | Spending key          | Preimage (when the leg needs one) | Secret at rest    |
| ------------------- | --------------------- | --------------------------------- | ----------------- |
| fresh HD descriptor | re-derives from seed  | derives deterministically         | none              |
| static `tr(pubkey)` | the wallet's identity | random, stored on the record      | the preimage only |

The preimage split follows the **descriptor's shape**, not the wallet's type: an HD child
descriptor is unique to its swap, so `sha256(sign_det(...))` is safe; a static descriptor is the
same key for every swap, so a derived preimage would repeat across swaps — one solver learning its
own preimage would learn every other swap's — and a per-swap random preimage is stored instead.
`mustPersistPreimage` says which you got. A stored preimage is the one secret at rest in the
design, and it is never a private key.

```ts
const swap = await requestOnchainSend(/* … */);
// `swapSecretsToRecord` stores the public descriptor always, and `preimageHex`
// only when the wallet said it cannot re-derive P.
await saveSwap({ ...record, ...swapSecretsToRecord(swap.secrets) });

// Later, from the seed plus that descriptor. Only ask for a preimage the
// corridor gave us one for: a lightning send's P belongs to the payee, so
// this throws on those records rather than inventing something the chain will
// never match. `LIGHTNING_SEND_PAIR` is exported from this package.
if (record.signingDescriptor && record.pair !== LIGHTNING_SEND_PAIR) {
    const preimage = await contractPreimage(
        wallet,
        record.signingDescriptor,
        record.preimageHex ? hex.decode(record.preimageHex) : undefined,
    );
}

// For a refund, take the composition instead of the guard: it turns all three
// ways a wallet can fail to produce the sender key — the record names no
// descriptor, the descriptor is another seed's, the wallet holds the key but
// cannot sign — into one typed `RefundNotLocallyPossibleError` carrying which,
// and lets a signer outage stay retryable. Wire `refundArkade` to this.
const sender = await senderIdentityForSwapRecord(wallet, record);
```

`RfqSwapManager` catches that error and reports `needs_counterparty` with a `blockedReason`,
instead of retrying a push that cannot work until the refund window closes. The state is **not**
terminal: the lockup stays funded and watched, a solver claim still ends the swap `settled`, and a
`canRefundArkade` probe answering `ok` — after the right wallet is restored — returns it to
`pending`. The manager reports the same state when nothing is wired to act (`enableAutoActions:
false`, or no callbacks) and the window has passed.

A caller-supplied preimage keeps `signingDescriptor` for the sender key and stores only
`preimageHex` as secret material.

On an HD wallet each swap **allocates** its own descriptor rather than peeking at the current one:
two swaps sharing a descriptor derive the _identical_ preimage, so one solver learning its own
preimage would learn the other swap's. (Static wallets share their one descriptor by design — that
is why their preimages are stored per swap, never derived.) On restore, `adoptContractDescriptor`
(from `@arkade-os/sdk`) moves the wallet's watermark past a restored record's index so it cannot be
handed out twice; a static descriptor names no index and adopts as a no-op.

The derivation is `sha256(signSchnorrDeterministic(sha256("Arkade-RFQ-Preimage-v1" ‖ xonly(32) ‖
u32le(0))))`, mirroring NArk's Boltz scheme (`SwapsManagementService.cs:128-160`) with an
RFQ-scoped tag. NArk has no RFQ corridor yet, so this tag defines the scheme rather than matching
one; it is deliberately distinct from the Boltz tag so one wallet key cannot derive the same
preimage for both corridors.

**Not covered:** seed-only discovery after the swap repository is wiped. An unspent L1 HTLC reveals
too little public quote data to rediscover, so the record remains required.

**Gap-limit interaction:** every swap request — including one whose quote is refused — consumes one
index from the wallet's receive stream, and a swap index never becomes a funded receive contract,
so it looks _unused_ to a seed-only `restore()` gap scan. Many consecutive swap allocations between
two funded receive indices can therefore exceed the scan's `gapLimit` (default 20) and stop it
before later-funded addresses are found. Keep the swap repository in backups (restore then adopts
each record's descriptor via `adoptContractDescriptor`), or raise `gapLimit` on seed-only restores
after heavy swap use.

## Breaking changes on this branch (pre-release migration notes)

The package is pre-release; these notes replace a changelog for consumers tracking the branch.

- **`secrets.ts` is gone; key provisioning moved into `@arkade-os/sdk`.** This package no longer
  derives, mints, or names keys. It asks the SDK for what the leg needs — `provisionRefundKey(wallet)`
  for a leg it funds, `provisionClaimSecret(wallet, { preimage? })` for one it claims — and
  recovers with `contractSigner(wallet, descriptor)` / `contractPreimage(wallet, descriptor,
stored?)`. The returned `ProvisionedKey` / `ProvisionedClaimSecret` replace `SwapSecrets`, and
  `descriptor` replaces `signingDescriptor` on them. Removed from this package with no
  replacement here: `deriveSwapSecrets`, `randomSwapSecrets`, `senderPubkeyForRfqSecrets`,
  `preimageForRfqSecrets`, `senderIdentityForRfqSecrets`, `isPerSwapDescriptor`, `derivePreimage`,
  `buildPreimageMessage`, `RFQ_PREIMAGE_TAG`, `isDeterministicSigner`, `adoptSwapDescriptor` (now
  `adoptContractDescriptor` in the SDK), `SwapSecrets` / `DerivedSwapSecrets` /
  `StoredSwapSecrets`, and `rfqSecretsToRecord` / `rfqSecretsOfRecord` — persist a provisioned
  secret with **`swapSecretsToRecord`** from `store` instead, and read P back with
  `contractPreimage`. `RefundNotLocallyPossibleError` and `senderIdentityForSwapRecord` stay here
  (now in `refundBlocked.ts`): they are swap lifecycle, not key provisioning.
- **No swap record can carry a private key.** `AssetSwap.fallbackSecrets` and the
  `AssetSwapFallbackSecrets` types are deleted rather than kept readable, and `preimageHex` — set
  only when the wallet reports `mustPersistPreimage` — is the record's one secret field. A record
  written by 0.0.1–0.0.3 carries no `signingDescriptor`, so `senderIdentityForSwapRecord` refuses
  it with `no-secrets` rather than silently mis-signing; those versions shipped before any
  consumer, which is the window for doing this without a secret migration.
- **`requestLightningSend` / `requestOnchainSend` return `secrets`, not top-level raw key material.**
  `senderPrivateKey` is gone from both return types; caller-owned onchain preimages live inside
  `secrets` and must be persisted with the record. `pushRefundWithoutReceiver` /
  `refundIfUnresolved` take `sender: Identity` instead of `senderPrivateKey: Uint8Array` — build
  it from the record with `senderIdentityForSwapRecord`, which is what keeps a wallet that cannot
  sign reporting `RefundNotLocallyPossibleError` rather than a `TypeError` at the push site.
  `AssetSwap` gains `signingDescriptor?` and `preimageHex?`.
- **Every derived address changed, in both corridors.** The lightning-send lockup moved from the
  3-leaf program-artifact VHTLC to the 8-leaf `VHTLC.ScriptV2` (non-interactive claim and refund
  leaves), and the L1 HTLC's claim leaf gained a `SIZE 32 EQUALVERIFY` preimage-length guard. Both
  are pinned by golden tests (`test/rfq.test.ts`, `test/onchainHtlc.test.ts`). **Deployment must be
  coordinated:** trader and solver derive the lockup independently and compare (`lockup_address` /
  `htlc_address` are compare-only), so a version mismatch does not lose funds — it refuses every
  quote at `verifyLockupAddress`. Upgrade both sides before expecting fills.
- **`cancelOffer` and `restoreAssetSwaps` take an options object.** `cancelOffer(wallet, url,
offerHex, { repository, fundingTxid?, swapAddress? })` — the repository is required because the
  call now records its own outcome. `restoreAssetSwaps(indexer, txs, existingIds, { serverPubkey,
scanned? })` — the server key is required because a spend is classified by rebuilding the
  covenant and matching the leaf it took.
- **`isCancelSpend` is gone**, replaced by `classifySpend`, and `Tx.assets` with it. The old test
  read what a transaction moved, which a wallet reports as a _net_ delta: once the deposit is a
  registered contract, an asset offer's cancel moves the asset out and back, nets to zero, and is
  indistinguishable from a fill. Leaves have no such failure mode.
- **A spend that cannot be classified is no longer restored as `fulfilled`.** It leaves the funding
  txid unanswered so a later scan decides it. Records are never written on a guess.
- **`AssetSwap` gained `signingDescriptor?`**, and `preimageHex` now means "P that cannot be
  re-derived" — caller-supplied, or minted for a static descriptor. The repository version stays
  `1` — the package is unreleased, so there is no stored record to migrate — but a field-mapped
  backend must persist the record whole: silently dropping `preimageHex` leaves a static swap
  permanently unclaimable.
- **A write that gates something irreversible throws; one that follows it does not.**
  `addAssetSwap` and `updateAssetSwap` throw on a failed read or write — nothing irreversible may
  happen until the record is durable, which is why `cancelOffer` writes its `cancelling` marker
  before broadcasting. `updateAssetSwapBestEffort` is the other half: it records transitions that
  follow an irreversible action (a broadcast claim, a spent lockup), so it cannot fail the caller,
  and returns `{ swaps, persisted }` instead. `watchOfferSwaps` uses it and fires `onUpdate` only
  when `persisted` is true — the callback is documented as following a persisted change, and a
  consumer caching from it must not run ahead of the store.
- **`lightningSendProgram` and `htlcSendProgram` are gone** along with the program-artifact layer
  they compiled. Derive scripts through `lightningSendVtxoScript` / `onchainHtlcScript`.
- **The receive corridors are wired, and the wire shape settled.** `lightningReceiveRequest` is
  new; `onchainReceiveRequest`'s profile now matches the shipped solver schema (`payment_hash`,
  `claim_packet`, `refund_pubkey`, `payout_address`, `payout_pubkey` — the earlier
  `destination_address` / object-shaped `claim_packet` never interoperated). `sealClaimPacket`
  drops the vestigial `arkadeScript` input: the packet was never cryptographically bound to it,
  and the solver recomputes the script from its own row, so the wire carries only the ciphertext.
  `requestLightningSend` now returns `fundAmount = quote.from_amount` — the invoice plus the
  corridor's fee — and refuses quotes whose `to_amount` reprices the invoice; solvers charge
  per-corridor fees on all four pairs, and funding the bare invoice amount underfunds by exactly
  the fee.
- **`lightningSendVtxoScript` takes two new required fields**: `senderPubkey` (the trader's VHTLC
  sender key — generate, persist, see `requestLightningSend`) and `receiverPkScript` (the solver's
  claim destination, from `profile.receiver_pk_script`). Callers that built the lockup directly
  must supply both; callers going through `requestLightningSend` are unaffected.
- **`RfqSwapManagerCallbacks` gained a required `claimLockup`**, and `RfqSwap` a third member,
  `LightningReceiveSwap`. Required rather than optional for the same reason `claimOnchain` is: a
  receive swap monitored with nothing wired to claim it expires quietly, and a compile error is the
  right way to learn a corridor was added. A caller with only send swaps can satisfy it with a stub
  that throws. `RfqSwapActionName` gains `"claimLockup"`, so an exhaustive `switch` over it needs a
  new arm.
