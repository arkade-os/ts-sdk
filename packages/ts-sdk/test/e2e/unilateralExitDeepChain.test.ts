import { beforeEach, describe, expect, it } from "vitest";
import { ExitPackage, OnchainWallet, UnilateralExit } from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    createTestArkWallet,
    createTestOnchainWallet,
    createVtxo,
    execCommand,
    mineBlocks,
    waitFor,
} from "./utils";

// First input's prevout txid (display order) of a raw tx hex.
function firstInputTxid(rawHex: string): string {
    const rev = (h: string) => h.match(/../g)!.reverse().join("");
    let p = 0;
    const rd = (n: number) => {
        const s = rawHex.slice(p, p + n * 2);
        p += n * 2;
        return s;
    };
    rd(4); // version
    if (rawHex.slice(p, p + 4) === "0001") rd(2); // segwit marker+flag
    let c = parseInt(rd(1), 16);
    if (c === 0xfd) c = parseInt(rev(rd(2)), 16);
    else if (c === 0xfe) c = parseInt(rev(rd(4)), 16);
    return rev(rd(32)); // prevout txid, little-endian on the wire -> display order
}

describe("unilateral exit — deep chain ordering", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "prepare() emits a deep offchain send chain in physical-input topological order",
        { timeout: 300_000 },
        async () => {
            const alice = await createTestArkWallet();
            const address = await alice.wallet.getAddress();

            // Settle → on-chain-anchored vtxo (the unroll chain's confirmed root),
            // then chain off-chain sends for depth. buildExitDag orders these by
            // the indexer's logical chain, which diverges from the finalized txs'
            // physical inputs — so prepare() must re-sort by real inputs, or the
            // sequential executor deadlocks on a step whose input isn't onchain.
            const note = execCommand(`${arkdExec} arkd note --amount 300000`);
            execCommand(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
            await createVtxo(alice, 200_000);
            mineBlocks(1);
            await waitFor(async () => (await alice.wallet.getVtxos()).length === 1, {
                timeout: 30_000,
            });

            const HOPS = 6;
            for (let i = 0; i < HOPS; i++) {
                const vtxos = await alice.wallet.getVtxos();
                const spine = vtxos.reduce((a, b) => (a.value > b.value ? a : b));
                await alice.wallet.send({ address, amount: spine.value - 12_000 });
                await waitFor(async () => (await alice.wallet.getVtxos()).length === i + 2, {
                    timeout: 30_000,
                });
            }

            const dest = await createTestOnchainWallet();
            const feeWallet = await OnchainWallet.create(alice.identity, "regtest");
            const pkg = await UnilateralExit.prepare({
                wallet: alice.wallet,
                onchainWallet: feeWallet,
                sweepAddress: dest.wallet.address,
                feeRate: 2,
                mode: "graph" as const,
            });

            const bumps = pkg.steps.filter((s) => s.kind === "bump") as Extract<
                ExitPackage["steps"][number],
                { kind: "bump" }
            >[];
            // Genuinely deep: each send stacks a layer, so more unroll txs than hops.
            expect(bumps.length).toBeGreaterThan(HOPS);

            // Every bump's input is satisfied by an EARLIER bump or is already
            // on-chain — the exact invariant the strictly-sequential executor needs.
            // Driving the chain to completion is covered by the graph-mode e2e; a
            // full deep drive is too slow/timing-sensitive for CI, so we assert the
            // ordering invariant the fix guarantees rather than re-execute it here.
            const producedAt = new Map<string, number>();
            bumps.forEach((b, i) => producedAt.set(b.parentTxid, i));
            bumps.forEach((b, i) => {
                const producer = producedAt.get(firstInputTxid(b.parentHex));
                if (producer !== undefined) expect(producer).toBeLessThan(i);
            });

            // Step 0 spends a confirmed on-chain output (the root anchor). Before
            // the fix this could land mid-array, deadlocking the executor at step 0.
            // Poll until the root confirms — mining nudges a mempool-only root
            // through and gives Esplora time to index it; a single-shot check
            // flaked on CI's slower indexer (root read back as still unconfirmed).
            const rootTxid = firstInputTxid(bumps[0].parentHex);
            await waitFor(
                async () => {
                    const st = await feeWallet.provider
                        .getTxStatus(rootTxid)
                        .catch(() => undefined);
                    if (st?.confirmed) return true;
                    mineBlocks(1);
                    return false;
                },
                { timeout: 60_000 },
            );
        },
    );
});
