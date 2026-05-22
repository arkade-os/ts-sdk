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
const wallet = await Wallet.create({ identity })  // defaults to mainnet
```

### Read-Only Wallets (Watch-Only)

The SDK supports read-only wallets that allow you to query wallet state without exposing private keys. This is useful for:

- **Watch-only wallets**: Monitor addresses and balances without transaction capabilities
- **Public interfaces**: Display wallet information safely in public-facing applications
- **Separate concerns**: Keep signing operations isolated from query operations

#### Creating a Read-Only Wallet

```typescript
import { SingleKey, ReadonlySingleKey, ReadonlyWallet } from '@arkade-os/sdk'

// Create a read-only identity from a public key
const identity = SingleKey.fromHex('e09ca...56609')
const publicKey = await identity.compressedPublicKey()
const readonlyIdentity = ReadonlySingleKey.fromPublicKey(publicKey)

// Create a read-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
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
const wallet = await Wallet.create({ identity })

// Convert to read-only wallet (safe to share)
const readonlyWallet = await wallet.toReadonly()

// The read-only wallet can query but not transact
const balance = await readonlyWallet.getBalance()
```

#### Converting Identity to Read-Only

```typescript
import { MnemonicIdentity } from '@arkade-os/sdk'

// Full identity
const identity = MnemonicIdentity.fromMnemonic('abandon abandon...')

// Convert to read-only (no signing capability)
const readonlyIdentity = await identity.toReadonly()

// Use in read-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonlyIdentity,
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
})
```

#### Creating from Raw Seed

```typescript
import { SeedIdentity } from '@arkade-os/sdk'
import { mnemonicToSeedSync } from '@scure/bip39'

// If you already have a 64-byte seed
const seed = mnemonicToSeedSync(mnemonic)
const identity = SeedIdentity.fromSeed(seed)

// Or with a custom account-descriptor template (must end in "/*)")
const identityWithDescriptor = SeedIdentity.fromSeed(seed, { descriptor: template })

