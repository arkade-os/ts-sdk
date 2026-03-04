# Arkade Swaps

> Lightning and chain swaps for Arkade using Boltz

`@arkade-os/boltz-swap` provides seamless integration with the Lightning Network and Bitcoin on-chain through Boltz swaps, allowing users to move funds between Arkade, Lightning, and Bitcoin.

## Overview

The library enables four swap types:

1. **Lightning to Arkade** - Receive funds from Lightning payments into your Arkade wallet
2. **Arkade to Lightning** - Send funds from your Arkade wallet to Lightning invoices
3. **ARK to BTC** - Move funds from Arkade to a Bitcoin on-chain address
4. **BTC to ARK** - Move funds from Bitcoin on-chain into your Arkade wallet

Built on top of the Boltz swap protocol with automatic background monitoring via SwapManager.

## Installation

```bash
npm install @arkade-os/sdk @arkade-os/boltz-swap
```

## Basic Usage

### Initializing

```typescript
import { Wallet, SingleKey } from '@arkade-os/sdk';
import { ArkadeSwaps, BoltzSwapProvider } from '@arkade-os/boltz-swap';

// Create an identity
const identity = SingleKey.fromHex('your_private_key_in_hex');

// Initialize your Arkade wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://mutinynet.arkade.sh',
});

// Initialize the swap provider
const swapProvider = new BoltzSwapProvider({
  apiUrl: 'https://api.boltz.mutinynet.arkade.sh',
  network: 'mutinynet',
  referralId: 'arkade', // optional
});

// Create the ArkadeSwaps instance
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider,
  // Optional: enable SwapManager for background monitoring
  // swapManager: true,
});
```

**SwapRepository**: Swap storage is pluggable via `SwapRepository`. By default, `ArkadeSwaps` uses an IndexedDB-backed repository in browser contexts. You can inject your own repository (for tests, Node.js, or custom storage) via the `swapRepository` option. Custom implementations must set `readonly version = 1` to match the interface — TypeScript will error when the version is bumped, signaling a required update.

Platform-specific repositories are available as subpath exports:

```typescript
// SQLite (React Native / Node.js)
import { SQLiteSwapRepository } from '@arkade-os/boltz-swap/repositories/sqlite';

// Realm (React Native)
import { RealmSwapRepository, BoltzRealmSchemas } from '@arkade-os/boltz-swap/repositories/realm';
```

> [!WARNING]
> If you previously used the v1 `StorageAdapter`-based repositories, migrate
> data into the new IndexedDB repositories before use. You can use
> `getMigrationStatus` from `@arkade-os/sdk` to check whether migration is
> needed before running it:
>
> ```typescript
> import {
>   IndexedDbSwapRepository,
>   migrateToSwapRepository
> } from '@arkade-os/boltz-swap'
> import { getMigrationStatus } from '@arkade-os/sdk'
> import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
>
> // if you used a different name for the DB, use your own here
> const oldStorage = new IndexedDBStorageAdapter('arkade-service-worker', 1)
>
> const status = await getMigrationStatus('wallet', oldStorage)
> if (status !== 'not-needed') {
>   await migrateToSwapRepository(oldStorage, new IndexedDbSwapRepository())
> }
> ```

Existing data stays in the old DB (e.g. `arkade-service-worker`) until you run the migration once.
After `migrateToSwapRepository`, the IndexedDB-backed SwapRepository is used going forward.

## Background Swap Monitoring (SwapManager)

By default, you must manually monitor each swap and act on their state. **SwapManager** enables autonomous background processing - swaps complete automatically while the app is running. When the app reopens, it automatically resumes pending swaps.

### Enable SwapManager

```typescript
// Option 1: Enable with defaults
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider,
  swapManager: true, // Simple boolean to enable with defaults
});

// Option 2: Enable with custom config
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider,
  swapManager: {
    autoStart: false, // Set to false to manually call startSwapManager() later
    // Events for UI updates (optional, can also use on/off methods)
    events: {
      onSwapCompleted: (swap) => {
        console.log(`Swap ${swap.id} completed!`);
      },
      onSwapUpdate: (swap, oldStatus) => {
        console.log(`${swap.id}: ${oldStatus} → ${swap.status}`);
      },
    },
  },
});

// If autoStart is false, manually start monitoring
await swaps.startSwapManager();

// Create swaps - they're automatically monitored!
const invoice = await swaps.createLightningInvoice({ amount: 50000 });
// User can navigate to other pages - swap completes in background
```

### How It Works

