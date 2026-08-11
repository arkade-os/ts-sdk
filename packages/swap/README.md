# @arkade-os/swap

Offer-maker side [Arkade Intents](https://arkade.money) atomic swaps: discover markets, quote and
validate, create offers, track them, cancel them, and rebuild the whole record set from chain after
a wallet restore. Framework-free TypeScript over `@arkade-os/sdk`: the core API and
`InMemoryAssetSwapRepository` use no DOM and no Node-specific APIs, so they run in Node, the
browser, and React Native alike. `IndexedDbAssetSwapRepository` is the one exception — it needs a
platform-provided or polyfilled IndexedDB.

## Roles: maker and taker

Arkade Intents names its roles after the **offer**, not the quote:

- **maker** — creates the offer and funds the swap address. That is the consumer of this package:
  it prices a swap against the registry's markets, deposits one side, and waits.
- **taker** — the solver that fills the offer, delivering `wantAmount` to the maker's script over
  the covenant's `fulfill` path. Same sense the solver registry and
  [`@arkade-os/solver-discovery`](https://www.npmjs.com/package/@arkade-os/solver-discovery) use.

**This inverts generic RFQ vocabulary, so watch out for the collision.** In RFQ systems the side
that *requests* a quote is conventionally the taker and the side that *answers* with a price is the
maker — which makes "maker-side" elsewhere mean the liquidity provider, the exact opposite of what
it means here. This package is the quote-requesting side, and it is called the **maker** side for
that reason; nothing in it is an "RFQ taker layer". Throughout this package — its docs, its types,
its comments — `taker` always means the solver that fills, never the party asking for a price.

## The seven layers

1. **`offer`** — the swap covenant itself. Two program JSONs (want-BTC / want-asset), the
   `Offer` type, the TLV wire codec (`encodeOffer`/`decodeOffer`, `OFFER_PACKET_TYPE`), address
   derivation (`offerVtxoScript`), and the maker operations `createOffer`/`cancelOffer`. Identical
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
6. **`rfq`** — the maker / intent-submitter side of quoted swaps: RFQ negotiation over HTTP or a
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
const o = await createOffer(wallet, ARK, EMULATOR_PUBKEY, { wantAmount: 1000n, wantAsset });
await wallet.send({ address: o.address, amount: 1000, extensions: [o.extension] });

// asset -> BTC (the sats are the VTXO carrier for the asset)
const o = await createOffer(wallet, ARK, EMULATOR_PUBKEY, { wantAmount: 1000n, offerAsset });
await wallet.send({
    address: o.address,
    amount: 500,
    assets: [{ assetId, amount: 1000n }],
    extensions: [o.extension],
});
```

`EMULATOR_PUBKEY` is the covenant co-signer's x-only key — the solver's deployment, not yours.
`createOffer` does not fetch or verify it: clients have no network path to the emulator, only the
solver and covclaimd do. Obtain it out of band, before calling `createOffer`, from the solver's
signed registry/corridor card and check it against whatever value you independently trust.

### What `createOffer` gives you back

`createOffer` is pure derivation — it broadcasts nothing. The offer only becomes real when the
deposit lands at `address`.

| Field          | What it is                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`      | The swap address to fund with your deposit. Identical offers derive an identical address, so the **funding txid**, not the address, identifies one deposit. |
| `extension`    | Pass straight to `wallet.send`'s `extensions`. It carries the offer inside the funding tx so the solver can discover the offer from the txid alone.         |
| `offerHex`     | The encoded offer. **Persist this** — it is the only input `cancelOffer` needs to rebuild the covenant.                                                     |
| `swapPkScript` | The covenant's scriptPubKey: the key an indexer watches to spot the deposit and its later spend.                                                            |

The minimum a maker must keep to stay in control of a swap is `offerHex` plus the funding txid.
Everything else — status, amounts, timestamps — `restoreAssetSwaps` rebuilds from chain, and the
offer bytes themselves are recoverable from the funding tx if the record is lost.

## Live status

```ts
const watcher = await watchOfferSwaps({ wallet, arkServerUrl: ARK, repository, onUpdate: render });
// later
watcher.stop();
```

Because `createOffer` registers the covenant, the wallet already watches that script and emits a
spend event when the deposit moves — so a **fill** reaches the maker without re-running a scan,
which is what `restoreAssetSwaps` alone could never do.

How a spend is classified, cheapest answer first: a cancel this device made is already recorded by
`cancelOffer`, so nothing needs deciding; anything else is read off the spending transaction's
covenant leaf (`cancel` vs `fulfill`), which is exact and stays exact when one transaction fills
several offers at once. A spend that cannot be classified — the indexer has not caught up, say —
**leaves the record untouched** for the restore scan to decide later. Nothing is written on a
guess: a stored swap is skipped by every later scan, so a guess here would be permanent.

`onUpdate` is a notification for UI reactivity, not a second store; every write goes through the
repository.

## Cancelling an offer no taker filled

```ts
const txid = await cancelOffer(wallet, ARK, swap.offerHex, {
    repository,
    fundingTxid: swap.fundingTxid,
    swapAddress: swap.swapAddress,
});
```

The call records its own outcome — `cancelling` before submitting, `cancelled` plus the spend txid
after — so a cancel needs no follow-up write from the caller, and the live watcher below finds a
record already resolved rather than re-deriving it.

**An unfilled offer never expires.** Neither program carries a timelock, so a deposit no taker
picked up sits at the swap address indefinitely — nothing reclaims it for the maker, and there is
no "expired" state to wait for. Cancelling is the only way out, and the maker has to ask.

The two ways out of the covenant are deliberately asymmetric:

- **`fulfill`** is signed by the **server alone**, but the covenant constrains it to pay output 0
  to the maker's script for at least `wantAmount`. A taker cannot take the deposit without
  delivering the other side.
- **`cancel`** is a **2-of-2 of the maker and the server**. Cancelling is cooperative, not a
  unilateral withdrawal.

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
const swap = await requestLightningSend(
    wallet,
    arkServerUrl,
    emulatorPubkey,
    httpTransport(solverUrl),
    {
        invoice: { raw: bolt11, paymentHash, amountSats, expiresAt },
    },
);
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
(`AddressMismatch` means refuse-to-fund). `emulatorPubkey` is neither: it is not fetched or
verified by this library at all — clients have no network path to the emulator, only the solver
and covclaimd do — so it must arrive already obtained out of band, from the solver's signed
registry/corridor card, and already checked against whatever value you independently trust.
Refusals carry a closed reason set (`SwapRefusal`); unknown reasons are a generic decline. The
`swap-lightning-send.program.json` bytes are frozen the same way the offer programs are — a
golden test pins the compiled leaves and scriptPubKey to the reference solver's exact script.

Transports are symmetric-outbound: `httpTransport` (POST `/v1/swap`, GET `/v1/rfq/<rfq_id>`) and
`relayTransport` (the dev broker framing; the production target is Nostr — a directed kind with
NIP-44 content — which swaps only the transport function). Status by `rfq_id` reaches terminal
states `settled / refused / expired / refunded / stuck`; receipts (the preimage) appear only in
`settled`, and the chain itself is always the fallback nobody can withhold.

## Onchain corridor: `arkade:BTC -> onchain:BTC` (and back)

The off-board direction is implemented end to end on the maker side. The maker generates `P`
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
    preimageForRfqSecrets,
    rfqSecretsToRecord,
} from "@arkade-os/swap";

const swap = await requestOnchainSend(
    wallet,
    arkServerUrl,
    emulatorPubkey,
    httpTransport(solverUrl),
    { amount: 100_000, amountSide: "to", payoutPubkey },
);
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
    ...rfqSecretsToRecord(swap.secrets),
});
await wallet.send({ address: swap.address, amount: swap.fundAmount });

