# Banco Wallet Integration Spec

Integration of the Banco swap functionality as an "App" in the [arkade-os/wallet](https://github.com/arkade-os/wallet) PWA.

## Goal

Add a "Banco" app to the wallet that lets users create, browse, and fulfill peer-to-peer swap offers. Uses the `banco` namespace from `@arkade-os/sdk`.

## SDK Surface

The wallet imports everything from `@arkade-os/sdk`:

```ts
import { banco } from "@arkade-os/sdk";
const { Maker, Taker, Offer, BancoSwap } = banco;
```

### Maker API
```ts
const maker = new banco.Maker(wallet, serverUrl, introspectorUrl);

// Create offer — returns hex offer + extension packet + swap address
const { offer, packet, swapAddress } = await maker.createOffer({
  wantAmount: 10_000n,
  wantAsset?: "txid:vout",   // omit for BTC
  cancelDelay?: 3600,         // seconds from now
});

// Query VTXOs at a swap address
const statuses: banco.OfferStatus[] = await maker.getOffers(swapAddress);

// Cancel an offer (CLTV must have expired)
const txid: string = await maker.cancelOffer(offerHex);
```

### Taker API
```ts
const taker = new banco.Taker(wallet, serverUrl, introspectorUrl);

// Fulfill from offer hex (direct share)
const { txid } = await taker.fulfill(offerHex);

// Fulfill by txid (offer embedded in extension output)
const { txid } = await taker.fulfillByTxid(fundingTxid);
```

### Offer Encoding
```ts
// TLV encode/decode
const bytes = banco.Offer.encode(offerData);
const data = banco.Offer.decode(bytes);

// Hex convenience
const hex = banco.Offer.toHex(offerData);
const data = banco.Offer.fromHex(hex);

// Extension packet (for embedding in tx)
const packet = banco.Offer.toPacket(offerData);
```

## Wallet App Screens

### 1. Banco Home

Entry point for the Banco app. Two tabs:

- **My Offers** — List of the user's active offers (maker side)
- **Browse** — Discover offers from others (taker side, future: indexer-based discovery)

### 2. Create Offer (Maker Flow)

Form fields:
- **Want Amount** (sats) — required
- **Want Asset** (optional asset selector) — for BTC-to-asset swaps
- **Cancel After** (duration picker: 1h / 6h / 24h / 7d / none) — optional
- **Offer Amount** — how much to lock in the swap (comes from wallet balance)

Flow:
1. User fills the form and taps "Create Offer"
2. Call `maker.createOffer({ wantAmount, wantAsset, cancelDelay })`
3. Show the swap address — user sends funds to it via `wallet.send({ address: swapAddress, amount })`
   - Ideally embed the `packet` in the extension output of the funding tx
4. Display the offer hex as a copyable string + QR code
5. Show offer status (polling `maker.getOffers(swapAddress)`)

State to persist locally:
- `swapAddress` — to poll status
- `offerHex` — to share with takers or cancel later
- `createdAt` — for display

### 3. Offer Detail (Maker)

Shows:
- Swap address
- Want amount / asset
- Cancel timestamp (human-readable countdown)
- VTXO status (spendable / spent)
- Actions: **Copy Offer**, **Share** (via system share sheet), **Cancel** (if CLTV expired)

Cancel flow:
1. Tap "Cancel"
2. Call `maker.cancelOffer(offerHex)`
3. Show success/error

### 4. Take Offer (Taker Flow)

Entry:
- Paste offer hex, or
- Scan QR code, or
- Open via deep link / share intent

Flow:
1. Decode the offer: `banco.Offer.fromHex(hex)`
2. Display offer details: swap address, want amount, want asset
3. Show the user's balance and confirm they have enough
4. User taps "Take Offer"
5. Call `taker.fulfill(offerHex)`
6. Show progress (spinner) then success with txid

### 5. Offer Discovery (Future)

An indexer-based offer marketplace where users can browse live offers.
Out of scope for v1 — the initial version uses direct offer sharing (hex / QR).

## Data Flow

```
Maker                           Taker
  |                               |
  | createOffer()                 |
  |-----> swapAddress             |
  |                               |
  | wallet.send(swapAddress)      |
  |-----> VTXO at swap addr       |
  |                               |
  | share offerHex / QR           |
  |------------------------------>|
  |                               | fulfill(offerHex)
  |                               |-----> introspector
  |                               |-----> ark server
  |                               |-----> finalize
  |   maker receives wantAmount   |   taker receives swap VTXO
```

## QR Code Format

The offer hex is the QR payload. For deep linking:

```
arkade://banco/offer/<hex>
```

The wallet registers a handler for `arkade://banco/offer/` deep links.

## Local Storage

The wallet stores active offers in local storage (or IndexedDB):

```ts
interface StoredOffer {
  offerHex: string;
  swapAddress: string;
  wantAmount: string;  // stringified bigint
  wantAsset?: string;
  cancelDelay?: string;
  createdAt: number;   // timestamp ms
  status: "pending" | "funded" | "fulfilled" | "cancelled";
}
```

## Error Handling

| Error | User-facing message |
|-------|-------------------|
| `Insufficient funds` | "You don't have enough funds to take this offer" |
| `No spendable VTXO found` | "This offer is no longer available" |
| `Offer inconsistency` | "This offer appears to be invalid" |
| `Introspector did not sign` | "The introspector rejected this transaction — try again" |
| `FORFEIT_CLOSURE_LOCKED` | "The cancel timelock hasn't expired yet" |
| `Offer does not have a cancel path` | "This offer cannot be cancelled" |

## Configuration

The wallet already has server and introspector URLs configured. The Banco classes use the same URLs:

```ts
const maker = new banco.Maker(wallet, config.serverUrl, config.introspectorUrl);
const taker = new banco.Taker(wallet, config.serverUrl, config.introspectorUrl);
```

## Out of Scope (v1)

- Offer discovery / marketplace
- Partial fills
- Multi-introspector support
- Asset-for-asset swaps (only BTC-for-asset)
- Offer expiration notifications
