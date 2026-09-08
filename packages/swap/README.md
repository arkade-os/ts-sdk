# @arkade-os/swap

The swap client for [Arkade Intents](https://arkade.money). You state a route — what to give,
what to take, and where the value ends up — and the client resolves the market, picks the
contract, decodes the destination, seals the secret, funds with the right packet, persists before
it watches, claims, and refunds. Framework-free TypeScript over `@arkade-os/sdk`: no DOM and no
Node-specific APIs in the core, so it runs in Node, the browser and React Native alike.

```ts
import { createSwapClient, IndexedDbAssetSwapRepository } from "@arkade-os/swap";

const client = createSwapClient({ wallet, repository: new IndexedDbAssetSwapRepository() });
```

Construction is synchronous and inert: no network, no wallet read, no repository open. The first
call that needs one does it.

Market discovery needs no configuration either: the client defaults to the reference solver
registry's index for the wallet's network (`REGISTRY_URL[network]`, exported). Follow your own
registry instead with `discovery: { registryUrl }`, or opt out of registries entirely with
`discovery: { registryUrl: null }` — `discovery: { snapshot }` resolves against a fixed market
list without touching the network.

## The four routes

Each is one `quote` → `accept` chain. `quote` returns binding, verified terms and touches nothing
durable; `accept` writes the record, then funds.

```ts
const BTC = btcOn("arkade", "bitcoin"); // arkade:bitcoin/slip44:0
const USDT = "arkade:bitcoin/asset:…";

// arkade -> lightning: pay an invoice. The amount is the invoice's.
await client.accept(await client.quote({ give: BTC, to: bolt11 }));

// arkade -> arkade: swap one asset for another.
await client.accept(
    await client.quote({ give: BTC, take: USDT, amount: 1_000_000n, amountOn: "give" }),
);

// arkade -> onchain: withdraw to a bitcoin address.
await client.accept(
    await client.quote({ give: BTC, to: "bc1p…", amount: 100_000n, amountOn: "take" }),
);

// lightning -> arkade: receive. The artifact is the invoice the solver minted.
const r = await client.receive({ via: "lightning", amount: 50_000n });
showToPayer(r.artifact.bolt11);
```

The receive is the one route that is not a two-step, and the asymmetry is deliberate. Its
artifact is an invoice whose claim secret has to be durable before a payer can act on it, so
`receive` returns only after `accept` has persisted. Reaching for `quote` and reading the invoice
off it would show a payer an invoice this client could not yet claim; the verb removes the
ordering from the caller.

`onchain -> arkade` is not in the union. It resolves and quotes to `UnsupportedRoute` until the
client owns the trader's L1 refund path end to end.

An `arkade -> onchain` withdrawal claims the solver's L1 HTLC itself, and that claim's miner fee
comes out of the HTLC output — so the client grosses the take leg up by the claim's cost and the
recipient nets exactly the `amount` written, with the estimate folded into the reported `fee`. The
claim is built and broadcast by the client itself once the fill is claimable, signed by the
wallet's payout key and priced off a per-network fee-rate floor
(`discovery`/corridor overrides aside, that floor is the only environment-specific input). A
routing UI should raise it in congestion — the claim has a consensus deadline — via
`corridors: { onchain: { claimFeeRateSatVb } }`; set it to `null` to take the claim over manually
(the drive then reports the L1 half as your job rather than blocking it). Wire your own builder
with `corridors: { onchain: { claim } }` and it wins over the default.

### One call instead of two

`pay`, `receive` and `exchange` are `quote` → fee ceiling → `accept`, and add no capability the
client did not already have. What they add is the ceiling; what they subtract is vocabulary — a
product integrating payments never types the words route, corridor, market or quote.

```ts
await client.pay(destination, { amount: 50_000n, maxFee: { amount: 500n, asset: BTC } });
await client.receive({ via: "lightning", amount: 50_000n });
await client.exchange({ give: BTC, take: USDT, amount: 1_000_000n, amountOn: "give" });
```

`pay` takes any of the four destination forms — a bolt11 invoice, a bitcoin address, an Arkade
address, or a BIP21 URI carrying one of them — and exactly one corridor claims each. A plain
Arkade address is not a swap and does not become one: same asset, same rail, rate 1. It returns a
txid and no swap id, which is why `PayResult` has two arms.

Omit `amount` exactly when the destination pins it. An amount-bearing invoice does; passing one
beside it is `AmountMismatch` rather than a silent preference.

## Asset ids and amounts

Asset ids are CAIP-19 with the rail as the CAIP-2 namespace, `<rail>:<network>/<namespace>:<ref>`.
`arkade`, `bolt11` and `bitcoin` are the implemented rails, and BTC has one id per rail. Use
`btcOn(rail, network)` and `arkadeAsset(network, id)` rather than writing the strings, and
`canonicalAssetId` when the input is human:

```ts
const asset = canonicalAssetId("BTC", {
    network: "regtest",
    assets: [{ ticker: "BTC", id: "arkade:regtest/slip44:0" }],
});
```

Ticker matching is case-insensitive, scoped to the wallet's network, and refuses a collision
instead of guessing.

Amounts are `bigint` atomic units everywhere inside the client. Decimal strings exist at two
boundaries and mean different things at each: display decimals (`"0.001"`) belong to the UI, atomic
decimals (`"100000"`) belong to records and RFQ payloads. `Amount.parse` and `Amount.format` cross
the first; the client crosses the second itself.

## Watching, history and cancelling

There is no required `start()`. The client reads its repository once — `await client.ready` is
that read — and arms the drive when it finds live work, or on the first `accept` when it does
not. `start()` and `stop()` exist for manual control; `stop()` is a pause, not a cancellation, and
disposal is terminal cleanup that leaves every durable record and wallet registration recoverable.

```ts
const off = client.onUpdate(({ swap, outcome, detail }) => render(swap.id, outcome, detail));

const live = await client.swaps({ outcome: "funded" });
const { outcome } = await client.cancel(swapId);
const result = await client.recover(swapId);
```

`onUpdate` replays the current outcome of every swap it knows, then streams transitions, keyed on
the derived outcome so a legal backslide is delivered once. `Outcome` is one trader-centric
vocabulary across both families: `refunded` always means the value came back and a receive-leg
solver reclaim is `lapsed`, never the same word. The protocol's own state string is on `detail`
for logs.

`cancel` is typed to asset swaps, because that is where a cancel right exists. Corridor swaps
decompose into quote expiry, a timelocked refund and a lapse instead. A cancel that loses the race
to a fill reports the fill rather than throwing.

## Errors

Sixteen classes, each a condition noun, all reachable from the root; `SWAP_ERROR_NAMES` is the
complete list. `SwapRefusal` is the solver declining — a decision, not a fault — and it is the one
member the protocol layer owns. Everything else names what the client refused and why:
`UnsupportedRoute`, `AmbiguousDestination`, `AmountMismatch`, `QuoteExpired`, `MaxFeeExceeded`,
`InsufficientFunds`, `QuoteVerificationFailed`, `NotCancellable`, `ClientDisposed`,
`MissingCorridorDep` and the rest.

## Storage backends

| Backend                        | Import from                           | For                                             |
| ------------------------------ | ------------------------------------- | ----------------------------------------------- |
| `InMemoryAssetSwapRepository`  | `@arkade-os/swap`                     | tests, one-shot scripts — nothing survives exit |
| `IndexedDbAssetSwapRepository` | `@arkade-os/swap`                     | the browser (or a polyfilled IndexedDB)         |
| `SQLiteAssetSwapRepository`    | `@arkade-os/swap/repositories/sqlite` | React Native, over your SQLite driver           |
| `RealmAssetSwapRepository`     | `@arkade-os/swap/repositories/realm`  | React Native, over your Realm instance          |
| `nodeSwapRepository()`         | `@arkade-os/swap/node`                | Node — file-backed SQLite, opened for you       |

There is no implicit default and never an in-memory fallback: accepting a swap with nowhere to
write it is the silent loss the rule exists to forbid, so `accept` refuses with
`MissingCorridorDep("arkade", "repository")` instead. In-memory is available, explicitly, which is
the only way ephemeral storage is on the table.

Neither React Native subpath adds a dependency — they take the SDK's structural `SQLExecutor` and
`RealmLike` handles, so you pass the database you already opened. `@arkade-os/swap/node` is the
exception and the only entry point that imports `node:` builtins, which is why it is a subpath
rather than something the main entry falls back to. It opens the database under the platform
config directory at `arkade/swaps/swaps-<network>.sqlite`, and it is the one backend whose
disposal closes a connection, because it is the one that opened it:

```ts
import { nodeSwapRepository } from "@arkade-os/swap/node";

await using swaps = nodeSwapRepository({ network: "mainnet" }); // or { path } to choose the file
```

Records are stored whole. The SQLite and Realm backends serialize each record to JSON with only
the queryable columns mapped out, so a field they do not know about survives — which is what a
consumer's cast-extended record relies on. JSON is narrower than IndexedDB's structured clone,
though: a `Date` in a field you added comes back an ISO string, a `Set` or `Map` comes back empty,
and a `bigint` throws on save. The package's own records are JSON-safe by design; keep yours that
way too.

## Runtime requirements

The one global the core requires is `crypto.getRandomValues`. Node and browsers have it; React
Native does not, so install `react-native-get-random-values` (or `expo-crypto`) and import it
before this package. `crypto.subtle` is unused. `EventSource` and `WebSocket` are needed only by
the watch and relay transports, each of which takes an injected implementation.

The client takes no server URL anywhere. Server info, chain reads and broadcast are all derived
from the wallet, which is the single place that knows which operator it speaks to.

## Subpaths

| Subpath                            | What it is                                                        |
| ---------------------------------- | ----------------------------------------------------------------- |
| `@arkade-os/swap`                  | the client, the verbs, the vocabulary, the error taxonomy          |
| `@arkade-os/swap/advanced`         | the orchestration below the verbs: the drive, corridors, RFQ wire  |
| `@arkade-os/swap/node`             | the Node storage default                                          |
| `@arkade-os/swap/repositories/*`   | the React Native backends                                         |
| `@arkade-os/swap/nostr`            | the Nostr RFQ transport, for hand-building one                     |
| `@arkade-os/swap/protocol`         | the v1 building blocks, deprecated                                 |

The root is a curated surface — if a name the client's modules define is not on it, it is on
`./advanced` (manual driving with `createSwapDrive`, destination claiming with `corridorSet`,
custom quote flows with `acceptQuote`/`quoteViaRfq`, record reading with `recordLeg`/`swapOf`).
"Advanced" is a deliberate deep subpath, not a second compatibility promise: those names move
with the client's internals across minor versions; the root is what stays put.

`./nostr` is a floor and not a deprecation: the client opens the card's rendezvous itself, and the
subpath is what keeps that an escape hatch rather than a wall. It is a separate entry point
because `nostr-tools` is an optional peer dependency, so a consumer who never hand-builds a
transport never pays for it.

`./protocol` is the other kind of subpath, and it is a floor rather than a staging area. Every
name on it was the integration surface before this client — requests, covenants, records, the RFQ
manager, the restore scan — and each carries an `@deprecated` pointer naming what replaces it.
None of them is on the root: this release breaks against `0.1.0-rc.1` regardless, so a period of
re-exports would have split one migration into two and left 200 v1 names on a root whose claim is
to be the v2 surface. Nothing on the subpath is scheduled to be removed, and the tags mean "the
client does this for you now" rather than "this goes away next release". `MIGRATION.md` has the
table, including the names that have no floor and why.

## Further reading

- [MIGRATION.md](./MIGRATION.md) — every rename, every removal, and where each v1 name went.
- [V2_API.md](./V2_API.md) — the developer UX note on the client surface.
