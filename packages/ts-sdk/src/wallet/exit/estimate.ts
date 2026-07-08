import { base64, hex } from "@scure/base";
import type { ExtendedVirtualCoin, Outpoint } from "..";
import { NetworkName } from "../../networks";
import { VtxoScript } from "../../script/base";
import { sequenceToTimelock } from "../../utils/timelock";
import { Transaction } from "../../utils/transaction";
import { TxWeightEstimator } from "../../utils/txSizeEstimator";
import { OnchainWallet } from "../onchain";
import type { Wallet } from "../wallet";
import { buildExitDag, DagNode } from "./chain";
import { finalizeVirtualTx } from "./finalizeVirtualTx";
import { ExitPathError, ResolvedExitPath, resolveUnilateralPath } from "./path";
import { sweepFeeFor } from "./sweep";
import { ExitDelay, ExitQuote, ExitTotals, ExitVtxoInfo } from "./types";

/** Dust floor granted to every fee child's change output. */
export const CHILD_OUTPUT_DUST = 546;

export type ExitOptions = {
    /** Wallet owning the VTXOs: identity (signing) + indexer + onchain provider. */
    wallet: Wallet;
    /** Fee funding source and change/funding address. Must share the wallet identity. */
    onchainWallet: OnchainWallet;
    /** Destination for the exited funds. */
    sweepAddress: string;
    /** sat/vB; defaults to the onchain provider estimate, floored at MIN_FEE_RATE. */
    feeRate?: number;
    /** Defaults to all spendable VTXOs. */
    vtxos?: Outpoint[];
    /**
     * Network label embedded in the package (executor sanity check).
     * Resolved from the wallet's network when omitted — exact for
     * "bitcoin" and "regtest"; the tb-family defaults to "testnet", so
     * pass this explicitly on signet/mutinynet.
     */
    networkName?: NetworkName;
};

export function stepFundingAmount(stepFee: number): number {
    return stepFee + CHILD_OUTPUT_DUST;
}

export function resolveNetworkName(opts: ExitOptions): NetworkName {
    if (opts.networkName) return opts.networkName;
    const { bech32 } = opts.wallet.network;
    if (bech32 === "bc") return "bitcoin";
    if (bech32 === "bcrt") return "regtest";
    return "testnet";
}

export async function resolveFeeRate(opts: ExitOptions): Promise<number> {
    if (opts.feeRate) return Math.ceil(opts.feeRate);
    const feeRate = await opts.wallet.onchainProvider.getFeeRate();
    if (!feeRate || feeRate < OnchainWallet.MIN_FEE_RATE) return OnchainWallet.MIN_FEE_RATE;
    return Math.ceil(feeRate);
}

export async function selectExitVtxos(opts: ExitOptions): Promise<ExtendedVirtualCoin[]> {
    const all = await opts.wallet.getVtxos();
    if (!opts.vtxos) return all;
    const wanted = new Set(opts.vtxos.map((o) => `${o.txid}:${o.vout}`));
    return all.filter((v) => wanted.has(`${v.txid}:${v.vout}`));
}

export type ExitStepPlan = {
    node: DagNode;
    parent: Transaction;
    stepFee: number;
    funding: number;
};

export type ExitSweepPlan = {
    vtxo: ExtendedVirtualCoin;
    resolved: ResolvedExitPath;
    sweepFee: number;
    delay: ExitDelay;
};

export type ExitLayout = {
    vtxos: ExtendedVirtualCoin[];
    dag: DagNode[];
    steps: ExitStepPlan[];
    sweeps: ExitSweepPlan[];
    infos: ExitVtxoInfo[];
    totals: ExitTotals;
    splitterFee: number;
    validUntil?: number;
    balance: number;
    coins: Awaited<ReturnType<OnchainWallet["getCoins"]>>;
};

