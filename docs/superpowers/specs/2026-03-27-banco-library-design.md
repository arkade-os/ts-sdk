# Banco Library Design

Refactor the banco CLI into a reusable library (`@arkade-os/banco`) with `Maker` and `Taker` classes, TLV-encoded offers, and a thin CLI wrapper.

## Package Structure

```
packages/banco/                ← library (@arkade-os/banco)
  src/
    index.ts                   ← public exports
    maker.ts                   ← Maker class
    taker.ts                   ← Taker class
    offer.ts                   ← Offer type + TLV encode/decode
    contract.ts                ← BancoSwap (moved from examples/banco/src/contract/banco.ts)
  package.json                 ← depends on @arkade-os/sdk
  tsconfig.json

examples/banco/                ← CLI, depends on @arkade-os/banco
  src/index.ts                 ← thin CLI shell consuming the library
  package.json
```

## Offer Type & TLV Encoding

### Offer Fields

```ts
interface Offer {
  swapAddress: string
  wantAmount: bigint
  wantAsset?: string             // "txid:vout", omitted for BTC
  cancelDelay?: bigint           // CLTV unix timestamp, omitted if no cancel path
  makerPkScript: Uint8Array      // 34 bytes: OP_1 + push32 + x-only key
  makerWitnessProgram: Uint8Array // 32 bytes: x-only key (makerPkScript[2:])
  makerPublicKey: Uint8Array     // 32 bytes: maker's x-only taproot key
  introspectorPubkey: Uint8Array // 32 bytes
}
```

### TLV Format

Each field: `[type: 1 byte][length: 2 bytes big-endian][value: N bytes]`

| Type | Field | Encoding |
|------|-------|----------|
| `0x01` | swapAddress | UTF-8 |
| `0x02` | wantAmount | 8 bytes big-endian uint64 |
| `0x03` | wantAsset | UTF-8 `"txid:vout"` (omitted if BTC) |
| `0x04` | cancelDelay | 8 bytes big-endian uint64 (omitted if none) |
| `0x05` | makerPkScript | raw bytes (34) |
| `0x06` | makerWitnessProgram | raw bytes (32) |
| `0x07` | makerPublicKey | raw bytes (32) |
| `0x08` | introspectorPubkey | raw bytes (32) |

Optional fields (`0x03`, `0x04`) are omitted entirely when not set.

### Static API

```ts
namespace Offer {
  function encode(offer: Offer): Uint8Array   // TLV bytes
  function decode(data: Uint8Array): Offer    // parse TLV bytes
  function toHex(offer: Offer): string        // encode then hex
  function fromHex(hex: string): Offer        // hex then decode
}
```

## Maker Class

```ts
class Maker {
  constructor(
    wallet: IWallet,
    arkServerUrl: string,
    introspectorUrl: string
  )
```

### `createOffer(params): Promise<{ offer: string; swapAddress: string }>`

Parameters:
```ts
{
  wantAmount: bigint
  wantAsset?: string       // "txid:vout"
  cancelDelay?: number     // seconds from now → converted to CLTV timestamp
}
```

Steps:
1. Fetch server info (pubkey, exit delay) from `RestArkProvider`
2. Fetch introspector info (pubkey) from `RestIntrospectorProvider`
3. Derive maker's `pkScript`, `witnessProgram`, `publicKey` from `wallet.getAddress()` → `ArkAddress.decode()`
4. Build `BancoSwap` contract
5. Compute `swapAddress` from vtxoScript
6. TLV-encode the offer, return as hex string + swap address

The caller is responsible for sending funds to the swap address via `wallet.send()`.

### `getOffers(address: string): Promise<OfferStatus[]>`

Takes a swap address. Queries the indexer for VTXOs at that address's pkScript.

```ts
interface OfferStatus {
  txid: string
  vout: number
  value: number
  assets?: { assetId: string; amount: number }[]
  spendable: boolean
}
```

### `cancelOffer(offerHex: string): Promise<string>`

