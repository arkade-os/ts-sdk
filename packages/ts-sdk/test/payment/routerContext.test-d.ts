import { describe, expectTypeOf, it } from "vitest";
import { PaymentRouter } from "../../src/payment/router";
import { arkRail } from "../../src/payment/rails/ark";
import { arkAssetRail } from "../../src/payment/rails/arkAsset";
import { onchainRail } from "../../src/payment/rails/onchain";
import type { RouterContext } from "../../src/payment/types";
import type { IWallet } from "../../src/index";
import type { FeeInfo } from "../../src/providers/ark";
import type { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";

// Compile-time only: erased types are invisible to runtime assertions. wallet#950.
declare const sw: ServiceWorkerWallet;
declare const feeInfo: () => Promise<FeeInfo>;

describe("RouterContext wallet typing", () => {
    it("carries an IWallet, so no rail narrows the shared context", () => {
        expectTypeOf<RouterContext["wallet"]>().toEqualTypeOf<IWallet>();
    });

    it("accepts a wallet that only satisfies IWallet", () => {
        expectTypeOf<ServiceWorkerWallet>().toExtend<RouterContext["wallet"]>();
    });

    it("registers every rail on a router built with an IWallet-only wallet", () => {
        new PaymentRouter({ wallet: sw, prefs: {} })
            .use(arkRail())
            .use(arkAssetRail())
            .use(onchainRail({ feeInfo }));
    });

    it("cannot build the onchain rail without a fee source", () => {
        // @ts-expect-error required, not optional: a rail that cannot price an
        // offboard must fail to build rather than drop off the money path.
        onchainRail();
    });

    it("cannot build it from a deps object naming no fee source", () => {
        // @ts-expect-error as above — an empty bag is not a fee source.
        onchainRail({});
    });

    it("does not let IWallet reach arkProvider", () => {
        expectTypeOf<IWallet>().not.toHaveProperty("arkProvider");
    });
});
