import { hex } from "@scure/base";
import { expect, describe, it, beforeEach } from "vitest";
import { ArkadeCash, RestIndexerProvider } from "../../src";
import { beforeEachFaucet, createTestArkWallet, faucetOffchain, waitFor } from "./utils";

describe("ArkadeCash", () => {
    beforeEach(beforeEachFaucet, 20000);

    // `createCash` returns once the funding tx is submitted, before the indexer
    // exposes the VTXO. A real recipient gets the string out-of-band, so only
    // these in-process create-then-claim tests race `claimCash` against it.
    const indexer = new RestIndexerProvider("http://localhost:7070");
    const waitForCashFunded = async (cashStr: string) => {
        const script = hex.encode(ArkadeCash.fromString(cashStr).vtxoScript.pkScript);
        await waitFor(async () => {
            const { vtxos } = await indexer.getVtxos({ scripts: [script] });
            return vtxos.length > 0;
        });
    };

    const fundedWallet = async (amount: number) => {
        const w = await createTestArkWallet();
        faucetOffchain(await w.wallet.getAddress(), amount);
        await waitFor(async () => (await w.wallet.getVtxos()).length > 0);
        return w;
    };

    it("should send and claim arkadeCash (happy path)", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        // Alice creates cash — Bob never shares an address
        const cashStr = await alice.wallet.createCash(5000);
        expect(cashStr).toMatch(/cash1/);
        await waitForCashFunded(cashStr);

        const result = await bob.wallet.claimCash(cashStr);
        expect(result.swept).toBe(5000);
        expect(result.unclaimed.amount).toBe(0);
        expect(result.unclaimed.vtxos).toEqual([]);

        await waitFor(async () => (await bob.wallet.getBalance()).total >= 5000);

        // Sweep-or-report persists nothing: no arkadeCash contract may reach Bob's
        // repository, or his own renewal/recovery would settle an input he
        // cannot sign and reject the whole batch.
        const manager = await bob.wallet.getContractManager();
        const contracts = await manager.getContracts();
        const cashScript = hex.encode(ArkadeCash.fromString(cashStr).vtxoScript.pkScript);
        expect(contracts.some((c) => c.script === cashScript)).toBe(false);
    }, 60_000);

    it("should report an already-claimed arkadeCash instead of sweeping it", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();
        const charlie = await createTestArkWallet();

        const cashStr = await alice.wallet.createCash(5000);
        await waitForCashFunded(cashStr);

        await bob.wallet.claimCash(cashStr);
        await waitFor(async () => (await bob.wallet.getBalance()).total >= 5000);

        // The VTXO still exists, it is just spent — Charlie is told it was
        // already claimed rather than that the arkadeCash is unknown.
        const result = await charlie.wallet.claimCash(cashStr);
        expect(result.swept).toBe(0);
        expect(result.unclaimed.amount).toBe(5000);
        expect(result.unclaimed.vtxos).toHaveLength(1);
        expect(result.unclaimed.vtxos[0].reason).toBe("already-spent");
    }, 90_000);

    it("should throw when the arkadeCash was never funded", async () => {
        const alice = await fundedWallet(10000);
        const info = await alice.wallet.arkProvider.getInfo();
        const cash = ArkadeCash.generate(
            hex.decode(info.signerPubkey).slice(1),
            { type: "blocks", value: 144n },
            "tarkcash",
        );

        await expect(alice.wallet.claimCash(cash.toString())).rejects.toThrow("No VTXOs found");
    }, 30_000);

    it("should reject invalid createCash amounts", async () => {
        const alice = await fundedWallet(10000);

        for (const amount of [0, -1, 0.5, NaN, Infinity, 1]) {
            await expect(alice.wallet.createCash(amount)).rejects.toThrow(
                "Invalid ArkadeCash amount",
            );
        }
    }, 30_000);

    it("should claim each arkadeCash independently", async () => {
        const alice = await fundedWallet(30000);
        const bob = await createTestArkWallet();

        const cash1 = await alice.wallet.createCash(5000);
        await waitFor(async () => (await alice.wallet.getVtxos()).length > 0);
        const cash2 = await alice.wallet.createCash(3000);

        await waitForCashFunded(cash1);
        await waitForCashFunded(cash2);

        expect((await bob.wallet.claimCash(cash1)).swept).toBe(5000);
        expect((await bob.wallet.claimCash(cash2)).swept).toBe(3000);

        await waitFor(async () => (await bob.wallet.getBalance()).total >= 8000);
    }, 120_000);
});
