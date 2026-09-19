/**
 * The router that puts lightning and `arkade -> onchain` back into a payment
 * app's reach.
 *
 * Core's `createDefaultPaymentRouter(wallet)` registers `ark` and `onchain` and
 * nothing else. The two swap rails never lived there — they were in
 * `packages/boltz-swap`, behind a second overload with the priority
 * `["ark", "lightning", "onchain-swap", "onchain"]`, and ts-sdk #811 removed
 * them along with the package. This is that overload's shape, rebuilt on the v2
 * client.
 *
 * **The rails close over their own dependencies, and `RouterContext` is not
 * re-opened.** Widening core's context further was the alternative and it is
 * the wrong half: it edits a published payment type and asks core to name
 * things it cannot — a repository, a transport, a discovery index. (Core's
 * context carries an optional `swaps` slot for the legacy boltz-swap rails;
 * these rails ignore it.) A rail factory over an already-constructed
 * `SwapClient` names none of that in core.
 *
 * This factory stays out of core's own, which is pinned at exactly
 * `["ark", "onchain"]`. Registering the swap rails is the app's decision, and
 * the ranking it gets is a *preference*: both `onchain-swap` and `onchain` stay
 * registered, so an amount outside the solver's range drops the swap rail at
 * `available()` and the collaborative exit wins with no error.
 */
import type { PaymentRouter, RouterPreferences, Wallet } from "@arkade-os/sdk";
import { PaymentRouter as Router, arkRail, onchainRail, walletFeeSource } from "@arkade-os/sdk";
import { LIGHTNING_RAIL, lightningRail } from "./lightning";
import { ONCHAIN_SWAP_RAIL, onchainSwapRail, type OnchainSwapRailDeps } from "./onchainSwap";
import type { SwapRailClient } from "./swapRail";

/** The deleted factory's ranking, and the one this factory ships. */
export const SWAP_ROUTER_PRIORITY: readonly string[] = [
    "ark",
    LIGHTNING_RAIL,
    ONCHAIN_SWAP_RAIL,
    "onchain",
];

export interface SwapPaymentRouterConfig extends OnchainSwapRailDeps {
    /** Overrides the shipped ranking; `disabled`, `caps` and `tieBreak` pass through. */
    readonly prefs?: RouterPreferences;
}

/**
 * Core's four rails plus the two this package supplies, ranked as the deleted
 * factory ranked them.
 *
 * Takes the concrete `Wallet` — it fits core's `IWallet`-typed
 * `RouterContext`, and only the concrete class reaches `arkProvider`, which
 * the `onchain` rail's fee source needs — and the already-constructed client,
 * because building one here would put storage, discovery and corridor policy
 * behind a payment-router call that has no business deciding any of them.
 */
export function createSwapPaymentRouter(
    wallet: Wallet,
    client: SwapRailClient,
    config: SwapPaymentRouterConfig,
): PaymentRouter {
    return new Router({
        wallet,
        prefs: { priority: [...SWAP_ROUTER_PRIORITY], ...config.prefs },
    })
        .use(arkRail())
        .use(onchainRail({ feeInfo: walletFeeSource(wallet) }))
        .use(lightningRail(client))
        .use(
            onchainSwapRail(client, {
                claimFeeRateSatVb: config.claimFeeRateSatVb,
                ...(config.claimVsize === undefined ? {} : { claimVsize: config.claimVsize }),
            }),
        );
}
