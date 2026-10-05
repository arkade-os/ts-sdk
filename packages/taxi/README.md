# Arkade Taxi

`@arkade-os/taxi` owns verified Taxi sends, receive claims, Bitcoin-to-asset RFQ routing and persisted activity. It consumes `@arkade-os/sdk`, `@arkade-os/swap` and the Taxi client. Core SDK and swap remain independent of this plugin.

The Taxi client and protocol peers currently come from the frozen candidate archives in the wallet integration. This package has not been published; installing it alone from npm is not supported yet.

- `createTaxiSender` accepts trusted Arkade context, the server checkpoint script, storage, fresh unreserved coins and transaction coordination. Its journal is written before submission and preserves an uncertain payment for reconciliation.
- `createClaimWatch` verifies incoming offers against the configured server, emulator and operator before exposing them.
- `TaxiClaimQueue` plans and executes claims sequentially. With coordination enabled, verified free claims are automatic by default. Paid claims require `claim(key)`. `setAutomatic(false)` disables automatic signing. `setActive(false)` suspends a locked wallet and permanently revokes work begun before locking; `setActive(true)` resumes without discarding uncertain/completed-claim guards. `dispose()` revokes a departed wallet context.
- `TaxiActivityStore` persists and reconciles sender/receiver activity without making history failures a payment failure.
- `payAssetRequest` negotiates a receiver-paid carrier with a supporting solver, falls back only before funding and preserves an uncertain funding result.
- `decodeTaxiParams` and `encodeTaxiParams` preserve repayment preferences in amountless or fixed payment requests.

`FailedDirectTaxi.forget()` is an explicit local journal override, not cancellation. The operator can still complete a failed submission. Require the sender to acknowledge that making a replacement payment may pay twice; automation must retain the pending guard and reconcile instead.

Wallet adapters supply fresh coins with **all reservations excluded**, a shared transaction lock for sends and claims, the active authorization check and wallet reload. The queue remembers consumed inputs and waits for reload before proceeding. Without a coordination callback it plans offers and allows manual claims, but does not sign automatically.

```ts
const queue = new TaxiClaimQueue({
    identity: wallet.identity,
    getCoins: getUnreservedCoins,
    coordinate: runWithWalletTransactionLock,
    allowed: isWalletUnlocked,
    reload: reloadWallet,
    recordClaim: saveClaimActivity,
});
const stop = watchReceiverClaims(createClaimWatch({
    ...trustedWatchConfiguration,
    onOffer: (offer) => queue.offer(offer),
    onGone: (key) => queue.withdraw(key),
}));
// When the wallet identity, server or network changes:
stop();
queue.dispose();
```

Free eligibility requires zero receiver fare, no asset dilution and full retention of the receiver's funding coin. The receiver still needs liquidity to repay the carrier loan. A returned legacy sub-dust refund likewise needs consolidation before it is spendable; this plugin does not add a new refund covenant.

The regtest scenario uses two real SDK wallets and the local Taxi profile. Run `pnpm regtest:up:taxi` and `pnpm regtest:test:taxi`; `pnpm test:integration:taxi` resets, starts and tests the profile in one command.
