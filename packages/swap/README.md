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
   `updateAssetSwap`), thin helpers over an `AssetSwapRepository`. Read failures degrade to an
   empty list; write failures throw so pre-funding records can be retried before money is sent.
4. **`restore`** — `restoreAssetSwaps` rebuilds lost records by scanning sent virtual txs for
   offer packets and binding each funding vtxo to its spend. Incremental: answered txids are
   remembered in the repository (`getScannedTxids`/`markTxidsScanned`) so nothing is fetched
   twice.
5. **`rfq`** — the maker / intent-submitter side of quoted swaps: RFQ negotiation over HTTP or a
   relay, then non-interactive filling (see below). Covers `arkade:BTC|asset -> lightning:BTC`
   (implemented against the reference solver), `arkade:BTC|asset -> arkade:BTC|asset` (quote,
   then take by funding an offer from layer 1), and the onchain corridor below.
6. **`onchainHtlc`** — the Bitcoin-L1 side of `arkade:BTC <-> onchain:BTC`: a NUMS-keyed taproot
   HTLC as pure local derivation (golden-pinned), claim/refund spend builders with signing as a
   callback, the injected `ChainSource` seam (the package holds no L1 backend and no keys),
   preimage extraction from a spend's witness, and crash-recovery classification.
   `claimPacket` seals P to covclaimd for the on-board direction.

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
await wallet.send({ address: swap.address, amount: BigInt(swap.fundAmount) });
```

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
await wallet.send({ address: swap.address, amount: BigInt(swap.fundAmount) });

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

**On-board (`onchain:BTC -> arkade:BTC`) is milestone 2 and partially gated.** The wire request
(`onchainReceiveRequest`), the L1 HTLC (roles swapped: the solver claims, the maker refunds) and
`sealClaimPacket` (P sealed to covclaimd so the maker can go offline after funding) are in place.
The missing piece is verifying the solver-funded Arkade VHTLC locally before funding L1, which
requires the SDK's non-interactive-claim API — not merged upstream yet (`arkade-os/ts-sdk#613`);
the one-call on-board flow lands when it is. Until covclaimd's reference vectors are
cross-checked, the `sealClaimPacket` test vector is pinned from this implementation and marked
provisional (`TODO(claim-packet-vectors)`).

## RFQ secrets are derived, not stored

The two secrets an RFQ swap needs — the VHTLC `sender` key and, for an onchain send, the preimage —
are functions of the wallet seed plus one HD-allocated descriptor. The record keeps the descriptor,
which is public, so a copied browser profile or a device backup yields nothing spendable.

```ts
const swap = await requestOnchainSend(/* … */);
swap.secrets; // { derivable: true, signingDescriptor } — persist it, it holds no secret
await saveSwap({ ...record, ...rfqSecretsToRecord(swap.secrets) });

// Later, from the seed plus that descriptor:
const preimage = await preimageForRfqSecrets(wallet, rfqSecretsOfRecord(record)!);
const sender = await senderIdentityForRfqSecrets(wallet, rfqSecretsOfRecord(record)!);
```

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

## Breaking changes on this branch (pre-release migration notes)

The package is pre-release; these notes replace a changelog for consumers tracking the branch.

- **`requestLightningSend` / `requestOnchainSend` return `secrets`, not top-level raw key material.**
  `senderPrivateKey` is gone from both return types; caller-owned onchain preimages live inside
  `secrets` and must be persisted with the record. `pushRefundWithoutReceiver` /
  `refundIfUnresolved` take `sender: Identity` instead of `senderPrivateKey: Uint8Array` — build
  it with `senderIdentityForRfqSecrets`. `AssetSwap` gains `signingDescriptor?`,
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
- **`lightningSendProgram` and `htlcSendProgram` are gone** along with the program-artifact layer
  they compiled. Derive scripts through `lightningSendVtxoScript` / `onchainHtlcScript`.
- **`lightningSendVtxoScript` takes two new required fields**: `senderPubkey` (the trader's VHTLC
  sender key — generate, persist, see `requestLightningSend`) and `receiverPkScript` (the solver's
  claim destination, from `profile.receiver_pk_script`). Callers that built the lockup directly
  must supply both; callers going through `requestLightningSend` are unaffected.