- **Single WebSocket** monitors all swaps (not one per swap)
- **Automatic polling** after WebSocket connects/reconnects
- **Fallback polling** with exponential backoff if WebSocket fails
- **Auto-claim/refund** executes when status allows
- **Resumes on app reopen** - loads pending swaps, polls latest status, executes refunds if expired
- **Default `ArkadeSwaps` requires the app running** - monitoring stops when the app/tab closes
  - For browser background monitoring, use `ServiceWorkerArkadeSwaps`
  - If swaps expire while closed, refunds execute automatically on next app launch (unless claimed/refunded by your background runtime)

### Configuration Options

```typescript
  // Simple boolean to enable with defaults
  swapManager: true,

  // OR custom configuration
  swapManager: {
    enableAutoActions: true,        // Auto claim/refund (default: true)
    autoStart: true,                // Auto-start on init (default: true)
    pollInterval: 30000,            // Failsafe poll every 30s when WS active (default)
    reconnectDelayMs: 1000,         // Initial WS reconnect delay (default)
    maxReconnectDelayMs: 60000,     // Max WS reconnect delay (default)
    pollRetryDelayMs: 5000,         // Initial fallback poll delay (default)
    maxPollRetryDelayMs: 300000,    // Max fallback poll delay (default)

    // Optional: provide event listeners in config
    // (can also use on/off methods dynamically - see Event Subscription section)
    events: {
      onSwapUpdate: (swap, oldStatus) => {},
      onSwapCompleted: (swap) => {},
      onSwapFailed: (swap, error) => {},
      onActionExecuted: (swap, action) => {},  // 'claim', 'refund', 'claimArk', 'claimBtc', 'refundArk', 'signServerClaim'
      onWebSocketConnected: () => {},
      onWebSocketDisconnected: (error?) => {},
    }
  }
```

### Event Subscription

SwapManager supports flexible event subscription - you can add/remove listeners dynamically:

```typescript
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider,
  swapManager: true,
});

const manager = swaps.getSwapManager();

// Subscribe to events using on* methods (returns unsubscribe function)
const unsubscribe = manager.onSwapUpdate((swap, oldStatus) => {
  console.log(`Swap ${swap.id}: ${oldStatus} → ${swap.status}`);
});

// Subscribe to completed events
manager.onSwapCompleted((swap) => {
  console.log(`Swap ${swap.id} completed!`);
});

// Subscribe to failures
manager.onSwapFailed((swap, error) => {
  console.error(`Swap ${swap.id} failed:`, error);
});

// Subscribe to actions (claim/refund/claimArk/claimBtc/refundArk/signServerClaim)
manager.onActionExecuted((swap, action) => {
  console.log(`Executed ${action} for swap ${swap.id}`);
});

// WebSocket events
manager.onWebSocketConnected(() => console.log('Connected'));
manager.onWebSocketDisconnected((error) => console.log('Disconnected', error));

// Unsubscribe when no longer needed (e.g., component unmount)
unsubscribe();

// Or use off* methods to remove a specific listener
manager.offSwapUpdate(myListener);
```

### Cleanup (Disposable Pattern)

ArkadeSwaps implements the Disposable pattern for automatic cleanup:

```typescript
// Option 1: Manual cleanup
const swaps = new ArkadeSwaps({ wallet, swapProvider });
// ... use it
await swaps.dispose(); // Stops SwapManager and cleans up

// Option 2: Automatic cleanup with `await using` (TypeScript 5.2+)
{
  await using swaps = new ArkadeSwaps({
    wallet,
    swapProvider,
    swapManager: { autoStart: true },
  });

  // Use swaps...

} // SwapManager automatically stopped when scope exits
```

### Manual Control

```typescript
// Stop background monitoring
await swaps.stopSwapManager();

// Check manager stats
const manager = swaps.getSwapManager();
const stats = await manager?.getStats();
console.log(`Monitoring ${stats.monitoredSwaps} swaps`);
console.log(`WebSocket connected: ${stats.websocketConnected}`);
```

### Per-Swap UI Hooks

When SwapManager is enabled, you can subscribe to updates for specific swaps to show progress in your UI:

```typescript
const result = await swaps.createLightningInvoice({ amount: 50000 });

// Subscribe to this specific swap's updates
const manager = swaps.getSwapManager();
const unsubscribe = manager.subscribeToSwapUpdates(
  result.pendingSwap.id,
  (swap, oldStatus) => {
    console.log(`Swap ${swap.id}: ${oldStatus} → ${swap.status}`);
    if (swap.status === 'transaction.mempool') {
      showNotification('Payment detected in mempool!');
    } else if (swap.status === 'invoice.settled') {
      showNotification('Payment received!');
    }
  }
);

// Clean up when component unmounts
// unsubscribe();
```