// Unlike lightning-send the maker must STAY CLAIM-CAPABLE: watch for the fill
// and claim before the HTLC's refund leaf opens. chain is YOUR ChainSource.
const utxo = await awaitOnchainFill(chain, swap.htlc, minConfirmations);
await claimOnchainFill(chain, {
    htlc: swap.htlc,
    utxo,
    preimage: await preimageForRfqSecrets(wallet, swap.secrets),
    payoutPkScript,
    feeRateSatVb,
    sign,
});
```

`requestOnchainSend` derives BOTH contracts locally from the quote's binding fields
(`solver_pubkey`, `refund_locktime`, `htlc_pubkey`, `htlc_locktime`, `min_confirmations`) and
refuses on any mismatch — `lockup_address` and `htlc_address` are compare-only. `assertFundable`
adds three onchain gates, run immediately before funding: `timelock_order` (the L1 locktime plus a
2 h reorg margin must fall before the Arkade refund, so the maker's escape hatch opens LAST),
`claim_window_too_short`, and `confirmations_out_of_range`. `claimOnchainFill` refuses to
broadcast — publishing `P` — with less than 90 minutes before the refund leaf opens: past that
point the safe move is to let the swap die and take the Arkade covenant refund rather than race
the solver's refund with `P` exposed. If the solver never fills, there is nothing to do: the
covenant refund pays the maker's address after `refund_locktime`, pushable by anyone.

Crash recovery is record-driven, not chain-driven: `classifyOnchainHtlc` re-derives the HTLC's
state (unfunded / awaiting confirmations / claimable / refundable / claimed-with-P / swept) from
`ChainSource` plus the stored outpoint — without the stored record a spent HTLC is
indistinguishable from an unfunded one, which is why persisting before funding is mandatory. The
`AssetSwap` record carries the onchain fields (`paymentHash`, `signingDescriptor`,
`preimageHex` for caller-supplied P, `fallbackSecrets`, `htlcPkScriptHex`, `htlcLocktime`,
`l1Txid`) and the statuses `awaiting_fill / claimable / claimed / refunded_l1`.
`fallbackSecrets` is versioned and discriminated: `{ version: 1, type: "stored",
senderPrivateKeyHex, preimageHex? }`.

**On-board corridors are covered.** `requestLightningReceive` (`lightning:BTC -> arkade:BTC`) and
`requestOnchainReceive` (`onchain:BTC -> arkade:BTC`) mirror the send-side flows: quote → derive
BOTH contracts locally (the role-inverted VHTLC, and the L1 HTLC for the onchain leg) → verify
against the quote's compare-only addresses → gate. `requestLightningReceive` returns the solver's
hold invoice to pay; `requestOnchainReceive` returns the L1 HTLC to fund — the payment/broadcast
itself is the trader's own wallet's job, exactly as on the send corridors.

The invoice on the lightning-receive leg is the *solver's*, so the SDK owns the comparison rather
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
have already partially claimed (`partiallyClaimed`), where `P` is public anyway. Until covclaimd's
reference vectors are cross-checked, the `sealClaimPacket` test vector is pinned from this
implementation and marked provisional (`TODO(claim-packet-vectors)`).

## RFQ secrets are derived, not stored

The two secrets an RFQ swap needs — the VHTLC `sender` key and, for an onchain send, the preimage —
are functions of the wallet seed plus one HD-allocated descriptor. The record keeps the descriptor,
which is public, so a copied browser profile or a device backup yields nothing spendable.

```ts
const swap = await requestOnchainSend(/* … */);
swap.secrets; // { derivable: true, signingDescriptor } — persist it, it holds no secret
await saveSwap({ ...record, ...rfqSecretsToRecord(swap.secrets) });

