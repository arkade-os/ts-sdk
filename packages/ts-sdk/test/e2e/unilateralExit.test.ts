import { hex } from "@scure/base";
import { hash160 } from "@scure/btc-signer/utils.js";
import { execSync } from "child_process";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
    ExecutorEvent,
    ExitPackage,
    networks,
    OnchainProvider,
    OnchainWallet,
    UnilateralExit,
    VHTLC,
    VHTLCContractHandler,
} from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createTestOnchainWallet,
    createVtxo,
    faucetOnchain,
    mineBlocks,
    waitFor,
} from "./utils";

describe("unilateral exit packages", () => {
    beforeEach(beforeEachFaucet, 20000);

    let SERVER_KEY: Uint8Array;
    beforeAll(() => {
        const info = execSync("curl -fsS --max-time 5 http://localhost:7070/v1/info");
        const signerPubkey = JSON.parse(info.toString()).signerPubkey;
        SERVER_KEY = hex.decode(signerPubkey).slice(1);
    });

    /**
     * Run the executor to completion, mining on demand:
     * - after every broadcast, mine a block so it confirms
     * - on waiting_csv, mine up to the maturity height
     */
    async function driveExecutor(
        pkg: ExitPackage,
        provider: OnchainProvider,
    ): Promise<ExecutorEvent[]> {
        const events: ExecutorEvent[] = [];
        const executor = new UnilateralExit.Executor(pkg, provider, { pollIntervalMs: 500 });
        for await (const event of executor) {
            events.push(event);
            if (event.status === "broadcast") {
                mineBlocks(1);
            }
            if (event.status === "waiting_csv" && event.maturesAtHeight) {
                const tip = await provider.getChainTip();
                mineBlocks(Math.max(1, event.maturesAtHeight - tip.height + 1));
            }
        }
        return events;
    }

    async function confirmedBalance(provider: OnchainProvider, address: string): Promise<number> {
        const coins = await provider.getCoins(address);
        return coins.reduce((sum, c) => sum + c.value, 0);
    }

    it("exits a single settled vtxo end-to-end", { timeout: 300_000 }, async () => {
        const alice = await createTestArkWallet();
        await createVtxo(alice, 60_000);

        const feeWallet = await OnchainWallet.create(alice.identity, "regtest");
        const dest = await createTestOnchainWallet();

        const opts = {
            wallet: alice.wallet,
            onchainWallet: feeWallet,
            sweepAddress: dest.wallet.address,
            feeRate: 2,
        };

        // 1. quote with an empty fee wallet: full shortfall reported
        const quote = await UnilateralExit.estimate(opts);
        expect(quote.vtxos.filter((v) => !v.skipped)).toHaveLength(1);
        expect(quote.totals.txCount).toBeGreaterThanOrEqual(3);
        expect(quote.shortfallSats).toBe(quote.totals.fundingRequiredSats);

        // 2. fund the fee wallet (faucet mines 1 confirmation)
        faucetOnchain(feeWallet.address, quote.totals.fundingRequiredSats + 20_000);
        await waitFor(async () => (await feeWallet.getCoins()).some((c) => c.status.confirmed), {
            timeout: 30_000,
        });

        // 3. prepare signs everything and broadcasts the splitter
        const pkg = await UnilateralExit.prepare(opts);
        expect(pkg.steps[0].kind).toBe("broadcast");
        expect(pkg.network).toBe("regtest");
        mineBlocks(1); // confirm the splitter

        // 4. keyless execution against esplora only
        const events = await driveExecutor(pkg, feeWallet.provider);
        expect(events.filter((e) => e.status === "failed")).toHaveLength(0);
        expect(events.filter((e) => e.kind === "sweep" && e.status === "confirmed")).toHaveLength(
            1,
        );

        // 5. the recovered amount landed at the sweep address
        await waitFor(
            async () =>
                (await confirmedBalance(feeWallet.provider, dest.wallet.address)) ===
                pkg.totals.recoveredSats,
            { timeout: 30_000 },
        );
    });

    it("dedupes shared ancestors across two vtxos", { timeout: 300_000 }, async () => {
        const alice = await createTestArkWallet();
        await createVtxo(alice, 100_000);

        // split into two vtxos under ONE commitment (shared tree ancestors)
        const address = await alice.wallet.getAddress();
        await alice.wallet.settle({
            inputs: await alice.wallet.getVtxos(),
            outputs: [
                { address, amount: 40_000n },
                { address, amount: 60_000n },
            ],
        });
        await waitFor(async () => (await alice.wallet.getVtxos()).length === 2, {
            timeout: 30_000,
        });

        const feeWallet = await OnchainWallet.create(alice.identity, "regtest");
        const dest = await createTestOnchainWallet();
        const opts = {
            wallet: alice.wallet,
            onchainWallet: feeWallet,
            sweepAddress: dest.wallet.address,
            feeRate: 2,
        };

        const quote = await UnilateralExit.estimate(opts);
        faucetOnchain(feeWallet.address, quote.totals.fundingRequiredSats + 20_000);
        await waitFor(async () => (await feeWallet.getCoins()).some((c) => c.status.confirmed), {
            timeout: 30_000,
        });

        const pkg = await UnilateralExit.prepare(opts);
        mineBlocks(1);

        // the shared ancestor appears once, serving both vtxos
        const packageSteps = pkg.steps.filter((s) => s.kind === "package");
        expect(packageSteps.some((s) => s.forVtxos.length === 2)).toBe(true);
        expect(pkg.steps.filter((s) => s.kind === "sweep")).toHaveLength(2);

        const events = await driveExecutor(pkg, feeWallet.provider);
        expect(events.filter((e) => e.status === "failed")).toHaveLength(0);
        expect(events.filter((e) => e.kind === "sweep" && e.status === "confirmed")).toHaveLength(
            2,
        );

        await waitFor(
            async () =>
                (await confirmedBalance(feeWallet.provider, dest.wallet.address)) ===
                pkg.totals.recoveredSats,
            { timeout: 30_000 },
        );
    });

    it(
        "exits a vhtlc as receiver with the preimage (condition witness)",
        { timeout: 300_000 },
        async () => {
            const alice = await createTestArkWallet();
            await createVtxo(alice, 30_000);
            const bob = await createTestArkWallet();

            const preimage = new TextEncoder().encode("exit-package-preimage");
            const preimageHash = hash160(preimage);
            const vhtlcParams = {
                preimageHash,
                sender: (await alice.identity.xOnlyPublicKey())!,
                receiver: (await bob.identity.xOnlyPublicKey())!,
                server: SERVER_KEY,
                refundLocktime: 1000n,
                unilateralClaimDelay: { type: "blocks", value: 9n } as const,
                unilateralRefundDelay: { type: "blocks", value: 50n } as const,
                unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 50n } as const,
            };
            const vhtlcScript = new VHTLC.Script(vhtlcParams);
            const vhtlcAddress = vhtlcScript.address(networks.regtest.hrp, SERVER_KEY).encode();

            // fund the vhtlc in a settlement so the chain stays short
            await alice.wallet.settle({
                inputs: await alice.wallet.getVtxos(),
                outputs: [{ address: vhtlcAddress, amount: 30_000n }],
            });

            // register the contract (with the preimage) in bob's repository.
            // NOTE: registration goes straight to the repository — the
            // ContractManager annotation path (`deriveContractTapscripts`)
            // still assumes forfeit-style scripts and cannot annotate VHTLCs.
            // The exit flow's explicit-outpoint path is designed to work
            // without wallet-side VTXO tracking.
            await bob.wallet.contractRepository.saveContract({
                type: "vhtlc",
                params: {
                    ...VHTLCContractHandler.serializeParams(vhtlcParams),
                    preimage: hex.encode(preimage),
                },
                script: hex.encode(vhtlcScript.pkScript),
                address: vhtlcAddress,
                state: "active",
                createdAt: Date.now(),
            });

            // locate the funded vhtlc outpoint on the indexer
            let outpoint: { txid: string; vout: number } | undefined;
            await waitFor(
                async () => {
                    const res = await bob.wallet.indexerProvider.getVtxos({
                        scripts: [hex.encode(vhtlcScript.pkScript)],
                        spendableOnly: true,
                    });
                    if (res.vtxos.length !== 1) return false;
                    outpoint = { txid: res.vtxos[0].txid, vout: res.vtxos[0].vout };
                    return true;
                },
                { timeout: 30_000 },
            );

            const feeWallet = await OnchainWallet.create(bob.identity, "regtest");
            const dest = await createTestOnchainWallet();
            const opts = {
                wallet: bob.wallet,
                onchainWallet: feeWallet,
                sweepAddress: dest.wallet.address,
                feeRate: 2,
                vtxos: [outpoint!],
            };

            const quote = await UnilateralExit.estimate(opts);
            const active = quote.vtxos.filter((v) => !v.skipped);
            expect(active).toHaveLength(1);
            expect(active[0].path).toBe("vhtlc:unilateral");
            expect(active[0].delay).toEqual({ type: "blocks", value: 9 });

            faucetOnchain(feeWallet.address, quote.totals.fundingRequiredSats + 20_000);
            await waitFor(
                async () => (await feeWallet.getCoins()).some((c) => c.status.confirmed),
                { timeout: 30_000 },
            );

            const pkg = await UnilateralExit.prepare(opts);
            mineBlocks(1);

            // ground truth for condition-witness stack order: the sweep must
            // be accepted by real consensus with [sig, preimage, script, cb]
            const events = await driveExecutor(pkg, feeWallet.provider);
            expect(events.filter((e) => e.status === "failed")).toHaveLength(0);
            expect(
                events.filter((e) => e.kind === "sweep" && e.status === "confirmed"),
            ).toHaveLength(1);

            await waitFor(
                async () =>
                    (await confirmedBalance(feeWallet.provider, dest.wallet.address)) ===
                    pkg.totals.recoveredSats,
                { timeout: 30_000 },
            );
        },
    );
});
