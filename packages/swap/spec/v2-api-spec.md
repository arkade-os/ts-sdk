# Arkade Swap SDK v2: High-Level API Spec

Status: proposal. Breaks the documented v1 surface deliberately.
Scope: `@arkade-os/swap` public API and the product-facing verbs exported by the swap package.
Out of scope: contract scripts, solver behavior, and RFQ protocol design. Published RFQ is specified by `rfq-protocol.md` section 4.6; this spec ships addressed RFQ first and reserves the client policy/provenance space for published mode. Adapter compatibility during the RFQ amount migration is called out where it affects the SDK boundary.

---

## Press release

The v2 swap client takes a route and returns an outcome. A route is two endpoints, each an asset on a corridor, exactly as the Intents protocol defines them. The caller states what they give and what they take; the client resolves the market, picks the settlement contract, decodes and verifies instruments, funds with the correct packet, persists before anything irreversible, watches, claims, and refunds. Everything the v1 integration pages told the caller to do by hand, and warned them about in bold, is now an inference or an invariant. What survives on the surface is what cannot be hidden: the terms of the quote, the one artifact a counterparty must see, and the outcome.

---

## 1. Layers

| Layer | Package | Vocabulary | Audience |
|---|---|---|---|
| Intents protocol | wire + contracts | route, endpoint, corridor, RFQ, offer | solvers, auditors |
| Swap client (this spec) | `@arkade-os/swap` | route, quote, accept, outcome | app developers |
| Swap verbs | `@arkade-os/swap` client facade | pay, receive, withdraw, exchange | product developers |

The protocol layer is authoritative and unchanged. The v1 building blocks (`requestLightningSend`, `createOffer`, `pushClaim`, `refundIfUnresolved`, `watchOfferSwaps`, ...) are demoted to `@arkade-os/swap/protocol`: still exported, no longer documented as the integration path. The client is built on them; solvers and advanced integrators keep them.

The core `@arkade-os/sdk` package stays usable without `@arkade-os/swap`. PR #793 answers the ownership shape: product-facing swap UX extends `createSwapClient` in the swap package, not core `IWallet`.

---

## 2. Core types

```ts
/** CAIP-19. One BTC across every corridor; Arkade assets under bitcoin's chain id. */
type AssetId = string;
// "bip122:000000000019d6689c085ae165831e93/slip44:0"                    BTC
// "bip122:000000000019d6689c085ae165831e93/arkade:<genesis_txid>.<idx>" Arkade asset
// Tickers ("BTC", "USDT") are accepted as aliases and canonicalized via the registry.

type Corridor = "arkade" | "lightning" | "onchain";
type CorridorId = Corridor | `eip155:${number}`;   // known corridor ids; §9 is draft-only

/** An endpoint is an asset on a corridor, plus the instrument that settles it. */
interface Endpoint {
  corridor: CorridorId;
  asset: AssetId;
  instrument: Instrument;          // resolved by the client, never constructed by callers
}

type Instrument =
  | { kind: "wallet" }                                   // the client's Arkade wallet:
                                                         //   balance on give, payout address on take
  | { kind: "address"; address: string }                 // named external locus: Arkade, onchain, or EVM (§9)
  | { kind: "invoice"; bolt11: string; paymentHash: Hex; // Lightning payment request
      amount?: bigint; expiresAt: number };
```

Decision/TODO: the public API uses one CAIP-19 BTC id across corridors. That is an intentional API simplification, not direct NArk compatibility by type shape. Current discovery uses names such as `btc`, and NArk models Ark, Lightning, and onchain BTC as distinct corridor assets. V2 needs a registry-backed alias/canonicalization layer that maps the public CAIP-19 endpoint ids back to today's market pair strings, for example `arkade:BTC->lightning:BTC`.

An instrument is the leg's concrete settlement locus on its corridor; direction comes from give versus take, not from the instrument. `{ kind: "wallet" }` is the only instrument the SDK holds signing authority over, which is why it is the only one nobody passes: `accept()` acts on wallet legs (spend the balance, land the claim) and merely watches the others. The supply law: the caller provides non-wallet take instruments, which is what `to` is; the quote provides non-wallet give instruments, which is exactly what the artifact is; every remaining slot resolves to `wallet`. The variant is explicit rather than an absent field because absence would mean two unrelated things, wallet-by-default versus not-yet-resolved, and receive legs live in the second state until the quote returns.

