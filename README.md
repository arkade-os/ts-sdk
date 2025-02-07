# Ark Wallet SDK
The Ark Wallet SDK is a TypeScript library for building Bitcoin wallets with support for both on-chain and off-chain transactions via Ark protocol.

![v3](https://github.com/user-attachments/assets/bec6fd29-417d-46af-8216-709edc39d566)

## Installation

```bash
npm install @arklabs/wallet-sdk
```

## Usage

### Creating a Wallet

```typescript
import { InMemoryKey, Wallet } from '@arklabs/wallet-sdk'

// Create a new in-memory key (or use an external signer)
const identity = InMemoryKey.fromHex('your_private_key_hex')

// Create a wallet with Ark support
const wallet = new Wallet({
  network: 'mutinynet',  // 'bitcoin', 'testnet', 'regtest', 'signet' or 'mutinynet'
  identity: identity,
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  // OPTIONAL Ark Server connection information
  arkServerUrl: 'https://master.mutinynet.arklabs.to',
  arkServerPublicKey: 'd45fc69d4ff1f45cbba36ab1037261863c3a49c4910bc183ae975247358920b6'
})

// Get wallet addresses
const { onchain, offchain, bip21 } = wallet.getAddress()
console.log('Bitcoin Address:', onchain)
console.log('Ark Address:', offchain)
console.log('BIP21 URI:', bip21)
```

### Sending Bitcoin

```typescript
// Send bitcoin (automatically chooses on-chain or off-chain based on the address)
const txid = await wallet.sendBitcoin({
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,  // in satoshis
  feeRate: 1      // optional, in sats/vbyte
})

// Force on-chain transaction
const txid = await wallet.sendOnchain({
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,
  feeRate: 1
})

// Force off-chain transaction (requires Ark configuration)
const txid = await wallet.sendOffchain({
  address: 'tark1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,
  feeRate: 1
})
```

### Checking Balance

```typescript
// Get detailed balance information
const balance = await wallet.getBalance()
console.log('Total Balance:', balance.total)

// Onchain balances
console.log('Onchain Total:', balance.onchain.total)
console.log('Onchain Confirmed:', balance.onchain.confirmed)
console.log('Onchain Unconfirmed:', balance.onchain.unconfirmed)

// Offchain balances (if Ark is configured)
console.log('Offchain Total:', balance.offchain.total)
console.log('Offchain Settled:', balance.offchain.settled)
console.log('Offchain Pending:', balance.offchain.pending)
console.log('Offchain Swept:', balance.offchain.swept)
```

### Getting UTXOs and Virtual UTXOs

```typescript
// Get on-chain UTXOs
const coins = await wallet.getCoins()

// Get off-chain virtual UTXOs (requires Ark configuration)
const virtualCoins = await wallet.getVirtualCoins()
```

### Message Signing

```typescript
// Sign a message
const signature = await wallet.signMessage('Hello, World!')

// Verify a message
const isValid = await wallet.verifyMessage(
  'Hello, World!',
  signature,
  'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
)
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

#### Identity Interface

The SDK provides two implementations of the `Identity` interface:

1. `InMemoryKey`: For managing private keys in memory

```typescript
class InMemoryKey {
  static fromPrivateKey(privateKey: Uint8Array): InMemoryKey;
  static fromHex(privateKeyHex: string): InMemoryKey;
}
```

2.`ExternalSigner`: For integrating with external signing devices (hardware wallets, etc.)

```typescript
class ExternalSigner {
  static fromSigner(signer: any): ExternalSigner;
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
