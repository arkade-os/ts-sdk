import { hex } from "@scure/base";
import { expect, describe, it, beforeEach } from "vitest";
import { ArkadeCash, RestIndexerProvider } from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    faucetOffchain,
    mineBlocks,
    waitFor,
} from "./utils";

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

    // ── server-swept recovery (hybrid L3 — see plans/pr-337-new-plan.md) ──

    /**
     * Create an arkadeCash from `alice` and force the server to sweep its VTXO
     * at batch expiry (expiry = 20 blocks), so `claimCash` must take the
     * import-for-recovery branch instead of the thin sweep. Returns the string
     * and its script.
     */
    const sweptCash = async (
        alice: Awaited<ReturnType<typeof fundedWallet>>,
        amount: number,
    ): Promise<{ cashStr: string; cashScript: string }> => {
        const cashStr = await alice.wallet.createCash(amount);
        const cashScript = hex.encode(ArkadeCash.fromString(cashStr).vtxoScript.pkScript);

        // Wait for the arkadeCash VTXO to land before mining it into expiry.
        await waitForCashFunded(cashStr);

        // Push past the batch expiry so the server sweeps the VTXO. 30 > 20
        // blocks covers any offset between the funding batch and the tip.
        mineBlocks(30);
        await waitFor(
            async () => {
                const { vtxos } = await indexer.getVtxos({ scripts: [cashScript] });
                return vtxos.some((v) => v.virtualStatus.state === "swept" && !v.isSpent);
            },
            { timeout: 60_000 },
        );

        return { cashStr, cashScript };
    };

    it("should recover a server-swept arkadeCash by importing it for recovery", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        const { cashStr, cashScript } = await sweptCash(alice, 5000);

        // A swept VTXO cannot move through the thin sweep — claimCash imports
        // it as a signable recovery-only contract instead of reporting it.
        const result = await bob.wallet.claimCash(cashStr);
        expect(result.swept).toBe(0);
        expect(result.recovering.amount).toBe(5000);
        expect(result.recovering.vtxos).toHaveLength(1);
        expect(result.unclaimed.amount).toBe(0);
        // The old report-only behavior is gone: "swept" no longer surfaces.
        expect(result.unclaimed.vtxos.some((v) => v.reason === "swept")).toBe(false);

        // The import persisted exactly one recovery-only contract carrying a
        // signing descriptor for the arkadeCash key.
        const manager = await bob.wallet.getContractManager();
        const imported = await manager.getContracts({ script: cashScript });
        expect(imported).toHaveLength(1);
        expect(imported[0].metadata?.recoveryOnly).toBe(true);
        expect(typeof imported[0].metadata?.signingDescriptor).toBe("string");

        // Drive the isolated recovery pass until the funds settle back to Bob.
        // The pass is idempotent and self-serialized, so calling it each poll
        // is safe whether or not the claimCash kick is still in flight.
        const vtxoManager = await bob.wallet.getVtxoManager();
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= 5000;
            },
            { timeout: 120_000, interval: 3000 },
        );

        // Exactly the swept value arrived — no double-spend, no double-count.
        expect((await bob.wallet.getBalance()).total).toBe(5000);

        // Recovery over: the contract is removed and its keyring key purged.
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await manager.getContracts({ script: cashScript })).length === 0;
            },
            { timeout: 30_000, interval: 2000 },
        );
    }, 240_000);

    it("should be idempotent when claimCash is re-run before recovery settles", async () => {
        const alice = await fundedWallet(10000);
        const bob = await createTestArkWallet();

        const { cashStr, cashScript } = await sweptCash(alice, 5000);

        // Re-running the claim before recovery completes must not import a
        // second contract or a second key, nor recover the funds twice.
        const r1 = await bob.wallet.claimCash(cashStr);
        expect(r1.recovering.amount).toBe(5000);
        const r2 = await bob.wallet.claimCash(cashStr);
        // The second run either re-imports idempotently (still recovering) or
        // — if the kicked recovery already spent the VTXO — reports it spent;
        // either way it neither throws nor double-counts.
        expect(r2.recovering.amount + r2.swept).toBeLessThanOrEqual(5000);

        const manager = await bob.wallet.getContractManager();
        const imported = await manager.getContracts({ script: cashScript });
        expect(imported.length).toBeLessThanOrEqual(1);

        const vtxoManager = await bob.wallet.getVtxoManager();
        await waitFor(
            async () => {
                await vtxoManager.recoverImportedContracts();
                return (await bob.wallet.getBalance()).total >= 5000;
            },
            { timeout: 120_000, interval: 3000 },
        );

        // The double claim recovered the single VTXO exactly once.
        expect((await bob.wallet.getBalance()).total).toBe(5000);
    }, 240_000);
});