```ts
/**
 * The implemented routes, as a closed union. An unsupported corridor pair is an
 * `UnsupportedRoute` during resolve/quote and a type error once a route has
 * been resolved into this value.
 * Serialized as the protocol pair string: "arkade:BTC->lightning:BTC".
 */
type Route =
  | { give: Ep<"arkade">;    take: Ep<"arkade"> }        // asset swap (offer covenant)
  | { give: Ep<"arkade">;    take: Ep<"lightning"> }     // corridor swaps:
  | { give: Ep<"lightning">; take: Ep<"arkade"> }        // paired HTLCs,
  | { give: Ep<"arkade">;    take: Ep<"onchain"> };      // BTC on both legs
```

WARNING/TODO: `onchain:BTC -> arkade:BTC` is deliberately not in the implemented route union yet. It must return `UnsupportedRoute` during `resolve()` / `quote()`, before RFQ disclosure, artifact creation, persistence, or funding, until the manager owns the trader's L1 refund path end to end.

Amounts are `bigint` atomic units everywhere in this API. There is no display-amount code path. `Amount.parse("0.01", asset)` and `Amount.format(n, asset)` exist for UI code and are the only place decimals appear. Records and target wire forms serialize amounts as decimal strings, as v1 records already do; `bigint` is the in-memory law, not a storage format. This deletes the documented v1 footgun where `100000` meaning sats quoted 100,000 BTC.

RFQ compatibility note: the target RFQ contract is decimal strings for request and quote amounts, but current services may still emit safe JSON number quote fields during migration. The v2 adapter should parse canonical decimal strings, accept JSON numbers only when they are non-negative safe integers, emit decimal strings where the RFQ protocol expects them, and refuse unsafe `bigint` narrowing with a typed compatibility error.

---

## 3. Client surface

```ts
const client = createSwapClient({
  wallet,                          // IWallet; endpoint inference needs a neutral core API
  arkServerUrl?,                   // TODO: explicit fallback until that core API exists
  repository?,                     // default: IndexedDB in browser, file-backed SQLite in Node
  discovery?,                      // default: network + registry inferred from wallet's network
  corridors?,                      // overrides only; see §6
  policy?,                         // maxFee ceilings, allowed registries, quote TTL floor,
                                   // selectMarket veto, drive: "auto" | "manual" | "readonly";
                                   // published-RFQ names reserved/deferred: rfq, selectBid
});

// No required start(). In drive:"auto", construction runs one restore-read and
// arms live resources only when live swaps exist or on first accept(). quote()
// never drives swaps or opens watcher streams; it only performs quote/discovery work.
await client.ready;                // restore-read done; if it armed, the first pass ran
client.start(): Promise<void>      // idempotent; required only by drive:"manual"
client.stop(): Promise<void>       // releases live resources; instance remains reusable
await using _ = client;            // terminal cleanup; durable records/registrations remain

client.quote(input: QuoteInput): Promise<Quote>
client.accept(quote: Quote): Promise<Swap>
client.cancel(swapId: AssetSwapId): Promise<{ outcome: "cancelled" | "filled" }>
client.swaps(filter?): Promise<Swap[]>          // full history, both contract kinds
client.onUpdate(fn: (u: SwapUpdate) => void): Unsubscribe
client.markets(): Promise<Market[]>             // escape hatch; never required

// Product-facing verbs on the same swap facade; §5 expands these.
client.pay(destination: string, opts: PayOptions): Promise<Swap>
client.receive(opts: ReceiveOptions): Promise<ReceiveRequest>
client.exchange(opts: ExchangeOptions): Promise<Swap>
```

Lifecycle. Work arms the drive by default, never the caller's memory. Construction performs one background restore-read of the repository. In `drive: "auto"`, live swaps found by that read start the manager, run one immediate pass because a resumed swap may already be past a deadline, then hold the poll loop; if no live swaps exist, nothing runs until `accept()` supplies new work. In `drive: "manual"`, construction restores state but does not open timers or streams until `start()` is called. In `drive: "readonly"`, the client restores and reports but never actuates, honoring the read-without-driving consumer the manager's own restore/start split was designed for. The poll loop is the correctness mechanism, deadline-gated claims and refunds ride on it; the contract-event subscription is a latency optimization that only makes a pass run early, so dropping it is always safe.

`stop()` releases the live resources owned by this instance while leaving the instance reusable. `[Symbol.asyncDispose]` is stronger: it releases timers, streams, subscriptions, listeners, callbacks, and process-local loop state, then makes the client instance terminal. It must not delete durable swap records, wallet contract registrations, or recovery metadata; constructing a new client restores and resumes from that state. Double arming is a no-op, so React double-mounts and concurrent callers are safe. Concurrent drivers on one seed are wasteful, not unsafe: every push is evidence-gated, the first refund attempts are expected-refused by design, and a losing race reconciles as an outcome the same way cancel reconciles a fill.

