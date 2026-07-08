import { hex } from "@scure/base";
import { VtxoScript } from "../../script/base";
import { buildAnchorChild } from "../../utils/anchor";
import { Transaction } from "../../utils/transaction";
import { TxWeightEstimator } from "../../utils/txSizeEstimator";
import { selectCoins } from "../onchain";
import { DUST_AMOUNT } from "../utils";
import { computeExitLayout, ExitOptions, resolveFeeRate, resolveNetworkName } from "./estimate";
import { buildSignedSweep } from "./sweep";
import { BroadcastStep, ExitPackage, PackageStep, SweepStep } from "./types";

/**
 * Build the fully pre-signed unilateral exit package.
 *
 * Signs every transaction needed to land the selected VTXOs onchain and
 * **broadcasts the funding splitter** as a side effect — reserving the fee
 * budget so later wallet activity cannot invalidate the package. The
 * returned package is keyless to execute: hand it to
 * `UnilateralExit.Executor` (or any Esplora-speaking watchtower).
 */
export async function prepare(opts: ExitOptions): Promise<ExitPackage> {
    const { wallet, onchainWallet } = opts;
    const feeRate = await resolveFeeRate(opts);

    const walletKey = (await wallet.identity.xOnlyPublicKey())!;
    if (hex.encode(onchainWallet.onchainP2TR.tapInternalKey) !== hex.encode(walletKey)) {
        throw new Error("onchainWallet must share the wallet identity");
    }

    const layout = await computeExitLayout(opts, feeRate);

    // 1. Sweeps first — a VTXO whose sweep cannot be signed is skipped
    //    before we commit to a splitter layout.
    const sweepSteps: SweepStep[] = [];
    const activeOutpoints = new Set<string>();
    for (const sweep of layout.sweeps) {
        const outpoint = `${sweep.vtxo.txid}:${sweep.vtxo.vout}`;
        try {
            const { tx } = await buildSignedSweep({
                vtxo: {
                    txid: sweep.vtxo.txid,
                    vout: sweep.vtxo.vout,
                    value: sweep.vtxo.value,
                    pkScript: VtxoScript.decode(sweep.vtxo.tapTree).pkScript,
                },
                path: sweep.resolved.selection,
                outputAddress: opts.sweepAddress,
                feeRate,
                network: wallet.network,
                identity: wallet.identity,
            });
            activeOutpoints.add(outpoint);
            sweepSteps.push({
                kind: "sweep",
                vtxo: outpoint,
                txid: tx.id,
                hex: tx.hex,
                dependsOnTxid: sweep.vtxo.txid,
                delay: sweep.delay,
            });
        } catch (e) {
            const info = layout.infos.find((i) => i.outpoint === outpoint)!;
            info.skipped = e instanceof Error ? e.message : String(e);
            delete info.sweepFee;
            delete info.path;
            delete info.delay;
        }
    }

    // Drop unroll steps that serve only skipped VTXOs.
    const steps = layout.steps.filter((s) => s.node.forVtxos.some((v) => activeOutpoints.has(v)));
    if (steps.length === 0 && sweepSteps.length === 0) {
        throw new Error("no exitable vtxos (all skipped)");
    }

    // 2. Splitter: iterative fee + coin selection (fee depends on input count).
    const packageSteps: PackageStep[] = [];
    let broadcastStep: BroadcastStep | undefined;
    let splitterFee = 0;
    if (steps.length > 0) {
        const fundingTotal = steps.reduce((sum, s) => sum + s.funding, 0);
        let selected: ReturnType<typeof selectCoins> = { inputs: [], changeAmount: 0n };
        for (let i = 0; i < 10; i++) {
            const target = fundingTotal + splitterFee;
            try {
                selected = selectCoins(layout.coins, target);
            } catch {
                throw new Error(
                    `insufficient confirmed onchain funds: need ${target} sats, have ${layout.balance} ` +
                        `(deposit the shortfall to ${onchainWallet.address})`,
                );
            }
            const est = TxWeightEstimator.create();
            for (const _ of selected.inputs) est.addKeySpendInput(true);
            for (const _ of steps) est.addOutputAddress(onchainWallet.address, wallet.network);
            if (selected.changeAmount >= BigInt(DUST_AMOUNT)) {
                est.addOutputAddress(onchainWallet.address, wallet.network);
            }
            const newFee = Number(est.vsize().fee(BigInt(feeRate)));
            if (newFee <= splitterFee) break;
            splitterFee = newFee;
        }

        const splitter = new Transaction({ version: 2 });
        for (const coin of selected.inputs) {
            splitter.addInput({
                txid: coin.txid,
                index: coin.vout,
                witnessUtxo: {
                    script: onchainWallet.onchainP2TR.script,
                    amount: BigInt(coin.value),
                },
                tapInternalKey: onchainWallet.onchainP2TR.tapInternalKey,
            });
        }
        for (const step of steps) {
            splitter.addOutputAddress(onchainWallet.address, BigInt(step.funding), wallet.network);
        }
        const inputSum = selected.inputs.reduce((s, c) => s + c.value, 0);
        const change = BigInt(inputSum - fundingTotal - splitterFee);
        if (change >= BigInt(DUST_AMOUNT)) {
            splitter.addOutputAddress(onchainWallet.address, change, wallet.network);
        } else if (change > 0n) {
            // sub-dust remainder is absorbed into the fee
            splitterFee += Number(change);
        }
        const signedSplitter = await wallet.identity.sign(splitter);
        signedSplitter.finalize();

        // 3. Fee children — each spends [P2A of its parent, splitter output k].
        for (let k = 0; k < steps.length; k++) {
            const step = steps[k];
            const { child } = buildAnchorChild({
                parent: step.parent,
                feeRate,
                fundingCoins: [{ txid: signedSplitter.id, vout: k, value: step.funding }],
                changeAddress: onchainWallet.address,
                changeScript: onchainWallet.onchainP2TR.script,
                tapInternalKey: onchainWallet.onchainP2TR.tapInternalKey,
                network: wallet.network,
            });
            const signedChild = await wallet.identity.sign(child);
            for (let i = 1; i < signedChild.inputsLength; i++) {
                signedChild.finalizeIdx(i);
            }
            packageSteps.push({
                kind: "package",
                parentTxid: step.parent.id,
                parentHex: step.parent.hex,
                childTxid: signedChild.id,
                childHex: signedChild.hex,
                forVtxos: step.node.forVtxos.filter((v) => activeOutpoints.has(v)),
            });
        }

        broadcastStep = { kind: "broadcast", txid: signedSplitter.id, hex: signedSplitter.hex };
        await onchainWallet.provider.broadcastTransaction(signedSplitter.hex);
    }

    // 4. Totals reflect what actually made it into the package.
    const stepFees = steps.reduce((s, x) => s + x.stepFee, 0);
    const activeInfos = layout.infos.filter((i) => !i.skipped);
    const sweepFees = activeInfos.reduce((s, i) => s + (i.sweepFee ?? 0), 0);
    const recovered = activeInfos.reduce((s, i) => s + (i.value ?? 0) - (i.sweepFee ?? 0), 0);
    const fundingRequired = splitterFee + steps.reduce((s, x) => s + x.funding, 0);

    return {
        version: 1,
        network: resolveNetworkName(opts),
        createdAt: Math.floor(Date.now() / 1000),
        validUntil: layout.validUntil,
        feeRate,
        sweepAddress: opts.sweepAddress,
        totals: {
            txCount: (broadcastStep ? 1 : 0) + packageSteps.length * 2 + sweepSteps.length,
            totalFeeSats: splitterFee + stepFees + sweepFees,
            fundingRequiredSats: fundingRequired,
            recoveredSats: recovered,
        },
        vtxos: layout.infos,
        steps: [...(broadcastStep ? [broadcastStep] : []), ...packageSteps, ...sweepSteps],
    };
}
