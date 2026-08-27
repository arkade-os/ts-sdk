# Open RFQ Model: Research Notes for the v2 API Spec

Status: research companion to [`v2-api-spec.md`](./v2-api-spec.md). Records what the
swap package and the Intents docs actually establish about the RFQ model — directed
vs open, multi-solver quoting, best-quote selection — and inventories what an open
model still needs. Code citations are `path:line` against ts-sdk `master` (70879f5);
docs citations are page paths in the `arkade-os/docs` repo (6087a4a).

---

## 1. The question

Does the Intents RFQ model let **multiple solvers quote the same request**, with the
client **collecting several quotes and picking the best**? And if so, where does the
v2 client surface — which resolves *one* market, commits *one* solver, and returns
*one* `Quote` — leave room for it?

## 2. Short answer

The protocol defines **two request modes**; only one is shipped, and **neither is
"collect N binding quotes, take the best"**:

| Mode | Audience | Selection | Status |
|---|---|---|---|
| **Addressed** (`rfq_request`) | One solver, NIP-44-encrypted to its discovery key | The application selects the solver *before* requesting terms | **Shipped** — the only mode in use |
| **Published** (`rfq_open`) | Every solver watching the pair (plaintext, market-key-tagged) | Solvers return **sealed bids**; the application selects one bid and **closes with an addressed request** to that solver | **Work in progress** — no client publisher exists |

(`intents/reference/rfq.mdx` §"Addressed and Published Requests";
`intents/reference/implementation-status.mdx` — "General publisher not shipped".)

So:

- **Multiple solvers quoting one request — today: no, structurally.** The request is
  encrypted to a single solver's key; no other solver can read it, let alone answer.
- **Multiple solvers responding to one request — future: yes, but with bids, not
  quotes.** In published mode, N solvers may return sealed bids. A bid is "signed and
  attributable but not bonded"; it is **not binding**.
- **Best-quote selection — never, in either mode.** The client (future) selects among
  *bids*, then closes bilaterally with the winner; "the signed quote returned by the
  selected solver is the binding RFQ message" — there is always exactly **one binding
  quote per negotiation**, from one solver. Selection is broadcast-then-direct, not a
  quote auction.

## 3. Evidence: the shipped model is directed at every layer

**Transport construction.** The production Nostr transport is built for exactly one
solver: `nostrRfqTransport` takes a single `solverPubkey` (the market card's
`discovery_pubkey`), derives one NIP-44 conversation key from it at construction
(`packages/swap/src/nostr.ts:147-155`), p-tags only that key on the outbound
kind-24859 event (`nostr.ts:201-202`), and the kind constant is literally named
`RFQ_DIRECTED_KIND` (`nostr.ts:42`). The dev transports are the same shape:
`httpTransport(baseUrl)` POSTs to one solver's endpoint (`rfq.ts:502-514`);
`relayTransport` requires `options.solverPubkey` and stamps every envelope
`recipient: options.solverPubkey` (`rfq.ts:538-546, 596-607`).

**Reply path.** The reply subscription filters `authors: [solverPubkey]`
(`nostr.ts:171`) — no other solver's answer can reach the client — and any event past
the filter must still decrypt under the fixed conversation key (`nostr.ts:176-179`).
One waiter per `rfq_id`; the first matching reply resolves it and deletes it, later
replies are dropped (`nostr.ts:161-165, 221-233`). The 30 s default timeout is a
no-reply *failure*, cleared on the first reply — not a gathering window
(`nostr.ts:68, 217-219`).

**Contract.** `RfqTransport.requestQuote` returns `Promise<RfqQuote>` — one quote
(`rfq.ts:432-436`). No quote array, comparator, ranking, collection window, or
fan-out exists anywhere in the package (swept: `rfq_open`, `rfq_bid`, `24860`,
`Quote[]`, `bestQuote`, `selectQuote`, `allQuotes`, `Promise.race` over transports —
zero hits). The only price control is a unilateral ceiling: `maxPayAmount` rejects
the single quote as `price_too_high` (`rfq.ts:1472-1477`); repricing the fixed side
is refused (`rfq.ts:1342-1353`). Persistence models one negotiation → one record
(`rfqRecord.ts:141-153`): no schema for candidate bids or chosen-among-several.

**Discovery.** Selection happens *before* the request. `findMarket` collapses the
discovered card set to a single market per pair via `bestMarket` — return type
`{ market: DiscoveredMarket | null }`, never a list (`markets.ts:205-217`). Registry
indexes list multiple solvers per pair "with the best `fee_bps` first"
(`intents/get-discovered.mdx`), which the docs immediately downgrade: ranking is
"only a static proxy", re-ranking by fill history is application policy, and
"Discovery enables competition. It does not guarantee best execution."
(`intents/reference/discovery.mdx`.)