Storage. Browser defaults to IndexedDB. Node defaults for real swap operation should be file-backed SQLite, reusing `packages/swap/src/repositories/sqlite/repository.ts`; the `node:sqlite` executor can follow `config/test-helpers/nodeSqlExecutor.ts` but use a file path rather than `:memory:`. In-memory storage remains available only through an explicit ephemeral/test mode. TODO: choose the default Node database path and ownership rules for closing a client-created SQLite connection.

TODO: define exact `client.ready` failure semantics, especially for corrupt records, missing corridor dependencies, and a first restore pass that produces `needs_recovery`.

### 3.1 `quote(input)`

```ts
interface QuoteInput {
  give?: AssetId;                  // omitted when `to` fully determines it
  take?: AssetId;
  to?: string;                     // self-describing instrument: bolt11 | Arkade addr | bc1...
  via?: CorridorId;                // receive flows only: names the corridor when no
                                   // instrument can exist yet
  amount?: bigint;
  amountOn?: "give" | "take";
}
```

Resolution, in order. `to` is parsed once, at this boundary: a bolt11 yields the lightning corridor and an invoice instrument; an Arkade address yields arkade; a bitcoin L1 address yields onchain; anything ambiguous throws `AmbiguousDestination` here and nowhere else. `via` covers the receive case where the instrument does not exist yet. The corridor pair selects the `Route` variant; the pair `(give.asset, take.asset, corridors)` selects the market from the discovery index; the market card selects the backend, feed-priced or RFQ, per the protocol rule that the market picks the backend. Exactly one amount is pinned: by the caller via `amount` + `amountOn`, or by the invoice when one is present. Pinning a second one is `AmountMismatch`, thrown before any network round trip.

Resolution is also available without new disclosure: `client.resolve(input)` performs the same parsing and returns the resolved route when possible, so application policy can veto before an RFQ round trip discloses an invoice or an amount. Market and solver selection are network-free only against injected or cached discovery data. If no discovery snapshot is available, the client must either return an unresolved route shape or throw `DiscoverySnapshotUnavailable`; TODO: choose one result shape before implementation. `quote()` runs the same veto internally through `policy.selectMarket`, may fetch discovery as part of the quote path, and every `Quote` carries its market provenance for audit.

RFQ mode. Base v2 uses addressed RFQ: the client selects one market card/solver, sends one directed request, and returns one binding `Quote`. `rfq-protocol.md` section 4.6 specifies published RFQ as open request -> sealed bids -> addressed close with a fresh `rfq_id`; that can live inside `quote()` later without turning the return value into a quote array. The public surface should reserve, but not yet require, names for `policy.rfq`, `policy.selectBid`, bid timing, and `Quote.auction` provenance.

The returned `Quote` is the order, fully resolved:

```ts
interface Quote {
  id: QuoteId;
  route: Route;                    // both endpoints resolved, instruments included
  give: { asset: AssetId; amount: bigint };    // exact obligation, fee included
  take: { asset: AssetId; amount: bigint };    // exact obligation
  lock?: { hash: Hex };            // corridor routes: the HTLC hash
  market: MarketRef;               // provenance: which card priced this, from which registry
  solver?: Pubkey;                 // RFQ routes: the committed counterparty
  auction?: AuctionProvenance;      // published RFQ only; TODO exact shape
  expiresAt: number;               // quote TTL; corridor routes also carry
  refundLocktime?: number;         //   the non-optional-in-type refund bound
  artifact?: Artifact;             // §3.4: the one thing a counterparty must see
  fee: { amount: bigint; asset: AssetId };     // the spread, precomputed
}
```

The client verifies every quote against the request before returning it: pair match, locally derived contract address match, invoice consistency, refund window sanity. v1 documented the pair check as the caller's job in bold. In v2 a solver response that fails any check is a `QuoteVerificationError`, and a solver declining is still `SwapRefusal` with its reason.

### 3.2 `accept(quote)`

One call, one contract: persist the full record and secrets first, then fund, then update the record with the funding txid. `accept(quote)` is idempotent by quote id or by a deterministic accept id derived from the quote. Once an accept record exists, later calls with the same quote return or resume that record; they must not create a new swap, a new invoice, or a second funding attempt. If funding may have happened but the txid is missing, recovery reconciles from wallet/indexer/contract evidence before any funding retry.

The crash windows are part of the contract: before persistence, retry is a normal first accept; after persistence but before funding, retry resumes the existing record and can still expire safely; after funding but before txid persistence, retry reconciles from evidence before moving value; after txid persistence, the drive loop resumes from the saved record. Receive routes follow the same rule: on `lightning -> arkade`, `accept(quote)` arms persistence and the claim watcher, and the payer paying `quote.artifact.invoice` is the acceptance. A duplicate accept returns the same valid artifact/invoice rather than minting a second one.

