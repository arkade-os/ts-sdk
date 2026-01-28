# Arkade TypeScript SDK

The Arkade SDK is a TypeScript library for building Bitcoin wallets with support for both on-chain and off-chain transactions via the Ark protocol.

[![TypeScript Documentation](https://img.shields.io/badge/TypeScript-Documentation-blue?style=flat-square)](https://arkade-os.github.io/ts-sdk/)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ark-ts-sdk)

## Installation

```bash
npm install @arkade-os/sdk
```

## Usage

### Creating a Wallet

```typescript
import {
  SingleKey,
  Wallet,
  IndexedDBWalletRepository,
  IndexedDBContractRepository
} from '@arkade-os/sdk'

// Create a new in-memory key (or use an external signer)
const identity = SingleKey.fromHex('your_private_key_hex')

// Create a wallet with Ark support
const wallet = await Wallet.create({
  identity,
  // Esplora API, can be left empty - mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api',
  arkServerUrl: 'https://mutinynet.arkade.sh',
  // Optional: provide repositories for persistence (defaults to IndexedDB)
  // storage: {
  //   walletRepository: new IndexedDBWalletRepository('my-wallet-db'),
  //   contractRepository: new IndexedDBContractRepository('my-wallet-db')
  // }
})
```

### Readonly Wallets (Watch-Only)

The SDK supports readonly wallets that allow you to query wallet state without exposing private keys. This is useful for:

- **Watch-only wallets**: Monitor addresses and balances without transaction capabilities
- **Public interfaces**: Display wallet information safely in public-facing applications
- **Separate concerns**: Keep signing operations isolated from query operations

#### Creating a Readonly Wallet

```typescript
import { ReadonlySingleKey, ReadonlyWallet } from '@arkade-os/sdk'

// Create a readonly identity from a public key
const identity = SingleKey.fromHex('your_public_key_hex')
const publicKey = await identity.compressedPublicKey()
const readonlyIdentity = ReadonlySingleKey.fromPublicKey(publicKey)

// Create a readonly wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
  arkServerUrl: 'https://mutinynet.arkade.sh'
})

// Query operations work normally
const address = await readonlyWallet.getAddress()
const balance = await readonlyWallet.getBalance()
const vtxos = await readonlyWallet.getVtxos()
const history = await readonlyWallet.getTransactionHistory()

// Transaction methods are not available (TypeScript will prevent this)
// await readonlyWallet.sendBitcoin(...) // ❌ Type error!
```

#### Converting Wallets to Readonly

```typescript
import { Wallet, SingleKey } from '@arkade-os/sdk'

// Create a full wallet
const identity = SingleKey.fromHex('your_private_key_hex')
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh'
})

// Convert to readonly wallet (safe to share)
const readonlyWallet = await wallet.toReadonly()

// The readonly wallet can query but not transact
const balance = await readonlyWallet.getBalance()
```

#### Converting Identity to Readonly

```typescript
import { SingleKey } from '@arkade-os/sdk'

// Full identity
const identity = SingleKey.fromHex('your_private_key_hex')

// Convert to readonly (no signing capability)
const readonlyIdentity = await identity.toReadonly()

// Use in readonly wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
  arkServerUrl: 'https://mutinynet.arkade.sh'
})
```

**Benefits:**
- ✅ Type-safe: Transaction methods don't exist on readonly types
- ✅ Secure: Private keys never leave the signing environment
- ✅ Flexible: Convert between full and readonly wallets as needed
- ✅ Same API: Query operations work identically on both wallet types

### Receiving Bitcoin

```typescript
import { waitForIncomingFunds } from '@arkade-os/sdk'

// Get wallet addresses
const arkAddress = await wallet.getAddress()
const boardingAddress = await wallet.getBoardingAddress()
console.log('Ark Address:', arkAddress)
console.log('Boarding Address:', boardingAddress)

const incomingFunds = await waitForIncomingFunds(wallet)
if (incomingFunds.type === "vtxo") {
  // Virtual coins received 
  console.log("VTXOs: ", incomingFunds.vtxos)
} else if (incomingFunds.type === "utxo") {
  // Boarding coins received
  console.log("UTXOs: ", incomingFunds.coins)
}
```

### Onboarding

Onboarding allows you to swap on-chain funds into VTXOs:

```typescript
import { Ramps } from '@arkade-os/sdk'

const onboardTxid = await new Ramps(wallet).onboard();
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
const virtualCoins = await wallet.getVtxos()

// Get boarding UTXOs
const boardingUtxos = await wallet.getBoardingUtxos()
```

### Sending Bitcoin

```typescript
// Send bitcoin via Ark
const txid = await wallet.sendBitcoin({
  address: 'ark1qq4...', // ark address
  amount: 50000,         // in satoshis
})
```

### Batch Settlements

This can be used to move preconfirmed balances into finalized balances and to manually convert UTXOs and VTXOs.

```typescript
// For settling transactions
const settleTxid = await wallet.settle({
  inputs, // from getVtxos() or getBoardingUtxos()
  outputs: [{
    address: destinationAddress,
    amount: BigInt(amount)
  }]
})
```

### VTXO Management (Renewal & Recovery)

VTXOs have an expiration time (batch expiry). The SDK provides the `VtxoManager` class to handle both:

- **Renewal**: Renew VTXOs before they expire to maintain unilateral control of the funds.
- **Recovery**: Reclaim swept or expired VTXOs back to the wallet in case renewal window was missed.

```typescript
import { VtxoManager } from '@arkade-os/sdk'

// Create manager with optional renewal configuration
const manager = new VtxoManager(wallet, {
  enabled: true,                   // Enable expiration monitoring
  thresholdMs: 24 * 60 * 60 * 1000 // Alert when 24h hours % of lifetime remains (default)
})
```

#### Renewal: Prevent Expiration

Renew VTXOs before they expire to retain unilateral control of funds.
This settles expiring and recoverable VTXOs back to your wallet, refreshing their expiration time.

```typescript
// Renew all VTXOs to prevent expiration
const txid = await manager.renewVtxos()
console.log('Renewed:', txid)

// Check which VTXOs are expiring soon
const expiringVtxos = await manager.getExpiringVtxos()
// Override thresholdMs (e.g., renew when 5 seconds of time remains)
const urgentlyExpiring = await manager.getExpiringVtxos(5_000)
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

**Ultra-simplified setup!** We handle all the complex service worker registration and identity management for you:

```typescript
// SIMPLE SETUP with identity! 🎉
import { ServiceWorkerWallet, SingleKey } from '@arkade-os/sdk';

// Create your identity
const identity = SingleKey.fromHex('your_private_key_hex');
// Or generate a new one:
// const identity = SingleKey.fromRandomBytes();

const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  arkServerUrl: 'https://mutinynet.arkade.sh',
  identity
});