**Tests pin all of this.** No test anywhere constructs two solvers, two quotes for
one `rfq_id`, or any comparison; every fixture transport resolves one scripted quote
from one fixed solver key.

## 4. Two nuances that must not be conflated with an open RFQ

1. **The intra-Arkade *fill* is open; the *quote* is not.** The offer covenant names
   no solver pubkey and the TLV rides the funding tx "so a solver can discover it
   from the txid alone" (`offer.ts:64-79, 137-139`): any compatible solver can fill,
   first spend wins. But that competition is at *settlement of an already-priced
   swap* — the price came from one selected card's feed. The docs flag the pure
   latency race as a fairness problem with batching/commit-reveal/pro-rata as future
   work (`intents/reference/future-work.mdx`). On the HTLC corridors even the fill is
   closed: the quoted `solver_pubkey` is baked into the VHTLC covenant
   (`rfq.ts:907, 1136, 1586, 1813`), so only the quoting solver can ever fill.

2. **Responder identity is enforced by the production transport, not by the client
   check.** `expectQuote` validates type, `rfq_id`, and pair — it never compares the
   quote's self-declared `solver_pubkey` against the configured solver
   (`rfq.ts:458-470`), and that field is bound straight into the covenant. On the
   production Nostr path this is safe: the `authors` filter, the per-solver
   conversation key, and the Schnorr event signature jointly authenticate the
   responder. On the dev `relayTransport`/`httpTransport` there is no author check at
   all — first frame with a matching `rfq_id` wins (`rfq.ts:574-580`). Any open mode
   inherits this problem *by construction*: with N unknown responders, attribution
   must come from each bid's own signature, not from transport addressing.

## 5. Even the future is broadcast-then-direct — and deliberately bounded

