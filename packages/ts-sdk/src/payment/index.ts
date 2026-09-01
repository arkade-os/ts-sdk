export * from "./types";
export * from "./predicates";
export * from "./targets";
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
 * `onchain` (collaborative exit), ranked in that order.
 */
export function createDefaultPaymentRouter(wallet: Wallet): PaymentRouter {
    return new PaymentRouter({
        wallet,
        prefs: { priority: ["ark", "onchain"] },
    })
        .use(arkRail())
        .use(onchainRail());
}
