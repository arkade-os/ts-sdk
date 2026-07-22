export * from "./types";
export * from "./predicates";
export * from "./amount";
export * from "./handle";
export { PaymentRouter, AmbiguousRouteError } from "./router";
export { arkRail } from "./rails/ark";
export { onchainRail } from "./rails/onchain";

import { PaymentRouter } from "./router";
import { arkRail } from "./rails/ark";
import { onchainRail } from "./rails/onchain";
import type { Wallet } from "../index";

/**
 * Default payment router with the Wallet-only rails: `ark` (off-chain send) and
 * `onchain` (collaborative exit). Lightning and chain-swap rails live in
 * `@arkade-os/boltz-swap`, which ships a `createDefaultPaymentRouter(wallet,
 * swaps)` overload composing the full set.
 *
 * The default priority is `["ark", "lightning", "onchain"]` — the wallet's
 * Ark > Lightning > on-chain ladder. `"lightning"` is listed so it ranks
 * correctly once the boltz rail is added; it is simply absent here.
 */
export function createDefaultPaymentRouter(wallet: Wallet): PaymentRouter {
    return new PaymentRouter({
        wallet,
        prefs: { priority: ["ark", "lightning", "onchain"] },
    })
        .use(arkRail())
        .use(onchainRail());
}