// Or with a custom template and passphrase (MnemonicIdentity)
const identityWithDescriptorAndPassphrase = MnemonicIdentity.fromMnemonic(mnemonic, {
  descriptor: template,
  passphrase: 'my secret passphrase'
})
```

#### Watch-Only with ReadonlyDescriptorIdentity

Create watch-only wallets from an account-descriptor template:

```typescript
import { MnemonicIdentity, ReadonlyDescriptorIdentity, ReadonlyWallet } from '@arkade-os/sdk'
import { generateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

// From a full identity
const mnemonic = generateMnemonic(wordlist)
const identity = MnemonicIdentity.fromMnemonic(mnemonic)
const readonly = await identity.toReadonly()

// Or directly from a wildcard template (e.g., exported from another wallet)
const template = "tr([12345678/86'/0'/0']xpub.../0/*)"
const readonlyFromTemplate = ReadonlyDescriptorIdentity.fromDescriptor(template)

// Use in a watch-only wallet
const readonlyWallet = await ReadonlyWallet.create({
  identity: readonly,
})

// Can query but not sign
const balance = await readonlyWallet.getBalance()
```

**Derivation Path:** `m/86'/{coinType}'/0'/0/*`
- BIP86 (Taproot) purpose
- Coin type 0 for mainnet, 1 for testnet
- Account 0, external chain, wildcard index — `identity.descriptor` is the wildcard template that drives HD rotation; consumers materialize a concrete descriptor at a specific index when they need one.

### Batch Signing for Browser Wallets

Arkade send transactions require N+1 PSBT signatures (N checkpoints + 1 main tx). With local identities like `SingleKey` or `SeedIdentity` this is invisible, but browser wallet extensions (Xverse, UniSat, OKX, etc.) show a confirmation popup per signature. The `BatchSignableIdentity` interface lets wallet providers reduce N+1 popups to a single batch confirmation.

```typescript
import {
  BatchSignableIdentity,
  SignRequest,
  isBatchSignable,
  Wallet
} from '@arkade-os/sdk'

// Implement the interface in your wallet provider
class MyBrowserWallet implements BatchSignableIdentity {
  // ... implement Identity methods (sign, signMessage, xOnlyPublicKey, etc.)

  async signMultiple(requests: SignRequest[]): Promise<Transaction[]> {
    // Convert all PSBTs to your wallet's batch signing API format
    const psbts = requests.map(r => r.tx.toPSBT())
    // Single wallet popup for all signatures
    const signedPsbts = await myWalletExtension.signAllPSBTs(psbts)
    return signedPsbts.map(psbt => Transaction.fromPSBT(psbt))
  }
}

// The SDK automatically detects batch-capable identities
const identity = new MyBrowserWallet()
console.log(isBatchSignable(identity)) // true

// Wallet.send() uses one popup instead of N+1
const wallet = await Wallet.create({ identity })
await wallet.send({ address: 'ark1q...', amount: 1000 })
```

Identities without `signMultiple` continue to work unchanged — each checkpoint is signed individually via `sign()`.

### Onchain Providers

Wallets read onchain state (UTXOs, transactions, fee rates, chain tip) through an `OnchainProvider`. The SDK ships with two implementations and a single transport-agnostic interface so you can swap them without touching wallet code.

| Provider | Transport | When to use |
|---|---|---|
| `EsploraProvider` | REST/HTTP (mempool.space-compatible) | Default for browser wallets, public mempool deployments, simple integrations. Both atomic 1P1C package broadcast and outspends are first-class. |
| `ElectrumOnchainProvider` | WebSocket (Electrum protocol) | Self-hosted nodes (Fulcrum, electrs), low-latency subscriptions, environments where you control the backend. Required if you need to talk to an Electrum server directly. |

If you don't pass a provider explicitly, `OnchainWallet` and `Wallet.create({ ... })` both default to `EsploraProvider` pointing at the URL in `ESPLORA_URL[networkName]`.

#### Default URLs

The SDK ships with reachable defaults for each network — bitcoin, signet, and mutinynet point at Ark Labs–operated deployments; testnet falls back to mempool.space; regtest assumes a local nigiri stack.

```typescript
import {
  ESPLORA_URL,        // Record<NetworkName, string>
  ELECTRUM_WS_URL,    // Record<NetworkName, string>
  ELECTRUM_TCP_HOST,  // Record<NetworkName, string | null> — informational
} from '@arkade-os/sdk'

ESPLORA_URL.bitcoin       // "https://mempool.arkade.sh/api"
ESPLORA_URL.signet        // "https://mempool.signet.arkade.sh/api"
ESPLORA_URL.mutinynet     // "https://mempool.mutinynet.arkade.sh/api"

ELECTRUM_WS_URL.bitcoin   // "wss://electrum.arkade.sh"
ELECTRUM_WS_URL.signet    // "wss://electrum.signet.arkade.sh"
ELECTRUM_WS_URL.mutinynet // "wss://electrum.mutinynet.arkade.sh"
```

#### Using Esplora (default)

```typescript
import { EsploraProvider, ESPLORA_URL, OnchainWallet } from '@arkade-os/sdk'

// Use the default URL for the network
const provider = new EsploraProvider(ESPLORA_URL.bitcoin)

// Or pass nothing — OnchainWallet picks the default for you
const wallet = await OnchainWallet.create(identity, 'bitcoin')

// Or override with your own mempool/esplora instance
const customProvider = new EsploraProvider('https://my-esplora.example/api')
```

#### Using Electrum (WebSocket)

```typescript
import { ElectrumWS } from 'ws-electrumx-client'
import {
  ElectrumOnchainProvider,
  ELECTRUM_WS_URL,
  OnchainWallet,
  networks,
} from '@arkade-os/sdk'

const ws = new ElectrumWS(ELECTRUM_WS_URL.bitcoin)
const provider = new ElectrumOnchainProvider(ws, networks.bitcoin)

const wallet = await OnchainWallet.create(identity, 'bitcoin', provider)

// Remember to close the connection when you're done
await provider.close()
```

#### Atomic 1P1C package broadcast (TRUC / BIP 431)

Both providers expose `broadcastTransaction(...txs)` that accepts either a single tx or a 1P1C package (parent first, child last). The package path is **atomic** — the parent doesn't have to independently meet mempool minfee, which is the point of TRUC relay.

The Electrum provider implements this via `blockchain.transaction.broadcast_package` (Fulcrum ≥ 1.10 backed by bitcoind ≥ v28). **There is no fallback to sequential broadcast**: if the server doesn't support `broadcast_package`, the call surfaces a clear error so you can route through a different provider rather than have TRUC packages silently fail at the parent step. Ark Labs Fulcrum deployments at `electrum.arkade.sh` (and the `*.signet` / `*.mutinynet` variants) all support it.

#### Server compatibility notes

`ElectrumOnchainProvider` is built around methods supported by both **Fulcrum** and **electrs** (the two main Electrum server implementations):

- ✅ `blockchain.scripthash.{listunspent, get_history, subscribe}`
- ✅ `blockchain.transaction.{get, get_merkle, broadcast}`
- ✅ `blockchain.block.header`, `blockchain.headers.subscribe`
- ✅ `blockchain.estimatefee`, `blockchain.relayfee`
- ⚠️ `blockchain.transaction.broadcast_package` — **Fulcrum-only**. Required for atomic 1P1C; the provider throws a descriptive error against electrs.
- ❌ The provider does **not** call `blockchain.transaction.get` with `verbose=true` (Fulcrum-only and rejected by electrs); confirmation status is derived from `transaction.get_merkle` + raw block headers instead.

Output amounts are derived from parsed raw transaction bytes (exact bigints), never from floating-point `value` fields — protocol-level money handling shouldn't depend on `Math.round(value * 1e8)`.

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
  // Virtual outputs received 
  console.log("VTXOs: ", incomingFunds.newVtxos)
} else if (incomingFunds.type === "utxo") {
  // Boarding inputs received
  console.log("UTXOs: ", incomingFunds.coins)
}
```

### Onboarding

Onboarding allows you to swap onchain funds into virtual outputs:

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

// Get virtual outputs (available for offchain spending)
const vtxos = await wallet.getVtxos()

// Get boarding inputs
const boardingInputs = await wallet.getBoardingUtxos()
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
  amount: 1n,
  metadata: {
    ticker: 'ctrl-MTK'
  }
})

// Issue a new asset referencing the control asset
const { assetId } = await wallet.assetManager.issue({
  amount: 500n,
  controlAssetId,
  metadata: {
    ticker: 'MTK'
  }
})

// Reissue more supply of the asset (requires ownership of the control asset)
const reissuanceTxId = await wallet.assetManager.reissue({
  assetId,
  amount: 500n,
})

// Burn some of the asset
const burnTxId = await wallet.assetManager.burn({
  assetId,
  amount: 200n,
})

// Send asset to another Arkade address
const sendTxId = await wallet.send({
  address: 'ark1q...',
  assets: [{ assetId, amount: 100n }],
})

// Check remaining balance
const { assets } = await wallet.getBalance()
const assetBalance = assets.find(asset => asset.assetId === assetId)?.amount
```

