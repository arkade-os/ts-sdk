# @arkade-os/swap

Client-side [Arkade Intents](https://arkade.money) asset swaps: discover markets, quote and
validate, create offers, track them, cancel them, and rebuild the whole record set from chain after
a wallet restore. Framework-free TypeScript over `@arkade-os/sdk`: the core API uses no DOM and no
Node-specific APIs, so it runs in Node, the browser, and React Native alike. Four storage backends
ship — in-memory (anywhere, nothing outlives the process), IndexedDB (browser), SQLite and Realm
(React Native, on subpath entry points) — see "Storage backends" below.

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
(versioned interface, `AsyncDisposable`, one backend per platform). Construct one and pass it
wherever the package asks for a repository; `discoverMarkets` also accepts none, for a one-shot
uncached discovery.

## Storage backends

| Backend                        | Import from                           | For                                             |
| ------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `InMemoryAssetSwapRepository`  | `@arkade-os/swap`                     | tests, one-shot scripts — nothing survives exit |
| `IndexedDbAssetSwapRepository` | `@arkade-os/swap`                     | the browser (or a polyfilled IndexedDB)         |
| `SQLiteAssetSwapRepository`    | `@arkade-os/swap/repositories/sqlite` | React Native, over your SQLite driver           |
| `RealmAssetSwapRepository`     | `@arkade-os/swap/repositories/realm`  | React Native, over your Realm instance          |

Neither subpath adds a dependency: they take the SDK's structural `SQLExecutor` / `RealmLike`
handles, so you pass the database you already opened.

All four carry both record types: asset swaps and the monitored RFQ swaps
(`saveRfqSwap` / `getRfqSwap` / `getAllRfqSwaps` / `removeRfqSwap`). Each keeps them in a store of their own — a
second object store on IndexedDB, an `…rfq_swaps` table on SQLite, the `ArkadeRfqSwap` class on
Realm — since the two record types have different keys and no consumer wants them interleaved.

**Records are stored whole.** The SQLite and Realm backends serialize each record to **JSON** in a
`data` column, with only `status` / `createdAt` (and an RFQ record's `state` / `updatedAt`) mapped
out for querying — so a field they do not know about survives, which is what the `quote`-shaped
extension in `MIGRATION.md` relies on. It is also what keeps an RFQ record's corridor `profile`
intact: `profile.hashlock` is a nested object holding the payment hash and any preimage material, and
a field-mapped backend is exactly what would lose it. JSON is
the boundary, though, and it is narrower than IndexedDB's structured clone: a `Date` in a
consumer-added field comes back an ISO **string**, a `Set` or `Map` comes back empty, and a `bigint`
makes `saveSwap` **throw**. `AssetSwap` and `RfqSwapRecord` are both JSON-safe by design (amounts are
strings, binary is hex), and a corridor `profile` is plain JSON by the handler contract; keep your own
added fields — and any corridor profile you write — that way too.

### SQLite

```ts
import { SQLiteAssetSwapRepository } from "@arkade-os/swap/repositories/sqlite";
import { SQLiteWalletRepository, type SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";

const db = await SQLite.openDatabaseAsync("wallet.db"); // expo-sqlite
// Build the executor ONCE and hand this same instance to every repository on
// the database: the SDK serializes transactions in a chain keyed by this
// object, so a per-repository literal splits the chain and two BEGIN
// IMMEDIATEs can interleave.
const executor: SQLExecutor = {
    run: (sql, params) => db.runAsync(sql, params ?? []),
    get: (sql, params) => db.getFirstAsync(sql, params ?? []),
    all: (sql, params) => db.getAllAsync(sql, params ?? []),
};

const swaps = new SQLiteAssetSwapRepository(executor);
const wallet = new SQLiteWalletRepository(executor); // same instance
```

Sharing the executor is **necessary** for that serialization, not sufficient for atomicity across
all wallet storage: it disciplines the repositories that enter the chain — this one,
`SQLiteIntentRepository`, `SQLiteVirtualTxRepository`, and the wallet repository's migration path —
and nothing else. `SQLiteWalletRepository` and `SQLiteContractRepository` still write raw, so their
writes can land inside whatever transaction happens to be open.

Three tables land in your database, prefixed `arkade_`: `arkade_asset_swaps`,
`arkade_asset_swap_scanned_txids`, `arkade_asset_swap_markets`. Pass `{ prefix: "myapp_" }` if your
app already owns those names.

### Realm

```ts
import Realm from "realm";
import { AssetSwapRealmSchemas, RealmAssetSwapRepository } from "@arkade-os/swap/repositories/realm";
import { ArkRealmSchemas } from "@arkade-os/sdk/repositories/realm";

const realm = await Realm.open({
    schema: [...ArkRealmSchemas, ...AssetSwapRealmSchemas, ...yourOwnSchemas],
    schemaVersion: YOUR_VERSION, // these schemas are new: bump yours when adding them
});
const swaps = new RealmAssetSwapRepository(realm);
```

Four classes land in your Realm namespace: `ArkadeAssetSwap`, `ArkadeRfqSwap`,
`ArkadeAssetSwapScannedTxid`, `ArkadeAssetSwapMarketsCache`. Unlike SQLite there is no prefix option
— a Realm schema name is baked into the schema objects you register — so reconcile against your own
models by name.

`ArkadeRfqSwap` arrived after the other three. **If you already shipped them, add it and bump
`schemaVersion` again**: Realm creates schemas at open, so a config still listing three fails on the
first RFQ read rather than at open. SQLite needs nothing — its DDL runs `CREATE TABLE IF NOT EXISTS`
on every init, so the table appears on the next operation.

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
- **Arkade ↔ arkade** (BTC↔asset, asset↔asset): an arkade asset leg names the asset id itself —
  `arkade:<68-hex>`, built with `arkadeAssetLeg` (the deprecated coarse `ARKADE_ASSET` is served by
  no solver). The trader accepts a quote by creating and funding
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

| Wallet answers with       | Spending key          | Preimage (when the leg needs one)     | Secret at rest    |
| ------------------------- | --------------------- | ------------------------------------- | ----------------- |
| fresh HD descriptor       | re-derives from seed  | derives deterministically             | none              |
| static `tr(pubkey)`       | the wallet's identity | derives from a public per-swap salt   | none              |
| a signer that cannot sign |                       |                                       |                   |
| deterministically         | the wallet's identity | random, stored on the record          | the preimage only |

The preimage split follows the **descriptor's shape**, not the wallet's type. An HD child
descriptor is unique to its swap, so `sha256(sign_det(...))` over the key alone is safe. A static
descriptor is the same key for every swap, so that derivation would repeat across swaps — one
solver learning its own preimage would learn every other swap's — and the uniqueness has to come
from the message instead: the SDK mints 32 random bytes per swap, signs a **salted** message, and
stores the salt in the clear.

**The salt is not a secret.** Knowing it yields nothing without the seed, which is the whole
difference from the preimage it replaces: the record goes from carrying a per-swap _secret_ to a
per-swap _public_ value, exactly what `signingDescriptor` already is. Recoverability is unchanged
in shape — keep the record and the swap recovers from the seed.

Only a signer that cannot sign deterministically at all — an external or extension signer — still
gets a random stored preimage. `mustPersistPreimage` says which you got, and it is the only thing
to branch on. A stored preimage remains the one secret at rest in the design, and it is never a
private key.

```ts
const swap = await requestOnchainSend(/* … */);
// `swapSecretsToRecord` stores the public descriptor always, then whichever of
// `preimageSaltHex` (derivable) or `preimageHex` (not) the wallet produced.
await saveSwap({ ...record, ...swapSecretsToRecord(swap.secrets) });

// Later, from the seed plus the record's public fields. Only ask for a
// preimage the corridor gave us one for: a lightning send's P belongs to the
// payee, so this throws on those records rather than inventing something the
// chain will never match. `LIGHTNING_SEND_PAIR` is exported from this package.
if (record.pair !== LIGHTNING_SEND_PAIR) {
    const preimage = await preimageForSwapRecord(wallet, record);
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

**The two claim callbacks may be omitted.** `setCallbacks` accepts
`AvailableRfqSwapManagerCallbacks` — the full contract with `claimOnchain` and `claimLockup`
optional — so a consumer driving only lightning sends installs neither instead of stubbing them to
throw. Dispatch is already kind-gated, so neither is reachable there. `refundArkade` and `saveSwap`
stay required.

`RfqSwapManagerCallbacks` itself is unchanged and still means "fully wired", so a helper taking one
and calling `claimOnchain` keeps its guarantee; only the parameter widens, which every existing
caller satisfies. What moves from compile time to runtime is bought back as a **block**: a kind
whose claim is missing reports `needs_counterparty` naming the gap, non-terminal and re-evaluated
every pass, lifted the moment `setCallbacks` supplies it. Not `failed` — `setCallbacks` is
installable late by design, and a terminal state would foreclose the late wiring this exists for.
A manager with *no* callbacks at all keeps today's manual mode on the L1 half: it reports
`claimable` and you act by hand.

**Take `arkadeRefunder` rather than assembling `refundArkade` by hand.** It composes the atomic
push and keeps the three rules the manager relies on structural instead of documented — an empty
lockup returns `null`, and both `RefundNotLocallyPossibleError` and `LockupNeedsRecoveryError`
propagate untouched.

```ts
manager.setCallbacks({
    // `repository` is how it reaches `profile.signer`: the live swap the manager
    // passes carries no descriptor, so the refund key is resolved by `rfqId`.
    refundArkade: arkadeRefunder({ ark, indexer, wallet, repository }),
    saveSwap,
});
```

Keep the covenant on the swap (`request*`'s `script`, as a record's `lockup`): the refund is built
from it, and a swap carrying only `lockupPkScript` is refused rather than pushed.

`preimageForSwapRecord` is the read path to wire, not a hand-rolled `contractPreimage` call: it
knows which of the record's fields are derivation inputs, and it verifies the result against
`paymentHash`. A caller that forgets to pass the salt gets a _wrong_ preimage from a wallet that can
derive, not an error — and that surfaces as an opaque script failure at claim time.

Every refusal is a `PreimageNotRecoverableError` carrying a `reason`: `no-secrets` (the record
predates the descriptor), `malformed-record`, `not-derivable` (nothing to derive from, or a key this
wallet does not hold), or `hash-mismatch` (derived, but wrong — a tampered salt or the wrong seed).
Branch on `reason`, never on message text. It is deliberately **not**
`RefundNotLocallyPossibleError`: that one means no local refund is possible and `RfqSwapManager`
reports `needs_counterparty` for it, which is a different verdict from a claim-path read failing.

A caller-supplied preimage keeps `signingDescriptor` for the sender key and stores only
`preimageHex` as secret material.

On an HD wallet each swap **allocates** its own descriptor rather than peeking at the current one:
two swaps sharing a descriptor derive the _identical_ preimage, so one solver learning its own
preimage would learn the other swap's. (Static wallets share their one descriptor by design — the
per-swap salt is what separates their preimages instead.) On restore, `adoptContractDescriptor`
(from `@arkade-os/sdk`) moves the wallet's watermark past a restored record's index so it cannot be
handed out twice; a static descriptor names no index and adopts as a no-op.

Two derivations, picked by the descriptor's shape:

```
HD child      sha256(sign_det(sha256("Arkade-RFQ-Preimage-v1"             ‖ xonly(32) ‖ u32le(0))))
static/salted sha256(sign_det(sha256("Arkade-Contract-Preimage-Salted-v1" ‖ xonly(32) ‖ salt(32))))
```

The first mirrors NArk's Boltz scheme (`SwapsManagementService.cs:128-160`) with an RFQ-scoped tag.
NArk has no RFQ corridor yet, so this tag defines the scheme rather than matching one; it is
deliberately distinct from the Boltz tag so one wallet key cannot derive the same preimage for both
corridors.

The salted tag is corridor-generic where the first is not, and that asymmetry is deliberate: the v1
tags must be per-corridor because v1 pins its message index, leaving the tag as the only separation
between two corridors reaching the same key. The salted form mints a fresh salt per swap, so no two
swaps share a message within a corridor or across two — the salt carries the separation, and the tag
names the layer rather than the corridor.

**Not covered:** seed-only discovery after the swap repository is wiped. An unspent L1 HTLC reveals
too little public quote data to rediscover, so the record remains required.

**Gap-limit interaction:** every swap request — including one whose quote is refused — consumes one
index from the wallet's receive stream, and a swap index never becomes a funded receive contract,
so it looks _unused_ to a seed-only `restore()` gap scan. Many consecutive swap allocations between
two funded receive indices can therefore exceed the scan's `gapLimit` (default 20) and stop it
before later-funded addresses are found. Keep the swap repository in backups (restore then adopts
each record's descriptor via `adoptContractDescriptor`), or raise `gapLimit` on seed-only restores
after heavy swap use.

## Upgrading from 0.0.3

0.0.1–0.0.3 are published. Under npm's 0.0.x rules `^0.0.3` resolves to exactly 0.0.3, so nothing
auto-upgrades into the changes below — but a consumer that does upgrade meets them all in one jump,
so they are written as one migration rather than per-release fragments.

**Key provisioning moved into the SDK.** `packages/swap/src/secrets.ts` is gone. `deriveSwapSecrets`,
`randomSwapSecrets`, `preimageForRfqSecrets`, `senderIdentityForRfqSecrets`, `rfqSecretsToRecord`,
`rfqSecretsOfRecord`, `isPerSwapDescriptor`, `RFQ_PREIMAGE_TAG` and `SwapSecrets` no longer exist.
Import `provisionRefundKey`, `provisionClaimSecret`, `contractSigner`, `contractPreimage`,
`isPerArtifactDescriptor` and `ARKADE_SWAP_PREIMAGE_TAG` from `@arkade-os/sdk` instead;
`swapSecretsToRecord` and `senderIdentityForSwapRecord` stay in this package. No consumer branches
on wallet type any more, and no swap record can carry a private key.

**`contractPreimage` takes an options object.** `contractPreimage(wallet, descriptor, stored?)`
became `contractPreimage(wallet, descriptor, { stored?, salt? })`. Prefer `preimageForSwapRecord`,
which reads both fields off the record and verifies against `paymentHash`.

**Static wallets derive their preimage instead of storing it.** New records from such wallets carry
`preimageSaltHex` and no `preimageHex`; `mustPersistPreimage` is now `false` for them, so the
"persist the preimage" warning stops firing. Nothing at rest is secret unless the signer cannot sign
deterministically at all.

**`AssetSwap` gains `preimageSaltHex?`, and `AssetSwapRepository.version` is `2`.** External
repository implementations must recompile — deliberately, because a field-mapped backend that drops
`preimageSaltHex` leaves the swap unclaimable exactly as one dropping `preimageHex` does. Records
written by 0.0.1–0.0.3 need no rewrite and no migration: the field is optional, older rows resolve
through their stored `preimageHex` or their HD descriptor, and `DB_VERSION` is unchanged.

## Breaking changes on this branch (pre-release migration notes)

Notes from before 0.0.1, kept for consumers who tracked the branch.

- **`arkadeRefunder({ ark, indexer, wallet, repository })` ships the `refundArkade` wiring** that
  was prose in two places. New export, nothing removed.
- **`rfqSwapActivityInputs({ repository, indexer })` derives `SwapActivityInput[]` from the record
  store** — the correlation helper `activity.ts` promised. `SwapActivityInput["kind"]` is now
  `RfqSwapRecord["kind"]` rather than a literal union repeating it; source-compatible. Corridor
  handlers gained an optional `activityTxids(profile)` so a leg's own claim txid comes from the
  handler instead of a kind switch. The `indexer` is optional and consulted only for what a record
  cannot answer: a record predating `fundingArkTxid`, and the counterparty's spend on a swap no
  refund of ours ended. An unreachable indexer costs that record its extra txids, never a throw.
- **`setCallbacks` takes `AvailableRfqSwapManagerCallbacks`** — `RfqSwapManagerCallbacks` with the
  two kind-gated claims optional. Nothing breaks: the strict interface is untouched and the widened
  parameter accepts every existing caller. A consumer driving one kind stops stubbing the claims it
  cannot reach; in exchange, a missing claim blocks at runtime (`needs_counterparty`, non-terminal)
  instead of being unrepresentable.
- **The repository interface is at version `4`.** It gained
  `getRfqSwap(rfqId): Promise<RfqSwapRecord | undefined>` — every backend is already keyed by
  `rfqId`, so a consumer updating one record no longer scans them all. A miss returns `undefined`;
  retention prunes terminal records, so absence is ordinary. All four in-tree backends implement it
  and `DB_VERSION` is unchanged; a custom implementor adds the two-line read and bumps its own
  `version` to `4`.
- **`RfqSwapOrigin` gained `fundingArkTxid?`** — the ark transaction that funded the lockup. It is
  origin, not manager state: the caller broadcasts the funding and knows the txid, while the manager
  watches the lockup by script and never learns it. Optional and stored whole, so no migration.
  Consumers stashing it in `profile` should move it: `profile` is merged as
  `{ ...profile, ...handler.project(swap) }` on every write, so a key a corridor also projects is
  silently overwritten.
- **`readLockupFate` names the spends it observed.** `claimed` and `returned` now carry
  `spends: readonly LockupSpend[]`, one per spent lockup output, with the `checkpointTxid` that
  `spentBy` names and the `arkTxid` that rode it. History correlation wants `arkTxid`; the
  checkpoint txid is the wrong value to correlate on alone. `unknown` and `open` claim no spend.

- **Every derived address changed again, in both corridors — the unilateral ladder was re-spaced.**
  `unilateralRefundDelay` now sits **level with** `claimDelay` instead of one 512s step above it,
  and `unilateralRefundWithoutReceiverDelay` sits `SOLO_REFUND_HEADROOM_SECONDS` (4096s, newly
  exported) above it instead of two steps. The old ladder spaced all three leaves one step apart as
  though they were interchangeable rungs; they are not. Only `unilateralRefundWithoutReceiver` is a
  solo path for the funder, so it is the only one whose timing can steal, and one 512s tick was
  never enough for a claimant to complete a unilateral exit in. The two-signature refund needs no
  separation at all, since neither party can spend that leaf alone. This tracks the reference
  solver's [lightning-swap-service#81](https://github.com/arkade-os/lightning-swap-service/pull/81);
  the two derivations must produce **the same three delay values** for the same operator, which is
  what keeps the derived addresses identical. **Deployment must be coordinated** on the same terms
  as the entry below: for a quote not yet funded, a mismatch refuses it at `verifyLockupAddress`
  rather than losing funds.

  **An in-flight lockup funded before the upgrade needs care, and the entry below understates
  this.** The delays are not quote fields and are not persisted on the swap record
  (`AssetSwap` keeps `swapPkScript`, not `claimDelay`), and `RfqSwap`'s own doc tells callers to
  *rebuild* the script on restart from the quote's binding fields — which re-derives the delays
  under whatever ladder is compiled in. So a trader who funded on `0.0.4`, upgraded, and restarted
  rebuilds a **new** address, and `refundIfUnresolved` finds no VTXOs there and returns
  `nothing_to_refund` — a terminal-sounding answer for money still locked at the old script, with
  `refundLocktime` still ticking. Until the delays are persisted and rebuilt from the stored value,
  drain in-flight lockups before upgrading, or rebuild the old script from the pre-upgrade delays
  by hand. This is a pre-existing gap that any address-moving change hits, not one this change
  introduces.

  `unilateralClaimDelay`'s BIP68 ceiling tightened to reserve the full headroom rather than two
  steps. Note this guard alone is **not** mirrored in the reference solver, which still rejects
  only above `0xffff * 512`: for an operator `unilateralExitDelay` in `(33549824, 33553920]`
  seconds the trader throws here while the solver quotes and then fails deeper in its own script
  build. Both refuse, at different seams with different messages, so it is a diagnosability wart
  rather than a fund risk — and the window is unreachable in practice (~388 days).

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
  re-derived" — caller-supplied, or minted for a static descriptor. A field-mapped backend must
  persist the record whole: silently dropping `preimageHex` leaves a static swap permanently
  unclaimable.
- **The repository interface is at version `3`.** It gained `saveRfqSwap` / `getAllRfqSwaps` /
  `removeRfqSwap` for monitored RFQ swaps, and the IndexedDB backend a matching `rfqSwaps` object
  store at `DB_VERSION` 2. Version `2` was the shape 0.0.5 released — swaps, scan cursor, markets,
  with `preimageSaltHex` on the swap record — and `DB_VERSION` was 1 there, so this is the database's
  first version increase. The bump is deliberate: an implementor must acknowledge the new methods
  rather than silently satisfy an older shape. Existing databases upgrade in place: the new store is
  added and the three original ones are untouched. **`DB_VERSION` 2 is a one-way door** — a browser
  whose database has upgraded cannot be rolled back to 0.0.5, which opens it at version 1 and fails
  `VersionError` across the whole swap store, not just the RFQ half. Store RFQ records whole for the
  same reason as above: what is in one is what nothing else can recover — the manager's own state,
  and, inside the corridor's `profile`, its keys and its gates.
- **An RFQ record's keys live in its corridor's `profile`, under two keys.** `profile.signer` holds
  `signingDescriptor` — which wallet key signs this leg, on any corridor. `profile.hashlock` holds
  `paymentHash` (the covenant binds `hash160` of it, which is one-way) plus, **only on legs we
  claim**, `preimageHex` or `preimageSaltHex`. The record's own half — `kind`, `lockupAddress`,
  `amount`, the manager's state — recovers nothing on its own, so a backend that drops either nested
  object loses the signer or the claim secret exactly as one dropping `preimageHex` used to. Two keys
  rather than one because a hashlock belongs to a corridor and a signer does not: a corridor that
  settles without a preimage still has a leg to sign and refund.

    ```ts
    // In. One call per leg, whatever that leg's provisioning produced — never
    // hand-mapped: copying `signingDescriptor` and `preimageHex` across by hand
    // drops the salt a static wallet's P derives from, and the swap is
    // unclaimable with nothing to say so until claim time.
    const record = createRfqSwapRecord(
        {
            kind: "lightning_receive",
            lockupAddress: result.address,
            profile: {
                ...rfqSecretsProfile(result.secrets, result.treeParams.paymentHash),
                expectedAmount: result.expectedAmount,
                payoutAddress: result.payoutAddress,
            },
        },
        swap,
    );

    // Out, and WHICH reader depends on the leg. The refund signer, on any leg:
    const sender = await senderIdentityForSwapRecord(wallet, rfqSignerOf(record)!);
    // P, only where we claim — `lightning_receive`, `onchain_send`:
    const claim = rfqClaimSecretOf(record);
    if (claim) await preimageForSwapRecord(wallet, claim); // hash-checked
    ```

- **`lightning_send` has a payment hash and no preimage**, so `rfqClaimSecretOf` answers `undefined`
  for it. P belongs to the payee and its descriptor is a *refund* key from `provisionRefundKey`.
  Wiring the claim helper to all three legs does not degrade gracefully: the salted arm derives
  *some* P off the refund descriptor and the payment-hash check rejects it, so a correct record reads
  as corrupt. That leg's reader is `rfqSignerOf`.
- **Non-hashlock corridors carry no `profile.hashlock` at all** — no `paymentHash`, no preimage
  material, no placeholder; the key is simply absent, which is why `rfqSecretsProfile` takes the
  payment hash as an optional second argument. They still write `profile.signer` if their leg is one
  this wallet signs. The three corridors shipping today all lock to a preimage, but that is a fact
  about them and not about RFQ. A corridor needing more than one descriptor — a co-signed leg, a
  second key for an L1 half — extends `profile.signer` rather than fabricating a hashlock.
- **Both readers answer `undefined` only for "this corridor has no such half", and throw on a half
  that is there and unusable.** Neither ever hands back a partial projection:
  `preimageForSwapRecord` verifies only when the projection carries a `paymentHash`, so one missing
  its hash would claim with an *unverified* preimage instead of failing. A thrown
  `PreimageNotRecoverableError("malformed-record")` is a storage bug, not a protocol state — treating
  it as "no preimage available" and falling back to a refund reads the two as the same thing.
- **An RFQ record stores no covenant.** The tree lives in the lockup's contract row, written before
  the address could be funded and keyed by the script its params derive — a key `createContract`
  refuses to write unless they reproduce it. So the rebuild takes the params from the caller:

    ```ts
    const params = await lockupContractParams(
        await wallet.getContractManager(),
        record.lockupAddress,
    );
    const swap = rebuildRfqSwap(record, params);
    ```

    `lockupContractParams` throws `LockupContractMissing` when this wallet has no row for the lockup —
    a cleared contract store, or a record from elsewhere. A consumer that would rather not depend on
    the contract store can keep its own copy of
    `VHTLCV2ContractHandler.serializeParams(script.options)` and pass that instead; either way the
    params are checked against the record's `lockupAddress` before a swap is handed back, so the wrong
    row fails at restore rather than at refund time.

- **Pruning is the consumer's, and nothing here does it for you.** `shouldRetainRfqSwap(record, now)`
  answers whether a record is still worth keeping — live swaps and `needs_counterparty` always,
  terminal ones for `RFQ_SWAP_RETENTION_SECONDS` (30 days) after `updatedAt`. Sweep with it at boot
  and pass the rejects to `removeRfqSwap`; skip it and a hot wallet's `rfqSwaps` store grows without
  bound. `now` is **unix seconds**, the unit `RfqSwap.updatedAt` carries — `Date.now()` would retire
  every terminal record after ~43 minutes.
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
  new arm. **Superseded:** such a caller now installs `AvailableRfqSwapManagerCallbacks` and omits
  both — see above.
