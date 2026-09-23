import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
} from "../src";
import type { RelativeTimelock } from "../src/script/tapscript";
import { makeHdProviderForTest } from "./helpers/hdProvider";
import {
    installRestoreHarness,
    makeMockIndexer,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

const SERVER = hex.decode("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const TIMELOCK: RelativeTimelock = { value: 144n, type: "blocks" };

describe("look-ahead failure during startup", () => {
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    /** An HD wallet's boot: the band is registered, then the watched set syncs. */
    const makeManager = async () => {
        const provider = await makeHdProviderForTest();
        return ContractManager.create({
            indexerProvider: makeMockIndexer(new Set()),
            contractRepository: new InMemoryContractRepository(),
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 100_000, reconnectDelayMs: 100_000 },
            lookAhead: {
                size: 2,
                currentWatermark: async () => -1,
                materialize: (index) => provider.materializeDescriptorAt(index),
                candidateDeps: () => ({
                    network: { hrp: "tark" },
                    serverPubKey: SERVER,
                    csvTimelocks: [TIMELOCK],
                }),
            },
        });
    };

    it("keeps the wallet running and reports the band as unfinished", async () => {
        const drain = vi
            .spyOn(ContractManager.prototype as never, "scheduleLookAheadDrain" as never)
            .mockRejectedValueOnce(new ProviderUnavailableError("operator down"));

        // The point of the fix: construction survives the outage.
        const manager = await makeManager();
        drain.mockRestore();

        // The boot sync that follows succeeded, so this is not that sync's own
        // failure being reported — it is the band still being unfinished, which
        // a later success must not be able to claim away.
        const state = manager.getSyncState();
        expect(state.mode).toBe("degraded");
        expect(state.mode === "degraded" ? state.reason : "").toContain("look-ahead band");

        // The provider is back: the next event pays the owed refill, and the
        // state stops claiming a gap it no longer has.
        await (manager as any).handleContractEvent({
            type: "connection_reset",
            timestamp: Date.now(),
        });
        expect(manager.getSyncState().mode).toBe("online");

        await manager.dispose();
    });

    it("still propagates a terminal failure", async () => {
        const drain = vi
            .spyOn(ContractManager.prototype as never, "scheduleLookAheadDrain" as never)
            .mockRejectedValueOnce(new Error("schema violation"));

        await expect(makeManager()).rejects.toThrow("schema violation");
        drain.mockRestore();
    });
});