### Blocking with SwapManager

Even with SwapManager enabled, you can still wait for specific swaps to complete:

```typescript
const result = await swaps.createLightningInvoice({ amount: 50000 });

// This blocks until the swap completes, but SwapManager handles the monitoring
try {
  const { txid } = await swaps.waitAndClaim(result.pendingSwap);
  console.log('Payment claimed successfully:', txid);
} catch (error) {
  console.error('Payment failed:', error);
}
```

### Without SwapManager (Manual Mode)

If SwapManager is not enabled, you must manually monitor swaps:

```typescript
// Create invoice
const result = await swaps.createLightningInvoice({ amount: 50000 });

// MUST manually monitor - blocks until complete
await swaps.waitAndClaim(result.pendingSwap);
// User must stay on this page - navigating away stops monitoring
```

## Expo / React Native

Expo/React Native cannot run a long-lived Service Worker, and background work is executed by the OS for a short window (typically every ~15+ minutes). To enable best-effort background claim/refund for swaps, use `ExpoArkadeLightning` plus a background task defined at global scope.

### Prerequisites

- Install Expo background task dependencies:

```bash
npx expo install expo-task-manager expo-background-task
npx expo install @react-native-async-storage/async-storage expo-secure-store
npx expo install expo-crypto
npx expo install expo-sqlite && npm install indexeddbshim
```

- If you rely on the default IndexedDB-backed repositories in Expo, call `setupExpoDb()` **before any SDK/boltz-swap import**:

```ts
import { setupExpoDb } from "@arkade-os/sdk/adapters/expo-db";

setupExpoDb();
```

- Expo requires a `crypto.getRandomValues()` polyfill for cryptographic operations:

```ts
import * as Crypto from "expo-crypto";
if (!global.crypto) global.crypto = {} as any;
global.crypto.getRandomValues = Crypto.getRandomValues;
```

### 1) Define the background task (global scope)

`TaskManager.defineTask()` must be called at module scope before React mounts.

```ts
// App entry point (e.g., _layout.tsx) — GLOBAL SCOPE
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { SingleKey } from "@arkade-os/sdk";
import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import { IndexedDbSwapRepository } from "@arkade-os/boltz-swap";
import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo";

const swapTaskQueue = new AsyncStorageTaskQueue(AsyncStorage, "ark:swap-queue");
const swapRepository = new IndexedDbSwapRepository();

defineExpoSwapBackgroundTask("ark-swap-poll", {
  taskQueue: swapTaskQueue,
  swapRepository,
  identityFactory: async () => {
    const key = await SecureStore.getItemAsync("ark-private-key");
    if (!key) throw new Error("Missing private key in SecureStore");
    return SingleKey.fromHex(key);
  },
});
```

### 2) Set up `ExpoArkadeLightning` (component/provider)

