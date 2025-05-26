# Arkade TypeScript SDK
The Arkade SDK is a TypeScript library for building Bitcoin wallets with support for both on-chain and off-chain transactions via the Ark protocol.

## Installation

```bash
npm install @arkade-os/sdk
```

## Usage

### Creating a Wallet

```typescript
import { InMemoryKey, Wallet } from '@arkade-os/sdk'

// Create a new in-memory key (or use an external signer)
const identity = InMemoryKey.fromHex('your_private_key_hex')

// Create a wallet with Ark support
const wallet = await Wallet.create({
  network: 'mutinynet',  // 'bitcoin', 'testnet', 'regtest', 'signet' or 'mutinynet'
  identity: identity,
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  // OPTIONAL Ark Server connection information
  arkServerUrl: 'https://mutinynet.arkade.sh',
  arkServerPublicKey: 'fa73c6e4876ffb2dfc961d763cca9abc73d4b88efcb8f5e7ff92dc55e9aa553d'
})

// Get wallet addresses
const addresses = await wallet.getAddress()
console.log('Bitcoin Address:', addresses.onchain)
console.log('Ark Address:', addresses.offchain)
console.log('Boarding Address:', addresses.boarding)
console.log('BIP21 URI:', addresses.bip21)
```

### Sending Bitcoin

```typescript
// Send bitcoin (automatically chooses on-chain or off-chain based on the address)
const txid = await wallet.sendBitcoin({
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,  // in satoshis
  feeRate: 1      // optional, in sats/vbyte
})

// For settling transactions
const settleTxid = await wallet.settle({
  inputs, // from getVtxos() or getBoardingUtxos()
  outputs: [{
    address: destinationAddress,
    amount: BigInt(amount)
  }]
})
```

### Checking Balance

```typescript
// Get detailed balance information
const balance = await wallet.getBalance()
console.log('Total Onchain:', balance.onchain.total)
console.log('Total Offchain:', balance.offchain.total)

// Get virtual UTXOs (off-chain)
const virtualCoins = await wallet.getVtxos()

// Get boarding UTXOs
const boardingUtxos = await wallet.getBoardingUtxos()
```

### Transaction History

```typescript
// Get transaction history
const history = await wallet.getTransactionHistory()
console.log('History:', history)

// Example history entry:
{
  type: TxType.TxReceived, // or TxType.TxSent
  amount: 50000,
  settled: true,
  key: {
    boardingTxid: '...', // for boarding transactions
    redeemTxid: '...'    // for regular transactions
  }
}
```

### Unilateral Exit

```typescript
// Unilateral exit all vtxos
await wallet.exit();

// Unilateral exit a specific vtxo
await wallet.exit([{ txid: vtxo.txid, vout: vtxo.vout }]);
```

### Running the wallet in a service worker

1. Create a service worker file

```typescript
// service-worker.ts
import { Worker } from '@arkade-os/sdk'

// Worker is a class handling the communication between the main thread and the service worker
new Worker().start()
```

2. Instantiate the ServiceWorkerWallet

```typescript
// specify the path to the service worker file
// this will automatically register the service worker
const wallet = await ServiceWorkerWallet.create('/service-worker.js')

// initialize the wallet
await wallet.init({
  network: 'mutinynet',  // 'bitcoin', 'testnet', 'regtest', 'signet' or 'mutinynet'
  identity: identity,
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  // OPTIONAL Ark Server connection information
  arkServerUrl: 'https://mutinynet.arkade.sh',
  arkServerPublicKey: 'fa73c6e4876ffb2dfc961d763cca9abc73d4b88efcb8f5e7ff92dc55e9aa553d'
})
```

## API Reference

### Wallet

#### Constructor Options

```typescript
interface WalletConfig {
  /** Network to use ('bitcoin', 'testnet', 'regtest', 'signet', or 'mutinynet') */
  network: NetworkName;
  /** Identity for signing transactions */
  identity: Identity;
  /** Optional Esplora API URL */
  esploraUrl?: string;
  /** Ark server URL (optional) */
  arkServerUrl?: string;
  /** Ark server public key (optional) */
  arkServerPublicKey?: string;
}
```

#### Methods

```typescript
interface IWallet {
  /** Get wallet addresses */
  getAddress(): Promise<{
    onchain?: Address;
    offchain?: Address;
    boarding?: Address;
    bip21?: string;
  }>;

  /** Get wallet balance */
  getBalance(): Promise<{
    onchain: {
      total: number;
      confirmed: number;
      unconfirmed: number;
    };
    offchain: {
      total: number;
      settled: number;
      pending: number;
    };
  }>;

  /** Send bitcoin (on-chain or off-chain) */
  sendBitcoin(params: {
    address: string;
    amount: number;
    feeRate?: number;
  }, onchain?: boolean): Promise<string>;

  /** Get virtual UTXOs */
  getVtxos(): Promise<VirtualCoin[]>;

  /** Get boarding UTXOs */
  getBoardingUtxos(): Promise<BoardingUtxo[]>;

  /** Settle transactions */
  settle(params: {
    inputs: (VirtualCoin | BoardingUtxo)[];
    outputs: {
      address: string;
      amount: bigint;
    }[];
  }): Promise<string>;

  /** Get transaction history */
  getTransactionHistory(): Promise<Transaction[]>;
}

/** Transaction types */
enum TxType {
  TxSent = 'sent',
  TxReceived = 'received'
}

/** Transaction history entry */
interface Transaction {
  type: TxType;
  amount: number;
  settled: boolean;
  key: {
    boardingTxid?: string;
    redeemTxid?: string;
  };
}

/** Virtual coin (off-chain UTXO) */
interface VirtualCoin {
  txid: string;
  value: number;
  virtualStatus: {
    state: 'pending' | 'settled';
  };
}

/** Boarding UTXO */
interface BoardingUtxo {
  txid: string;
  vout: number;
  value: number;
}
```

#### Identity

```typescript
export interface Identity {
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    xOnlyPublicKey(): Uint8Array;
    signerSession(): SignerSession;
}
```

The SDK provides a default implementation of the `Identity` interface: `InMemoryKey` for managing private keys in memory:

```typescript
class InMemoryKey {
  static fromPrivateKey(privateKey: Uint8Array): InMemoryKey;
  static fromHex(privateKeyHex: string): InMemoryKey;
}
```

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

2.Install nigiri for integration tests:

```bash
curl https://getnigiri.vulpem.com | bash
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run unit tests only
pnpm test:unit

# Run integration tests (requires nigiri)
nigiri start --ark
pnpm test:setup      # Run setup script for integration tests
pnpm test:integration
nigiri stop --delete

# Watch mode for development
pnpm test:watch

# Run tests with coverage
pnpm test:coverage
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