The offer extension packet is attached by the client on asset-swap routes; the v1 failure mode of funding without the extension is unrepresentable. On `arkade -> lightning` and `arkade -> onchain`, accept funds the lockup and the caller can go offline; recovery is the client's job. On `arkade <-> arkade`, accept creates and funds the offer. Calling accept after `expiresAt` is `QuoteExpired`; the client never silently re-quotes.

### 3.3 `cancel(swapId)`

Defined only for asset swaps, and typed that way: `cancel(id: AssetSwapId)`, with a corridor-swap id rejected as `NotCancellable` at runtime for ids that arrive untyped from `swaps()`. The asymmetry is structural, not a policy choice. An offer covenant has no expiry, so cancellation is the only exit an unfilled offer has, and the deposit's return path is available to the trader for as long as no fill lands. Cancellation races a fill; when the deposit is already spent, v2 reconciles the spending transaction and returns `{ outcome: "filled" }` instead of throwing, because v1's documented throw-means-completed behavior was a trap.

An HTLC corridor swap has no cancel, only phases. Before funding, abandonment is free: the quote expires and nothing was committed. After funding, the contract's exits are a claim or a refund. The covenant does carry a cooperative no-timelock refund leaf (trader + solver + server), but no protocol message exists to request the solver's signature for it, and any future one must be gated on the solver not having paid out yet, since a cooperative refund after the invoice is paid is theft from the solver. After `refundLocktime`, taking the value back is not cancellation but the recovery the client already drives, surfacing as `refunding` then `refunded`. Receive legs cancel by inaction: an unpaid invoice expires, an unclaimed lockup returns to the solver on its own timeout, and both sides unwind without a message. A cooperative corridor cancel is therefore a protocol extension (an RFQ message pairing the refund leaf with a payout-gated solver co-sign), not an SDK flag, and this spec does not offer it.

### 3.4 Artifacts

Some routes have exactly one thing a counterparty must see. It is a first-class field, not a loose property:

```ts
type Artifact =
  | { kind: "invoice"; bolt11: string }        // lightning receive: show to the payer
  | { kind: "deposit"; corridor: CorridorId; address: string;
      asset: AssetId; amount: bigint; expiresAt?: number;
      chain?: string | number };               // future inbound corridors, including §9
```

Everything else that v1 exposed around the artifact, sealing keys, preimages, claim scripts, is internal. TODO: finalize the deposit artifact before inbound corridors ship; the shape above is intentionally broad enough to cover the EVM draft without under-specifying expiry, asset, or chain identity.

### 3.5 Updates and outcomes

The protocol keeps two state vocabularies, asset-swap contract states and RFQ wire states. That stays true and stays internal. The client performs the translation the protocol docs assign to the application layer, once, for everyone:

```ts
type Outcome =
  | "accepted" | "funding" | "funded" | "open"
  | "filled" | "claimed" | "paid"
  | "cancelling" | "cancelled"
  | "refunding" | "refunded" | "lapsed" | "needs_recovery"
  | "failed";

interface SwapUpdate { swap: Swap; outcome: Outcome; detail: RawState }
```

Outcomes are trader-centric by definition, because the protocol's own words swap meanings across directions: on a receive leg, the state named `refunded` is the solver taking back a lockup the trader failed to claim, a loss. This enum refuses to inherit that trap. `refunded` only ever means the trader's value came back; the receive-leg solver reclaim is `lapsed`; and `detail` preserves the protocol's untranslated vocabulary for support and audit.

`family` does not exist. `u.family === "offer" ? u.swap.status : u.swap.state` was the translation shipped to every consumer; it is now this enum. `detail` carries the raw protocol state for debugging and support. Subscribing replays the current outcome of every live swap before streaming transitions, and delivery is idempotent per swap and outcome, which retires the double-notify class the v1 wiring allowed. `needs_recovery` is surfaced, never retried silently, matching the protocol's returned-not-retried rule; `client.recover(swapId)` drives it after the wallet's VTXO recovery.

---

## 4. What is inferred, and from where

This table is the spec's center. "v1" is the currently documented integration surface.

