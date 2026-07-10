import { schnorr } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { ChainTxType } from "../src/providers/indexer";
import { SingleKey } from "../src/identity/singleKey";
import { getNetwork } from "../src/networks";
import { VtxoScript } from "../src/script/base";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { P2A } from "../src/utils/anchor";
import { Transaction } from "../src/utils/transaction";
import { buildExitDag } from "../src/wallet/exit/chain";
import { IndexerExitDataSource } from "../src/wallet/exit/indexerSource";
import { CHILD_OUTPUT_DUST, estimate } from "../src/wallet/exit/estimate";
import type { ExitOptions } from "../src/wallet/exit/estimate";

const COMMIT = "c0".repeat(32);
const SHARED = "a1".repeat(32);
const LEAF_A = "a2".repeat(32);
const LEAF_B = "b2".repeat(32);

function fakeIndexer(chains: Record<string, unknown[]>, psbts: Record<string, string> = {}) {
    return {
        getVtxoChain: async ({ txid }: { txid: string }) => ({ chain: chains[txid] }),
        getVirtualTxs: async (txids: string[]) => ({
            txs: txids.map((txid) => psbts[txid]).filter((x): x is string => !!x),
        }),
    } as never;
}

function fakeOnchain(confirmed: Set<string>) {
    return {
        getTxStatus: async (txid: string) => {
            if (!confirmed.has(txid)) throw new Error("not found");
            return { confirmed: true, blockHeight: 100, blockTime: 1_000 };
        },
        getFeeRate: async () => 2,
    } as never;
}

