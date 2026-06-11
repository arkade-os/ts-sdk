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

By default the call resolves only once the swap fully settles (`transaction.claimed`),
i.e. after Boltz has swept the HTLC. To show an optimistic "sent" state as soon as the
payment is in flight — like most Lightning wallets — pass `optimisticResolveAt`:

```typescript
const result = await swaps.sendLightningPayment(
  { invoice: 'lnbc500u1pj...' },
  { optimisticResolveAt: 'invoice.pending' },
);
// Resolves as soon as the status is observed (or any later status in the
// lifecycle — intermediate statuses can be skipped). result.preimage is
// undefined when the swap hasn't settled yet; keep the SwapManager enabled
// so settlement tracking and auto-refunds continue in the background.
```

The same option is accepted by `waitForSwapSettlement(pendingSwap, options)`.

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

### Submarine Fund Recovery

If a Lightning payment fails and funds get stranded in a VHTLC, you can recover them manually:

```typescript
// Scan all local swaps for recoverable funds
const candidates = await swaps.scanRecoverableSubmarineSwaps();
// candidates[i].status: "recoverable" | "pre_cltv" | "none" | "already_spent" | "invalid_swap"

// Recover all at once
const results = await swaps.recoverAllSubmarineFunds(candidates.map(c => c.swap));

// Or inspect / recover a single swap
const info = await swaps.inspectSubmarineRecovery(swap);
if (info.status === 'recoverable') {
  await swaps.recoverSubmarineFunds(swap);
}
```

> [!NOTE]
> This only scans swaps stored in your local repository. It does not discover swaps that exist on Boltz but are missing locally.

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
> data before use. `migrateToSwapRepository` copies legacy `reverseSwaps` and
> `submarineSwaps` collections from the old `ContractRepository` into the new
> `SwapRepository`. It writes its own swap-specific migration flag, so it is
> idempotent and safe to call on every startup — do not gate it on the
> wallet-side `getMigrationStatus`.
>
> ```typescript
> import { IndexedDbSwapRepository, migrateToSwapRepository } from '@arkade-os/boltz-swap'
> import { IndexedDBStorageAdapter } from '@arkade-os/sdk/adapters/indexedDB'
>
> const oldStorage = new IndexedDBStorageAdapter('arkade-service-worker', 1)
> await migrateToSwapRepository(oldStorage, new IndexedDbSwapRepository())
> ```

## Expo / React Native

Expo/React Native cannot run a long-lived Service Worker, and background work is executed by the OS for a short window (typically every ~15+ minutes). To enable best-effort background claim/refund for swaps, use `ExpoArkadeLightning` plus a background task defined at global scope.

> [!WARNING]
> **Change since 0.3.30** — fix for [#136](https://github.com/arkade-os/boltz-swap/issues/136).
>
> Background task helpers moved from `@arkade-os/boltz-swap/expo` to
> `@arkade-os/boltz-swap/expo/background`. OS-level registration is no
> longer performed by `ExpoArkadeSwaps.setup()` — call it explicitly.
>
> | Before | After |
> | --- | --- |
> | `import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo"` | `import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background"` |
> | `background: { taskName, taskQueue, minimumBackgroundInterval, foregroundIntervalMs }` | `background: { taskQueue, foregroundIntervalMs }` + explicit `await registerExpoSwapBackgroundTask(taskName, { minimumInterval })` |
> | `dispose()` unregistered the OS task | Call `unregisterExpoSwapBackgroundTask(taskName)` yourself |
>
> TypeScript callers get a compile error on the removed fields. **JS callers must update manually** — the old fields are silently ignored and the OS task will never run.

### Prerequisites

- Install Expo background task dependencies:

```bash
npx expo install expo-task-manager expo-background-task
npx expo install @react-native-async-storage/async-storage expo-secure-store
npx expo install expo-crypto
npx expo install expo-sqlite
```

- For persistence on Expo, prefer the SQLite-backed repositories
  (`@arkade-os/boltz-swap/repositories/sqlite` and
  `@arkade-os/sdk/repositories/sqlite`) on top of `expo-sqlite`, or the Realm
  repositories on top of `realm`. There is no SDK-shipped IndexedDB helper
  for Expo.

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
import * as SQLite from "expo-sqlite";
import { SingleKey } from "@arkade-os/sdk";
import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import { SQLiteSwapRepository } from "@arkade-os/boltz-swap/repositories/sqlite";
import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";

const swapTaskQueue = new AsyncStorageTaskQueue(AsyncStorage, "ark:swap-queue");

const swapDb = SQLite.openDatabaseSync("ark-swaps.db");
const swapRepository = new SQLiteSwapRepository({
  run: (sql, params) => swapDb.runAsync(sql, params ?? []),
  get: (sql, params) => swapDb.getFirstAsync(sql, params ?? []),
  all: (sql, params) => swapDb.getAllAsync(sql, params ?? []),
});

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
import { registerExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";

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
    taskQueue: swapTaskQueue, // must match the one used in defineExpoSwapBackgroundTask
    foregroundIntervalMs: 20_000,
  },
});

// Activate the OS scheduler (Expo Android/iOS only).
// Must use the same task name passed to defineExpoSwapBackgroundTask above.
await registerExpoSwapBackgroundTask("ark-swap-poll", { minimumInterval: 15 });

await arkLn.createLightningInvoice({ amount: 1000 });

// On logout / wallet reset / app teardown:
import { unregisterExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";
await arkLn.dispose();
await unregisterExpoSwapBackgroundTask("ark-swap-poll");
```

> [!IMPORTANT]
> The OS-task helpers (`defineExpoSwapBackgroundTask`,
> `registerExpoSwapBackgroundTask`, `unregisterExpoSwapBackgroundTask`)
> live under `@arkade-os/boltz-swap/expo/background`. That subpath is
> the **only** module that imports `expo-task-manager` /
> `expo-background-task`; keeping it isolated lets react-native-web and
> Node consumers use `/expo` without those native packages.

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

Package-local releases are disabled. Releases run from the monorepo root and are package-scoped: `pnpm run release -- boltz-swap patch` bumps and publishes just `@arkade-os/boltz-swap` with a `@arkade-os/boltz-swap/<version>` tag, against the currently published `@arkade-os/sdk` version. See the [root README](../../README.md#releasing) for full flags and `pnpm run release -- --help`.

## License

MIT