The docs do not aspire to an unbounded quote auction. `rfq_open`/`rfq_bid` payloads
are **deliberately unspecified** ("Pinning field names before an implementation
exists would publish a schema that the first working publisher then contradicts");
the client publisher is tracked as
[arkade-os/ts-sdk#725](https://github.com/arkade-os/ts-sdk/issues/725); the reference
deployment bids only on Lightning sends, flat-fee bids skipped. And
`intents/reference/future-work.mdx` argues open broadcast *degrades* quote quality
(winner's curse, information leakage) and points instead at **bounded
client-selected panels of a few solvers, deadline-based selection, and
post-selection exclusivity**. The relay explicitly "does not select a solver,
aggregate quotes, or touch funds."

## 6. Missing pieces for the published mode

### Wire / protocol

1. **Payload schemas** — `rfq_open` and `rfq_bid` have no specified fields: no bid
   contents, no expiry/sealing semantics, no reply-window ("bid-by") field; the
   interplay between a bid's validity and the closing quote's `valid_until` is
   undefined.
2. **Privacy of the broadcast payload** — kind 24860 is plaintext, but the current
   corridor request profiles carry the full BOLT11, `payment_hash`, refund/payout
   addresses and client pubkeys. Reusing those shapes in an `rfq_open` would expose
   amount, destination, and linkable keys to every relay observer. A redacted or
   two-phase payload (amount-only open request; full instrument only in the
   addressed close) is needed and unspecified.
3. **Bid fade / renege** — nothing ties the closing quote to the winning bid's terms;
   bids are unbonded; negotiation kinds are ephemeral with no relay retention, so
   there is no record from which to build accountability or fill-history reputation.
   Bonds/staking are separately listed as future work.
4. **Spam/DoS** — every plaintext `rfq_open` forces quote computation on all watching
   solvers; no proof-of-work, rate limit, or admission control is specified.
5. **Rendezvous** — directed mode takes its relays from the chosen solver's card; open
   mode has no canonical per-market relay set, and with ephemeral kinds and no
   store-and-forward, "every solver watching the pair" is only "every solver on the
   same relays at that instant". The canonical market key tag is referenced but its
   derivation is not documented.
6. **Bid revision/dedup** — no semantics for a solver revising or retracting a bid,
   and no dedup-by-author rule; a first-event-wins waiter would take whichever copy
   arrives first.
7. **`quote_conflict`** is listed in the refusal set with no defined multi-quote
   semantics; concurrent parallel *addressed* negotiations (one client, N solvers, N
   `rfq_id`s) are neither forbidden nor described anywhere.
8. **Provisional wire** — kinds 24859/24860/38859 are unregistered; the design reuses
   one solver key for transport and settlement identity (transport-key delegation is
   future work).

### Client / SDK

9. **The "one-line client change" is understated.** `rfq.mdx` claims "dropping the
   transport's `solverPubkey` is the entire client change", but the shipped transport
   derives a *single* conversation key at construction, hard-filters
   `authors: [solverPubkey]`, and delivers through a single-resolver
   `Promise<RfqQuote>`. Hearing N bidders needs per-event conversation-key derivation
   from each bid's author, an author-admission policy replacing the fixed filter, and
   a multi-value delivery contract (callback or async iterator) — an interface
   change, not a dropped parameter.
10. **Bid collection and selection surface** — no collection window, ranking policy,
    tie-breaking, or deadline semantics exist anywhere; selection is "application
    policy" with no reference implementation.
11. **Persistence** — `RfqSwapRecord` has no shape for candidate bids or for auditing
    which solver was chosen among several.
12. **Discovery surface** — nothing returns *all* cards for a pair; `bestMarket`'s
    ranking rule lives in the external `@arkade-os/solver-discovery` package (not
    vendored here, unverifiable from this repo); cards carry no reputation or
    fill-history data a client could rank on.
13. **Ecosystem reality** — one closed-source, pinned corridor solver (onboarding by
    email); zero solvers serve Lightning receive; open-source `solverd` fills asset
    swaps but does no RFQ. A second competing corridor solver does not exist yet.

### Observed drift (worth fixing independently)

- The code's closed refusal set includes `rate_limited` (`rfq.ts:139-147`); the docs'
  closed set (`intents/reference/rfq.mdx` §Refusal) lists seven reasons without it.
  Harmless today (both sides say to treat unknown reasons as a generic decline), but
  the doc's "closed set" is stale against the shipped type.

## 7. Implications for the v2 spec

The v2 surface as drafted is single-solver-shaped: `Quote.solver?: Pubkey` is "the
committed counterparty" (singular), `resolve()` returns one `{ route, market,
solver? }`, `quote()` returns one `Quote`, and `policy.selectMarket` is a *veto*.
That is **correct for the shipped protocol** and — because even published mode ends
in one addressed close and one binding quote — it remains the right *return* shape
after the open mode ships. The published mode slots **inside** `quote()`:
publish → collect sealed bids → select → addressed close → return the one verified
`Quote`. No caller-visible type changes.

What the spec does *not* yet say, and should decide:

1. **Mode selection is policy.** Whether a given `quote()` runs addressed (to the
   resolved card's solver) or published (to the pair's watchers) is a disclosure
   decision: published mode shows the request to the world, which cuts directly
   against the spec's own `resolve()`-without-disclosure design goal. This wants a
   policy knob (e.g. `policy.rfq: "addressed" | "published" | "panel"`), defaulting
   to addressed, and per §5 above the docs' own direction is *panel* (bounded N),
   not unbounded broadcast.
2. **Bid selection is the missing policy hook.** `selectMarket` vetoes a market;
   nothing in the spec ranks *bids*. A `policy.selectBid` (or a default: best
   take-amount after fees, earliest tie-break) plus a collection deadline belongs in
   `policy` next to the quote-TTL floor.
3. **Provenance widens.** `Quote.market: MarketRef` documents which card priced the
   quote. Under published mode the honest provenance is "which bids were seen,
   which won, why" — an audit artifact the spec's provenance stance implies but its
   types don't carry (e.g. `Quote.auction?: { bids: BidRef[]; selected: Pubkey }`).
4. **Persist-first extends to the auction.** The spec's persist-before-irreversible
   invariant should cover the selected-bid record, both for support ("why this
   solver") and for any future reputation layer, since the wire itself retains
   nothing.
5. **Timing invariants.** The spec asserts refund-window sanity per quote; a panel
   adds cross-quote clocks: the collection deadline must sit safely inside every
   collected bid's validity, and the close must still respect the winner's
   `valid_until`. "Calling accept after `expiresAt` is `QuoteExpired`" already
   covers the tail; the head (bid deadline semantics) is unspecified protocol (§6.1).

None of this blocks v2 as drafted: the spec can ship addressed-only against the
current protocol, provided it reserves the policy surface (`rfq` mode knob,
`selectBid`, auction provenance) so that published mode lands as a policy + internal
change — which is exactly the layering the protocol docs promise, minus their
optimistic "one line".
