# covclaim

Covenant claim watcher daemon for Arkade VHTLCs. Watches for on-chain UTXOs at registered `CovVHTLC` taproot addresses and automatically claims them via the introspector-enforced covenant path.

Inspired by [BoltzExchange/covclaim](https://github.com/BoltzExchange/covclaim) (Liquid), but for Arkade on Bitcoin using the [introspector](https://github.com/ArkLabsHQ/introspector) co-signing service.

## How it works

1. A client registers a covenant-claimable VTXO via `POST /covenant` with the VHTLC parameters and the preimage
2. The daemon derives the `CovVHTLC` taproot address and starts polling esplora for UTXOs at that address
3. When a UTXO appears (after unilateral exit or round expiry puts the VTXO on-chain), the daemon:
   - Builds a transaction spending via the `covenantClaim` leaf
   - Submits the PSBT to the introspector for co-signing (the introspector validates output constraints match the arkade script)
   - Broadcasts the signed transaction via esplora

## Prerequisites

- Node.js 22+
- An [introspector](https://github.com/ArkLabsHQ/introspector) instance
- An [esplora](https://github.com/blockstream/esplora) instance
- An Ark server (`arkd`) for the network you're targeting

## Configuration

Via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `ESPLORA_URL` | `http://localhost:3000` | Esplora REST API URL |
| `INTROSPECTOR_URL` | `http://localhost:7073` | Introspector REST API URL |
| `PORT` | `1234` | HTTP server port |
| `POLL_INTERVAL_MS` | `5000` | Esplora polling interval in ms |
| `NETWORK` | `regtest` | Bitcoin network (`regtest`, `signet`, `mainnet`) |

## Running

### Development

```bash
cd covclaim
npm install
npm run dev
```

### Production

```bash
cd covclaim
npm install
npm run build
npm start
```

### Docker

```bash
docker build -t covclaim -f covclaim/Dockerfile .
docker run -p 1234:1234 \
  -e ESPLORA_URL=http://esplora:3000 \
  -e INTROSPECTOR_URL=http://introspector:7073 \
  -e NETWORK=regtest \
  covclaim
```

## API

### `POST /covenant`

Register a VTXO to watch for covenant claiming.

**Request:**

```json
{
  "sender": "<hex x-only pubkey>",
  "receiver": "<hex x-only pubkey>",
  "server": "<hex x-only pubkey>",
  "preimage": "<hex 32-byte preimage>",
  "claimAddress": "<bech32/bech32m address>",
  "expectedAmount": 10000,
  "refundLocktime": 800100,
  "unilateralClaimDelay": { "type": "blocks", "value": 100 },
  "unilateralRefundDelay": { "type": "blocks", "value": 102 },
  "unilateralRefundWithoutReceiverDelay": { "type": "blocks", "value": 103 }
}
```

**Response (201):**

```json
{
  "id": "uuid",
  "taprootAddress": "bcrt1p...",
  "status": "watching"
}
```

### `GET /covenant/:id`

Check status of a registered covenant.

**Response:**

```json
{
  "id": "uuid",
  "taprootAddress": "bcrt1p...",
  "status": "watching|claiming|claimed|failed",
  "utxo": { "txid": "...", "vout": 0, "value": 10546 },
  "claimTxid": "...",
  "error": null,
  "createdAt": 1711900000000
}
```

### `GET /health`

Returns `{ "status": "ok" }`.

## Running against regtest

1. Start `arkd`, introspector, and esplora (e.g., via docker-compose from the Ark repo)
2. Start the daemon:

```bash
ESPLORA_URL=http://localhost:3000 \
INTROSPECTOR_URL=http://localhost:7073 \
NETWORK=regtest \
npm run dev
```

3. Create a `CovVHTLC` in your wallet, perform a unilateral exit to put the VTXO on-chain
4. Register the covenant with the daemon:

```bash
curl -X POST http://localhost:1234/covenant \
  -H 'Content-Type: application/json' \
  -d '{
    "sender": "...",
    "receiver": "...",
    "server": "...",
    "preimage": "...",
    "claimAddress": "bcrt1q...",
    "expectedAmount": 10000,
    "refundLocktime": 800100,
    "unilateralClaimDelay": { "type": "blocks", "value": 100 },
    "unilateralRefundDelay": { "type": "blocks", "value": 102 },
    "unilateralRefundWithoutReceiverDelay": { "type": "blocks", "value": 103 }
  }'
```

5. The daemon will detect the UTXO and claim it automatically.
