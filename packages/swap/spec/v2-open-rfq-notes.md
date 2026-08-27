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

## 5. Published RFQ Is Specified, But Still Broadcast-Then-Direct

`rfq-protocol.md` section 4.6 is the normative source for published RFQ. It
specifies the open request, sealed bid, and directed close shapes. The important
model does not change: published mode is **open -> sealed bids -> addressed close**,
not "collect N binding quotes and take the best". There is still exactly one
binding quote per negotiation, from the solver selected after the bid phase.

This matters for the v2 API spec: published RFQ can live inside `quote()` later
without changing `quote()` into a quote-array API. The main quote return shape can
stay singular; only policy, timing, and provenance need reserved space.

## 6. Resolved By `rfq-protocol.md` Section 4.6

Section 4.6 resolves the items that earlier drafts treated as missing:

1. **Payload schema** — `rfq_open` is kind 24860 plaintext and carries `open_id`,
   `pair`, `amount_side`, `amount` or `size_bucket`, optional `bids_until`, and the
   canonical market-key `t` tag shared with discovery.
2. **Privacy boundary** — an open request must not include invoice, address, or
   profile fields; the full instrument appears only in the addressed close.
3. **Bid schema** — `rfq_bid` is sealed to the opener and carries `fee_bps`,
   required `min` / `max`, `valid_until`, and one-bid-per-solver revision rules.
4. **Malformed/unserved opens** — opens are ignored rather than refused; an empty
   window is a timeout, not `SwapRefusal`.
5. **Close semantics** — the winner is closed with the existing directed RFQ flow
   using a fresh `rfq_id`, and the final quote must be no worse than the bid.
6. **Client interface direction** — published mode lives inside `requestQuote`; the
   fixed `solverPubkey` becomes optional and `selectBid` is the policy hook.

## 7. Still Open For Client/API Work

These remain real work even with section 4.6 as the protocol source:

1. **Client publisher** — the SDK has no published-RFQ publisher/subscriber path;
   shipped transports are still single-solver/direct.
2. **Policy surface** — the v2 API should reserve or name `policy.rfq`,
   `policy.selectBid`, collection deadline, and tie-breaking semantics. Addressed
   RFQ should remain the default.
3. **Provenance and persistence** — a published quote needs audit data for bids seen,
   the selected solver, and why it won; the selected-bid record should be persisted
   before any irreversible action.
4. **Timing invariants** — collection deadlines must sit inside bid validity, and the
   addressed close must still respect the winning bid's `valid_until` and the final
   quote `expiresAt`.
5. **Flat-fee corridors** — the §4.6 bid schema is `fee_bps` based, so flat-fee
   corridors still need a bidding representation.
6. **Loser notification and bonding** — losing bidders are not notified, bids are not
   bonded, and renege accountability remains reputational.
7. **Rendezvous relay set** — in practice this is likely the union of card-listed
   relays for the pair, but the SDK still needs deterministic client behavior.
8. **Responder authentication in dev transports** — production Nostr authenticates by
   author filter and conversation key; dev relay/http paths still need explicit
   attribution rules if reused for open mode.
9. **Ecosystem reality** — published mode has server-side pieces, but a second
   competing corridor solver and a general client publisher are not in regular use.

### Observed Drift Worth Fixing Independently

- The code's closed refusal set includes `rate_limited` (`rfq.ts:139-147`); the docs'
  closed set (`intents/reference/rfq.mdx` section "Refusal") lists seven reasons
  without it. Harmless today because both sides say to treat unknown reasons as a
  generic decline, but the docs' "closed set" is stale against the shipped type.

## 8. Implications For The V2 Spec

The v2 surface remains correctly singular: `Quote.solver?: Pubkey` is the committed
counterparty, `resolve()` selects one market when discovery is available, and
`quote()` returns one verified `Quote`. Published mode can slot inside `quote()` as
open -> collect sealed bids -> select -> addressed close -> return that one quote.
The accurate statement is therefore **no main `quote()` return-shape change is
required**, not that published RFQ has no caller-visible API at all.

The API spec should reserve/defer the caller-visible additions needed for published
mode: RFQ mode policy, bid selection policy, bid timing, and auction provenance. It
can still ship addressed-only first against the current client implementation.
