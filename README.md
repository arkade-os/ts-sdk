# Arkade TypeScript SDK

The Arkade SDK is a TypeScript library for building Bitcoin wallets using the Arkade protocol.

[![TypeDoc](https://img.shields.io/badge/TypeScript-Documentation-blue?style=flat-square)](https://arkade-os.github.io/ts-sdk/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/arkade-os/ts-sdk)

## Installation

```bash
npm install @arkade-os/sdk
```

## Usage

### Creating a Wallet

```typescript
import {
  MnemonicIdentity,
  Wallet,
} from '@arkade-os/sdk'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// Generate a new mnemonic or use an existing one
const mnemonic = generateMnemonic(wordlist)
const identity = MnemonicIdentity.fromMnemonic(mnemonic)

// Create a wallet with Arkade support
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
})
```

### Read-Only Wallets (Watch-Only)

The SDK supports read-only wallets that allow you to query wallet state without exposing private keys. This is useful for:

- **Watch-only wallets**: Monitor addresses and balances without transaction capabilities
- **Public interfaces**: Display wallet information safely in public-facing applications
- **Separate concerns**: Keep signing operations isolated from query operations

#### Creating a Read-Only Wallet

```typescript
import { ReadonlySingleKey, ReadonlyWallet } from '@arkade-os/sdk'

// Create a read-only identity from a public key
const identity = SingleKey.fromHex('e09ca...56609')
const publicKey = await identity.compressedPublicKey()
const readonlyIdentity = ReadonlySingleKey.fromPublicKey(publicKey)

// Create a read-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
  arkServerUrl: 'https://arkade.computer'
})

// Query operations work normally
const address = await readonlyWallet.getAddress()
const balance = await readonlyWallet.getBalance()
const vtxos = await readonlyWallet.getVtxos()
const history = await readonlyWallet.getTransactionHistory()

// Transaction methods are not available (TypeScript will prevent this)
// await readonlyWallet.send(...) // ❌ Type error!
```

#### Converting Wallets to Read-Only

```typescript
import { Wallet, MnemonicIdentity } from '@arkade-os/sdk'

// Create a full wallet
const identity = MnemonicIdentity.fromMnemonic('abandon abandon...')
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer'
})

// Convert to read-only wallet (safe to share)
const readonlyWallet = await wallet.toReadonly()

// The read-only wallet can query but not transact
const balance = await readonlyWallet.getBalance()
```

#### Converting Identity to Read-Only

```typescript
import { SingleKey } from '@arkade-os/sdk'

// Full identity
const identity = SingleKey.fromHex('e09ca...56609')

// Convert to read-only (no signing capability)
const readonlyIdentity = await identity.toReadonly()

// Use in read-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
  arkServerUrl: 'https://arkade.computer'
})
```

### Seed & Mnemonic Identity (Recommended)

The SDK supports key derivation from BIP39 mnemonic phrases or raw seeds using BIP86 (Taproot) output descriptors. This is the recommended identity type for new integrations — it uses standard derivation paths that are interoperable with other wallets and HD-ready for future multi-address support.

> **Note:** Prefer `MnemonicIdentity` or `SeedIdentity` over `SingleKey` for new applications. `SingleKey` exists for backward compatibility with raw private keys.

#### Creating from Mnemonic

```typescript
import { MnemonicIdentity, Wallet } from '@arkade-os/sdk'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// Generate a new 12-word mnemonic
const mnemonic = generateMnemonic(wordlist)

// Create identity from a 12 or 24 word mnemonic
const identity = MnemonicIdentity.fromMnemonic(mnemonic)

// With optional passphrase for additional security
const identityWithPassphrase = MnemonicIdentity.fromMnemonic(mnemonic, {
  passphrase: 'my secret passphrase'
})

// Create wallet as usual
const wallet = await Wallet.create({
  identity: identityWithPassphrase,
  arkServerUrl: 'https://arkade.computer'
})
```

#### Creating from Raw Seed

```typescript
import { SeedIdentity } from '@arkade-os/sdk'
import { mnemonicToSeedSync } from '@scure/bip39'

// If you already have a 64-byte seed
const seed = mnemonicToSeedSync(mnemonic)
const identity = SeedIdentity.fromSeed(seed)

// Or with a custom output descriptor
const identityWithDescriptor = SeedIdentity.fromSeed(seed, { descriptor })

// Or with a custom descriptor and passphrase (MnemonicIdentity)
const identityWithDescriptorAndPassphrase = MnemonicIdentity.fromMnemonic(mnemonic, {
  descriptor,
  passphrase: 'my secret passphrase'
})
```

#### Watch-Only with ReadonlyDescriptorIdentity

Create watch-only wallets from an output descriptor:

```typescript
import { MnemonicIdentity, ReadonlyDescriptorIdentity, ReadonlyWallet } from '@arkade-os/sdk'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// From a full identity
const mnemonic = generateMnemonic(wordlist)
const identity = MnemonicIdentity.fromMnemonic(mnemonic)
const readonly = await identity.toReadonly()

// Or directly from a descriptor (e.g., from another wallet)
const descriptor = "tr([12345678/86'/0'/0']xpub.../0/0)"
const readonlyFromDescriptor = ReadonlyDescriptorIdentity.fromDescriptor(descriptor)

// Use in a watch-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonly,
  arkServerUrl: 'https://arkade.computer'
})

// Can query but not sign
const balance = await readonlyWallet.getBalance()
```

**Derivation Path:** `m/86'/{coinType}'/0'/0/0`
- BIP86 (Taproot) purpose
- Coin type 0 for mainnet, 1 for testnet
- Account 0, external chain, first address

The descriptor format (`tr([fingerprint/path']xpub.../0/0)`) is HD-ready — future versions will support deriving multiple addresses and change outputs from the same seed.

### Receiving Bitcoin

```typescript
import { waitForIncomingFunds } from '@arkade-os/sdk'

// Get wallet addresses
const arkadeAddress = await wallet.getAddress()
const boardingAddress = await wallet.getBoardingAddress()
console.log('Arkade Address:', arkadeAddress)
console.log('Boarding (Mainnet) Address:', boardingAddress)

const incomingFunds = await waitForIncomingFunds(wallet)
if (incomingFunds.type === "vtxo") {
  // Virtual UTXOs received 
  console.log("VTXOs: ", incomingFunds.vtxos)
} else if (incomingFunds.type === "utxo") {
  // Boarding UTXOs received
  console.log("UTXOs: ", incomingFunds.coins)
}
```

### Onboarding

Onboarding allows you to swap on-chain funds into VTXOs:

```typescript
import { Ramps } from '@arkade-os/sdk'

const boardingTxId = await new Ramps(wallet).onboard();
```

### Checking Balance

```typescript
// Get detailed balance information
const balance = await wallet.getBalance()
console.log('Total Balance:', balance.total)
console.log('Boarding Total:', balance.boarding.total)
console.log('Offchain Available:', balance.available)
console.log('Offchain Settled:', balance.settled)
console.log('Offchain Preconfirmed:', balance.preconfirmed)
console.log('Recoverable:', balance.recoverable)

// Get virtual UTXOs (off-chain)
const virtualUtxos = await wallet.getVtxos()

// Get boarding UTXOs
const boardingUtxos = await wallet.getBoardingUtxos()
```

### Sending Bitcoin

```typescript
// Send bitcoin instantly offchain
const txid = await wallet.send({
  address: 'ark1q...',  // arkade address
  amount: 50_000,       // in satoshis
})
```

### Assets (Issue, Reissue, Burn, Send)

The wallet's `assetManager` lets you create and manage assets on Arkade. The `send` method supports sending assets.

```typescript
// Issue a new asset (non-reissuable by default)
const { assetId: controlAssetId } = await wallet.assetManager.issue({
  amount: 1,
  metadata: {
    ticker: 'ctrl-MTK'
  }
})

// Issue a new asset referencing the control asset
const { assetId } = await wallet.assetManager.issue({
  amount: 500,
  controlAssetId,
})

// Reissue more supply of the asset (requires ownership of the control asset)
const reissuanceTxId = await wallet.assetManager.reissue({
  assetId,
  amount: 500,
})

// Burn some of the asset
const burnTxId = await wallet.assetManager.burn({
  assetId,
  amount: 200,
})

// Send asset to another Arkade address
const sendTxId = await wallet.send({
  address: 'ark1q...',
  assets: [{ assetId, amount: 100 }],
})

// Check remaining balance
const { assets } = await wallet.getBalance()
const assetBalance = assets.find(asset => asset.assetId === assetId)?.amount
```

### Batch Settlement

The `settle` method can be used to move preconfirmed balances into finalized balances and to manually convert UTXOs to VTXOs.

```typescript
// Fetch offchain preconfirmed VTXOs and onchain boarding UTXOs
const [virtualUtxos, boardingUtxos] = await Promise.all([
  wallet.getVtxos(),
  wallet.getBoardingUtxos()
])

// For settling transactions
const settlementTxId = await wallet.settle({
  inputs: [...virtualUtxos, ...boardingUtxos],
  // Optional: specify a mainnet output
  outputs: [{
    address: "bc1p...",
    amount: 100_000n
  }]
})
```

### VTXO Management (Renewal & Recovery)

VTXOs have an expiration time (batch expiry). The SDK provides the `VtxoManager` class to handle:

- **Renewal**: Renew VTXOs before they expire to maintain unilateral control of the funds.
- **Recovery**: Reclaim swept or expired VTXOs back to the wallet in case renewal window was missed.
- **Boarding UTXO Sweep**: Sweep expired boarding UTXOs back to a fresh boarding address to restart the timelock.

#### Settlement Configuration

The recommended way to configure `VtxoManager` is via `settlementConfig` on the wallet.
If you omit `settlementConfig`, settlement is enabled with the default behavior:
VTXO renewal at 3 days and boarding UTXO sweep enabled.

```typescript
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
  // Enable settlement with defaults explicitly:
  settlementConfig: {
    // Seconds before VTXO expiry to trigger renewal
    vtxoThreshold: 259200, // 3 days
    // Whether to sweep expired boarding UTXOs back to a fresh boarding address
    boardingUtxoSweep: true,
    // Polling interval in milliseconds for checking boarding UTXOs
    pollIntervalMs: 60000 // 1 minute
  },
})
```

```typescript
// Enable both VTXO renewal and boarding UTXO sweep
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
  settlementConfig: {
    vtxoThreshold: 86400,      // renew when 24 hours remain (in seconds)
    boardingUtxoSweep: true,   // sweep expired boarding UTXOs
  },
})
```

```typescript
// Explicitly disable all settlement
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
  settlementConfig: false,
})
```

Create the `VtxoManager` by passing the wallet and its settlement config:

```typescript
import { VtxoManager } from '@arkade-os/sdk'

const manager = new VtxoManager(
  wallet,
  undefined,               // renewalConfig (deprecated)
  wallet.settlementConfig  // new settlementConfig
)
```

> **Migration from `renewalConfig`:** The old `renewalConfig` with `enabled` and `thresholdMs` (milliseconds) is still supported but deprecated. If both are provided, `settlementConfig` takes precedence. The new `vtxoThreshold` uses **seconds** instead of milliseconds.

#### Renewal: Prevent Expiration

Renew VTXOs before they expire to retain unilateral control of funds.
This settles expiring and recoverable VTXOs back to your wallet, refreshing their expiration time.

```typescript
// Renew all VTXOs to prevent expiration
const txid = await manager.renewVtxos()
// Check which VTXOs are expiring soon
const expiringVtxos = await manager.getExpiringVtxos()
// Override thresholdMs (e.g., get VTXOs expiring in the next 60 seconds)
const urgentlyExpiring = await manager.getExpiringVtxos(60_000)
```

#### Boarding UTXO Sweep

When a boarding UTXO's CSV timelock expires, it can no longer be onboarded into Arkade cooperatively. The sweep feature detects these expired UTXOs and builds a raw on-chain transaction that spends them via the unilateral exit path back to a fresh boarding address, restarting the timelock.

- Multiple expired UTXOs are batched into a single transaction (many inputs, one output)
- A dust check ensures the sweep is skipped if fees would consume the entire value

```typescript
// Check for expired boarding UTXOs
const expired = await manager.getExpiredBoardingUtxos()
console.log(`${expired.length} expired boarding UTXOs`)

// Sweep them back to a fresh boarding address (requires boardingUtxoSweep: true)
try {
  const txid = await manager.sweepExpiredBoardingUtxos()
  console.log('Swept expired boarding UTXOs:', txid)
} catch (e) {
  // "No expired boarding UTXOs to sweep" or "Sweep not economical"
}
```

#### Recovery: Reclaim Swept VTXOs

Recover VTXOs that have been swept by the server or consolidate small amounts (subdust).

```typescript
// Recover swept VTXOs and preconfirmed subdust
const txid = await manager.recoverVtxos((event) => {
  console.log('Settlement event:', event.type)
})
console.log('Recovered:', txid)
// Check what's recoverable
const balance = await manager.getRecoverableBalance()
```


### VTXO Delegation

Delegation allows you to outsource VTXO renewal to a third-party delegator service. Instead of renewing VTXOs yourself, the delegator will automatically settle them before they expire, sending the funds back to your wallet address (minus a service fee). This is useful for wallets that cannot be online 24/7.

When a `delegatorProvider` is configured, the wallet address includes an extra tapscript path that authorizes the delegator to co-sign renewals alongside the Arkade server.

To run a delegator, you'll need to set up a [Fulmine server](https://github.com/ArkLabsHQ/fulmine) with the [Delegation API](https://github.com/ArkLabsHQ/fulmine?tab=readme-ov-file#-delegate-api) enabled.

#### Setting Up a Wallet with Delegation

```typescript
import { Wallet, SingleKey, RestDelegatorProvider } from '@arkade-os/sdk'

const identity = SingleKey.fromHex('e09ca...56609')

const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
  delegatorProvider: new RestDelegatorProvider('http://localhost:7001'),
})
```

> **Note:** Adding a `delegatorProvider` changes your wallet address because the offchain tapscript includes an additional delegation path. Funds sent to an address without delegation cannot be delegated, and vice versa.

#### Delegating VTXOs

Once the wallet is configured with a delegator, use `wallet.delegatorManager` to delegate your VTXOs:

```typescript
// Get spendable VTXOs (including recoverable)
const vtxos = (await wallet.getVtxos({ withRecoverable: true }))
  .filter(v => v.virtualStatus.type === 'confirmed')

// Delegate all VTXOs — the delegator will renew them before expiry
const arkadeAddress = await wallet.getAddress()
const delegatorManager = await wallet.getDelegatorManager();
const delegationResult = await delegatorManager.delegate(vtxos, arkadeAddress)

console.log('Delegated:', result.delegated.length)
console.log('Failed:', result.failed.length)
```

The `delegate` method groups VTXOs by expiry date and submits them to the delegator service. By default, delegation is scheduled at 90% of each VTXO's remaining lifetime. You can override this with an explicit date:

```typescript
// Delegate with a specific renewal time
const delegateAt = new Date(Date.now() + 12 * 60 * 60 * 1000) // 12 hours from now
await delegatorManager.delegate(vtxos, arkadeAddress, delegateAt)
```

#### Service Worker Integration

When using a service worker wallet, pass the `delegatorUrl` option. The service worker will automatically delegate VTXOs after each VTXO update:

```typescript
import { ServiceWorkerWallet, MnemonicIdentity } from '@arkade-os/sdk'

const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  arkServerUrl: 'https://arkade.computer',
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
  delegatorUrl: 'http://localhost:7001',
})
```

#### Querying Delegator Info

You can query the delegator service directly to inspect its public key, fee, and payment address:

```typescript
import { RestDelegatorProvider } from '@arkade-os/sdk'

const provider = new RestDelegatorProvider('https://delegator.example.com')
const info = await provider.getDelegateInfo()

console.log('Delegator public key:', info.pubkey)
console.log('Service fee (sats):', info.fee)
console.log('Fee address:', info.delegatorAddress)
```

### BIP-322 Message Signing

Sign and verify messages using [BIP-322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki). Supports P2TR (Taproot) signing, and verification for P2TR, P2WPKH, and legacy P2PKH addresses.

```typescript
import { BIP322, SingleKey } from '@arkade-os/sdk'

const identity = SingleKey.fromHex('your_private_key_hex')

// Sign a message (P2TR key-spend)
const signature = await BIP322.sign('Hello Bitcoin!', identity)

// Verify against a P2TR address
const valid = BIP322.verify('Hello Bitcoin!', signature, 'bc1p...')

// Also works with P2WPKH and legacy P2PKH addresses
BIP322.verify('Hello Bitcoin!', sig, 'bc1q...')  // P2WPKH
BIP322.verify('Hello Bitcoin!', sig, '1A1zP1...')  // legacy P2PKH
```

### Transaction History

```typescript
// Get transaction history
const history = await wallet.getTransactionHistory()
```

### Offboarding

Collaborative exit or "offboarding" allows you to withdraw your virtual funds to an on-chain address:

```typescript
import { Ramps } from '@arkade-os/sdk'

// Get fee information from the server
const info = await wallet.arkProvider.getInfo();

const exitTxid = await new Ramps(wallet).offboard(
  onchainAddress,
  info.fees
);
```

### Unilateral Exit

Unilateral exit allows you to withdraw your funds from the Ark protocol back to the Bitcoin blockchain without requiring cooperation from the Ark server. This process involves two main steps:

1. **Unrolling**: Broadcasting the transaction chain from off-chain back to on-chain
2. **Completing the exit**: Spending the unrolled VTXOs after the timelock expires

#### Step 1: Unrolling VTXOs

```typescript
import { Unroll, OnchainWallet, SingleKey } from '@arkade-os/sdk'

// Create an identity for the onchain wallet
const onchainIdentity = SingleKey.fromHex('your_onchain_private_key_hex');

// Create an onchain wallet to pay for P2A outputs in VTXO branches
// OnchainWallet implements the AnchorBumper interface
const onchainWallet = await OnchainWallet.create(onchainIdentity, 'regtest');

// Unroll a specific VTXO
const vtxo = { txid: 'your_vtxo_txid', vout: 0 };
const session = await Unroll.Session.create(
  vtxo,
  onchainWallet,
  onchainWallet.provider,
  wallet.indexerProvider
);

// Iterate through the unrolling steps
for await (const step of session) {
  switch (step.type) {
    case Unroll.StepType.WAIT:
      console.log(`Waiting for transaction ${step.txid} to be confirmed`);
      break;
    case Unroll.StepType.UNROLL:
      console.log(`Broadcasting transaction ${step.tx.id}`);
      break;
    case Unroll.StepType.DONE:
      console.log(`Unrolling complete for VTXO ${step.vtxoTxid}`);
      break;
  }
}
```

The unrolling process works by:

- Traversing the transaction chain from the root (most recent) to the leaf (oldest)
- Broadcasting each transaction that isn't already on-chain
- Waiting for confirmations between steps
- Using P2A (Pay-to-Anchor) transactions to pay for fees

#### Step 2: Completing the Exit

Once VTXOs are fully unrolled and the unilateral exit timelock has expired, you can complete the exit:

```typescript
// Complete the exit for specific VTXOs
await Unroll.completeUnroll(
  wallet,
  [vtxo.txid], // Array of VTXO transaction IDs to complete
  onchainWallet.address // Address to receive the exit amount
);
```

**Important Notes:**

- Each VTXO may require multiple unroll steps depending on the transaction chain length
- Each unroll step must be confirmed before proceeding to the next
- The `completeUnroll` method can only be called after VTXOs are fully unrolled and the timelock has expired
- You need sufficient on-chain funds in the `OnchainWallet` to pay for P2A transaction fees

### Running the wallet in a service worker

The SDK provides a `MessageBus` orchestrator that runs inside a service worker
and routes messages to pluggable `MessageHandler`s. The built-in
`WalletMessageHandler` exposes all wallet operations over this message bus, and
`ServiceWorkerWallet` is a client-side proxy that communicates with it
transparently.

#### Service worker file

```javascript
// service-worker.js
import {
  MessageBus,
  WalletMessageHandler,
  IndexedDBWalletRepository,
  IndexedDBContractRepository,
} from '@arkade-os/sdk'

const walletRepo = new IndexedDBWalletRepository()
const contractRepo = new IndexedDBContractRepository()

const bus = new MessageBus(walletRepo, contractRepo, {
  messageHandlers: [new WalletMessageHandler()],
  tickIntervalMs: 10_000, // default 10s
})

bus.start()
```

#### Client-side usage

```typescript
// app.ts
import { ServiceWorkerWallet, SingleKey } from '@arkade-os/sdk'

const identity = SingleKey.fromHex('your_private_key_hex')

// One-liner: registers the SW, initializes the MessageBus, and creates the wallet
const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  arkServerUrl: 'https://mutinynet.arkade.sh',
  identity,
})

// Use like any other wallet — calls are proxied to the service worker
const address = await wallet.getAddress()
const balance = await wallet.getBalance()
```

For watch-only wallets, use `ServiceWorkerReadonlyWallet` with a
`ReadonlySingleKey` identity instead.

### Worker Architecture

The _worker_ captures the background processing infrastructure for the SDK.
Two platform-specific implementations share common patterns (pluggable
handlers, periodic scheduling, repository/provider dependency injection) but
differ in orchestration and communication.

| Platform | Directory                                    | Orchestrator | Communication |
|----------|----------------------------------------------|-------------|---------------|
| **Browser** | [`browser/`](./src/worker/browser/README.md) | `MessageBus` inside a Service Worker | `postMessage` between SW and window clients |
| **Expo/React Native** | [`expo/`](./src/worker/expo/README.md)       | `runTasks()` called from foreground interval and OS background wake | `AsyncStorageTaskQueue` inbox/outbox |

See the platform READMEs for architecture details, runtime flow, and usage
examples.



### Repositories (Storage)

The `StorageAdapter` API is deprecated. Use repositories instead. If you omit
`storage`, the SDK uses IndexedDB repositories with the default database name.

#### Migration from v1 StorageAdapter

> [!WARNING]
> If you previously used the v1 `StorageAdapter`-based repositories, migrate
> data into the new IndexedDB repositories before use:
>
> ```typescript
> import {
>   IndexedDBWalletRepository,
>   IndexedDBContractRepository,
>   getMigrationStatus,
>   migrateWalletRepository,
>   rollbackMigration,
> } from '@arkade-os/sdk'
> import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
>
> const oldStorage = new IndexedDBStorageAdapter('legacy-wallet', 1)
> const newDbName = 'my-app-db'
> const walletRepository = new IndexedDBWalletRepository(newDbName)
>
> // Check migration status before running
> const status = await getMigrationStatus('wallet', oldStorage)
> // status: "not-needed" | "pending" | "in-progress" | "done"
>
> if (status === 'pending' || status === 'in-progress') {
>   try {
>     await migrateWalletRepository(oldStorage, walletRepository, {
>       onchain: [ 'address-1', 'address-2' ],
>       offchain: [ 'onboarding-address-1' ],
>     })
>   } catch (err) {
>     // Reset migration flag so the next attempt starts clean
>     await rollbackMigration('wallet', oldStorage)
>     throw err
>   }
> }
> ```
>
> **Migration status helpers:**
>
> | Helper | Description |
> |--------|-------------|
> | `getMigrationStatus(repoType, adapter)` | Returns `"not-needed"` (no legacy DB), `"pending"`, `"in-progress"` (interrupted), or `"done"` |
> | `requiresMigration(repoType, adapter)` | Returns `true` if status is `"pending"` or `"in-progress"` |
> | `rollbackMigration(repoType, adapter)` | Removes the migration flag so migration can re-run from scratch |
> | `MIGRATION_KEY(repoType)` | Returns the storage key used for the migration flag |
>
> `migrateWalletRepository` sets an `"in-progress"` flag before copying data.
> If the process crashes mid-way, the flag remains as `"in-progress"` so the
> next call to `getMigrationStatus` can detect the partial migration. Old data
> is never deleted — re-running migration after a rollback is safe.
>
> Anything related to contract repository migration must be handled by the package which created them. The SDK doesn't manage contracts in V1. Data remains untouched and persisted in the same old location.
>
> If you persisted custom data in the ContractRepository via its `setContractData` method,
> or a custom collection via `saveToContractCollection`, you'll need to migrate it manually:
>
> ```typescript
> // Custom data stored in the ContractRepository
> const oldStorage = new IndexedDBStorageAdapter('legacy-wallet', 1)
> const oldRepo = new ContractRepositoryImpl(storageAdapter)
> const customContract = await oldRepo.getContractData('my-contract', 'status')
> await contractRepository.setContractData('my-contract', 'status', customData)
> const customCollection = await oldRepo.getContractCollection('swaps')
> await contractRepository.saveToContractCollection('swaps', customCollection)
> ```

#### Repository Versioning

`WalletRepository`, `ContractRepository`, and `SwapRepository` (in
`@arkade-os/boltz-swap`) each declare a `readonly version` field with a literal
type. All built-in implementations set this to the current version. If you
maintain a custom repository implementation, TypeScript will produce a compile
error when the version is bumped, signaling that a semantic update is required:

```typescript
import { WalletRepository } from '@arkade-os/sdk'

class MyWalletRepository implements WalletRepository {
  readonly version = 1 // must match the interface's literal type
  // ...
}
```

#### SQLite Repository (Node.js / React Native)

For Node.js or React Native environments, use the SQLite repository with any
SQLite driver. The SDK accepts a `SQLExecutor` interface — you provide the
driver, the SDK handles the schema.

See [examples/node/multiple-wallets.ts](examples/node/multiple-wallets.ts) for
a full working example using `better-sqlite3`.

```typescript
import { SingleKey, Wallet } from '@arkade-os/sdk'
import { SQLiteWalletRepository, SQLiteContractRepository, SQLExecutor } from '@arkade-os/sdk/repositories/sqlite'
import Database from 'better-sqlite3'

const db = new Database('my-wallet.sqlite')
db.pragma('journal_mode = WAL')

const executor: SQLExecutor = {
  run: async (sql, params) => { db.prepare(sql).run(...(params ?? [])) },
  get: async (sql, params) => db.prepare(sql).get(...(params ?? [])) as any,
  all: async (sql, params) => db.prepare(sql).all(...(params ?? [])) as any,
}

const wallet = await Wallet.create({
  identity: SingleKey.fromHex('your_private_key_hex'),
  arkServerUrl: 'https://mutinynet.arkade.sh',
  storage: {
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  },
})
```

#### Realm Repository (React Native)

For React Native apps using Realm, pass your Realm instance directly:

```typescript
import { RealmWalletRepository, RealmContractRepository, ArkRealmSchemas } from '@arkade-os/sdk/repositories/realm'

const realm = await Realm.open({ schema: [...ArkRealmSchemas, ...yourSchemas] })
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
  storage: {
    walletRepository: new RealmWalletRepository(realm),
    contractRepository: new RealmContractRepository(realm),
  },
})
```

#### IndexedDB Repository (Browser)

In the browser, the SDK defaults to IndexedDB repositories when no `storage`
is provided:

```typescript
import { SingleKey, Wallet } from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity: SingleKey.fromHex('your_private_key_hex'),
  arkServerUrl: 'https://mutinynet.arkade.sh',
  // Uses IndexedDB by default in the browser
})
```

If you want a custom database name or a different repository implementation,
pass `storage` explicitly.

For ephemeral storage (no persistence), pass the in-memory repositories:

```typescript
import {
  InMemoryWalletRepository,
  InMemoryContractRepository,
  Wallet
} from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
  storage: {
    walletRepository: new InMemoryWalletRepository(),
    contractRepository: new InMemoryContractRepository()
  }
})
```

### Using with Node.js

Node.js does not provide a global `EventSource` implementation. The SDK relies on `EventSource` for Server-Sent Events during settlement (onboarding/offboarding) and contract watching. You must polyfill it before using the SDK:

```bash
npm install eventsource
```

```typescript
import { EventSource } from "eventsource";
(globalThis as any).EventSource = EventSource;

// Use dynamic import so the polyfill is set before the SDK evaluates
const { Wallet, SingleKey, Ramps } = await import("@arkade-os/sdk");
```

If you also need IndexedDB persistence (e.g. for `WalletRepository`), set up the shim before any SDK import:

```typescript
// Must define `self` BEFORE calling setGlobalVars
if (typeof self === "undefined") {
    (globalThis as any).self = globalThis;
}
import setGlobalVars from "indexeddbshim/src/node-UnicodeIdentifiers";
(globalThis as any).window = globalThis;
setGlobalVars(null, { checkOrigin: false });
```

> **Note:** `eventsource` and `indexeddbshim` are optional peer dependencies.
> Without the `EventSource` polyfill, settlement operations will fail with
> `ReferenceError: EventSource is not defined`.

See [`examples/node/multiple-wallets.ts`](examples/node/multiple-wallets.ts) for a complete working example.

### Using with Expo/React Native

For React Native and Expo applications where standard EventSource and fetch streaming may not work properly, use the Expo-compatible providers:

```typescript
import { Wallet, SingleKey } from '@arkade-os/sdk'
import { ExpoArkProvider, ExpoIndexerProvider } from '@arkade-os/sdk/adapters/expo'

const identity = SingleKey.fromHex('your_private_key_hex')

const wallet = await Wallet.create({
  identity: identity,
  esploraUrl: 'https://mutinynet.com/api',
  arkProvider: new ExpoArkProvider('https://mutinynet.arkade.sh'), // For settlement events and transactions streaming
  indexerProvider: new ExpoIndexerProvider('https://mutinynet.arkade.sh'), // For address subscriptions and VTXO updates
})

// use expo/fetch for streaming support (SSE)
// All other wallet functionality remains the same
const balance = await wallet.getBalance()
const address = await wallet.getAddress()
```

Both ExpoArkProvider and ExpoIndexerProvider are available as adapters following the SDK's modular architecture pattern. This keeps the main SDK bundle clean while providing opt-in functionality for specific environments:

- **ExpoArkProvider**: Handles settlement events and transaction streaming using expo/fetch for Server-Sent Events
- **ExpoIndexerProvider**: Handles address subscriptions and VTXO updates using expo/fetch for JSON streaming

For persistence in Expo/React Native, use the SQLite repository with `expo-sqlite`:

```typescript
import { SQLiteWalletRepository, SQLiteContractRepository } from '@arkade-os/sdk/repositories/sqlite'
import * as SQLite from 'expo-sqlite'

const db = SQLite.openDatabaseSync('my-wallet.db')
const executor = {
  run: (sql, params) => db.runAsync(sql, params ?? []),
  get: (sql, params) => db.getFirstAsync(sql, params ?? []),
  all: (sql, params) => db.getAllAsync(sql, params ?? []),
}

const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
  arkProvider: new ExpoArkProvider('https://mutinynet.arkade.sh'),
  indexerProvider: new ExpoIndexerProvider('https://mutinynet.arkade.sh'),
  storage: {
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  },
})
```

#### Crypto Polyfill Requirement

Install `expo-crypto` and polyfill `crypto.getRandomValues()` at the top of your app entry point:

```bash
npx expo install expo-crypto
```

```typescript
// App.tsx or index.js - MUST be first import
import * as Crypto from 'expo-crypto';
if (!global.crypto) global.crypto = {} as any;
global.crypto.getRandomValues = Crypto.getRandomValues;

// Now import the SDK
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ExpoArkProvider, ExpoIndexerProvider } from '@arkade-os/sdk/adapters/expo';
```

This is required for MuSig2 settlements and cryptographic operations.

### Contract Management

Both `Wallet` and `ServiceWorkerWallet` use a `ContractManager` internally to watch for VTXOs. This provides resilient connection handling with automatic reconnection and failsafe polling - for your wallet's default address and any external contracts you register (Boltz swaps, HTLCs, etc.).

When you call `wallet.notifyIncomingFunds()` or use `waitForIncomingFunds()`, it uses the ContractManager under the hood, giving you automatic reconnection and failsafe polling for free - no code changes needed.

For advanced use cases, you can access the ContractManager directly to register external contracts:

```typescript
// Get the contract manager (wallet's default address is already registered)
const manager = await wallet.getContractManager()

// Register a VHTLC contract (e.g., for a Lightning swap)
const contract = await manager.createContract({
  type: 'vhtlc',
  params: {
    sender: alicePubKey,
    receiver: bobPubKey,
    server: serverPubKey,
    hash: paymentHash,
    refundLocktime: '800000',
    claimDelay: '100',
    refundDelay: '102',
    refundNoReceiverDelay: '103',
  },
  script: swapScript,
  address: swapAddress,
})

// Listen for all contracts events (wallet address + external contracts)
const unsubscribe = await manager.onContractEvent((event) => {
  switch (event.type) {
    case 'vtxo_received':
      console.log(`Received ${event.vtxos.length} VTXOs on ${event.contractScript}`)
      break
    case 'vtxo_spent':
      console.log(`Spent VTXOs on ${event.contractScript}`)
      break
    case 'contract_expired':
      console.log(`Contract ${event.contractScript} expired`)
      break
  }
})

// Update contract data (e.g., set preimage when revealed)
await manager.updateContractParams(contract.script, { preimage: revealedPreimage })

// Check spendable paths (requires a specific VTXO)
const [withVtxos] = await manager.getContractsWithVtxos({ script: contract.script })
const vtxo = withVtxos.vtxos[0]
const paths = manager.getSpendablePaths({
  contractScript: contract.script,
  vtxo,
  collaborative: true,
  walletPubKey: myPubKey,
})
if (paths.length > 0) {
  console.log('Contract is spendable via:', paths[0].leaf)
}

// Or list all possible paths for the current context (no spendability checks)
const allPaths = manager.getAllSpendingPaths({
  contractScript: contract.script,
  collaborative: true,
  walletPubKey: myPubKey,
})

// Get balances across all contracts
const balances = await manager.getAllBalances()

// Manually sweep all eligible contracts
const sweepResults = await manager.sweepAll()

// Stop watching
unsubscribe()
```

The watcher features:
- **Automatic reconnection** with exponential backoff (1s → 30s max)
- **Failsafe polling** every 60 seconds to catch missed events
- **Immediate sync** on connection and after failures

### Repository Pattern

Access low-level data management through repositories:

```typescript
// VTXO management (automatically cached for performance)
const addr = await wallet.getAddress()
const vtxos = await wallet.walletRepository.getVtxos(addr)
await wallet.walletRepository.saveVtxos(addr, vtxos)

// Contract data for SDK integrations
await wallet.contractRepository.setContractData('my-contract', 'status', 'active')
const status = await wallet.contractRepository.getContractData('my-contract', 'status')

// Collection management for related data
await wallet.contractRepository.saveToContractCollection(
  'swaps',
  { id: 'swap-1', amount: 50000, type: 'reverse' },
  'id' // key field
)
const swaps = await wallet.contractRepository.getContractCollection('swaps')
```

_For complete API documentation, visit our [TypeScript documentation](https://arkade-os.github.io/ts-sdk/)._

## Development

### Requirements

- [pnpm](https://pnpm.io/) - Package manager
- [nigiri](https://github.com/vulpemventures/nigiri) - For running integration tests with a local Bitcoin regtest network

### Setup

1. Install dependencies:

   ```bash
   pnpm install
   pnpm format
   pnpm lint
   ```

1. Install nigiri for integration tests:

   ```bash
   curl https://getnigiri.vulpem.com | bash
   ```

### Running Tests

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests with ark provided by nigiri
nigiri start --ark
pnpm test:setup # Run setup script for integration tests
pnpm test:integration
nigiri stop --delete

# Run integration tests with ark provided by docker (requires nigiri)
nigiri start
pnpm test:up-docker
pnpm test:setup-docker # Run setup script for integration tests
pnpm test:integration-docker
pnpm test:down-docker
nigiri stop --delete

# Watch mode for development
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
```

### Building the documentation

```bash
# Build the TypeScript documentation
pnpm docs:build
# Open the docs in the browser
pnpm docs:open
```

### Releasing

```bash
# Release new version (will prompt for version patch, minor, major)
pnpm release

# You can test release process without making changes
pnpm release:dry-run

# Cleanup: checkout version commit and remove release branch
pnpm release:cleanup
```

## License

MIT
