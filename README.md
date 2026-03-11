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
import { Wallet, MnemonicIdentity } from '@arkade-os/sdk';
import { ArkadeSwaps } from '@arkade-os/boltz-swap';

// Create an identity
const identity = MnemonicIdentity.fromMnemonic('your twelve word mnemonic phrase ...', { isMainnet: true });

// Initialize your Arkade wallet
const wallet = await Wallet.create({
  identity,
  arkServerUrl: 'https://arkade.computer',
});

// Initialize swaps (network auto-detected from wallet, SwapManager enabled by default)
const swaps = await ArkadeSwaps.create({ wallet });
```

> [!NOTE]
> Upgrading from v1 `StorageAdapter`? See [SwapRepository migration](#swaprepository).

### Receive Lightning

```typescript
const result = await swaps.createLightningInvoice({ amount: 50000 });
console.log('Invoice:', result.invoice);
// SwapManager auto-claims when paid
```

### Send Lightning

```typescript
const result = await swaps.sendLightningPayment({ invoice: 'lnbc500u1pj...' });
console.log('Paid:', result.txid);
// SwapManager auto-refunds if payment fails
```

### ARK to BTC

```typescript
const result = await swaps.arkToBtc({
  btcAddress: 'bc1q...',
  senderLockAmount: 100000,
});
// SwapManager auto-claims BTC when ready
```

### BTC to ARK

```typescript
const result = await swaps.btcToArk({ receiverLockAmount: 100000 });
console.log('Pay to:', result.btcAddress, 'Amount:', result.amountToPay);
// SwapManager auto-claims ARK when ready
```

### Listening for Updates

```typescript
const manager = swaps.getSwapManager();

// Global listeners
manager.onSwapCompleted((swap) => console.log(`${swap.id} completed`));
manager.onSwapFailed((swap, error) => console.error(`${swap.id} failed`, error));
manager.onSwapUpdate((swap, oldStatus) => console.log(`${swap.id}: ${oldStatus} → ${swap.status}`));

// Wait for a specific swap
const result = await swaps.createLightningInvoice({ amount: 50000 });
const unsubscribe = manager.subscribeToSwapUpdates(result.pendingSwap.id, (swap, oldStatus) => {
  console.log(`${oldStatus} → ${swap.status}`);
});

// Or block until a specific swap completes
const { txid } = await manager.waitForSwapCompletion(result.pendingSwap.id);
```

### Fees and Limits

```typescript
// Lightning
const fees = await swaps.getFees();
const limits = await swaps.getLimits();

// Chain swaps
const chainFees = await swaps.getFees('ARK', 'BTC');
const chainLimits = await swaps.getLimits('ARK', 'BTC');
```

### Swap History

```typescript
const history = await swaps.getSwapHistory();
const pending = await swaps.getPendingReverseSwaps();
```

---

## Advanced Usage

### Chain Swap Amounts

When creating a chain swap, specify exactly one:
- `senderLockAmount`: sender sends this exact amount, receiver gets less (amount - fees)
- `receiverLockAmount`: receiver gets this exact amount, sender pays more (amount + fees)

### Renegotiating Quotes

If the amount sent differs from expected:

```typescript
const newAmount = await swaps.quoteSwap(pendingSwap.id);
```

### Blocking on a Swap

Even with SwapManager, you can block until a specific swap completes:

```typescript
const result = await swaps.createLightningInvoice({ amount: 50000 });
const { txid } = await swaps.waitAndClaim(result.pendingSwap);
```

### Without SwapManager (Manual Mode)

If you disable SwapManager, you must manually monitor and act on swaps:

```typescript
const swaps = await ArkadeSwaps.create({ wallet, swapManager: false });

const result = await swaps.createLightningInvoice({ amount: 50000 });
await swaps.waitAndClaim(result.pendingSwap); // blocks until complete
```

### SwapManager Configuration

```typescript
const swaps = await ArkadeSwaps.create({
  wallet,
  swapManager: {
    enableAutoActions: true,        // Auto claim/refund (default: true)
    autoStart: true,                // Auto-start on init (default: true)
    pollInterval: 30000,            // Failsafe poll interval (default)
    events: {
      onSwapCompleted: (swap) => {},
      onSwapFailed: (swap, error) => {},
      onSwapUpdate: (swap, oldStatus) => {},
      onActionExecuted: (swap, action) => {},
      onWebSocketConnected: () => {},
      onWebSocketDisconnected: (error?) => {},
    }
  },
});
```

### Per-Swap UI Hooks

```typescript
const result = await swaps.createLightningInvoice({ amount: 50000 });
const manager = swaps.getSwapManager();

const unsubscribe = manager.subscribeToSwapUpdates(
  result.pendingSwap.id,
  (swap, oldStatus) => {
    if (swap.status === 'invoice.settled') showNotification('Payment received!');
  }
);
```

### Cleanup

```typescript
// Manual
await swaps.dispose();

// Automatic (TypeScript 5.2+)
{
  await using swaps = await ArkadeSwaps.create({ wallet });
  // ...
} // auto-disposed
```

### SwapRepository

Swap storage defaults to IndexedDB in browsers. For other platforms:

```typescript
// SQLite (React Native / Node.js)
import { SQLiteSwapRepository } from '@arkade-os/boltz-swap/repositories/sqlite';

// Realm (React Native)
import { RealmSwapRepository, BoltzRealmSchemas } from '@arkade-os/boltz-swap/repositories/realm';
```

Custom implementations must set `readonly version = 1` — TypeScript will error when bumped, signaling a required update.

> [!WARNING]
> If you previously used the v1 `StorageAdapter`-based repositories, migrate
> data before use:
>
> ```typescript
> import { IndexedDbSwapRepository, migrateToSwapRepository } from '@arkade-os/boltz-swap'
> import { getMigrationStatus } from '@arkade-os/sdk'
> import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
>
> const oldStorage = new IndexedDBStorageAdapter('arkade-service-worker', 1)
> const status = await getMigrationStatus('wallet', oldStorage)
> if (status !== 'not-needed') {
>   await migrateToSwapRepository(oldStorage, new IndexedDbSwapRepository())
> }
> ```

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

### Error Handling

With SwapManager, refunds are automatic — listen to `onSwapFailed` for notifications. Without it, handle errors manually:

```typescript
import { isPendingSubmarineSwap, isPendingChainSwap } from '@arkade-os/boltz-swap';

try {
  await swaps.sendLightningPayment({ invoice: 'lnbc500u1pj...' });
} catch (error) {
  if (error.isRefundable && error.pendingSwap) {
    if (isPendingChainSwap(error.pendingSwap)) {
      await swaps.refundArk(error.pendingSwap);
    } else if (isPendingSubmarineSwap(error.pendingSwap)) {
      await swaps.refundVHTLC(error.pendingSwap);
    }
  }
}
```

Error types: `InvoiceExpiredError`, `InvoiceFailedToPayError`, `InsufficientFundsError`, `NetworkError`, `SchemaError`, `SwapExpiredError`, `TransactionFailedError`.

### Type Guards

```typescript
import {
  isPendingReverseSwap, isPendingSubmarineSwap, isPendingChainSwap,
  isChainSwapClaimable, isChainSwapRefundable,
} from '@arkade-os/boltz-swap';
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
