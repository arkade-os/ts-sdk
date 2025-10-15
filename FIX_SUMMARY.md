# Fix: Multiple WebSockets Issue

## Problem
Every time the wallet is reloaded in the service worker, a new WebSocket connection was created without properly closing the previous one. This led to multiple concurrent WebSocket connections accumulating over time.

## Root Cause
The issue was in two places:

1. **Type Mismatch**: The `incomingFundsSubscription` cleanup function was typed as `() => void` but needed to be async to properly await cleanup operations.

2. **Missing Await**: When reloading the wallet in `worker.ts`, the old subscription cleanup was called synchronously without awaiting its completion, which meant new subscriptions could be created before old ones were fully closed.

## Solution
Made the subscription cleanup async to ensure proper resource cleanup:

### Changes in `src/wallet/wallet.ts`:
1. Changed `notifyIncomingFunds()` return type from `() => void` to `() => Promise<void>`
2. Made the internal `stopFunc` async and await the indexer unsubscription
3. Updated `onchainStopFunc` and `indexerStopFunc` types to be optional (properly typed as `(() => void) | undefined`)
4. Updated `waitForIncomingFunds()` to use the new async cleanup signature

### Changes in `src/wallet/serviceWorker/worker.ts`:
1. Updated `incomingFundsSubscription` type from `(() => void) | undefined` to `(() => Promise<void>) | undefined`
2. Added `await` when calling `incomingFundsSubscription()` in both `clear()` and `onWalletInitialized()` methods

## Impact
- WebSocket connections are now properly closed before new ones are created
- Async cleanup operations complete before new subscriptions start
- No resource leaks from accumulated WebSocket connections
- All existing tests pass without modification

## Testing
- Verified with existing unit test suite (all 92 tests pass)
- Build succeeds without TypeScript errors
- Code style passes linter checks