| Concern | v1: caller's job | v2: inferred from |
|---|---|---|
| Kind / dispatch (`spot`, `ln_send`, ...) | pick the function, pick the kind | corridor pair of the parsed route |
| Market | `discoverMarkets` + `findMarket` by hand | `(give.asset, take.asset, corridors)` against the discovery index |
| Backend (feed-priced vs RFQ) | implicit in which function you called | the market card; a card change, never a client change |
| Transport | hand-build `nostrRfqTransport({relays, solverPubkey})` | the card's relays and discovery pubkey |
| Quote-pair verification | manual `quote.pair !== ...` check, documented in bold | always verified; mismatch is a typed error |
| Invoice decoding | caller builds `InvoiceFacts`, passes `decodeInvoice` | built-in decoder in the lightning corridor; caller passes the bolt11 string |
| Take amount on lightning send | read `quote.to_amount` | pinned from the invoice; equality asserted |
| Funding amount | read `payment.fundAmount`, "read the field, not the number" | `accept()` funds internally with the quote's give amount |
| Offer extension packet | attach `extensions: [offer.extension]` or the deposit is invisible | attached by `accept()` on asset-swap routes |
| Record assembly + persistence | build `AssetSwap` by hand, call `addAssetSwap` | internal; persist-first is an invariant, not advice |
| Sealing key (`covclaimdPubkey`) | generate an ephemeral key with noble, discard it | internal ephemeral seal by default; a covclaimd deployment key is optional config on the lightning corridor |
| `amountSide: "to"` | caller | `amountOn: "take"`, one vocabulary for both contract kinds |
| Refund locktime | `quote.refund_locktime!` non-null assertion | non-optional in the corridor-quote type; consumed by the watcher |
| Claim | `awaitLockupFunding` + `contractSigner` + `contractPreimage` + `pushClaim` + `expectedAmount` | automatic on funding; expected amount is the order's take amount; short-funded lockups still refuse to reveal the preimage |
| Refund | `refundIfUnresolved` with seven hand-fed parameters | automatic after `refundLocktime`; surfaces as `refunded` or `needs_recovery` |
| Preimage persistence | check `secrets.mustPersistPreimage` | internal |
| Arkade Service URL | config parameter | wallet via a neutral core endpoint API; explicit config remains until that exists |
| Emulator key | optional parameter | resolved from the operator; override retained |
| Repository | required parameter | browser IndexedDB; Node file-backed SQLite; injectable; in-memory only as explicit ephemeral/test mode |
| Units | display strings with a documented footgun | `bigint` atomic at the API; RFQ adapter serializes decimal strings and accepts safe-number quotes only during migration |
| Status vocabulary | ternary on `family` | one `Outcome` enum; raw state on `detail` |
| Watcher lifecycle | required `start()` after construction, `stop()` on teardown | `drive:"auto"` starts itself when restore finds live swaps or on first `accept`; optional manual `start()`/`stop()` provide deterministic control; async disposal is terminal cleanup and registrations survive |

The caller supplies, at most: two asset ids or one destination string, one amount, which side it pins, and optionally a corridor for receives. Nothing else.

---

## 5. Swap verbs

PR #793 settles the ownership shape: the product-facing layer is the `createSwapClient` facade exported by `@arkade-os/swap`. These verbs extend that facade; they are not required methods on core `IWallet`, and `@arkade-os/sdk` stays useful without the swap package installed.

```ts
const swaps = createSwapClient({ wallet });

await swaps.pay(destination, { amount?, maxFee? });
// bolt11        -> arkade:BTC -> lightning:BTC   (amount from invoice)
// bc1...        -> arkade:BTC -> onchain:BTC     (amount required)
// Arkade addr   -> plain Arkade transaction      (no swap; not this SDK's concern)

const r = await swaps.receive({ amount, via: "lightning" });
showToPayer(r.artifact.bolt11);
// lightning:BTC -> arkade:BTC; claim is automatic while online

await swaps.exchange({ give: "BTC", take: "USDT", amount, amountOn: "give", maxFee? });
// arkade <-> arkade asset swap
```

Each verb compiles to a `QuoteInput`, calls `quote`, checks `quote.fee` against `maxFee`, and calls `accept`. `maxFee` exceeded rejects before funding with the quote attached, so the app can re-present. The verbs add no capability; they subtract vocabulary. A product integrating payments never sees the words route, corridor, market, or quote, and Lightning is what it has always been to a wallet user: BTC, paid or received.

---

## 6. Corridors as modules

Each corridor owns its parse claim over destination strings, its instrument type, its deps, and its settlement watcher. Defaults ship for all three; `corridors` in the client config is for overrides only.

| Corridor | Default deps | Overridable |
|---|---|---|
| arkade | wallet, operator stream | repository |
| lightning | built-in BOLT11 decoder, ephemeral sealing | decoder, covclaimd deployment key |
| onchain | Arkade-provided chain source | chain source (esplora URL) |