Steps:
1. Decode TLV offer
2. Fetch server info to get server pubkey, exit delay, checkpoint tapscript
3. Reconstruct `BancoSwap` from offer fields
4. Query indexer for spendable VTXO at the swap address
5. Build offchain tx spending via the CLTV cancel leaf (maker + server multisig with absolute timelock)
6. Output goes back to maker's address (derived from wallet)
7. Sign with wallet identity
8. Submit to ark server (submitTx + finalizeTx)
9. Return ark txid

Fails if the CLTV timelock hasn't expired yet.

## Taker Class

```ts
class Taker {
  constructor(
    wallet: IWallet,
    arkServerUrl: string,
    introspectorUrl: string
  )
```

### `fulfill(offerHex: string): Promise<{ txid: string }>`

Steps:
1. Decode TLV offer
2. Fetch server info (pubkey, exit delay, checkpoint tapscript)
3. Reconstruct `BancoSwap` from offer fields + server pubkey + introspector pubkey (from offer)
4. Query indexer for spendable VTXO at the swap address
5. Get taker's VTXOs from `wallet.getVtxos()`
6. Get taker's address from `wallet.getAddress()`
7. Build outputs:
   - output 0: `wantAmount` → `makerPkScript` (checked by arkade script)
   - output 1: swap VTXO value → taker's pkScript
   - output 2 (if change): change → taker's pkScript
   - extension output: introspector packet + asset transfer packet (if assets)
8. Build offchain tx with `buildOffchainTx()` (from SDK)
9. Sign taker inputs via `wallet.identity.sign()` (not the swap input — that's server + introspector)
10. Submit to introspector via `RestIntrospectorProvider.submitTx()`
11. Submit to ark server via `RestArkProvider.submitTx()`
12. Merge introspector checkpoint sigs into server checkpoints using `combineTapscriptSigs()` (from SDK `utils/arkTransaction`)
13. Counter-sign taker checkpoints (index > 0) via `wallet.identity.sign()`
14. Finalize via `arkProvider.finalizeTx()`
15. Return `{ txid }`

## SDK Reuse

The library reuses these SDK primitives instead of reimplementing them:

| SDK export | Used for |
|------------|----------|
| `buildOffchainTx` | Building the virtual tx + checkpoints |
| `combineTapscriptSigs` | Merging introspector signatures into server checkpoints (replaces manual tapScriptSig merge loop) |
| `ArkAddress.decode()` | Deriving pkScript, witnessProgram, publicKey from ark addresses |
| `RestArkProvider` | Server info, submitTx, finalizeTx |
| `RestIndexerProvider` | Querying VTXOs at swap addresses |
| `RestIntrospectorProvider` | Submitting arkade-script txs for co-signing |
| `Extension.create` + `IntrospectorPacket` | Building the extension output with introspector metadata |
| `asset.Packet` / `asset.AssetGroup` | Asset transfer packets when the swap VTXO carries assets |
| `BancoSwap.vtxoScript()` → `.findLeaf()` / `.encode()` | Tap leaf selection and tree encoding |
| `CSVMultisigTapscript.decode()` | Decoding the server's checkpoint unroll closure |

## BancoSwap Contract

Moved as-is from `examples/banco/src/contract/banco.ts` to `packages/banco/src/contract.ts`. No changes to the contract logic — just relocated into the library.

## CLI Update

`examples/banco/src/index.ts` becomes a thin wrapper:

- `banco init` — saves server/introspector config (unchanged)
- `banco make` — creates `Maker`, calls `createOffer()`, prints hex-encoded offer
- `banco take` — creates `Taker`, calls `fulfill(offerHex)`
- `banco status --address <swap-address>` — calls `maker.getOffers(address)`
- `banco cancel --offer <hex>` — calls `maker.cancelOffer(offerHex)`

The CLI still manages its own config file (`~/.banco/config.json`) and provides the `IWallet` instance (via `SingleKey` + `InMemoryRepository`) to the library classes.

## Public Exports

```ts
// packages/banco/src/index.ts
export { Maker } from "./maker"
export { Taker } from "./taker"
export { Offer, type OfferStatus } from "./offer"
export { BancoSwap, type BancoSwapParams } from "./contract"
```

Not re-exported from the main `@arkade-os/sdk` — this is a separate package.
