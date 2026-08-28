# Arkade Swap v2: RFC-lite

One page to agree on direction before the detail. Full spec: `v2-api-spec.md`. RFQ research companion: `v2-open-rfq-notes.md`. Reply by ID: "P3 concern", "Q1: prefer X".

## The pitch

The v2 client takes a route and returns an outcome. A route is two endpoints, asset on a corridor, exactly as the Intents docs already define them. The caller states give and take; the client resolves the market, picks the contract, decodes, seals, funds with the right packet, persists first, watches, claims, refunds. Every bolded warning in the current integration docs becomes an inference or an invariant. What stays visible is what cannot be hidden: the terms, the one artifact a counterparty must see, and the outcome.

## Before and after

```ts
// v1: pick the kind, the market, the decoder, the sealing key, the fund field
const ln = markets.find((m) => m.quote_corridor === "lightning");
const q = await client.quote(ln, { kind: "ln_send", invoice: toInvoiceFacts(bolt11) });
await client.accept(q);          // then read payment.fundAmount, not the invoice amount

// v2: state the route; the client does the rest
await client.accept(await client.quote({ give: BTC, to: bolt11 }));                                  // ln send
await client.accept(await client.quote({ give: BTC, take: USDT, amount: 1_000_000n, amountOn: "give" })); // asset swap
const r = await client.quote({ take: BTC, via: "lightning", amount: 50_000n, amountOn: "take" });    // ln receive
showToPayer(r.artifact.bolt11); await client.accept(r);
await client.accept(await client.quote({ give: BTC, to: "bc1p...", amount: 100_000n, amountOn: "take" })); // onchain send
```

## Proposals

| ID | Proposal | Why | Breaks |
|---|---|---|---|
| P1 | Route replaces `kind` and `family`: `quote` takes two endpoints; the implemented surface is a closed union of supported routes. `onchain -> arkade` is future work and returns `UnsupportedRoute` during `resolve()` / `quote()` for now. | kills the resolveKind misroute class; SDK finally speaks the Intents docs' language | `SwapQuoteInput` kinds, `family` |
| P2 | Radical inference: caller supplies assets or one destination string, one amount plus its side, optionally a corridor on receives; market, backend, transport, decoding, sealing, funding packet, claim, and refund are inferred | each of those was a documented way to lose money | `requestLightning*`, `createOffer` as the integration path |
| P3 | Public asset ids are CAIP-19, with one BTC id across corridors; `bigint` is the in-memory amount type and decimal strings are the storage/RFQ boundary. Discovery/RFQ/NArk mappings are compatibility adapters, not caller API. | one id space; deletes the units footgun | display-amount inputs |
| P4 | No required `start()`: `drive: "auto"` is the default, optional `start()` / `stop()` exist for manual control, and `drive: "readonly"` remains inspection-only. Disposal is terminal cleanup for the client instance; durable records and wallet registrations stay recoverable. | live-swaps-unwatched becomes unreachable without hiding lifecycle control from daemons, tests, and mobile apps | required `start()` / `stop()` choreography |
| P5 | `cancel` typed to asset swaps only; corridors decompose into quote expiry, timelocked refund, and lapse | matches the leaf table; corridors have no cancel right | `cancel` on corridor ids |
| P6 | One trader-centric `Outcome` enum with replay-on-subscribe; `refunded` always means value back, receive-leg solver reclaim is `lapsed`; raw protocol states on `detail` | protocol words swap meanings across directions; UIs must not render a loss green | the `status`/`state` ternary |
| P7 | v1 building blocks demoted to `/protocol`: exported one more major, removed from integration docs | solvers and terms-showing apps keep a floor | soft |
| P8 | PR #793 settles the ownership shape: product-facing swap UX belongs on `createSwapClient` in `@arkade-os/swap`, not on core `IWallet`. Spark-style verbs are direct methods on that swap facade. | keeps `@arkade-os/sdk` usable without the swap package while preserving low-friction product APIs | none |
| P9 | Browser persistence defaults to IndexedDB; Node persistence for real swaps defaults to file-backed SQLite using the existing swap SQLite repository. In-memory storage is explicit ephemeral/test mode only. | recovery depends on durable state; Node defaults must not silently lose active swaps | implicit in-memory Node storage |
| P10 | Base v2 uses addressed RFQ. Published RFQ is specified by `rfq-protocol.md` section 4.6 and can later slot inside `quote()` as open -> sealed bids -> addressed close, without turning the return value into a quote auction. | avoids mixing current shipped behavior with future multi-bid policy | none if deferred/reserved |