```ts
interface CorridorOverrides {
  arkade?:    { repository?: SwapRepository };
  lightning?: { decode?: (bolt11: string) => InvoiceFacts;
                covclaimd?: { pubkey: CompressedHex } };  // default: ephemeral self-claim seal
  onchain?:   { chain?: { esploraUrl: string } };
}
```

Override semantics. An override replaces a dependency inside an implemented corridor module; it never enables a route (the closed `Route` union and discovered markets own that), never selects a solver or transport (the market card owns that), and never alters settlement behavior. Every override is a named trust anchor: the chain source is whose L1 view reconcile-from-evidence runs against, the decoder is who validates an invoice before display, the covclaimd key is who may open the sealed claim packet, the repository is where persist-first lands. Each defaults to the wallet, the operator, or a built-in, so the config key can be absent entirely; explicitly overriding a dep to nothing surfaces as `MissingCorridorDep` at quote time, before funding.

WARNING/TODO: dependency overrides are not yet a safe public third-party corridor plugin API. A corridor cannot be registered externally unless parsing, quoting/RFQ adaptation, persistence, restoration, observation, actions, deadline semantics, and outcome translation are registered together. Until that manager contract exists, §6 should be read as internal modularity plus dependency overrides.

Future corridors such as BOLT12 offers as reusable lightning instruments or an EVM corridor with `eip155` asset ids appear as new `Route` variants in a minor version only after that full contract exists. EVM configuration is therefore draft-only in §9, not part of `CorridorOverrides`.

TODO: built-in BOLT11 decoding is now an SDK guarantee. The lightning corridor must define decoder choice and validation rules for amountless invoices, expiry, payment hash extraction, and network checks.

---

## 7. Errors

```ts
type SwapError =
  | AmbiguousDestination       // "0x..." or otherwise underdetermined `to`
  | UnsupportedRoute           // corridor pair unsupported, including onchain -> arkade for now
  | DiscoverySnapshotUnavailable // resolve() needs market data but has no injected/cached snapshot
  | AmountMismatch             // two pinned amounts, or amount vs invoice conflict
  | AmountEncodingUnsupported  // RFQ migration would require unsafe bigint narrowing
  | QuoteVerificationError     // solver response fails local derivation or pair check
  | SwapRefusal                // solver declined, with reason (protocol type, retained)
  | QuoteExpired
  | MaxFeeExceeded             // verbs layer; carries the quote
  | InsufficientFunds          // v1's validatePlan, run internally before accept
  | AcceptConflict             // quote id maps to an incompatible persisted accept record
  | ClientDisposed             // method called after async disposal
  | NotCancellable             // cancel() on a corridor swap; only asset swaps cancel (§3.3)
  | InconsistentRoute          // destination disagrees with an asset's chain (§9)
  | MissingCorridorDep;        // e.g. onchain route with chain source overridden to null
```

Every error is thrown before value moves or not at all; post-funding problems are outcomes, not exceptions. `AcceptConflict` is only for incompatible durable evidence, not ordinary duplicate `accept(quote)`, which returns or resumes the original swap.

---

## 8. Deprecations

| v1 surface | v2 disposition |
|---|---|
| `requestLightningSend` / `requestLightningReceive` | internal to `quote`/`accept`; exported from `/protocol` |
| `createOffer` + manual `wallet.send` + `addAssetSwap` | internal to `accept` |
| `watchOfferSwaps`, RFQ manager wiring | internal; `drive:"auto"` arms when live work exists, optional manual `start()`/`stop()` remains for explicit control |
| `awaitLockupFunding`, `pushClaim`, `contractPreimage` plumbing | internal claim path |
| `refundIfUnresolved` | internal recovery; `client.recover` for `needs_recovery` |
| `cancelOffer` | `client.cancel`, fill race reconciled |
| `quoteOffer`, `validatePlan`, `QUOTE_OPTIONS`, `makeCachedFeedFetch` | internal pricing path |
| `findMarket` in the happy path | `client.markets()` escape hatch only |
| `InvoiceFacts` as a caller-built input | internal; bolt11 strings at the boundary |
| `SwapQuoteInput` kinds / flat bag | `QuoteInput` + closed `Route` union |
| `family` on updates | deleted; `Outcome` + `detail` |
| `amountSide: "to"` | `amountOn: "take"` |
| required lifecycle `start()` / `stop()` choreography | no required start; optional manual control; async disposal is terminal cleanup |
| `arkServerUrl` config | wallet/provider-derived only after a neutral core API exists; explicit config remains until then |
| display-amount inputs | `bigint` + `Amount.parse`; RFQ adapter serializes decimal strings |

Deprecated does not mean deleted: one major version of re-exports from `/protocol` with `@deprecated` pointers, then removal from the root export.

