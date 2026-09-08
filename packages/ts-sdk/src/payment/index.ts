export * from "./types";
export * from "./predicates";
export * from "./targets";
export * from "./amount";
export * from "./handle";
export { PaymentRouter, AmbiguousRouteError } from "./router";
export { arkRail } from "./rails/ark";
export { arkAssetRail, ASSET_CARRIER_SATS } from "./rails/arkAsset";
export { onchainRail } from "./rails/onchain";

import { PaymentRouter } from "./router";
import { arkRail } from "./rails/ark";
import { arkAssetRail } from "./rails/arkAsset";
import { onchainRail } from "./rails/onchain";
import type { Wallet } from "../index";

/**
 * Default payment router with the Wallet-only rails: `ark` (off-chain BTC send),
 * `ark-asset` (off-chain asset send) and `onchain` (collaborative exit).
 * Solver-routed rails live in `@arkade-os/swap` and are registered by the app.
 *
 * The default priority is `["ark", "ark-asset", "onchain"]`.
 * `ark` and `ark-asset` never compete — the amount decides which is
 * available — so their order between themselves is immaterial.
 */
export function createDefaultPaymentRouter(wallet: Wallet): PaymentRouter {
    return new PaymentRouter({
        wallet,
        prefs: { priority: ["ark", "ark-asset", "onchain"] },
    })
        .use(arkRail())
        .use(arkAssetRail())
        .use(onchainRail());
}