### Batch Settlement

The `settle` method can be used to move preconfirmed balances into finalized balances and to manually convert onchain funds to virtual outputs.

```typescript
// Fetch offchain preconfirmed outputs and onchain boarding inputs
const [vtxos, boardingInputs] = await Promise.all([
  wallet.getVtxos(),
  wallet.getBoardingUtxos()
])

// For settling transactions
const settlementTxId = await wallet.settle({
  inputs: [...vtxos, ...boardingInputs],
  // Optional: specify a mainnet output
  outputs: [{
    address: "bc1p...",
    amount: 100_000n
  }]
})
```

### Virtual Output Management (Renewal & Recovery)

Virtual outputs have an expiration time (batch expiry).

The SDK provides the `VtxoManager` class to handle:

- **Renewal**: Renew virtual outputs before they expire to maintain unilateral control of the funds.
- **Recovery**: Reclaim swept or expired virtual outputs back to the wallet in case renewal window was missed.
- **Boarding Input Sweep**: Sweep expired boarding inputs back to a fresh boarding address to restart the timelock.

#### Settlement Configuration

The recommended way to configure `VtxoManager` is via `settlementConfig` on the wallet.
If you omit `settlementConfig`, settlement is enabled with the default behavior:
Virtual output renewal at 3 days and boarding input sweep enabled.

```typescript
const wallet = await Wallet.create({
  identity,
  // Enable settlement with defaults explicitly:
  settlementConfig: {
    // Seconds before virtual output expiry to trigger renewal
    vtxoThreshold: 60 * 60 * 24 * 3, // 3 days
    // Whether to sweep expired boarding inputs back to a fresh boarding address
    boardingUtxoSweep: true,
    // Polling interval in milliseconds for checking boarding inputs
    pollIntervalMs: 60_000 // 1 minute
  },
})
```

