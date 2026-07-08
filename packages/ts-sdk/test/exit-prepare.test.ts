import { base64, hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { SingleKey } from "../src/identity/singleKey";
import { getNetwork } from "../src/networks";
import { ChainTxType } from "../src/providers/indexer";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { VtxoScript } from "../src/script/base";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { timelockToSequence } from "../src/utils/timelock";
import { P2A } from "../src/utils/anchor";
import { Transaction } from "../src/utils/transaction";
import { CHILD_OUTPUT_DUST, estimate } from "../src/wallet/exit/estimate";
import type { ExitOptions } from "../src/wallet/exit/estimate";
import { prepare } from "../src/wallet/exit/prepare";
import { PackageStep, SweepStep } from "../src/wallet/exit/types";

const COMMIT = "c0".repeat(32);
const identity = SingleKey.fromHex("aa".repeat(32));
const network = getNetwork("regtest");
const timelock = { type: "blocks", value: 144n } as const;

async function fixture(opts?: { coins?: { value: number }[] }) {
    const owner = (await identity.xOnlyPublicKey())!;
    const exit = CSVMultisigTapscript.encode({ pubkeys: [owner], timelock });
    const vtxoScript = new VtxoScript([exit.script]);
    const pay = p2tr(owner, undefined, network);

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
    const psbts: Record<string, string> = {
        [shared.txid]: shared.psbt,
        [leaf.txid]: leaf.psbt,
    };

    const vtxo = { txid: leaf.txid, vout: 0, value: 50_000, tapTree: vtxoScript.encode() };
    const coins = (opts?.coins ?? [{ value: 100_000 }]).map((c, i) => ({
        txid: "77".repeat(31) + i.toString(16).padStart(2, "0"),
        vout: 0,
        value: c.value,
        status: { confirmed: true },
    }));

    const broadcasts: string[][] = [];
    const onchainProvider = {
        getTxStatus: async (txid: string) => {
            if (txid !== COMMIT) throw new Error("not found");
            return { confirmed: true, blockHeight: 100, blockTime: 1_000 };
        },
        getFeeRate: async () => 2,
        broadcastTransaction: async (...txs: string[]) => {
            broadcasts.push(txs);
            return "ok";
        },
    } as never;

    const wallet = {
        identity,
        network,
        indexerProvider: {
            getVtxoChain: async ({ txid }: { txid: string }) => ({
                chain: chains[txid as keyof typeof chains],
            }),
            getVirtualTxs: async (txids: string[]) => ({
                txs: txids.map((t) => psbts[t]).filter((x): x is string => !!x),
            }),
        },
        onchainProvider,
        contractRepository: new InMemoryContractRepository(),
        getVtxos: async () => [vtxo],
    };
    const onchainWallet = {
        address: pay.address!,
        network,
        onchainP2TR: pay,
        getCoins: async () => coins,
        provider: onchainProvider,
    };

    const exitOpts = {
        wallet,
        onchainWallet,
        sweepAddress: pay.address!,
        feeRate: 2,
    } as unknown as ExitOptions;

    return { exitOpts, vtxo, broadcasts, leaf, shared };
}

describe("prepare", () => {
    it("builds a fully pre-signed package with txid-chained fee children", async () => {
        const { exitOpts, vtxo, broadcasts, leaf } = await fixture();
        const pkg = await prepare(exitOpts);

        expect(pkg.version).toBe(1);
        expect(pkg.network).toBe("regtest");

        // step 0: the splitter, broadcast by prepare()
        const splitterStep = pkg.steps[0];
        if (splitterStep.kind !== "broadcast") throw new Error("expected broadcast step");
        expect(broadcasts).toHaveLength(1);
        expect(broadcasts[0]).toEqual([splitterStep.hex]);
        const splitter = Transaction.fromRaw(hex.decode(splitterStep.hex));
        expect(splitter.id).toBe(splitterStep.txid);

        // two package steps in topological order, children spend splitter outputs
        const pkgSteps = pkg.steps.filter((s): s is PackageStep => s.kind === "package");
        expect(pkgSteps).toHaveLength(2);
        pkgSteps.forEach((step, k) => {
            const child = Transaction.fromRaw(hex.decode(step.childHex), {
                allowUnknownInputs: true,
            });
            expect(child.id).toBe(step.childTxid);
            expect(child.inputsLength).toBe(2);
            const funding = child.getInput(1);
            expect(hex.encode(funding.txid!)).toBe(splitterStep.txid);
            expect(funding.index).toBe(k);
            // funding output = childFee + dust, so change is exactly dust
            expect(child.getOutput(0).amount).toBe(BigInt(CHILD_OUTPUT_DUST));
            // splitter funds it with more than dust
            expect(splitter.getOutput(k).amount!).toBeGreaterThan(BigInt(CHILD_OUTPUT_DUST));
        });

        // sweep step: depends on the vtxo-creating leaf tx with the CSV delay
        const sweeps = pkg.steps.filter((s): s is SweepStep => s.kind === "sweep");
        expect(sweeps).toHaveLength(1);
        expect(sweeps[0].vtxo).toBe(`${vtxo.txid}:0`);
        expect(sweeps[0].dependsOnTxid).toBe(leaf.txid);
        expect(sweeps[0].delay).toEqual({ type: "blocks", value: 144 });
        const sweepTx = Transaction.fromRaw(hex.decode(sweeps[0].hex), {
            allowUnknownInputs: true,
        });
        expect(sweepTx.getInput(0).sequence).toBe(timelockToSequence(timelock));

        // totals: consistent with estimate() over identical fixtures
        const quote = await estimate((await fixture()).exitOpts);
        expect(pkg.totals).toEqual(quote.totals);
        expect(pkg.validUntil).toBe(1725000000);
    });

    it("rejects with the exact shortfall message when underfunded", async () => {
        const { exitOpts } = await fixture({ coins: [] });
        await expect(prepare(exitOpts)).rejects.toThrow(
            /insufficient confirmed onchain funds: need \d+ sats, have 0/,
        );
    });
});