// Later, from the seed plus that descriptor. Guard the lookup: offer-corridor
// records (and records that lost their secrets fields) carry no secrets at
// all, and a `!` here would crash the whole recovery loop on the first one.
const secrets = rfqSecretsOfRecord(record);
if (secrets) {
    const preimage = await preimageForRfqSecrets(wallet, secrets);
}

// For a refund, take the composition instead of the guard: it turns all three
// ways a wallet can fail to produce the sender key — no secrets on the record,
// an unreadable fallback arm, a descriptor from another seed — into one typed
// `RefundNotLocallyPossibleError` carrying which. Wire `refundArkade` to this.
const sender = await senderIdentityForSwapRecord(wallet, record);
```

`RfqSwapManager` catches that error and reports `needs_counterparty` with a `blockedReason`,
instead of retrying a push that cannot work until the refund window closes. The state is **not**
terminal: the lockup stays funded and watched, a solver claim still ends the swap `settled`, and a
`canRefundArkade` probe answering `ok` — after the right wallet is restored — returns it to
`pending`. The manager reports the same state when nothing is wired to act (`enableAutoActions:
false`, or no callbacks) and the window has passed.

`derivable: false` is the fallback for wallets that cannot allocate (static / `auto` / custom
signers). It carries the raw `senderPrivateKey` and, for onchain sends, `preimage`;
`rfqSecretsToRecord` stores them under `AssetSwap.fallbackSecrets` as a complete versioned
record. The discriminant is a type-level fact, so a consumer written against the derivable arm
alone will not compile against the fallback. A caller-supplied preimage on an HD wallet keeps
`signingDescriptor` for the sender key and stores only `preimageHex` as secret material.

Each swap **allocates** its own descriptor rather than peeking at the current one: two swaps sharing
a descriptor derive the *identical* preimage, so one solver learning its own preimage would learn the
other swap's. On restore, `adoptSwapDescriptor` moves the wallet's watermark past a restored record's
index so it cannot be handed out twice.

The derivation is `sha256(signSchnorrDeterministic(sha256("Arkade-RFQ-Preimage-v1" ‖ xonly(32) ‖
u32le(0))))`, mirroring NArk's Boltz scheme (`SwapsManagementService.cs:128-160`) with an
RFQ-scoped tag. NArk has no RFQ corridor yet, so this tag defines the scheme rather than matching
one; it is deliberately distinct from the Boltz tag so one wallet key cannot derive the same
preimage for both corridors.

**Not covered:** seed-only discovery after the swap repository is wiped. An unspent L1 HTLC reveals
too little public quote data to rediscover, so the record remains required.

**Gap-limit interaction:** every swap request — including one whose quote is refused — consumes one
index from the wallet's receive stream, and a swap index never becomes a funded receive contract,
so it looks *unused* to a seed-only `restore()` gap scan. Many consecutive swap allocations between
two funded receive indices can therefore exceed the scan's `gapLimit` (default 20) and stop it
before later-funded addresses are found. Keep the swap repository in backups (restore then adopts
each record's descriptor via `adoptSwapDescriptor`), or raise `gapLimit` on seed-only restores
after heavy swap use.

## Breaking changes on this branch (pre-release migration notes)

The package is pre-release; these notes replace a changelog for consumers tracking the branch.

- **`requestLightningSend` / `requestOnchainSend` return `secrets`, not top-level raw key material.**
  `senderPrivateKey` is gone from both return types; caller-owned onchain preimages live inside
  `secrets` and must be persisted with the record. `pushRefundWithoutReceiver` /
  `refundIfUnresolved` take `sender: Identity` instead of `senderPrivateKey: Uint8Array` — build
  it from the record with `senderIdentityForSwapRecord`, which is what keeps a wallet that cannot
  sign reporting `RefundNotLocallyPossibleError` rather than a `TypeError` at the push site;
  `senderIdentityForRfqSecrets` is for callers that already hold resolved secrets. `AssetSwap`
  gains `signingDescriptor?`,
  `preimageHex?`, and complete stored-arm `fallbackSecrets?`. Landed while the package is
  unpublished and consumer-free, which is the whole window for doing it: after a consumer ships,
  the same change becomes a secret migration across every deployed wallet.
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
- **`AssetSwap` gained the secret-bearing `signingDescriptor?` / `fallbackSecrets?` fields**, and
  `preimageHex` narrowed from "the claim preimage P" to "caller-supplied P only". The repository
  version stays `1` — the package is unreleased, so there is no stored record to migrate — but a
  field-mapped backend must persist the record whole: silently dropping `fallbackSecrets` on write
  loses the stored arm's claim and refund keys.
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