## Open questions

| ID | Question |
|---|---|
| Q1 | Naming: `lapsed` for the receive-leg loss? `give`/`take` versus `from`/`to`? |
| Q2 | `resolve()` can parse routes offline, but market/solver selection needs discovery. Should a missing discovery snapshot return a partial route, throw `DiscoverySnapshotUnavailable`, or make construction warm discovery? |
| Q3 | What exact manual lifecycle shape do we want: always-present idempotent `start()` / `stop()`, or methods only exposed in manual mode? What are `client.ready` failure semantics? |
| Q4 | Is one major version of `/protocol` re-exports a long enough migration window? |
| Q5 | What registry-backed alias/canonicalization rules map public CAIP-19 ids back to discovery/RFQ/NArk shapes such as `arkade:BTC->lightning:BTC`? |
| Q6 | Should the Arkade Service URL come from a new neutral core wallet/provider API, or should swap keep an explicit endpoint config until that exists? |
| Q7 | Public third-party corridor plugins need parser, quote, persistence, restoration, observation, action, deadline, and outcome hooks together. Is that a v2 goal or internal-only for now? |
| Q8 | Built-in BOLT11 decoding becomes an SDK guarantee. Which decoder and validation rules own amountless invoices, expiry, payment hash, and network checks? |
| Q9 | Which reserved published-RFQ API names survive: `policy.rfq`, `policy.selectBid`, `Quote.auction`, and bid timing/provenance fields? |

## Decisions (M0)

Recorded when the corresponding spec text landed; rationale in `v2-m0-groundwork.md`.

- **P1–P10: ratified as a set** as the fixed public direction for v2. No amendments.
- **Q4: one major version.** `/protocol` re-exports with `@deprecated` pointers live for exactly one major version, then are removed from the root export.
- **Q7: internal-only for v2.** Corridor modules are internal modularity plus dependency overrides; the public third-party plugin API is a deferred track, re-entered once the full manager registration contract exists.
- **Q9: freeze the reserved set.** `policy.rfq`, `policy.selectBid`, `Quote.auction`, and bid timing/provenance fields are the complete published-RFQ surface scoped into v2 — typed, inert; nothing beyond them.
- **Q1: ratified.** `give`/`take`, `lapsed` — no rename.
- **Q2: throw.** `resolve()` without a discovery snapshot throws `DiscoverySnapshotUnavailable`; no partial route shape (§3.1).
- **Q3: as drawn.** Always-present idempotent `start()`/`stop()`; `client.ready` rejects only on an unreadable repository — per-record and per-swap problems surface as outcomes, never construction failures (§3).
- **Q5: swap-package alias layer.** Tickers case-insensitive, network-scoped, collisions rejected; arkade asset identity form round-trips byte-for-byte; NArk divergence documented in §2/FAQ.
- **Q8: `light-bolt11-decoder`.** Swap-package dependency behind the lightning corridor's overridable `decode`; validation rules in §6.
- **Q4, Q6, Q7, Q9: open/deferred** per `v2-m0-groundwork.md` (Q6 tracks PR #803).

## Decision Boundaries / TODOs

- Supported routes, lifecycle/disposal, Node SQLite durability, and accept idempotency are specified in `v2-api-spec.md`; this RFC only records the decision.
- Published RFQ payload/privacy/dedup/close semantics are not open here; they are owned by `rfq-protocol.md` section 4.6. Client implementation, policy naming, provenance, and timing integration remain TODOs.
- EVM, BOLT12 offers, cooperative corridor cancel, public third-party corridor plugins, and `onchain -> arkade` support stay deferred.

## What agreement unlocks

Sign-off on P1 through P6 fixes the public client direction. PR #793 is the implementation precursor for the swap facade, while PR #738 is the package-boundary precedent: core owns reusable wallet/key primitives, swap owns swap orchestration and product-facing swap UX. The integration docs shrink to the four lines above.
