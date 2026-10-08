/**
 * A payment router with the lightning and `arkade -> onchain` swap rails on top of core's
 * `ark` and `onchain`. The rails close over their own deps rather than widening core's
 * published `RouterContext` (whose legacy `swaps` slot is ignored).
 *
 * Both `onchain-swap` and `onchain` stay registered, so an amount outside the solver's
 * range drops the swap rail at `available()` and the collaborative exit wins, no error.
 */
import type { PaymentRouter, RouterPreferences, Wallet } from "@arkade-os/sdk";
import { PaymentRouter as Router, arkRail, onchainRail, walletFeeSource } from "@arkade-os/sdk";
import { LIGHTNING_RAIL, lightningRail } from "./lightning";
import { ONCHAIN_SWAP_RAIL, onchainSwapRail, type OnchainSwapRailDeps } from "./onchainSwap";
import type { SwapRailClient } from "./swapRail";

/** The ranking this factory ships (the removed boltz-swap overload's). */
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
 * Core's rails plus the two this package supplies, ranked by {@link SWAP_ROUTER_PRIORITY}.
 *
 * Takes the concrete `Wallet` because only it reaches `arkProvider`, which the `onchain`
 * rail's fee source needs; and an already-constructed client so storage, discovery and
 * corridor policy are not decided behind a router call.
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
        .use(onchainSwapRail(client, config));
}
