import { expect, describe, it, beforeAll, beforeEach, vi } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    SingleKey,
    EsploraProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    RestOperatorProvider,
    RestDelegateProvider,
} from "../../src";
import { toXOnly } from "../../src/utils/keys";
import { beforeEachFaucet, createVtxo, ESPLORA_API_URL, OPERATOR_URL, waitFor } from "./utils";

const DELEGATOR_URL = "http://localhost:7012";

// Regtest has no pin: stand the local delegator in for Arkade's retired one.
const retired = vi.hoisted(() => ({ keys: [] as Uint8Array[] }));
vi.mock("../../src/networks", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/networks")>()),
    retiredDelegatePubKeys: () => retired.keys,
}));

const createWallet = (identity: SingleKey, withDelegator: boolean) =>
    Wallet.create({
        identity,
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        ...(withDelegator && { delegateProvider: new RestDelegateProvider(DELEGATOR_URL) }),
        settlementConfig: false,
    });

describe("Retired delegator contracts", () => {
    beforeAll(async () => {
        const info = await new RestDelegateProvider(DELEGATOR_URL).getDelegateInfo();
        retired.keys = [toXOnly(hex.decode(info.pubkey), "delegate key")];
    });

    beforeEach(beforeEachFaucet, 60_000);

    it("restores and renews a delegate coin without a delegator", {
        timeout: 120_000,
    }, async () => {
        const identity = SingleKey.fromRandomBytes();

        const a = await createWallet(identity, true);
        let delegateScript: string;
        try {
            await createVtxo({ wallet: a, identity }, 50_000);
            const [vtxo] = await a.getVtxos();
            delegateScript = vtxo.script;
            expect(delegateScript).toBe(hex.encode(a.offchainTapscript.pkScript));
        } finally {
            await a.dispose().catch(() => undefined);
        }

        const b = await createWallet(identity, false);
        try {
            expect(hex.encode(b.offchainTapscript.pkScript)).not.toBe(delegateScript);
            await b.restore();
            await waitFor(async () =>
                (await b.getVtxos()).some((v) => v.script === delegateScript),
            );
            expect((await b.getBalance()).total).toBeGreaterThanOrEqual(50_000);

            await b.settle();
            await waitFor(async () => {
                const vtxos = await b.getVtxos();
                return (
                    vtxos.length > 0 &&
                    vtxos.every((v) => v.script === hex.encode(b.offchainTapscript.pkScript))
                );
            });
        } finally {
            await b.dispose().catch(() => undefined);
        }
    });
});
