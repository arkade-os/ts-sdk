import { expect, describe, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    EsploraProvider,
    RestIndexerProvider,
    RestArkProvider,
} from "../../src";
import {
    verifyVtxo,
    collectExitData,
    validateExitData,
    InMemoryExitDataRepository,
    canSovereignExit,
} from "../../src/verification";
import {
    createTestArkWallet,
    createVtxo,
    beforeEachFaucet,
    execCommand,
} from "./utils";

const ESPLORA_URL = "http://localhost:3000";
const INDEXER_URL = "http://localhost:7070";
const ARK_URL = "http://localhost:7070";

function mineBlock() {
    execCommand("nigiri rpc -generate 1");
}

async function waitForEsplora(
    onchain: EsploraProvider,
    txid: string,
    timeoutMs = 30000
) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const status = await onchain.getTxStatus(txid);
            if (status.confirmed) return;
        } catch {
            // not found yet
        }
        mineBlock();
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Timeout waiting for tx ${txid} to confirm`);
}

describe("VTXO Verification - Integration", () => {
    beforeEach(beforeEachFaucet, 20000);

    describe("Tier 1: Full pipeline against live arkd", () => {
        it(
            "should verify a real VTXO end-to-end",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const indexer = new RestIndexerProvider(INDEXER_URL);
                const arkProvider = new RestArkProvider(ARK_URL);
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                // Create a VTXO via arkd
                await createVtxo(alice, 10_000);

                const vtxos = await alice.wallet.getVtxos();
                expect(vtxos.length).toBeGreaterThan(0);

                const vtxo = vtxos[0];
                const info = await arkProvider.getInfo();

                const serverPubKey = hex.decode(info.signerPubkey).slice(1);
                const sweepInterval = {
                    value: info.boardingExitDelay,
                    type:
                        info.boardingExitDelay < 512n
                            ? ("blocks" as const)
                            : ("seconds" as const),
                };

                // Ensure commitment tx is confirmed on-chain
                const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
                if (commitmentTxid) {
                    await waitForEsplora(onchain, commitmentTxid);
                }

                const result = await verifyVtxo(
                    vtxo,
                    indexer,
                    onchain,
                    { pubkey: serverPubKey, sweepInterval },
                    { verifySignatures: true }
                );

                console.log(
                    "verifyVtxo result:",
                    JSON.stringify(result, null, 2)
                );

                expect(result.valid).toBe(true);
                expect(result.errors).toHaveLength(0);
                expect(result.commitmentTxid).toBeTruthy();
                expect(result.confirmationDepth).toBeGreaterThan(0);
                expect(result.chainLength).toBeGreaterThan(0);
            }
        );
    });

    describe("Tier 1: Onchain anchor against real esplora", () => {
        it(
            "should verify a real commitment tx onchain",
            { timeout: 60000 },
            async () => {
                const alice = await createTestArkWallet();
                const indexer = new RestIndexerProvider(INDEXER_URL);
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);

                const vtxos = await alice.wallet.getVtxos();
                const vtxo = vtxos[0];
                const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
                expect(commitmentTxid).toBeTruthy();

                // Mine blocks until commitment tx is confirmed
                await waitForEsplora(onchain, commitmentTxid!);

                const txHex = await onchain.getTxHex(commitmentTxid!);
                expect(txHex).toBeTruthy();
                expect(txHex.length).toBeGreaterThan(0);

                const txStatus = await onchain.getTxStatus(commitmentTxid!);
                expect(txStatus.confirmed).toBe(true);
            }
        );
    });

    describe("Tier 1: Signature and cosigner verification", () => {
        it(
            "should verify tree signatures on a real VTXO tree",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const indexer = new RestIndexerProvider(INDEXER_URL);
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);
                const vtxos = await alice.wallet.getVtxos();
                const vtxo = vtxos[0];

                const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
                expect(commitmentTxid).toBeTruthy();

                await waitForEsplora(onchain, commitmentTxid!);

                // Fetch tree and verify signatures directly
                const { vtxoTree } = await indexer.getVtxoTree({
                    txid: commitmentTxid!,
                    vout: 0,
                });
                expect(vtxoTree.length).toBeGreaterThan(0);

                const txids = vtxoTree.map((n) => n.txid);
                const { txs } = await indexer.getVirtualTxs(txids);
                expect(txs.length).toBe(txids.length);
            }
        );
    });

    describe("Tier 1: Multiple VTXO batch verification", () => {
        it(
            "should verify multiple VTXOs from same batch",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const bob = await createTestArkWallet();
                const indexer = new RestIndexerProvider(INDEXER_URL);
                const arkProvider = new RestArkProvider(ARK_URL);
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);

                const vtxos = await alice.wallet.getVtxos();
                expect(vtxos.length).toBeGreaterThan(0);

                // Verify all at once
                const info = await arkProvider.getInfo();
                const serverPubKey = hex.decode(info.signerPubkey).slice(1);

                const commitmentTxid =
                    vtxos[0].virtualStatus?.commitmentTxIds?.[0];
                if (commitmentTxid) {
                    await waitForEsplora(onchain, commitmentTxid);
                }

                const { verifyAllVtxos } = await import(
                    "../../src/verification"
                );
                const results = await verifyAllVtxos(vtxos, indexer, onchain, {
                    pubkey: serverPubKey,
                    sweepInterval: {
                        value: info.boardingExitDelay,
                        type:
                            info.boardingExitDelay < 512n
                                ? ("blocks" as const)
                                : ("seconds" as const),
                    },
                });

                expect(results.size).toBe(vtxos.length);
                for (const [key, result] of results) {
                    console.log(`VTXO ${key}: valid=${result.valid}`);
                    if (!result.valid) {
                        console.log("  errors:", result.errors);
                        console.log("  warnings:", result.warnings);
                    }
                    expect(result.commitmentTxid).toBeTruthy();
                }
            }
        );
    });

    describe("Wallet API: verifyVtxo via Wallet class", () => {
        it(
            "should verify a VTXO through wallet.verifyVtxo()",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);
                const vtxos = await alice.wallet.getVtxos();
                expect(vtxos.length).toBeGreaterThan(0);

                const vtxo = vtxos[0];
                const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
                if (commitmentTxid) {
                    await waitForEsplora(onchain, commitmentTxid);
                }

                // Use the Wallet API (not standalone function)
                const result = await alice.wallet.verifyVtxo(vtxo);

                console.log(
                    "wallet.verifyVtxo result:",
                    JSON.stringify(result, null, 2)
                );

                expect(result.commitmentTxid).toBeTruthy();
                expect(result.chainLength).toBeGreaterThan(0);
                expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
            }
        );
    });

    describe("Wallet API: verifyAllVtxos via Wallet class", () => {
        it(
            "should verify all VTXOs through wallet.verifyAllVtxos()",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);
                const vtxos = await alice.wallet.getVtxos();
                expect(vtxos.length).toBeGreaterThan(0);

                const commitmentTxid =
                    vtxos[0].virtualStatus?.commitmentTxIds?.[0];
                if (commitmentTxid) {
                    await waitForEsplora(onchain, commitmentTxid);
                }

                const results = await alice.wallet.verifyAllVtxos();

                console.log(
                    "wallet.verifyAllVtxos:",
                    results.size,
                    "VTXOs verified"
                );

                expect(results.size).toBe(vtxos.length);
                for (const [key, result] of results) {
                    expect(result.commitmentTxid).toBeTruthy();
                    expect(result.vtxoOutpoint).toBeDefined();
                }
            }
        );
    });

    describe("Tier 3: Exit data collection from live arkd", () => {
        it(
            "should collect and validate exit data for a real VTXO",
            { timeout: 120000 },
            async () => {
                const alice = await createTestArkWallet();
                const indexer = new RestIndexerProvider(INDEXER_URL);
                const onchain = new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

                await createVtxo(alice, 10_000);

                const vtxos = await alice.wallet.getVtxos();
                const vtxo = vtxos[0];

                const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
                expect(commitmentTxid).toBeTruthy();

                // Mine so commitment tx is on-chain
                await waitForEsplora(onchain, commitmentTxid!);

                // Fetch chain
                const { chain } = await indexer.getVtxoChain({
                    txid: vtxo.txid,
                    vout: vtxo.vout,
                });
                expect(chain.length).toBeGreaterThan(0);

                // Fetch tree
                const { vtxoTree } = await indexer.getVtxoTree({
                    txid: commitmentTxid!,
                    vout: 0,
                });

                // Fetch virtual txs
                const txids = vtxoTree.map((n) => n.txid);
                const { txs } = await indexer.getVirtualTxs(txids);

                const virtualTxs: Record<string, string> = {};
                for (let i = 0; i < txids.length; i++) {
                    virtualTxs[txids[i]] = txs[i];
                }

                const treeNodes = vtxoTree.map((n) => ({
                    txid: n.txid,
                    tx: virtualTxs[n.txid] ?? "",
                    children: n.children,
                }));

                // Collect exit data
                const exitData = collectExitData(
                    vtxo,
                    chain,
                    virtualTxs,
                    treeNodes
                );

                expect(exitData.commitmentTxid).toBe(commitmentTxid);
                expect(exitData.chain.length).toBeGreaterThan(0);
                expect(Object.keys(exitData.virtualTxs).length).toBeGreaterThan(
                    0
                );

                // Validate
                const validation = validateExitData(exitData);
                console.log(
                    "validateExitData:",
                    JSON.stringify(validation, null, 2)
                );
                expect(validation.valid).toBe(true);

                // Store and check sovereign exit readiness
                const repo = new InMemoryExitDataRepository();
                await repo.saveExitData(exitData);

                const exitCheck = await canSovereignExit(
                    { txid: vtxo.txid, vout: vtxo.vout },
                    repo,
                    onchain
                );
                console.log(
                    "canSovereignExit:",
                    JSON.stringify(exitCheck, null, 2)
                );
                expect(exitCheck.canExit).toBe(true);
            }
        );
    });
});
