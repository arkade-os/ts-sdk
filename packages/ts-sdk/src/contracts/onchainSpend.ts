import { base64, hex } from "@scure/base";
import { Script, SigHash, TaprootControlBlock } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { scriptFromTapLeafScript } from "../script/base";
import { Extension, ExtensionNotFoundError } from "../extension";
import type { ArkProvider } from "../providers/ark";
import {
    ONCHAIN_COSIGN_AMBIGUOUS_PREFIX,
    ONCHAIN_COSIGN_REJECTED_PREFIX,
    ONCHAIN_COSIGN_UNSUPPORTED_PREFIX,
    OnchainCosignAmbiguousError,
    OnchainCosignRejectedError,
    OnchainCosignUnsupportedError,
} from "../providers/ark";
import { ArkErrorName } from "../providers/errors";
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
import { isOnchainScoped } from "./scope";
import { sequenceToTimelock } from "../utils/timelock";

export const DEFAULT_COSIGN_MARGIN_BLOCKS = 6;

/** Upper bound on the renew window; short-CSV networks use a quarter of the CSV instead. */
export const ONCHAIN_RENEW_WINDOW_BLOCKS = 144;

/** Exit CSV in blocks, seconds counted as 600 per block; no CSV means the exit is already open (0). */
export function csvBlocksOf(contract: Contract): number {
    const sequence = exitSequence(contract);
    if (sequence === undefined) return 0;
    const { type, value } = sequenceToTimelock(sequence);
    return type === "blocks" ? Number(value) : Math.ceil(Number(value) / 600);
}

export const ONCHAIN_COSIGN_PREFLIGHT_PREFIX = "Onchain cosign preflight failed: ";

export class OnchainCosignPreflightError extends Error {
    constructor(
        readonly reason: string,
        options?: { cause?: unknown },
    ) {
        super(`${ONCHAIN_COSIGN_PREFLIGHT_PREFIX}${reason}`, options);
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
    // scure merges key maps, and arkd requires exactly one leaf. Dropping PSBT-only
    // fields leaves the tx, and so other inputs' signatures, untouched.
    const { tapLeafScript, tapScriptSig } = tx.getInput(index);
    if (tapLeafScript || tapScriptSig) {
        tx.updateInput(index, { tapLeafScript: undefined, tapScriptSig: undefined }, true);
    }
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

/**
 * Automatic sweeps take boarding coins only, in the last stretch before cosign is refused.
 * Unrolled outputs are a user's exit: re-boarding them would undo it, so they stay manual.
 */
export function needsOnchainSweep(
    coin: VirtualCoin,
    contract: Contract,
    tipHeight: number,
    marginBlocks = DEFAULT_COSIGN_MARGIN_BLOCKS,
): boolean {
    if (!isOnchainScoped(contract)) return false;
    const confirmedAt = coin.status.block_height;
    if (!coin.status.confirmed || confirmedAt === undefined) return false;
    const csvBlocks = csvBlocksOf(contract);
    const window = Math.min(ONCHAIN_RENEW_WINDOW_BLOCKS, Math.floor(csvBlocks / 4));
    const remaining = confirmedAt + csvBlocks - tipHeight;
    return remaining > marginBlocks && remaining <= marginBlocks + window;
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

/** True only when the coins were definitely not spent, so paying another way is safe. */
export function isCosignFallback(e: unknown): boolean {
    if (e instanceof OnchainCosignRejectedError) {
        return !!e.arkErrorName && e.arkErrorName !== ArkErrorName.INTERNAL_ERROR;
    }
    return e instanceof OnchainCosignUnsupportedError || e instanceof OnchainCosignPreflightError;
}

/** Structured clone across the service-worker bus strips error classes; restore them by message prefix. */
export function rehydrateCosignError(e: unknown): unknown {
    if (
        !(e instanceof Error) ||
        e instanceof OnchainCosignRejectedError ||
        e instanceof OnchainCosignAmbiguousError ||
        e instanceof OnchainCosignUnsupportedError ||
        e instanceof OnchainCosignPreflightError
    ) {
        return e;
    }
    const { message } = e;
    if (message.startsWith(ONCHAIN_COSIGN_REJECTED_PREFIX)) {
        const rest = message.slice(ONCHAIN_COSIGN_REJECTED_PREFIX.length);
        const named = rest.match(/^\[([A-Z0-9_]+)\] ([\s\S]*)$/);
        return named
            ? new OnchainCosignRejectedError(named[2], named[1])
            : new OnchainCosignRejectedError(rest);
    }
    if (message.startsWith(ONCHAIN_COSIGN_AMBIGUOUS_PREFIX)) {
        return new OnchainCosignAmbiguousError(
            message.slice(ONCHAIN_COSIGN_AMBIGUOUS_PREFIX.length),
        );
    }
    if (message.startsWith(ONCHAIN_COSIGN_PREFLIGHT_PREFIX)) {
        return new OnchainCosignPreflightError(
            message.slice(ONCHAIN_COSIGN_PREFLIGHT_PREFIX.length),
        );
    }
    if (message.startsWith(ONCHAIN_COSIGN_UNSUPPORTED_PREFIX))
        return new OnchainCosignUnsupportedError();
    return e;
}

export function estimateOnchainCosignFee(nIn: number, nOut: number, feeRate: number): number {
    const estimator = TxWeightEstimator.create();
    // 2-of-2 leaf: two 64-byte sigs; the estimator adds the first one's length byte itself.
    for (let i = 0; i < nIn; i++) estimator.addTapscriptInput(2 * 64 + 1, 68, 65);
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
        if (!deps.arkProvider.cosignOnchainTx) throw new OnchainCosignUnsupportedError();
        return deps.arkProvider.cosignOnchainTx(base64.encode(tx.toPSBT()));
    }
    for (let i = 0; i < tx.inputsLength; i++) {
        if (!tx.getInput(i).finalScriptWitness) finalizeOwnedInput(tx, i);
    }
    return deps.onchainProvider.broadcastTransaction(hex.encode(tx.extract()));
}