```typescript
// Enable both virtual output renewal and boarding input sweep
const wallet = await Wallet.create({
  identity,
  settlementConfig: {
    vtxoThreshold: 60 * 60 * 24,  // renew when 24 hours remain (in seconds)
    boardingUtxoSweep: true,      // sweep expired boarding inputs
  },
})
```

```typescript
// Explicitly disable all settlement
const wallet = await Wallet.create({
  identity,
  settlementConfig: false,
})
```

Access the `VtxoManager` from the wallet after configuring `settlementConfig`:

```typescript
const manager = await wallet.getVtxoManager()
```

> **Migration from `renewalConfig`:** Directly initializing a `VtxoManager` with `renewalConfig` is still supported but deprecated. Prefer `settlementConfig` where `vtxoThreshold` is expressed in **seconds** instead of milliseconds.

#### Renewal: Prevent Expiration

Renew virtual outputs before they expire to retain unilateral control of funds.
This settles expiring and recoverable virtual outputs back to your wallet, refreshing their expiration time.

```typescript
// Renew all virtual outputs to prevent expiration
const txid = await manager.renewVtxos()
// Check which virtual outputs are expiring soon
const expiringVtxos = await manager.getExpiringVtxos()
// Override thresholdMs (e.g., get virtual outputs expiring in the next 60 seconds)
const urgentlyExpiring = await manager.getExpiringVtxos(60_000)
```

#### Boarding Input Sweep

When a boarding input's CSV timelock expires, it can no longer be onboarded into Arkade cooperatively. The sweep feature detects these expired UTXOs and builds a raw onchain transaction that spends them via the unilateral exit path back to a fresh boarding address, restarting the timelock.

- Multiple expired UTXOs are batched into a single transaction (many inputs, one output)
- A dust check ensures the sweep is skipped if fees would consume the entire value

```typescript
// Check for expired boarding inputs
const expired = await manager.getExpiredBoardingUtxos()
console.log(`${expired.length} expired boarding inputs`)

// Sweep them back to a fresh boarding address (requires boardingUtxoSweep: true)
try {
  const txid = await manager.sweepExpiredBoardingUtxos()
  console.log('Swept expired boarding inputs:', txid)
} catch (e) {
  // "No expired boarding inputs to sweep" or "Sweep not economical"
}
```

#### Recovery: Reclaim Swept VTXOs

Recover virtual outputs that have been swept by the server or consolidate small amounts (subdust).

```typescript
// Recover swept virtual outputs and preconfirmed subdust
const txid = await manager.recoverVtxos((event) => {
  console.log('Settlement event:', event.type)
})
console.log('Recovered:', txid)
// Check what's recoverable
const balance = await manager.getRecoverableBalance()
```


### Delegation

Delegation allows users to outsource virtual output renewal to a third-party delegation service.

Instead of the delegating user renewing virtual outputs by themself, their delegate will automatically settle them before they expire, sending the funds back to the delegate's wallet address (minus a service fee).

This is useful for wallets that cannot be online 24/7.

When a `delegateProvider` is configured, the wallet address includes an extra tapscript path that authorizes the delegate to co-sign renewals alongside the Arkade server.

To run a delegation service, you'll need to set up a [Fulmine server](https://github.com/ArkLabsHQ/fulmine) with the [Delegation API](https://github.com/ArkLabsHQ/fulmine?tab=readme-ov-file#-delegate-api) enabled.

#### Setting Up a Wallet with Delegation

```typescript
import { Wallet, MnemonicIdentity, RestDelegateProvider } from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
  delegateProvider: new RestDelegateProvider('http://localhost:7001'),
})
```

> **Note:** Adding a `delegateProvider` changes your wallet address because the offchain tapscript includes an additional delegation path. Funds sent to an address without delegation cannot be delegated, and vice versa.

#### Delegating Virtual Outputs

Once the wallet is configured with a delegate, use `wallet.delegateManager` to delegate your virtual outputs:

