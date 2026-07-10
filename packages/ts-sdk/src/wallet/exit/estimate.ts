import { base64, hex } from "@scure/base";
import type { Outpoint, VirtualCoin } from "..";
import { contractHandlers } from "../../contracts/handlers";
import { NetworkName } from "../../networks";
import { VtxoScript } from "../../script/base";
import { sequenceToTimelock } from "../../utils/timelock";
import { Transaction } from "../../utils/transaction";
import { TxWeightEstimator } from "../../utils/txSizeEstimator";
import { isOperatorUnreachable } from "../../utils/operatorReachability";
import { OnchainWallet } from "../onchain";
import type { Wallet } from "../wallet";
import { buildExitDag, DagNode, topoSortByDeps } from "./chain";
import { createExitChainResolver } from "./resolver";
import { finalizeVirtualTx } from "./finalizeVirtualTx";
import { ExitPathError, ResolvedExitPath, resolveUnilateralPath } from "./path";
import { sweepFeeFor } from "./sweep";
import { ExitDelay, ExitMode, ExitQuote, ExitTotals, ExitVtxoInfo } from "./types";

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
     * Fee-funding strategy (default `"funded"`):
     * - `"funded"`: broadcast a splitter at prepare time and pre-sign the
     *   fee children — the package executes fully keyless.
     * - `"graph"`: transport only the tx graph + sweeps; the executor funds
     *   and signs the CPFP bumps at execution time ("send funds to this
     *   address and we proceed"). No splitter, no `onchainWallet` funds used.
     */
    mode?: ExitMode;
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

export function resolveMode(opts: ExitOptions): ExitMode {
    return opts.mode ?? "funded";
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

/** The VTXO shape the exit flow needs — a coin plus its taproot tree. */
export type ExitVtxo = Pick<VirtualCoin, "txid" | "vout" | "value"> & { tapTree: Uint8Array };

/**
 * Resolve the raw VTXO rows for an explicit set of exit outpoints.
 *
 * Tries the indexer first (authoritative, and reaches contract VTXOs the wallet
 * does not itself track). On a network-level operator failure it degrades to the
 * wallet's offline-first `getVtxos()` (backed by the local repository — see the
 * operator-offline resilience work), filtered to the requested outpoints, so an
 * explicit-outpoint exit can be built with the indexer down. Non-network errors
 * (e.g. a malformed response) propagate.
 *
 * Offline caveat: only VTXOs present in the local cache are returned — an
 * untracked contract VTXO cannot be exited via this path while the indexer is
 * unreachable.
 */
export async function resolveExplicitOutpointVtxos(
    wallet: Wallet,
    outpoints: Outpoint[],
): Promise<Pick<VirtualCoin, "txid" | "vout" | "value" | "script" | "isSpent">[]> {
    try {
        const res = await wallet.indexerProvider.getVtxos({ outpoints });
        return res.vtxos;
    } catch (err) {
        if (!isOperatorUnreachable(err)) {
            throw err;
        }
        const wanted = new Set(outpoints.map((o) => `${o.txid}:${o.vout}`));
        const cached = await wallet.getVtxos();
        return cached.filter((v) => wanted.has(`${v.txid}:${v.vout}`));
    }
}

export async function selectExitVtxos(opts: ExitOptions): Promise<ExitVtxo[]> {
    if (!opts.vtxos) return opts.wallet.getVtxos();

    // Explicit outpoints are resolved from the indexer plus the registered
    // contract row (tap tree derived via the contract handler). This
    // deliberately bypasses the wallet's own VTXO listing, so contract
    // VTXOs the wallet does not track are exitable too. With the indexer
    // unreachable, resolveExplicitOutpointVtxos degrades to the local cache.
    const resolved = await resolveExplicitOutpointVtxos(opts.wallet, opts.vtxos);
    const tapTrees = new Map<string, Uint8Array>();
    const out: ExitVtxo[] = [];
    for (const vtxo of resolved) {
        if (vtxo.isSpent) continue;
        let tapTree = tapTrees.get(vtxo.script);
        if (!tapTree) {
            const [contract] = await opts.wallet.contractRepository.getContracts({
                script: vtxo.script,
            });
            if (!contract) {
                throw new Error(
                    `no contract registered for vtxo script ${vtxo.script} — register the contract before exiting`,
                );
            }
            const handler = contractHandlers.get(contract.type);
            if (!handler) {
                throw new Error(`no contract handler registered for type '${contract.type}'`);
            }
            tapTree = handler.createScript(contract.params).encode();
            tapTrees.set(vtxo.script, tapTree);
        }
        out.push({ txid: vtxo.txid, vout: vtxo.vout, value: vtxo.value, tapTree });
    }
    return out;
}

export type ExitStepPlan = {
    node: DagNode;
    parent: Transaction;
    stepFee: number;
    funding: number;
};

export type ExitSweepPlan = {
    vtxo: ExitVtxo;
    resolved: ResolvedExitPath;
    sweepFee: number;
    delay: ExitDelay;
};

export type ExitLayout = {
    vtxos: ExitVtxo[];
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

    // Resolve exit chain data local-first (repo → indexer), read-through cached.
    // With no virtualTxRepository this is exactly the indexer-only path.
    const resolver = createExitChainResolver({
        indexer: wallet.indexerProvider,
        repository: wallet.virtualTxRepository,
        extraSources: wallet.exitDataCapture?.sources,
    });
    const dag = await buildExitDag({
        vtxos,
        chain: resolver,
        onchain: wallet.onchainProvider,
    });

    // Fetch pending virtual txs and key their PSBTs by unsigned txid (the
    // id is witness-independent, so it is stable pre-finalization).
    const pendingNodes = dag.filter((n) => !n.confirmed);
    const psbts = new Map<string, string>();
    if (pendingNodes.length > 0) {
        const txs = await resolver.getVirtualTxs(pendingNodes.map((n) => n.txid));
        for (const psbt of txs) {
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

    const rawSteps: ExitStepPlan[] = pendingNodes.map((node) => {
        const psbt = psbts.get(node.txid);
        if (!psbt) {
            throw new Error(`indexer did not return virtual tx ${node.txid}`);
        }
        const parent = finalizeVirtualTx(node.type, psbt);
        const stepFee = Math.ceil(feeRate * (parent.vsize + childVsize));
        return { node, parent, stepFee, funding: stepFundingAmount(stepFee) };
    });
    // Re-sort by the finalized txs' real inputs. buildExitDag orders by the
    // indexer's logical vtxo chain; for offchain send chains the physical
    // inputs diverge (an ARK tx spends a checkpoint output, not its logical
    // parent), and the sequential executor deadlocks unless a step's inputs
    // are already onchain when it is reached.
    const parentInputTxids = (tx: Transaction): string[] => {
        const ids: string[] = [];
        for (let i = 0; i < tx.inputsLength; i++) {
            const txid = tx.getInput(i).txid;
            if (txid) ids.push(hex.encode(txid));
        }
        return ids;
    };
    const steps = topoSortByDeps(
        rawSteps,
        (s) => s.parent.id,
        (s) => parentInputTxids(s.parent),
    );

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

    // Splitter sizing. Two passes break the fee↔input-count circularity:
    // when the wallet must be topped up, the caller's deposit is an
    // ADDITIONAL prepare-time input the current coin set does not yet
    // include. Pricing pass 1 with the existing coins and, if that still
    // leaves a shortfall, re-pricing with one extra input ensures the quote
    // covers the deposit UTXO itself — otherwise depositing exactly the
    // quoted shortfall would leave prepare() one input short.
    const coins = (await onchainWallet.getCoins()).filter((c) => c.status.confirmed);
    const balance = coins.reduce((sum, c) => sum + c.value, 0);
    const fundingTotal = steps.reduce((sum, s) => sum + s.funding, 0);
    const splitterFeeFor = (inputCount: number): number => {
        if (steps.length === 0) return 0;
        const est = TxWeightEstimator.create();
        for (let i = 0; i < inputCount; i++) est.addKeySpendInput(true);
        for (let i = 0; i < steps.length + 1; i++) {
            est.addOutputAddress(onchainWallet.address, wallet.network);
        }
        return Number(est.vsize().fee(BigInt(feeRate)));
    };
    const graph = resolveMode(opts) === "graph";
    let splitterFee = 0;
    if (!graph) {
        splitterFee = splitterFeeFor(Math.max(1, coins.length));
        if (steps.length > 0 && balance < fundingTotal + splitterFee) {
            // a deposit is required — count it as a further input
            splitterFee = splitterFeeFor(coins.length + 1);
        }
    }

    const stepFees = steps.reduce((s, x) => s + x.stepFee, 0);
    const sweepFees = sweeps.reduce((s, x) => s + x.sweepFee, 0);
    const totals: ExitTotals = {
        // graph: each unroll step is parent + a live-built child (2 txs), no
        // splitter. funded: + 1 splitter tx and pre-signed children.
        txCount: (graph ? 0 : steps.length > 0 ? 1 : 0) + steps.length * 2 + sweeps.length,
        totalFeeSats: splitterFee + stepFees + sweepFees,
        // graph funding is what the executor sends to its own fee address:
        // just the CPFP fees (change recycles); funded also locks the
        // per-child dust into the splitter.
        fundingRequiredSats: graph ? stepFees : splitterFee + fundingTotal,
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

    // In graph mode the executor funds from its own (e.g. ephemeral) fee
    // wallet, so the preparer's onchain balance is irrelevant: report the
    // whole fee budget as the amount to send, with no pre-known address.
    if (resolveMode(opts) === "graph") {
        return {
            feeRate,
            fundingAddress: "",
            currentBalanceSats: 0,
            shortfallSats: layout.totals.fundingRequiredSats,
            validUntil: layout.validUntil,
            totals: layout.totals,
            vtxos: layout.infos,
        };
    }

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
