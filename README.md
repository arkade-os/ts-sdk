# Arkade TypeScript SDK
The Arkade SDK is a TypeScript library for building Bitcoin wallets with support for both on-chain and off-chain transactions via the Ark protocol.

[![TypeScript Documentation](https://img.shields.io/badge/TypeScript-Documentation-blue?style=flat-square)](https://arkade-os.github.io/ts-sdk/)

## Installation

```bash
npm install @arkade-os/sdk
```

## Usage

### Creating a Wallet

```typescript
import { SingleKey, Wallet } from '@arkade-os/sdk'

// Create a new in-memory key (or use an external signer)
const identity = SingleKey.fromHex('your_private_key_hex')

// Create a wallet with Ark support
const wallet = await Wallet.create({
  identity: identity,
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  arkServerUrl: 'https://mutinynet.arkade.sh',
})
```

### Receiving Bitcoin

```typescript
// Get wallet addresses
const arkAddress = await wallet.getAddress()
const boardingAddress = await wallet.getBoardingAddress()
console.log('Ark Address:', arkAddress)
console.log('Boarding Address:', boardingAddress)

const incomingFunds = await waitForIncomingFunds(wallet)
if (incomingFunds.type === "vtxo") {
  // virtual coins received 
  console.log("VTXOs: ", incomingFunds.vtxos)
} else if (incomingFunds.type === "utxo") {
  // boarding coins received
  console.log("UTXOs: ", incomingFunds.coins)
}
```

### Onboarding

Onboarding allows you to swap onchain funds into VTXOs

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
  address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  amount: 50000,  // in satoshis
  feeRate: 1      // optional, in sats/vbyte
})
```

### Batch Settlements 

This can be used to move preconfirmed balances into finalized balances, to convert manually UTXOs and VTXOs.

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


### Transaction History

```typescript
// Get transaction history
const history = await wallet.getTransactionHistory()
console.log('History:', history)

// Example history entry:
{
  key: {
    boardingTxid: '...', // for boarding transactions
    commitmentTxid: '...', // for commitment transactions
    redeemTxid: '...'    // for regular transactions
  },
  type: TxType.TxReceived, // or TxType.TxSent
  amount: 50000,
  settled: true,
  createdAt: 1234567890
}
```

### Offboarding

Collaborative exit or "offboarding" allows you to withdraw your virtual funds to an onchain address.

```typescript
import { Ramps } from '@arkade-os/sdk'

const exitTxid = await new Ramps(wallet).offboard(onchainAddress);
```

### Unilateral Exit

Unilateral exit allows you to withdraw your funds from the Ark protocol back to the Bitcoin blockchain without requiring cooperation from the Ark server. This process involves two main steps:

1. **Unrolling**: Broadcasting the transaction chain from off-chain back to on-chain
2. **Completing the exit**: Spending the unrolled VTXOs after the timelock expires

#### Step 1: Unrolling VTXOs

```typescript
import { Unroll, OnchainWallet } from '@arkade-os/sdk'

// Create an onchain wallet to pay for P2A outputs in VTXO branches
// OnchainWallet implements the AnchorBumper interface
const onchainWallet = new OnchainWallet(wallet.identity, 'regtest');

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

1. Create a service worker file

```typescript
// service-worker.ts
import { Worker } from '@arkade-os/sdk'

// Worker handles communication between the main thread and service worker
new Worker().start()
```

2. Instantiate the ServiceWorkerWallet

```typescript
// specify the path to the service worker file
// this will automatically register the service worker
const serviceWorker = await setupServiceWorker('/service-worker.js')
const wallet = new ServiceWorkerWallet(serviceWorker)

// Initialize the wallet
await wallet.init({
  privateKey: 'your_private_key_hex',
  // Esplora API, can be left empty mempool.space API will be used
  esploraUrl: 'https://mutinynet.com/api', 
  // OPTIONAL Ark Server connection information
  arkServerUrl: 'https://mutinynet.arkade.sh',
})

// check service worker status
const status = await wallet.getStatus()
console.log('Service worker status:', status.walletInitialized)

// clear wallet data stored in the service worker memory
await wallet.clear()
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

2. Install nigiri for integration tests:

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
# Build the TS doc
pnpm docs:build
# open the docs in the browser
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
