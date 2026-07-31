import { PaymentRouter, arkRail, onchainRail } from "@arkade-os/sdk";
import type { Wallet } from "@arkade-os/sdk";
import type { ArkadeSwaps } from "../arkade-swaps";
import { lightningRail } from "./lightning";
import { onchainSwapRail } from "./onchain-swap";

export { lightningRail } from "./lightning";
export { onchainSwapRail } from "./onchain-swap";

/**
 * Full payment router composing the Wallet-only rails from `@arkade-os/sdk`
 * (`ark`, `onchain`) with the swap rails (`lightning`, `onchain-swap`). This is
 * the boltz-swap overload of the core `createDefaultPaymentRouter(wallet)`; an
 * Ark-only app uses the core one, a Lightning-capable app uses this.
 *
 * Default priority `["ark", "lightning", "onchain-swap", "onchain"]` — Ark first,
 * then Lightning, then on-chain. For a plain BTC address the chain swap
 * (`onchain-swap`) is preferred over the collaborative exit (`onchain`), but
 * both stay registered: the default is a *preference*, not a restriction —
 * `options()` surfaces both and an app/user can override `priority` (or
 * `disabled`) to force the collaborative exit.
 *
 * The preference also self-heals by amount. `onchain-swap.available()` gates on
 * the ARK→BTC limits (bracketing the user-lock/source amount): when the
 * reconstructed source amount is in range the chain swap wins, and when it is
 * out of range (below min or above max) the rail drops and `onchain` wins
 * automatically — graceful degradation, not a trap.
 *
 * For automatic refunds of a stranded chain-swap lockup, construct `swaps` with a
 * `SwapManager` (the TS analogue of NArk's Boltz poll-loop/sweeper); `onchain-swap`
 * then refunds via the monitor rather than inline. Without one, refund recovery is
 * driven from the payment handle's `failed` event — see {@link onchainSwapRail}.
 */
export function createDefaultPaymentRouter(wallet: Wallet, swaps: ArkadeSwaps): PaymentRouter {
    return new PaymentRouter({
        wallet,
        swaps,
        prefs: { priority: ["ark", "lightning", "onchain-swap", "onchain"] },
    })
        .use(arkRail())
        .use(onchainRail())
        .use(lightningRail())
        .use(onchainSwapRail());
}