Use an `IWallet` implementation that provides `arkProvider` and `indexerProvider` (for example `ExpoWallet` from `@arkade-os/sdk/wallet/expo`, or `Wallet.create()` with `ExpoArkProvider` / `ExpoIndexerProvider`).

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import { BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { ExpoArkadeLightning } from "@arkade-os/boltz-swap/expo";

// Used by ExpoWallet's background task (defined via @arkade-os/sdk/wallet/expo)
const walletTaskQueue = new AsyncStorageTaskQueue(AsyncStorage, "ark:wallet-queue");

const wallet = await ExpoWallet.setup({
  identity, // same identity used by identityFactory()
  arkServerUrl: "https://mutinynet.arkade.sh",
  storage: { walletRepository, contractRepository },
  background: {
    taskName: "ark-wallet-poll",
    taskQueue: walletTaskQueue,
    foregroundIntervalMs: 20_000,
    minimumBackgroundInterval: 15,
  },
});

const swapProvider = new BoltzSwapProvider({
  apiUrl: "https://api.boltz.mutinynet.arkade.sh",
  network: "mutinynet",
});

const arkLn = await ExpoArkadeLightning.setup({
  wallet,
  swapProvider,
  swapRepository, // must match the one used in defineExpoSwapBackgroundTask
  background: {
    taskName: "ark-swap-poll",
    taskQueue: swapTaskQueue, // must match the one used in defineExpoSwapBackgroundTask
    foregroundIntervalMs: 20_000,
    minimumBackgroundInterval: 15,
  },
});

await arkLn.createLightningInvoice({ amount: 1000 });
```

## Receiving Lightning Payments

To receive a Lightning payment into your Arkade wallet:

```typescript
const result = await swaps.createLightningInvoice({
  amount: 50000, // 50,000 sats
  description: 'Payment to my Arkade wallet',
});

console.log('Receive amount:', result.amount);
console.log('Expiry (seconds):', result.expiry);
console.log('Lightning Invoice:', result.invoice);
console.log('Payment Hash:', result.paymentHash);
console.log('Pending swap', result.pendingSwap);
console.log('Preimage', result.preimage);
```

### Monitoring Incoming Lightning Payments

**With SwapManager (recommended):**
```typescript
// SwapManager handles monitoring and claiming automatically
const result = await swaps.createLightningInvoice({ amount: 50000 });
// Payment will be claimed automatically when received
```

**Without SwapManager (manual mode):**
```typescript
// You must manually monitor - blocks until payment is received
const receivalResult = await swaps.waitAndClaim(result.pendingSwap);
console.log('Transaction ID:', receivalResult.txid);
```

## Sending Lightning Payments

**With SwapManager (recommended):**
```typescript
import { decodeInvoice } from '@arkade-os/boltz-swap';

// Validate invoice first
const invoiceDetails = decodeInvoice('lnbc500u1pj...');
console.log('Invoice amount:', invoiceDetails.amountSats, 'sats');

// Send payment - returns immediately after creating swap
const paymentResult = await swaps.sendLightningPayment({
  invoice: 'lnbc500u1pj...',
});

console.log('Payment initiated:', paymentResult.txid);
// SwapManager monitors in background and handles refunds if payment fails
```

**Without SwapManager (manual mode):**
```typescript
const paymentResult = await swaps.sendLightningPayment({
  invoice: 'lnbc500u1pj...',
});

console.log('Amount:', paymentResult.amount);
console.log('Preimage:', paymentResult.preimage);
console.log('Transaction ID:', paymentResult.txid);
```

## Chain Swaps

Chain swaps move funds between Arkade and Bitcoin on-chain via Boltz.

#### Amounts

When creating a swap, and because there are fees to be paid, you must define one and only one type of amount:
- senderLockAmount: sender will send this exact amount, receiver will receive less (amount - fees)
- receiverLockAmount: receiver will receive this exact amount, sender needs to send more (amount + fees)

### ARK to BTC

Send funds from your Arkade wallet to a Bitcoin address:

```typescript
// Create the swap
const result = await swaps.arkToBtc({
  btcAddress: 'bc1q...',
  senderLockAmount: 100000,
  feeSatsPerByte: 2, // optional, defaults to 1
});

console.log('Pay to ARK address:', result.arkAddress);
console.log('Amount to pay:', result.amountToPay, 'sats');

// Wait for BTC to be claimed
// If you use swapManager, this step is not needed
const { txid } = await swaps.waitAndClaimBtc(result.pendingSwap);
console.log('BTC claimed:', txid);
```

If the swap fails, refund your ARK funds:

```typescript
await swaps.refundArk(result.pendingSwap);
```

### BTC to ARK

Receive funds from Bitcoin into your Arkade wallet:

```typescript
// Create the swap
const result = await swaps.btcToArk({
  receiverLockAmount: 100000,
  feeSatsPerByte: 2, // optional, defaults to 1
});

console.log('Pay to BTC address:', result.btcAddress);
console.log('Amount to pay:', result.amountToPay, 'sats');

// Wait for ARK to be claimed
// If you use swapManager, this step is not needed
const { txid } = await swaps.waitAndClaimArk(result.pendingSwap);
console.log('ARK claimed:', txid);
```

### Chain Swap Fees and Limits

```typescript
// Get chain swap fees
const chainFees = await swaps.getFees('ARK', 'BTC');
console.log('Percentage:', chainFees.percentage);
console.log('Server miner fee:', chainFees.minerFees.server);
console.log('User claim fee:', chainFees.minerFees.user.claim);
console.log('User lockup fee:', chainFees.minerFees.user.lockup);

// Get chain swap limits
const chainLimits = await swaps.getLimits('ARK', 'BTC');
console.log('Min:', chainLimits.min, 'sats');
console.log('Max:', chainLimits.max, 'sats');
```

### Renegotiating Quotes

If the amount sent to the swap is different from the expected, renegotiate it:

```typescript
const newAmount = await swaps.quoteSwap(pendingSwap.id);
console.log('Updated amount:', newAmount);
```

## Checking Swap Limits

Before creating swaps, check the supported amount range:

```typescript
// Lightning swap limits
const limits = await swaps.getLimits();
console.log('Min:', limits.min, 'sats');
console.log('Max:', limits.max, 'sats');

// Chain swap limits
const chainLimits = await swaps.getLimits('ARK', 'BTC');
```

### Validating Lightning Invoice Amounts

```typescript
import { decodeInvoice } from '@arkade-os/boltz-swap';

const invoice = 'lnbc500u1pj...';
const decoded = decodeInvoice(invoice);
console.log('Invoice amount:', decoded.amountSats, 'sats');

const limits = await swaps.getLimits();
if (decoded.amountSats >= limits.min && decoded.amountSats <= limits.max) {
  await swaps.sendLightningPayment({ invoice });
}
```

## Checking Swap Fees

```typescript
// Lightning fees
const fees = await swaps.getFees();

const calcSubmarineSwapFee = (satoshis: number): number => {
  const { percentage, minerFees } = fees.submarine;
  return Math.ceil((satoshis * percentage) / 100 + minerFees);
};

const calcReverseSwapFee = (satoshis: number): number => {
  const { percentage, minerFees } = fees.reverse;
  return Math.ceil((satoshis * percentage) / 100 + minerFees.claim + minerFees.lockup);
};

// Chain fees
const chainFees = await swaps.getFees('ARK', 'BTC');
```

## Checking Swap Status

**With SwapManager:** Status updates are automatic via events - no manual checking needed.

**Without SwapManager (manual mode):**
```typescript
const response = await swaps.getSwapStatus('swap_id');
console.log('swap status = ', response.status);
```

## Storage

All swap data is persisted automatically and can be retrieved:

```typescript
// Get pending swaps by type
const pendingSubmarineSwaps = await swaps.getPendingSubmarineSwaps();
const pendingReverseSwaps = await swaps.getPendingReverseSwaps();
const pendingChainSwaps = await swaps.getPendingChainSwaps();

// Get complete swap history (all types, sorted by creation date)
const swapHistory = await swaps.getSwapHistory();
```

**Note**: If IndexedDB is not available (e.g., in Node.js), provide a custom `swapRepository` implementation.

## Error Handling

**With SwapManager:** Refunds are handled automatically - listen to `onSwapFailed` event for notifications.

**Without SwapManager (manual mode):** You must handle errors and execute refunds manually:

```typescript
import {
  SwapError,
  SchemaError,
  NetworkError,
  SwapExpiredError,
  InvoiceExpiredError,
  InvoiceFailedToPayError,
  InsufficientFundsError,
  TransactionFailedError,
  isPendingSubmarineSwap,
  isPendingChainSwap,
} from '@arkade-os/boltz-swap';

try {
  await swaps.sendLightningPayment({
    invoice: 'lnbc500u1pj...',
  });
} catch (error) {
  if (error instanceof InvoiceExpiredError) {
    console.error('The invoice has expired.');
  } else if (error instanceof InvoiceFailedToPayError) {
    console.error('The provider failed to pay the invoice.');
  } else if (error instanceof InsufficientFundsError) {
    console.error('Not enough funds available:', error.message);
  } else if (error instanceof NetworkError) {
    console.error('Network issue:', error.message);
  } else if (error instanceof SchemaError) {
    console.error('Invalid response from API.');
  } else if (error instanceof SwapExpiredError) {
    console.error('The swap has expired.');
  } else if (error instanceof TransactionFailedError) {
    console.error('Transaction failed.');
  } else {
    console.error('Unknown error:', error);
  }

  // Manual refund (only needed without SwapManager)
  if (error.isRefundable && error.pendingSwap) {
    if (isPendingChainSwap(error.pendingSwap)) {
      await swaps.refundArk(error.pendingSwap);
    } else if (isPendingSubmarineSwap(error.pendingSwap)) {
      await swaps.refundVHTLC(error.pendingSwap);
    }
  }
}
```

## Type Guards

```typescript
import {
  isPendingReverseSwap,
  isPendingSubmarineSwap,
  isPendingChainSwap,
  isSubmarineSwapRefundable,
  isChainSwapClaimable,
  isChainSwapRefundable,
  isSubmarineFinalStatus,
  isReverseFinalStatus,
  isChainFinalStatus,
} from '@arkade-os/boltz-swap';

// Discriminate swap types
if (isPendingReverseSwap(swap)) { /* Lightning → Arkade */ }
if (isPendingSubmarineSwap(swap)) { /* Arkade → Lightning */ }
if (isPendingChainSwap(swap)) { /* ARK ↔ BTC chain */ }

// Check swap state
if (isChainSwapClaimable(swap)) { /* ready to claim */ }
if (isChainSwapRefundable(swap)) { /* can be refunded */ }
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
