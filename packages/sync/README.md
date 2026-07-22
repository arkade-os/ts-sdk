# @arkade-os/sync

End-to-end-encrypted **backup, restore and multi-device sync** for Arkade wallet
state — contracts (VHTLCs, Boltz-swap contracts, the default receive contract),
wallet settings, and any other keyed data — over the
[bucket-sync protocol](https://github.com/Kukks/bucket-sync-server).

The sync server only ever stores **opaque ciphertext**. It never sees your
contract parameters, scripts, or settings: values are sealed client-side with
`cse-v1` (AES-256-GCM envelope encryption) before they leave the device, and the
key that decrypts them is derived from your seed and **never** sent to the server.

## Why

A wallet backs up its mnemonic, but the *derived* state — contracts and their
parameters, VHTLC secrets, swap records — is large and painful to lose even when
funds are recoverable from seed. This package keeps that state backed up and
converged across devices, differentially and live, without trusting the server
with plaintext.

## Install

```bash
pnpm add @arkade-os/sync @arkade-os/sdk
```

## Quick start

```ts
import { MnemonicIdentity, InMemoryContractRepository } from "@arkade-os/sdk";
import {
  WalletSync,
  ContractSource,
  SyncedContractRepository,
  deriveKwk,
} from "@arkade-os/sync";

// 1. Your wallet identity (used only to AUTHENTICATE — never to encrypt).
const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: true });

// 2. A key-wrapping key derived from the seed, SEPARATE from the signing key.
const kwk = deriveKwk(seed); // seed = mnemonicToSeedSync(mnemonic)

// 3. Point the contract source at your repository.
const contracts = new InMemoryContractRepository();

const sync = await WalletSync.create({
  baseUrl: "https://sync.example.com",
  identity,
  encryptionKey: kwk,
  sources: [new ContractSource(contracts)],
});

// Restore on a fresh device (pull everything into the local repo):
await sync.restore();

// Or push the current local state up:
await sync.backup();

// Keep two devices converged — catch up, then live-tail via SSE:
const ac = new AbortController();
sync.start(ac.signal).catch(console.error);
```

### Automatic backup on every write

Wrap your `ContractRepository` so writes mirror to the server in the background,
then hand the wrapper to the wallet:

```ts
const synced = new SyncedContractRepository(contracts, sync);
const wallet = await Wallet.create({ identity, storage: { contractRepository: synced } });
// wallet.contractManager.createContract(...) now backs up automatically.
```

Local writes complete first and return immediately; the encrypted push is
fire-and-forget (failures surface via the optional `onError` callback and are
reconciled on the next `backup()`/`sync()`).

## Security model

- **Values are sealed with `cse-v1`** — a random per-record data key (AES-256-GCM)
  encrypts the value; that key is wrapped to you under a 32-byte key-wrapping key
  (KWK). The server stores the whole opaque envelope and reads only the scheme tag.
- **The KWK is distinct from the signing key.** `deriveKwk(seed)` is HKDF-SHA256
  with a domain-separated label (`bucket-sync:cse-v1:kwk`). Auth uses your BIP-340
  Schnorr identity; encryption uses the KWK. Reusing one key for both is the
  antipattern this avoids.
- **Auth is your existing identity.** The client proves ownership by signing a
  server nonce with `identity.signMessage(msg, "schnorr")` — the same key your
  wallet already holds. No separate sync credential.
- **Buckets are isolated by the server**, which derives the bucket id from the
  authenticated key. There is no client-supplied bucket id to tamper with.

## What syncs

| Source | Keys | Notes |
|---|---|---|
| `ContractSource` | `contract:{script}` | Per-contract CAS; JSON-safe. |
| `WalletStateSource` | `state:wallet` | Portable `settings` only — the device-local `lastSyncTime` indexer cursor is deliberately **not** synced. |

Coins/UTXOs and transaction history are address-collection-keyed and require the
SDK's internal serializers; they are a planned follow-up (this release focuses on
contracts + settings, which are enumerable and JSON-safe).

## Conflict handling

Writes use optimistic CAS. On a concurrent-write clash the default resolver is
**local-wins** (the pushing device refreshes the version and overwrites). Pass a
custom `resolver` to `WalletSync.create` for smarter merges.

## Testing

```bash
pnpm --filter @arkade-os/sync test:unit          # crypto, protocol, engine, sources (no server)
```

The end-to-end tests run against a real server and are **opt-in**. Start a
[bucket-sync-server](https://github.com/Kukks/bucket-sync-server) (in-memory
backend is fine) and point the tests at it:

```bash
# in the server repo:
dotnet run --project src/BucketSync.Api --urls http://localhost:5080

# here:
BUCKET_SYNC_URL=http://localhost:5080 pnpm --filter @arkade-os/sync exec vitest run test/e2e
```

Without `BUCKET_SYNC_URL` the e2e suite skips cleanly.
