# Arkade Swap v2: RFC-lite

One page to agree on direction before the detail. Full spec: `v2-api-spec.md`. Reply by ID: "P3 concern", "Q1: prefer X".

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
| P3 | CAIP-19 ids, one BTC across every corridor, arkade assets under bip122; `bigint` atomic in memory, decimal strings at rest and at RFQ boundaries. During RFQ migration, the adapter accepts current safe-number quote fields and refuses unsafe narrowing. | one id space; deletes the units footgun | display-amount inputs |
| P4 | No required `start()`: `drive: "auto"` is the default, optional `start()` / `stop()` exist for manual control, and `drive: "readonly"` remains inspection-only. Disposal is terminal cleanup for the client instance; durable records and wallet registrations stay recoverable. | live-swaps-unwatched becomes unreachable without hiding lifecycle control from daemons, tests, and mobile apps | required `start()` / `stop()` choreography |
| P5 | `cancel` typed to asset swaps only; corridors decompose into quote expiry, timelocked refund, and lapse | matches the leaf table; corridors have no cancel right | `cancel` on corridor ids |
| P6 | One trader-centric `Outcome` enum with replay-on-subscribe; `refunded` always means value back, receive-leg solver reclaim is `lapsed`; raw protocol states on `detail` | protocol words swap meanings across directions; UIs must not render a loss green | the `status`/`state` ternary |
| P7 | v1 building blocks demoted to `/protocol`: exported one more major, removed from integration docs | solvers and terms-showing apps keep a floor | soft |
| P8 | Wallet-style verbs (`pay`, `receive`, `exchange`, Spark-shaped) ship from `@arkade-os/swap` as client methods or a wallet-shaped wrapper; they are not required methods on core `IWallet`. | keeps `@arkade-os/sdk` usable without the swap package while preserving low-friction product APIs | none |
| P9 | Browser persistence defaults to IndexedDB; Node persistence for real swaps defaults to file-backed SQLite using the existing swap SQLite repository. In-memory storage is explicit ephemeral/test mode only. | recovery depends on durable state; Node defaults must not silently lose active swaps | implicit in-memory Node storage |

## Open questions

| ID | Question |
|---|---|
| Q1 | Naming: `lapsed` for the receive-leg loss? `give`/`take` versus `from`/`to`? |
| Q2 | `resolve()` can parse routes offline, but market/solver selection needs discovery. Should a missing discovery snapshot return a partial route, throw `DiscoverySnapshotUnavailable`, or make construction warm discovery? |
| Q3 | What exact manual lifecycle shape do we want: always-present idempotent `start()` / `stop()`, or methods only exposed in manual mode? What are `client.ready` failure semantics? |
| Q4 | Is one major version of `/protocol` re-exports a long enough migration window? |
| Q5 | CAIP-19 with one BTC id is a deliberate divergence from NArk/current discovery shapes. What registry-backed alias/canonicalization rules map it back to existing market pair strings such as `arkade:BTC->lightning:BTC`? |
| Q6 | Should the Arkade Service URL come from a new neutral core wallet/provider API, or should swap keep an explicit endpoint config until that exists? |
| Q7 | Public third-party corridor plugins need parser, quote, persistence, restoration, observation, action, deadline, and outcome hooks together. Is that a v2 goal or internal-only for now? |
| Q8 | Built-in BOLT11 decoding becomes an SDK guarantee. Which decoder and validation rules own amountless invoices, expiry, payment hash, and network checks? |

## Warnings / TODOs

- WARNING: `await using` is scoped cleanup, not pause/resume syntax. Disposal releases timers, streams, subscriptions, listeners, and callbacks and makes that client instance unusable. It must not delete swap records, wallet contract registrations, or recovery metadata.
- WARNING: `onchain -> arkade` must stay unsupported until the manager owns the trader's L1 refund path end to end. Throw `UnsupportedRoute` before RFQ disclosure, artifact creation, persistence, or funding.
- TODO: Make `accept(quote)` idempotent by quote id or deterministic accept id. Duplicate accepts must return or resume the same record, and recovery must reconcile evidence before any possible funding retry.
- TODO: Reuse `packages/swap/src/repositories/sqlite/repository.ts` for Node durability; a Node executor can follow `config/test-helpers/nodeSqlExecutor.ts` but use a file path rather than `:memory:` for real swaps.
- TODO: Keep swap orchestration in `packages/swap`; promote only generally useful wallet/key primitives into `packages/ts-sdk`.

## Deferred, deliberately

EVM corridor (spec §9 draft), BOLT12 offers, cooperative corridor cancel, public third-party corridor plugins, the exact swap-verb wrapper API, and `onchain -> arkade` support. None of these blocks agreement on P1 through P6.

## What agreement unlocks

Sign-off on P1 through P6 fixes the public client direction. PR #793 remains relevant as an engine precursor inside `@arkade-os/swap`, while PR #738 is the useful package-boundary precedent: core owns reusable wallet/key primitives, swap owns swap orchestration and product-facing swap UX. The integration docs shrink to the four lines above.