---

## 9. EVM corridor, worked end to end (extension draft)

Not in the closed union yet. This section is the reference for adding it, and a proof that the seams in §2 and §6 hold: a new corridor is a parser, an instrument, deps, a watcher, and new `Route` variants. Nothing else in the client changes shape.

### 9.1 Identifiers and routes

```ts
type EvmCorridor = `eip155:${number}`;                 // "eip155:8453" = Base
type CorridorV2  = CorridorId;

const BTC       = "bip122:000000000019d6689c085ae165831e93/slip44:0";
const USDT_ARK  = "bip122:000000000019d6689c085ae165831e93/arkade:<genesis_txid>.<idx>";
const USDC_BASE = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Added Route variants. Both are corridor swaps; unlike the bitcoin corridors,
// the two legs carry different assets, which the market key already permits.
type RouteV2 = Route
  | { give: Ep<"arkade">;    take: Ep<EvmCorridor> }   // arkade -> EVM, solver direct-fills
  | { give: Ep<EvmCorridor>; take: Ep<"arkade"> };     // EVM -> arkade, deposit artifact
```

Three rules govern everything below. For an `eip155` asset the corridor is implied by the chain id inside the asset; nobody passes it. An EVM account never determines an asset, any token lives at any address, so `take` is required on EVM sends; this is the one asymmetry against bitcoin corridors, where the corridor implies BTC. And a bare `0x...` is `AmbiguousDestination` always: accepted destination forms are CAIP-10 (`eip155:8453:0xAbC...`) or `{ chain, address }`. A destination whose chain disagrees with the take asset's chain is `InconsistentRoute`, thrown at the parse boundary before any network round trip.

### 9.2 Configuration

```ts
// Draft-only extension config. Final public corridor plugin shape is still open.
const client = createSwapClient({
  wallet,
  corridorExtensions: {
    evm: {
      chains: { 8453: { rpc: "https://mainnet.base.org", confirmations: 1 } },
    },
  },
});
```

The dependency is a read-only RPC per chain. There is no signer, no key, no gas concept anywhere in this SDK. Outbound fills are solver-direct to the recipient address, and inbound deposits are sent from the user's own EVM wallet, outside this SDK by design. A quoted route whose chain has no configured RPC is `MissingCorridorDep`.

### 9.3 Send: arkade BTC to USDC on Base, exact-out

```ts
const q = await client.quote({
  give: BTC,
  take: USDC_BASE,
  to: "eip155:8453:0xAbC...123",
  amount: 250_000_000n,          // 250 USDC atomic; the recipient's exact obligation
  amountOn: "take",
});
// Inferred: give corridor arkade (wallet instrument), take corridor eip155:8453
// (from the asset), market from (BTC, USDC_BASE, corridors), backend RFQ from
// the card, lock hash from the wallet, fillDeadline from the quote TTL.
// q.give.amount is the BTC owed with the fee inside; q.fee is precomputed.

const swap = await client.accept(q);   // persist first, fund the lockup, go offline
// accepted -> funding -> funded -> filled
```

Settlement is direct-fill: the solver transfers USDC straight to the recipient, and the watcher verifies the token `Transfer` receipt on chain 8453 against token, recipient, amount, and the fill reference, at the configured confirmation depth, before emitting `filled`. The recipient needs zero gas and zero interaction. No fill by `refundLocktime` runs the same recovery as the bitcoin corridors: `refunding` then `refunded` on the arkade side. Reconcile-from-evidence applies unchanged: an RPC timeout is unknown, never `failed`.

### 9.4 Deposit: USDC on Base to arkade USDT

```ts
const q = await client.quote({
  give: USDC_BASE,               // corridor eip155:8453 implied by the asset
  take: USDT_ARK,
  amount: 100_000_000n,          // 100 USDC
  amountOn: "give",
});

showDeposit(q.artifact);
// { kind: "deposit", corridor: "eip155:8453", chain: 8453,
//   address: "0x...", asset: USDC_BASE, amount: 100_000_000n, expiresAt }

const swap = await client.accept(q);   // arms persistence and the watcher
// The deposit itself is the acceptance: accepted -> open -> funded -> claimed
```

This is the structural mirror of lightning receive. No accept message crosses the wire; the counterparty-visible artifact is a deposit instruction instead of a hold invoice; `accept` arms persistence and watching; and the funding action happens in a wallet this SDK does not control. The `deposit` artifact kind reserved in §3.4 is this route's irreducible piece.

### 9.5 Swap verbs