```typescript
// Get spendable virtual outputs (including recoverable)
const vtxos = await wallet.getVtxos({ withRecoverable: true })

// Delegate all virtual outputs — the delegate will renew them before expiry
const arkadeAddress = await wallet.getAddress()
const delegateManager = await wallet.getDelegateManager();
const delegationResult = await delegateManager.delegate(vtxos, arkadeAddress)

console.log('Delegated:', delegationResult.delegated.length)
console.log('Failed:', delegationResult.failed.length)
```

The `delegate` method groups virtual outputs by expiry date and submits them to the delegation service.

By default, delegation is scheduled at 90% of each virtual output's remaining lifetime.

You can override this with an explicit date:

```typescript
// Delegate with a specific renewal time
const delegateAt = new Date(Date.now() + 12 * 60 * 60 * 1000) // 12 hours from now
await delegateManager.delegate(vtxos, arkadeAddress, delegateAt)
```

#### Service Worker Integration

When using a service worker wallet, pass the `delegateUrl` option. The service worker will automatically delegate virtual outputs after each update:

```typescript
import { ServiceWorkerWallet, MnemonicIdentity } from '@arkade-os/sdk'

const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
  delegateUrl: 'http://localhost:7001',
})
```

#### Querying Delegate Info

You can query the delegation service directly to inspect its public key, fee, and payment address:

```typescript
import { RestDelegateProvider } from '@arkade-os/sdk'

const provider = new RestDelegateProvider('https://delegate.example.com')
const info = await provider.getDelegateInfo()

console.log('Delegate public key:', info.pubkey)
console.log('Service fee (sats):', info.fee)
console.log('Fee address:', info.delegateAddress)
```

### BIP-322 Message Signing

Sign and verify messages using [BIP-322](https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki). Supports P2TR (Taproot) signing, and verification for P2TR, P2WPKH, and legacy P2PKH addresses.

```typescript
import { BIP322, MnemonicIdentity } from '@arkade-os/sdk'

const identity = MnemonicIdentity.fromMnemonic('abandon abandon...')

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
/*
{
    key: {
        boardingTxid: string;
        commitmentTxid: string;
        arkTxid: string;
    };
    type: "SENT" | "RECEIVED";
    amount: number;       // BTC amount in satoshis
    settled: boolean;
    createdAt: number;
    assets?: Array<{
        assetId: string,
        amount: bigint    // asset amount in base units
    }>
}
*/
```

### Offboarding

Collaborative exit or "offboarding" allows you to withdraw your virtual funds to an onchain address:

```typescript
import { Wallet, MnemonicIdentity, Ramps } from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
})

// Get fee information from the server
const { fees: feeInfo } = await wallet.arkProvider.getInfo();

const exitTxid = await new Ramps(wallet).offboard(
  'bc1p...',
  feeInfo
);
```

### Unilateral Exit

Unilateral exit allows you to withdraw your funds from the Arkade protocol back to the Bitcoin blockchain without requiring cooperation from the Arkade server. This process involves two main steps:

1. **Unrolling**: Broadcasting the transaction chain from offchain back to onchain
2. **Completing the exit**: Spending the unrolled virtual outputs after the timelock expires

#### Step 1: Unrolling Virtual Outputs

```typescript
import { MnemonicIdentity, OnchainWallet, Unroll } from '@arkade-os/sdk'

// Create an identity for the onchain wallet
const onchainIdentity = MnemonicIdentity.fromMnemonic('abandon abandon...')

// Create an onchain wallet to pay for P2A outputs in virtual output branches
// OnchainWallet implements the AnchorBumper interface
const onchainWallet = await OnchainWallet.create(onchainIdentity, 'regtest');

// Unroll a specific virtual output
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
      console.log(`Transaction ${step.tx.id} unrolled`);
      break;
    case Unroll.StepType.DONE:
      console.log(`Unrolling complete for virtual output ${step.vtxoTxid}`);
      break;
  }
}
```

The unrolling process works by:

- Traversing the transaction chain from the root (most recent) to the leaf (oldest)
- Broadcasting each transaction that isn't already onchain
- Waiting for confirmations between steps
- Using P2A (Pay-to-Anchor) transactions to pay for fees

Optionally, you can use `session.next()` to control the broadcasting process manually.

