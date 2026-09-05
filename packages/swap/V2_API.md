# Swap SDK v2 API

This document is the package-level developer UX note for the v2 swap client. It
tracks what the package API is meant to feel like as the v2 milestones land.

The planning track remains broader than this file. This file should stay close
to the code in `packages/swap`: examples should compile on the branch that
introduces the API they describe, or be marked as future shape.

## Status

The v2 client surface has landed through M7 and is published from the
`@arkade-os/swap/client` subpath. The root export continues to expose the
existing offer, RFQ, restore, watch and manager building blocks — including the
v1 `createSwapClient` facade — until the deprecation milestone moves the v2
client onto the root name and the protocol helpers behind their final boundary.

Current imports look like this:

```ts
import { createSwapClient } from "@arkade-os/swap/client";
import { Amount, canonicalAssetId } from "@arkade-os/swap/client";
```

## The Shape

A v2 swap starts with a route request:

```ts
const client = createSwapClient({ wallet, repository });

const quote = await client.quote({
    give: "arkade:bitcoin/slip44:0",
    take: "bolt11:bitcoin/slip44:0",
    to: invoice,
});

const outcome = await client.accept(quote);
```

`quote` is network-free terms and persists nothing; `accept` writes the record
before funding. Most applications skip both and use a verb — `pay`, `receive`
or `exchange` — which run `quote` → fee ceiling → `accept` as one call:

```ts
const result = await client.pay(destination, { amount: 50_000n });
```

That is the target shape, and it is wired. The pieces below are what make the
route safe before and inside it:

- asset ids are parsed and checked before they reach discovery or RFQ;
- display amounts become `bigint` atomic units before records or wire payloads;
- destination strings are claimed by exactly one corridor before any solver sees
  them;
- corridor dependencies are resolved lazily, so disabling an unused corridor
  does not break an unrelated route.

## Asset IDs

Asset ids are CAIP-19 shaped, with the rail as the CAIP-2 namespace:

```text
<rail>:<network>/<asset-namespace>:<asset-reference>
```

Examples:

```text
arkade:bitcoin/slip44:0
bolt11:bitcoin/slip44:0
bitcoin:bitcoin/slip44:0
arkade:regtest/asset:<68 lowercase hex chars>
eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7
```

`arkade`, `bolt11` and `bitcoin` are the implemented bitcoin-family rails.
`eip155` parses as reserved vocabulary for the later EVM corridor; it is not a
routeable corridor today.

Use the alias layer when accepting human input:

```ts
const asset = canonicalAssetId("BTC", {
    network: "regtest",
    assets: [{ ticker: "BTC", id: "arkade:regtest/slip44:0" }],
});
```

Ticker matching is case-insensitive, scoped to the wallet network, and refuses a
collision instead of guessing.

## Amounts

Amounts inside the v2 client are `bigint` atomic units. Decimal strings split
into two forms:

- display decimals, such as `"0.001"`, are only for UI input and output;
- atomic decimals, such as `"100000"`, are only for records and RFQ payloads.

Use `Amount` at the UI boundary:

```ts
const sats = Amount.parse("0.001", { decimals: 8 });
const display = Amount.format(sats, { decimals: 8 });
```

Use the RFQ amount helpers at the record or wire boundary; do not parse a stored
atomic amount as a display amount.

## Corridors

Corridors are the settlement paths. Their names are discovery vocabulary, not
always the same string as the asset id rail:

| Corridor | Asset rail | Destination forms |
| --- | --- | --- |
| `arkade` | `arkade` | Arkade address, or `bitcoin:?ark=<address>` |
| `lightning` | `bolt11` | BOLT11 invoice, `lightning:<invoice>`, or `bitcoin:?lightning=<invoice>` |
| `onchain` | `bitcoin` | Bitcoin address, or the body of a BIP21 URI |

The implemented route union is:

- `arkade -> arkade`;
- `arkade -> lightning`;
- `lightning -> arkade`;
- `arkade -> onchain`.

`onchain -> arkade` is deliberately absent until the client owns the trader's L1
refund path end to end.

## Destination Claiming

The corridor registry is the current source-level API for parsing a destination
string:

```ts
const broadcaster = await wallet.getArkadeBroadcaster();
const operator = {
    getInfo: () => wallet.getArkadeInfo({ requireLive: true }),
    submitTx: (signedArkTx: string, checkpointTxs: string[]) =>
        broadcaster.submitTx(signedArkTx, checkpointTxs),
    finalizeTx: (arkTxid: string, finalCheckpointTxs: string[]) =>
        broadcaster.finalizeTx(arkTxid, finalCheckpointTxs),
};

const base = await resolveCorridorBase({ wallet, operator });
const corridors = corridorSet(base, {
    lightning: { decode: myBolt11Decoder },
    onchain: { chain: { esploraUrl: "http://localhost:3000" } },
});

const claim = corridors.claim(to);
```

`resolveCorridorBase` performs one live `wallet.getArkadeInfo({ requireLive:
true })` read and derives the network and signer set from it. A stale snapshot
is not used for covenant derivation.

`corridors.claim(to)` returns `ClaimedDestination | undefined`: `undefined`
when core classifies the string but no corridor serves it — an LNURL today —
which becomes `UnsupportedRoute` at route resolution rather than a parse
failure here. Otherwise it returns:

```ts
type ClaimedDestination = {
    corridor: "arkade" | "lightning" | "onchain";
    instrument:
        | { kind: "address"; address: string }
        | {
              kind: "invoice";
              bolt11: string;
              paymentHash: string;
              amount?: bigint;
              expiresAt: number;
          };
};
```

It throws before value moves:

- `AmbiguousDestination` when the string names no corridor, more than one
  corridor, or a corridor-owned destination that fails validation;
- `MissingCorridorDep` when the destination belongs to a corridor whose required
  dependency was explicitly set to `null`;
- later route resolution turns a known-but-unserved destination, such as LNURL
  today, into `UnsupportedRoute`.

`undefined` in an override means "use the default". `null` means "this dep is
disabled" and is refused only when that corridor is actually used.

## Persistence and Outcomes

Quote, accept and outcome driving have landed. The rules this document keeps
carrying forward are:

- persist before funding;
- funding is acceptance;
- exceptions stop before value moves;
- everything after funding is an outcome, not a thrown setup error;
- the wallet is the source of Arkade server identity, network and signing
  policy.

Past funding, the client owns the lifecycle: `cancel` takes back an unfilled
offer's deposit (a fill winning the race reconciles to `filled`, never throws),
`swaps` reads the client's history in the drive's outcome vocabulary, and
`onUpdate` streams every transition — including `needs_recovery`, which
`recover` drives. Construction stays inert; the first `await client.ready`
runs the restore read and arms the drive where there is live work.
