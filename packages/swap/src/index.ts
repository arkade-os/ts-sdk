/**
 * `@arkade-os/swap` — the v2 swap client.
 *
 * The caller states a route: what to give, what to take, and where the value
 * ends up. Everything that used to be a caller obligation happens behind
 * `quote()` and `accept()` — the destination parse, the corridor pair, the
 * market lookup, the rendezvous, the amount encoding, the covenant derivation,
 * the funding packet, the persist-before-watch ordering, the claim and the
 * refund. `README.md` is one chain per route and nothing else.
 *
 * Three layers reach that surface, in the order a consumer meets them:
 *
 * 1. **The verbs.** `pay`, `receive` and `exchange` are `quote` -> fee ceiling
 *    -> `accept`, and add no capability the client did not already have.
 * 2. **The client.** `createSwapClient` returns the same object the verbs use;
 *    reach for it when you want the terms before committing to them, the
 *    history, a cancel, or the update stream.
 * 3. **The protocol floor.** Everything below the client — requests, covenants,
 *    records, the RFQ transports — lives at `@arkade-os/swap/protocol`, under
 *    `@deprecated` pointers naming what replaced it, and nowhere else. It is a
 *    floor for solvers and terms-showing apps, not a staging area: nothing is
 *    scheduled to disappear from it.
 *
 * The v1 names are NOT re-exported here, and that is deliberate. `0.1.0` breaks
 * against `0.1.0-rc.1` regardless — the client took the `createSwapClient` name
 * and the `./client` subpath is gone — so a window would not spare anyone a
 * migration, only split it into two, while leaving 200 v1 names on a root whose
 * whole claim is to be the v2 surface. One break, one migration, one specifier
 * edit for anything that reaches below the client. `MIGRATION.md` maps it.
 *
 * Two subpaths are neither deprecations nor going anywhere: `./nostr` is the
 * hand-built transport floor, and `./node` plus `./repositories/*` are the
 * storage backends. `./client` is gone — the client is this root.
 */

// The v2 client, the three verbs, the closed `Route` union, the amount law, the
// asset-id vocabulary, the sixteen-member error taxonomy, and the durable
// record `accept()` writes.
export * from "./client";

// Storage. `SwapClientConfig.repository` takes the interface; the backends are
// the browser default, the explicit ephemeral one, and — off `./node` and
// `./repositories/*` — SQLite and Realm. There is no implicit default: a client
// that accepts a swap with nowhere to write it is the silent loss the rule
// exists to forbid.
export {
    type AssetSwapRepository,
    type MarketsCacheEntry,
    InMemoryAssetSwapRepository,
} from "./repository";
export { IndexedDbAssetSwapRepository } from "./indexedDbRepository";

// `SwapClientConfig.operator`: the structural slice of the operator connection,
// for a second operator or a test. The wallet supplies it otherwise, and no
// server URL is accepted anywhere.
export { type SwapOperator } from "./refund";

// The payment rails, for an app that routes through core's payment router
// rather than calling the verbs itself. These are the v2 rails — the `solver-*`
// ones they replaced are on the protocol floor below.
export { LIGHTNING_RAIL, lightningRail } from "./payment/lightning";
export {
    ONCHAIN_SWAP_RAIL,
    claimFeeSats,
    onchainSwapRail,
    type OnchainSwapRailDeps,
} from "./payment/onchainSwap";
export {
    SWAP_ROUTER_PRIORITY,
    createSwapPaymentRouter,
    type SwapPaymentRouterConfig,
} from "./payment/router";
export { PAYMENT_STATUS, isTerminalStatus, paymentStatusOf } from "./payment/status";
export {
    SwapPaymentFailedError,
    railAvailable,
    receiverExact,
    swapHandle,
    type SwapRailClient,
} from "./payment/swapRail";