const chainOf = (leaf: string) => [
    { txid: leaf, type: ChainTxType.TREE, expiresAt: "1725000000", spends: [SHARED] },
    { txid: SHARED, type: ChainTxType.TREE, expiresAt: "1725000000", spends: [COMMIT] },
    { txid: COMMIT, type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
];

describe("buildExitDag", () => {
    it("dedupes shared ancestors and topologically orders", async () => {
        const dag = await buildExitDag({
            vtxos: [
                { txid: LEAF_A, vout: 0 },
                { txid: LEAF_B, vout: 0 },
            ],
            chain: new IndexerExitDataSource(
                fakeIndexer({ [LEAF_A]: chainOf(LEAF_A), [LEAF_B]: chainOf(LEAF_B) }),
            ),
            onchain: fakeOnchain(new Set([COMMIT])),
        });
        expect(dag.map((n) => n.txid)).toEqual([SHARED, LEAF_A, LEAF_B]);
        expect(dag[0].forVtxos.sort()).toEqual([`${LEAF_A}:0`, `${LEAF_B}:0`].sort());
        expect(dag.every((n) => n.type !== ChainTxType.COMMITMENT)).toBe(true);
    });

    it("marks already-confirmed nodes", async () => {
        const dag = await buildExitDag({
            vtxos: [{ txid: LEAF_A, vout: 0 }],
            chain: new IndexerExitDataSource(fakeIndexer({ [LEAF_A]: chainOf(LEAF_A) })),
            onchain: fakeOnchain(new Set([COMMIT, SHARED])),
        });
        expect(dag.find((n) => n.txid === SHARED)!.confirmed).toBe(true);
        expect(dag.find((n) => n.txid === LEAF_A)!.confirmed).toBe(false);
    });

    it("throws on a cyclic chain", async () => {
        const cyclic = [
            { txid: LEAF_A, type: ChainTxType.TREE, expiresAt: "", spends: [SHARED] },
            { txid: SHARED, type: ChainTxType.TREE, expiresAt: "", spends: [LEAF_A] },
        ];
        await expect(
            buildExitDag({
                vtxos: [{ txid: LEAF_A, vout: 0 }],
                chain: new IndexerExitDataSource(fakeIndexer({ [LEAF_A]: cyclic })),
                onchain: fakeOnchain(new Set()),
            }),
        ).rejects.toThrow(/inconsistent/i);
    });
});

// ---------------------------------------------------------------------------
// estimate()
// ---------------------------------------------------------------------------

const identity = SingleKey.fromHex("aa".repeat(32));
const network = getNetwork("regtest");
const timelock = { type: "blocks", value: 144n } as const;

async function estimateFixture(opts?: {
    coins?: { txid: string; vout: number; value: number; status: { confirmed: boolean } }[];
    vtxoValue?: number;
}) {
    const owner = (await identity.xOnlyPublicKey())!;
    const exit = CSVMultisigTapscript.encode({ pubkeys: [owner], timelock });
    const vtxoScript = new VtxoScript([exit.script]);
    const pay = p2tr(owner, undefined, network);

    // Real TREE PSBTs (with anchor + tapKeySig) so vsizes are exact.
    function treePsbt(fill: number): { txid: string; psbt: string } {
        const tx = new Transaction({ allowUnknownOutputs: true, allowLegacyWitnessUtxo: true });
        tx.addInput({
            txid: new Uint8Array(32).fill(fill),
            index: 0,
            witnessUtxo: { script: pay.script, amount: 10_000n },
        });
        tx.addOutput({ script: vtxoScript.pkScript, amount: 10_000n });
        tx.addOutput(P2A);
        tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(7) });
        return { txid: tx.id, psbt: base64.encode(tx.toPSBT()) };
    }

    const shared = treePsbt(1);
    const leaf = treePsbt(2);
    const vtxoValue = opts?.vtxoValue ?? 50_000;

    const chains = {
        [leaf.txid]: [
            {
                txid: leaf.txid,
                type: ChainTxType.TREE,
                expiresAt: "1725000000",
                spends: [shared.txid],
            },
            {
                txid: shared.txid,
                type: ChainTxType.TREE,
                expiresAt: "1725001000",
                spends: [COMMIT],
            },
            { txid: COMMIT, type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
        ],
    };
    const psbts = { [shared.txid]: shared.psbt, [leaf.txid]: leaf.psbt };

    const vtxo = {
        txid: leaf.txid,
        vout: 0,
        value: vtxoValue,
        tapTree: vtxoScript.encode(),
    };

    const coins = opts?.coins ?? [];
    const wallet = {
        identity,
        network,
        indexerProvider: fakeIndexer(chains, psbts),
        onchainProvider: fakeOnchain(new Set([COMMIT])),
        contractRepository: new InMemoryContractRepository(),
        getVtxos: async () => [vtxo],
    };
    const onchainWallet = {
        address: pay.address!,
        network,
        onchainP2TR: pay,
        getCoins: async () => coins,
        provider: fakeOnchain(new Set([COMMIT])),
    };

    const exitOpts = {
        wallet,
        onchainWallet,
        sweepAddress: pay.address!,
        feeRate: 2,
    } as unknown as ExitOptions;

    return { exitOpts, vtxo };
}