```ts
await swaps.pay("eip155:8453:0xAbC...123", {
  take: USDC_BASE,               // required: EVM destinations name no asset
  amount: 250_000_000n,
  maxFee,
});

const d = await swaps.receive({ via: "eip155:8453", asset: USDC_BASE, amount: 100_000_000n });
showDeposit(d.artifact);
```

`pay` grows exactly one field, and only on EVM destinations; the compile error when `take` is missing is the API teaching the asymmetry. Everything else, `maxFee` ceiling, quote and accept collapsed inside, rejection-with-quote on an exceeded ceiling, is identical to §5. The verbs still come from the swap package client facade, not core `IWallet`.

### 9.6 Inference additions

| Concern | Inferred from |
|---|---|
| EVM corridor | chain id inside the `eip155` asset or CAIP-10 destination |
| Chain | the asset id; the destination must agree or `InconsistentRoute` |
| `take` asset on EVM sends | never inferred; required by rule |
| Fill verification | token `Transfer` receipt on the corridor RPC, confirmations policy |
| Gas | nonexistent: direct-fill sends, user-wallet deposits |
| Deposit artifact | the quote, exactly like the hold invoice |

---

## FAQ

**Why is it acceptable to break the documented surface?**
Because the documentation is currently a list of ways to lose money: fund without the extension and nobody indexes your deposit, read the wrong amount field and overpay, skip the pair check no transport does for you, forget that cancel-throwing means the swap completed. Each of those sentences is a caller obligation that should have been an invariant. v2 converts the warnings into code; the break is the point.

**Why keep two-step quote/accept at the client layer when Spark hides it?**
Because the layers serve different people. An exchange UI must show terms before commitment; a checkout flow must not. The client keeps the honest two-step; the verbs collapse it behind `maxFee`. Deleting the two-step from the client would force every terms-showing app back down to `/protocol`.

**Does v2 require published RFQ?**
No. Base v2 uses addressed RFQ because that is the shipped client behavior. `rfq-protocol.md` section 4.6 specifies published RFQ, but the client publisher and API policy names are deferred/reserved: `policy.rfq`, `policy.selectBid`, bid timing, and `Quote.auction` provenance.

**Why is the invoice still visible at all?**
It is the one irreducible artifact: the payer needs it, and no abstraction changes that. v2's move is to make it the only visible piece of lightning receive, with the sealing key, preimage, and claim removed from the surface around it.

**Why a closed `Route` union instead of `Corridor x Corridor`?**
The full product contains pairs no contract implements. An open type forces runtime classification, and the v1 classifier already misroutes a mixed onchain-to-lightning market. The closed union makes unimplemented pairs unrepresentable after resolution and turns adding a corridor profile into an explicit, reviewable type change. Runtime `QuoteInput` still validates strings and throws `UnsupportedRoute`; `onchain -> arkade` deliberately stays in that bucket until the L1 refund leg is owned end to end.

**Why `bigint` only?**
The current docs dedicate a bold paragraph to the display-versus-atomic trap. A high-level API that needs a warning about its number types has the wrong number types. Conversion still exists; it is just spelled `Amount.parse`, where a reviewer can see it. The RFQ adapter carries any temporary safe-number compatibility during migration; callers never get a display-number path back.

**Does this change the trust model?**
No. Derive locally, persist first, reconcile from evidence remain exactly the protocol's rules; v2 relocates their enforcement from documentation into the client. Registries and cards remain advisory, quotes remain solver-signed and short-lived, and a quote that disagrees with local derivation still dies before funding.

**Why are swap verbs not required methods on `IWallet`?**
Because package direction matters. Core wallet primitives belong in `@arkade-os/sdk`, but swap orchestration, solver discovery, artifacts, route UX, and outcome translation belong in `@arkade-os/swap`. PR #793 sets the direction: product code uses the swap package's client facade, and core wallet consumers do not inherit a swap dependency.

**What about assets on other networks?**
The asset id layout is already CAIP-19 with room reserved: `eip155` assets imply their own corridor, arkade assets live under bitcoin's `bip122` chain id, and BTC is a single id on every corridor. New networks are new corridor modules and new `Route` variants, not new client shapes; §9 is the worked instance. TODO: define the canonical alias map from CAIP-19 ids to current discovery and RFQ pair strings, and document the deliberate divergence from NArk's corridor-specific BTC asset model.

**Why does an EVM send require `take` when a bolt11 requires nothing?**
Instruments differ in how much they self-describe. An invoice pins the asset, the amount, the deadline, and the settlement hash; an EVM account pins only a chain. The API mirrors that gradient instead of papering over it: the invoice-shaped call takes one argument, the account-shaped call takes three, and the extra arguments are exactly the information the instrument failed to carry.
