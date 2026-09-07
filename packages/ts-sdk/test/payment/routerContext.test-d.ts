import { describe, expectTypeOf, it } from "vitest";
import { PaymentRouter } from "../../src/payment/router";
import { arkRail } from "../../src/payment/rails/ark";
import { arkAssetRail } from "../../src/payment/rails/arkAsset";
import { onchainRail } from "../../src/payment/rails/onchain";
import type { RouterContext } from "../../src/payment/types";
import type { IWallet, Wallet } from "../../src/index";
import type { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";

// Compile-time only: erased types are invisible to runtime assertions. wallet#950.
declare const sw: ServiceWorkerWallet;
declare const wallet: Wallet;

describe("RouterContext wallet typing", () => {
    it("defaults to the concrete Wallet, so existing consumers are unchanged", () => {
        expectTypeOf<RouterContext>().toEqualTypeOf<RouterContext<Wallet>>();
    });

    it("accepts a wallet that only satisfies IWallet", () => {
        const router = new PaymentRouter({ wallet: sw, prefs: {} });
        expectTypeOf(router).toEqualTypeOf<PaymentRouter<ServiceWorkerWallet>>();
        router.use(arkRail()).use(arkAssetRail());
    });

    it("refuses a rail needing more than the router's wallet", () => {
        const router = new PaymentRouter({ wallet: sw, prefs: {} });
        // @ts-expect-error `onchain` reads Wallet.arkProvider, absent from IWallet.
        router.use(onchainRail());
    });

    it("still accepts that rail on a concrete-Wallet router", () => {
        new PaymentRouter({ wallet, prefs: {} }).use(onchainRail());
    });

    it("keeps an IWallet-only rail usable on a concrete-Wallet router", () => {
        expectTypeOf(arkRail()).toExtend<ReturnType<typeof onchainRail>>();
    });

    it("does not let IWallet reach arkProvider", () => {
        expectTypeOf<IWallet>().not.toHaveProperty("arkProvider");
    });
});