// That's it! Ready to use immediately:
const address = await wallet.getAddress();
const balance = await wallet.getBalance();
```

You'll also need to create a service worker file:

```typescript
// service-worker.js
import { Worker } from '@arkade-os/sdk'

// Worker handles communication between the main thread and service worker
new Worker().start()
```

### Repositories (Storage)

The `StorageAdapter` API is deprecated. Use repositories instead. If you omit
`storage`, the SDK uses IndexedDB repositories with the default database name.

> [!WARNING]
> If you previously used the v1 `StorageAdapter`-based repositories, migrate
> data into the new IndexedDB repositories before use:
>
> ```typescript
> import {
>   IndexedDBWalletRepository,
>   IndexedDBContractRepository,
>   migrateWalletRepository
> } from '@arkade-os/sdk'
> import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
>
> const oldStorage = new IndexedDBStorageAdapter('legacy-wallet', 1)
> const newDbName = 'my-app-db'
>
> const walletRepository = new IndexedDBWalletRepository(newDbName)
> await migrateWalletRepository(oldStorage, walletRepository, [
>   'address-1',
>   'address-2'
> ])
> ```
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

Note: `IndexedDB*Repository` requires [indexeddbshim](https://github.com/indexeddbshim/indexeddbshim) in Node or other
**non-browser environments**. It is a dev dependency of the SDK, so you must
install and initialize it in your app before using the repositories. This
also applies when you rely on the default storage behavior (no `storage`).

Please see the working example in [examples/node/multiple-wallets.ts](examples/node/multiple-wallets.ts).

```typescript
import { SingleKey, Wallet } from '@arkade-os/sdk'
import setGlobalVars from 'indexeddbshim'

setGlobalVars()

const identity = SingleKey.fromHex('your_private_key_hex')

// Create wallet with default IndexedDB storage
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
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

To use IndexedDB repositories in Expo/React Native, install `indexeddbshim` and a
SQLite-backed WebSQL adapter (e.g., `expo-sqlite` or `react-native-sqlite-storage`),
then wire the WebSQL `openDatabase` into the shim before creating repositories:

```typescript
import setGlobalVars from 'indexeddbshim'
import * as SQLite from 'expo-sqlite'

setGlobalVars(globalThis, { openDatabase: SQLite.openDatabase })
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

// Check spendable paths
const paths = manager.getSpendablePaths({
  contractScript: contract.script,
  collaborative: true,
  walletPubKey: myPubKey,
})
if (paths.length > 0) {
  console.log('Contract is spendable via:', paths[0].leaf)
}

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
