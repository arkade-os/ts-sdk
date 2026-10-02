import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { Extension } from "../extension";
import type { ArkProvider } from "../providers/ark";
import { OnchainCosignRejectedError, OnchainCosignUnsupportedError } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { OnchainProvider } from "../providers/onchain";
import { Transaction } from "../utils/transaction";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import { ConditionWitness, VtxoTaprootTree, setArkPsbtField } from "../utils/unknownFields";
import type { VirtualCoin } from "../wallet";
import type { PathSelection } from "./types";

export const DEFAULT_COSIGN_MARGIN_BLOCKS = 144;

export class OnchainCosignPreflightError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OnchainCosignPreflightError";
    }
}

export type OwnedOnchainInput = {
    index: number;
    coin: Pick<VirtualCoin, "value" | "script">;
    path: PathSelection;
    tapTree: Uint8Array;
};

export function prepareOwnedInput(
    tx: Transaction,
    { index, coin, path, tapTree }: OwnedOnchainInput,
): void {
    tx.updateInput(index, {
        witnessUtxo: { amount: BigInt(coin.value), script: hex.decode(coin.script) },
        tapLeafScript: [path.leaf],
        sighashType: SigHash.DEFAULT,
    });
    setArkPsbtField(tx, index, VtxoTaprootTree, tapTree);
    if (path.extraWitness?.length) {
        setArkPsbtField(tx, index, ConditionWitness, path.extraWitness);
    }
}

export function emulatorInputIndexes(tx: Transaction): Set<number> {
    try {
        return new Set(
            Extension.fromTx(tx)
                .getEmulatorPacket()
                ?.entries.map((e) => e.vin) ?? [],
        );
    } catch {
        return new Set();
    }
}

export function assertCosignable(
    coin: VirtualCoin,
    csvBlocks: number,
    tipHeight: number,
    marginBlocks = DEFAULT_COSIGN_MARGIN_BLOCKS,
): void {
    const outpoint = `${coin.txid}:${coin.vout}`;
    const confirmedAt = coin.status.block_height;
    if (!coin.status.confirmed || confirmedAt === undefined) {
        throw new OnchainCosignPreflightError(`${outpoint} is unconfirmed`);
    }
    if (confirmedAt + csvBlocks - tipHeight <= marginBlocks) {
        throw new OnchainCosignPreflightError(
            `${outpoint} is within ${marginBlocks} blocks of exit maturity`,
        );
    }
}

export function isCosignFallback(e: unknown): boolean {
    return (
        e instanceof OnchainCosignUnsupportedError ||
        e instanceof OnchainCosignRejectedError ||
        e instanceof OnchainCosignPreflightError
    );
}

export function estimateOnchainCosignFee(nIn: number, nOut: number, feeRate: number): number {
    const estimator = TxWeightEstimator.create();
    for (let i = 0; i < nIn; i++) estimator.addTapscriptInput(64, 68, 65);
    for (let i = 0; i < nOut; i++) estimator.addP2TROutput();
    return Number(estimator.vsize().fee(BigInt(Math.ceil(feeRate))));
}

export type OnchainSpendDeps = {
    arkProvider?: Pick<ArkProvider, "cosignOnchainTx">;
    emulator?: Pick<EmulatorProvider, "submitOnchainTx">;
    onchainProvider: Pick<OnchainProvider, "broadcastTransaction" | "getRawTransaction">;
};

export async function submitOnchainSpend(
    tx: Transaction,
    arkInputs: Set<number>,
    deps: OnchainSpendDeps,
): Promise<string> {
    const emulated = emulatorInputIndexes(tx);
    if (emulated.size > 0) {
        if (!deps.emulator) {
            throw new Error("emulator inputs present but no emulator provider configured");
        }
        const { signedTx } = await deps.emulator.submitOnchainTx(base64.encode(tx.toPSBT()));
        tx = Transaction.fromPSBT(base64.decode(signedTx));
        for (const i of emulated) tx.finalizeIdx(i);
    }
    if (arkInputs.size > 0) {
        if (!deps.arkProvider) {
            throw new Error("arkd-cosigned inputs present but no arkProvider configured");
        }
        return deps.arkProvider.cosignOnchainTx(base64.encode(tx.toPSBT()));
    }
    tx.finalize();
    return deps.onchainProvider.broadcastTransaction(hex.encode(tx.extract()));
}