```typescript
const step = await session.next();
switch (step.type) {
  case Unroll.StepType.WAIT:
    await step.do(); // wait for the transaction to be confirmed
    break;
  case Unroll.StepType.UNROLL:
    const [parent, child] = step.pkg;
    console.log(`Parent: ${parent}`)
    console.log(`Child: ${child}`)
    await step.do(); // broadcast the 1C1P package
    break;
  case Unroll.StepType.DONE:
    console.log(`Unrolling complete for VTXO ${step.vtxoTxid}`);
    break;
  }
```

#### Step 2: Completing the Exit

Once virtual outputs are fully unrolled and the unilateral exit timelock has expired, you can complete the exit:

```typescript
// Complete the exit for specific virtual outputs
await Unroll.completeUnroll(
  wallet,
  [vtxo.txid], // Array of virtual output transaction IDs to complete
  onchainWallet.address // Address to receive the exit amount
);
```

**Important Notes:**

- Each virtual output may require multiple unroll steps depending on the transaction chain length
- Each unroll step must be confirmed before proceeding to the next
- The `completeUnroll` method can only be called after all virtual outputs are fully unrolled and the timelock has expired
- You need sufficient onchain funds in the `OnchainWallet` to pay for P2A transaction fees

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
import { ServiceWorkerWallet, MnemonicIdentity } from '@arkade-os/sdk'

// One-liner: registers the SW, initializes the MessageBus, and creates the wallet
const wallet = await ServiceWorkerWallet.setup({
  serviceWorkerPath: '/service-worker.js',
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
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

The `StorageAdapter` API is deprecated. Use repositories instead. If you omit `storage`, the SDK uses IndexedDB repositories with the default database name.

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
> Anything related to contract repository migration must be handled by the
> package that created the contracts. The SDK doesn't manage external contracts
> in V1; data persisted by other packages remains untouched in its original
> location. For example, see `@arkade-os/boltz-swap`'s `migrateToSwapRepository`
> for migrating legacy `reverseSwaps` / `submarineSwaps` collections.

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
import { MnemonicIdentity, Wallet } from '@arkade-os/sdk'
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
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
  storage: {
    walletRepository: new SQLiteWalletRepository(executor),
    contractRepository: new SQLiteContractRepository(executor),
  },
})
```

#### Realm Repository (React Native)

For React Native apps using Realm, pass your Realm instance directly:

```typescript
import {
  RealmWalletRepository,
  RealmContractRepository,
  ArkRealmSchemas,
  ARK_REALM_SCHEMA_VERSION,
  runArkRealmMigrations,
} from '@arkade-os/sdk/repositories/realm'

const realm = await Realm.open({
  schema: [...ArkRealmSchemas, ...yourSchemas],
  schemaVersion: Math.max(ARK_REALM_SCHEMA_VERSION, yourSchemaVersion),
  onMigration: (oldRealm, newRealm) => {
    runArkRealmMigrations(oldRealm, newRealm)
    // your own migrations
  },
})
const wallet = await Wallet.create({
  identity,
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
import { MnemonicIdentity, Wallet } from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
  // Uses IndexedDB by default in the browser
})
```

If you want a custom database name or a different repository implementation,
pass `storage` explicitly.

For ephemeral storage (no persistence), pass the in-memory repositories:

```typescript
import {
  MnemonicIdentity,
  Wallet,
  InMemoryWalletRepository,
  InMemoryContractRepository
} from '@arkade-os/sdk'

