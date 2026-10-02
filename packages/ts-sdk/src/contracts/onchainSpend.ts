import { base64, hex } from "@scure/base";
import { Script, SigHash, TaprootControlBlock } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { scriptFromTapLeafScript } from "../script/base";
import { Extension, ExtensionNotFoundError } from "../extension";
import type { ArkProvider } from "../providers/ark";
import { OnchainCosignRejectedError, OnchainCosignUnsupportedError } from "../providers/ark";
import type { EmulatorProvider } from "../providers/emulator";
import type { OnchainProvider } from "../providers/onchain";
import { Transaction } from "../utils/transaction";
import { TxWeightEstimator } from "../utils/txSizeEstimator";
import {
    ConditionWitness,
    VtxoTaprootTree,
    getArkPsbtFields,
    setArkPsbtField,
} from "../utils/unknownFields";
import type { VirtualCoin } from "../wallet";
import type { Contract, PathSelection } from "./types";
import { exitSequence } from "./handlers/helpers";
import { sequenceToTimelock } from "../utils/timelock";

export const DEFAULT_COSIGN_MARGIN_BLOCKS = 144;

/** Exit CSV in blocks, seconds counted as 600 per block; no CSV means the exit is already open (0). */
export function csvBlocksOf(contract: Contract): number {
    const sequence = exitSequence(contract);
    if (sequence === undefined) return 0;
    const { type, value } = sequenceToTimelock(sequence);
    return type === "blocks" ? Number(value) : Math.ceil(Number(value) / 600);
}

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
    } catch (e) {
        if (e instanceof ExtensionNotFoundError) return new Set();
        throw e;
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

/** scure's finalizeIdx cannot place a ConditionWitness, so those inputs are laid out here. */
function finalizeOwnedInput(tx: Transaction, index: number): void {
    const condition = getArkPsbtFields(tx, index, ConditionWitness)[0];
    if (!condition) {
        tx.finalizeIdx(index);
        return;
    }
    const input = tx.getInput(index);
    const leaf = input.tapLeafScript?.[0];
    if (!leaf) throw new Error(`input ${index} has no tap leaf to finalize`);
    const script = scriptFromTapLeafScript(leaf);
    const ops = Script.decode(script);
    const position = (pubKey: Uint8Array) =>
        ops.findIndex((op) => op instanceof Uint8Array && equalBytes(op, pubKey));
    const sigs = (input.tapScriptSig ?? [])
        .map(([{ pubKey }, sig]) => ({ sig, pos: position(pubKey) }))
        .filter((s) => s.pos !== -1)
        .sort((a, b) => a.pos - b.pos)
        .map((s) => s.sig)
        .reverse();
    if (sigs.length === 0) throw new Error(`input ${index} has no signatures to finalize`);
    tx.updateInput(index, {
        finalScriptWitness: [...sigs, ...condition, script, TaprootControlBlock.encode(leaf[0])],
    });
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
        for (const i of emulated) finalizeOwnedInput(tx, i);
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
