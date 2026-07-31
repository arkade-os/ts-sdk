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

// Same for swaps — a reverse swap's preimage is backed up the moment it exists,
// rather than at the next periodic sync.
const syncedSwaps = new SyncedSwapRepository(swaps, sync);
```

Local writes complete first and return immediately; the encrypted push is
fire-and-forget (failures surface via the optional `onError` callback). That keeps
an optional backup server off the critical path of a wallet operation — it should
never be able to fail a swap — at the cost of a push that can go missing.

### Repairing pushes that never landed

`sync()` only applies remote → local, so a push that failed leaves a record living
nowhere but this device, and nothing would notice. `reconcile()` closes that:

```ts
const repaired = await sync.reconcile(); // number of records re-pushed
```

It pulls, then re-pushes anything the server is missing or disagrees with. The
pull is deliberate — diffing without it would let a reconcile push stale local
state over another device's newer write. `start()` opens with a `reconcile()`, so
long-running sessions self-heal; call it directly on app resume if you don't hold
a live session.

It repairs missing and divergent records only. A **delete** whose push failed is
not detected — a record absent from the local snapshot is indistinguishable from
one that was never there — so a deleted record can survive on the server and
reappear on a later restore. The asymmetry is intentional: a resurrected stale
record is untidy, a missing preimage loses money.

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
| `SwapSource` | `swap:{id}` | Boltz swap records. Carries `preimage` — see below. |
| `WalletStateSource` | `state:wallet` | Portable `settings` only — the device-local `lastSyncTime` indexer cursor is deliberately **not** synced. |

`SwapSource` is not optional if you use swaps. A VHTLC contract stores
`preimageHash` (hash160 of the secret), never the secret; `BoltzReverseSwap.preimage`
is the only copy, and it is what claims the VHTLC. Restoring contracts without
swaps therefore yields a swap you can see but cannot claim, losing the funds to
the Boltz refund timeout. It needs `@arkade-os/boltz-swap`, declared as an
optional peer dependency and imported as types only, so wallets that never swap
pull in nothing extra.

**Coins/UTXOs and transaction history are deliberately not synced.** They are
derivable cache — arkd's indexer and the chain are the source of truth — so
mirroring them would let a stale device overwrite fresher local state and would
grow the bucket to save a re-sync that happens anyway. What syncs here is the
state no one else can give back to you.

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