/** Shared step/sweep/splitter math used by `estimate` and `prepare`. */
export async function computeExitLayout(opts: ExitOptions, feeRate: number): Promise<ExitLayout> {
    const { wallet, onchainWallet } = opts;
    const vtxos = await selectExitVtxos(opts);
    if (vtxos.length === 0) throw new Error("no vtxos to exit");

    const dag = await buildExitDag({
        vtxos,
        indexer: wallet.indexerProvider,
        onchain: wallet.onchainProvider,
    });

    // Fetch pending virtual txs and key their PSBTs by unsigned txid (the
    // id is witness-independent, so it is stable pre-finalization).
    const pendingNodes = dag.filter((n) => !n.confirmed);
    const psbts = new Map<string, string>();
    if (pendingNodes.length > 0) {
        const res = await wallet.indexerProvider.getVirtualTxs(pendingNodes.map((n) => n.txid));
        for (const psbt of res.txs) {
            psbts.set(Transaction.fromPSBT(base64.decode(psbt)).id, psbt);
        }
    }

    const childVsize = Number(
        TxWeightEstimator.create()
            .addP2AInput()
            .addKeySpendInput(true)
            .addOutputAddress(onchainWallet.address, wallet.network)
            .vsize().value,
    );

    const steps: ExitStepPlan[] = pendingNodes.map((node) => {
        const psbt = psbts.get(node.txid);
        if (!psbt) {
            throw new Error(`indexer did not return virtual tx ${node.txid}`);
        }
        const parent = finalizeVirtualTx(node.type, psbt);
        const stepFee = Math.ceil(feeRate * (parent.vsize + childVsize));
        return { node, parent, stepFee, funding: stepFundingAmount(stepFee) };
    });

    // Per-VTXO sweep resolution.
    const walletPubKeyHex = hex.encode((await wallet.identity.xOnlyPublicKey())!);
    const infos: ExitVtxoInfo[] = [];
    const sweeps: ExitSweepPlan[] = [];
    for (const vtxo of vtxos) {
        const outpoint = `${vtxo.txid}:${vtxo.vout}`;
        try {
            const resolved = await resolveUnilateralPath({
                vtxo,
                scriptHex: hex.encode(VtxoScript.decode(vtxo.tapTree).pkScript),
                contractRepository: wallet.contractRepository,
                walletPubKeyHex,
                currentTime: Date.now(),
            });
            const sweepFee = sweepFeeFor(
                resolved.selection,
                opts.sweepAddress,
                wallet.network,
                feeRate,
            );
            if (vtxo.value - sweepFee < CHILD_OUTPUT_DUST) {
                infos.push({
                    outpoint,
                    value: vtxo.value,
                    skipped: `uneconomic: value ${vtxo.value} <= sweep fee + dust`,
                });
                continue;
            }
            const t = sequenceToTimelock(resolved.selection.sequence!);
            const delay: ExitDelay = { type: t.type, value: Number(t.value) };
            infos.push({ outpoint, value: vtxo.value, sweepFee, path: resolved.label, delay });
            sweeps.push({ vtxo, resolved, sweepFee, delay });
        } catch (e) {
            if (e instanceof ExitPathError) {
                infos.push({ outpoint, value: vtxo.value, skipped: e.message });
                continue;
            }
            throw e;
        }
    }

    // Splitter sizing. Input count is exact once the balance covers the
    // requirement; before funding arrives it assumes one (documented
    // approximation, re-derived at prepare time).
    const coins = (await onchainWallet.getCoins()).filter((c) => c.status.confirmed);
    const balance = coins.reduce((sum, c) => sum + c.value, 0);
    const fundingTotal = steps.reduce((sum, s) => sum + s.funding, 0);
    let splitterFee = 0;
    if (steps.length > 0) {
        const inputCount = Math.max(1, coins.length);
        const est = TxWeightEstimator.create();
        for (let i = 0; i < inputCount; i++) est.addKeySpendInput(true);
        for (let i = 0; i < steps.length + 1; i++) {
            est.addOutputAddress(onchainWallet.address, wallet.network);
        }
        splitterFee = Number(est.vsize().fee(BigInt(feeRate)));
    }

    const totals: ExitTotals = {
        txCount: (steps.length > 0 ? 1 : 0) + steps.length * 2 + sweeps.length,
        totalFeeSats:
            splitterFee +
            steps.reduce((s, x) => s + x.stepFee, 0) +
            sweeps.reduce((s, x) => s + x.sweepFee, 0),
        fundingRequiredSats: splitterFee + fundingTotal,
        recoveredSats: sweeps.reduce((s, x) => s + (x.vtxo.value - x.sweepFee), 0),
    };

    const expiries = pendingNodes
        .map((n) => n.expiresAt)
        .filter((x): x is number => x !== undefined);
    const validUntil = expiries.length > 0 ? Math.min(...expiries) : undefined;

    return {
        vtxos,
        dag,
        steps,
        sweeps,
        infos,
        totals,
        splitterFee,
        validUntil,
        balance,
        coins,
    };
}

/**
 * Quote a unilateral exit: how many transactions, how many sats of fees,
 * and how much must be deposited to the funding address. Requires no
 * onchain funds and signs nothing.
 */
export async function estimate(opts: ExitOptions): Promise<ExitQuote> {
    const feeRate = await resolveFeeRate(opts);
    const layout = await computeExitLayout(opts, feeRate);
    return {
        feeRate,
        fundingAddress: opts.onchainWallet.address,
        currentBalanceSats: layout.balance,
        shortfallSats: Math.max(0, layout.totals.fundingRequiredSats - layout.balance),
        validUntil: layout.validUntil,
        totals: layout.totals,
        vtxos: layout.infos,
    };
}