const wallet = await Wallet.create({
  identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
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
const { Wallet } = await import("@arkade-os/sdk");
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
import { Wallet, MnemonicIdentity } from '@arkade-os/sdk'
import { ExpoArkProvider, ExpoIndexerProvider } from '@arkade-os/sdk/adapters/expo'

const identity = MnemonicIdentity.fromMnemonic('abandon abandon...')

const wallet = await Wallet.create({
  identity: identity,
  arkProvider: new ExpoArkProvider('https://arkade.computer'), // For settlement events and transactions streaming
  indexerProvider: new ExpoIndexerProvider('https://arkade.computer'), // For address subscriptions and virtual output state updates
})

// use expo/fetch for streaming support (SSE)
// All other wallet functionality remains the same
const balance = await wallet.getBalance()
const address = await wallet.getAddress()
```

Both ExpoArkProvider and ExpoIndexerProvider are available as adapters following the SDK's modular architecture pattern. This keeps the main SDK bundle clean while providing opt-in functionality for specific environments:

- **ExpoArkProvider**: Handles settlement events and transaction streaming using expo/fetch for Server-Sent Events
- **ExpoIndexerProvider**: Handles address subscriptions and virtual output state updates using expo/fetch for JSON streaming

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
  arkProvider: new ExpoArkProvider('https://arkade.computer'),
  indexerProvider: new ExpoIndexerProvider('https://arkade.computer'),
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
import { Wallet, MnemonicIdentity } from '@arkade-os/sdk';
import { ExpoArkProvider, ExpoIndexerProvider } from '@arkade-os/sdk/adapters/expo';
```

This is required for MuSig2 settlements and cryptographic operations.

### Contract Management

Both `Wallet` and `ServiceWorkerWallet` use a `ContractManager` internally to watch for virtual outputs. This provides resilient connection handling with automatic reconnection and failsafe polling - for your wallet's default address and any external contracts you register (Boltz swaps, HTLCs, etc.).

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
      console.log(`Received ${event.vtxos.length} virtual outputs to ${event.contractScript}`)
      break
    case 'vtxo_spent':
      console.log(`Spent virtual outputs from ${event.contractScript}`)
      break
  }
})

// Update contract data (e.g., set preimage when revealed)
await manager.updateContractParams(contract.script, { preimage: revealedPreimage })

// Check spendable paths (requires a specific virtual output)
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
const allPaths = await manager.getAllSpendingPaths({
  contractScript: contract.script,
  collaborative: true,
  walletPubKey: myPubKey,
})

// Fetch contracts together with their current virtual outputs
const contractsWithVtxos = await manager.getContractsWithVtxos()

// Force a full refresh from the indexer when needed
await manager.refreshVtxos()

// Stop watching
unsubscribe()
```

The watcher features:
- **Automatic reconnection** with exponential backoff (1s → 30s max)
- **Failsafe polling** every 60 seconds to catch missed events
- **Immediate sync** on connection and after failures

### Repository Pattern

Most users don't need to touch repositories directly — `Wallet` and `ContractManager` already read and write through them. They are documented here for advanced integrations (custom storage backends, offline-first apps, repository inspection).

```typescript
// Wallet repository — VTXOs, UTXOs, transaction history, settings
const addr = await wallet.getAddress()
const vtxos = await wallet.walletRepository.getVtxos(addr)
const utxos = await wallet.walletRepository.getUtxos(addr)
const history = await wallet.walletRepository.getTransactionHistory(addr)

// Contract repository — script-keyed contracts (default address, VHTLCs, etc.)
const contracts = await wallet.contractRepository.getContracts({ type: 'vhtlc' })
await wallet.contractRepository.saveContract(myContract)
await wallet.contractRepository.deleteContract(myContract.script)
```

_For complete API documentation, visit our [TypeDoc documentation](https://arkade-os.github.io/ts-sdk/)._

## Development

This package is developed inside the [arkade-os/ts-sdk](../..) monorepo. See the [root README](../../README.md) for repo-wide setup (`pnpm install`, submodule init, lint) and the integration test workflow against the shared regtest stack.

Common package-local commands (run from the repo root):

```bash
pnpm -C packages/ts-sdk run typecheck    # Type-check the SDK
pnpm -C packages/ts-sdk test:unit        # Unit tests, excluding e2e
pnpm -C packages/ts-sdk test:watch       # Vitest watch mode
pnpm -C packages/ts-sdk test:coverage    # Coverage report
pnpm -C packages/ts-sdk docs:build       # Build TypeDoc API docs
pnpm -C packages/ts-sdk docs:open        # Open API docs in the browser
```

For integration tests, use the root commands (`pnpm run test:integration:ts-sdk` and the `regtest:*:ts-sdk` family) — see the root README.

### Releasing

Package-local releases are disabled. Releases run from the monorepo root and are package-scoped: `pnpm run release -- sdk patch` bumps `@arkade-os/sdk`, creates a `@arkade-os/sdk/<version>` tag, and also bumps `@arkade-os/boltz-swap` (which depends on SDK via `workspace:*`). See the [root README](../../README.md#releasing) for full flags and `pnpm run release -- --help`.

## License

MIT