describe("estimate", () => {
    it("quotes txCount, fees, funding and shortfall for a 2-step chain", async () => {
        const { exitOpts } = await estimateFixture();
        const quote = await estimate(exitOpts);

        // splitter + 2 package steps (2 txs each) + 1 sweep
        expect(quote.totals.txCount).toBe(1 + 2 * 2 + 1);
        expect(quote.feeRate).toBe(2);

        const sweepFees = quote.vtxos.reduce((s, v) => s + (v.sweepFee ?? 0), 0);
        // fundingRequired = totalFee - sweepFees + dust floor per step
        expect(quote.totals.fundingRequiredSats).toBe(
            quote.totals.totalFeeSats - sweepFees + 2 * CHILD_OUTPUT_DUST,
        );
        // empty onchain wallet: shortfall == full requirement
        expect(quote.currentBalanceSats).toBe(0);
        expect(quote.shortfallSats).toBe(quote.totals.fundingRequiredSats);
        // validUntil = min expiry across pending nodes
        expect(quote.validUntil).toBe(1725000000);
        // vtxo recovered = value - sweepFee
        expect(quote.totals.recoveredSats).toBe(50_000 - sweepFees);
    });

    it("reports zero shortfall when the wallet holds enough confirmed coins", async () => {
        const { exitOpts } = await estimateFixture({
            coins: [
                { txid: "77".repeat(32), vout: 0, value: 1_000_000, status: { confirmed: true } },
            ],
        });
        const quote = await estimate(exitOpts);
        expect(quote.currentBalanceSats).toBe(1_000_000);
        expect(quote.shortfallSats).toBe(0);
    });

    it("skips uneconomic vtxos with a reason", async () => {
        const { exitOpts } = await estimateFixture({ vtxoValue: 500 });
        const quote = await estimate(exitOpts);
        expect(quote.vtxos).toHaveLength(1);
        expect(quote.vtxos[0].skipped).toMatch(/uneconomic/);
        // no sweep -> package still counts unroll steps but recovers nothing
        expect(quote.totals.recoveredSats).toBe(0);
    });

    it("resolves explicit outpoints via indexer + contract row, not wallet.getVtxos", async () => {
        const { exitOpts, vtxo } = await estimateFixture();
        const opts = exitOpts as unknown as {
            wallet: {
                getVtxos: () => Promise<never>;
                indexerProvider: { getVtxos?: unknown };
                contractRepository: InMemoryContractRepository;
            };
            vtxos?: { txid: string; vout: number }[];
        };

        // wallet listing must NOT be touched on the explicit path
        opts.wallet.getVtxos = async () => {
            throw new Error("wallet.getVtxos must not be called");
        };

        // indexer serves the outpoint with its locking script — which must be
        // the script the contract params derive (as it is for real rows)
        const owner = (await identity.xOnlyPublicKey())!;
        const server = schnorr.getPublicKey(new Uint8Array(32).fill(0xbb));
        const { DefaultVtxo } = await import("../src/script/default");
        const defaultScript = new DefaultVtxo.Script({
            pubKey: owner,
            serverPubKey: server,
            csvTimelock: timelock,
        });
        const scriptHex = hex.encode(defaultScript.pkScript);
        opts.wallet.indexerProvider.getVtxos = async (o: {
            outpoints: { txid: string; vout: number }[];
        }) => ({
            vtxos: o.outpoints.map((op) => ({
                txid: op.txid,
                vout: op.vout,
                value: 50_000,
                script: scriptHex,
                isSpent: false,
            })),
        });

        // the registered contract row provides the tap tree via its handler
        const { DefaultContractHandler } = await import("../src/contracts/handlers");
        await opts.wallet.contractRepository.saveContract({
            type: "default",
            params: DefaultContractHandler.serializeParams({
                pubKey: owner,
                serverPubKey: server,
                csvTimelock: timelock,
            }),
            script: scriptHex,
            address: "unused",
            state: "active",
            createdAt: 1,
        });

        opts.vtxos = [{ txid: vtxo.txid, vout: 0 }];
        const quote = await estimate(exitOpts);
        const active = quote.vtxos.filter((v) => !v.skipped);
        expect(active).toHaveLength(1);
        expect(active[0].path).toBe("default:unilateral");
    });

    it("rejects explicit outpoints whose script has no registered contract", async () => {
        const { exitOpts, vtxo } = await estimateFixture();
        const opts = exitOpts as unknown as {
            wallet: { indexerProvider: Record<string, unknown> };
            vtxos?: { txid: string; vout: number }[];
        };
        opts.wallet.indexerProvider.getVtxos = async () => ({
            vtxos: [
                {
                    txid: vtxo.txid,
                    vout: 0,
                    value: 50_000,
                    script: "beef".repeat(8),
                    isSpent: false,
                },
            ],
        });
        opts.vtxos = [{ txid: vtxo.txid, vout: 0 }];
        await expect(estimate(exitOpts)).rejects.toThrow(/no contract registered/);
    });
});
