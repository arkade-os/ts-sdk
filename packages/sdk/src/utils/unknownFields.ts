import { RawWitness, ScriptNum, Transaction } from "@scure/btc-signer";
import { TransactionInputUpdate } from "@scure/btc-signer/psbt.js";
import { sequenceToTimelock } from "./timelock";

/**
 * ArkadePsbtFieldKey are the available key names for the Arkade PSBT custom fields.
 */
export enum ArkadePsbtFieldKey {
    VtxoTaprootTree = "taptree",
    VtxoTreeExpiry = "expiry",
    Cosigner = "cosigner",
    ConditionWitness = "condition",
    PrevArkTx = "prevarktx",
    PrevoutTx = "prevouttx",
}

/**
 * ArkadePsbtFieldKeyType is the key type of the Arkade PSBT custom field.
 * Every Arkade PSBT field has key type 222.
 */
export const ArkadePsbtFieldKeyType = 222;

/**
 * ArkadePsbtFieldCoder is the coder for the Arkade PSBT custom fields.
 * Each type has its own coder.
 */
export interface ArkadePsbtFieldCoder<T> {
    key: ArkadePsbtFieldKey;
    encode: (value: T) => NonNullable<TransactionInputUpdate["unknown"]>[number];
    decode: (value: NonNullable<TransactionInputUpdate["unknown"]>[number]) => T | null;
}

/**
 * setArkadePsbtField appends a new unknown field to the input at inputIndex
 *
 * @example
 * ```typescript
 * setArkadePsbtField(tx, 0, VtxoTaprootTree, myTaprootTree);
 * setArkadePsbtField(tx, 0, VtxoTreeExpiry, myVtxoTreeExpiry);
 * ```
 */
export function setArkadePsbtField<T>(
    tx: Transaction,
    inputIndex: number,
    coder: ArkadePsbtFieldCoder<T>,
    value: T,
): void {
    tx.updateInput(inputIndex, {
        unknown: [...(tx.getInput(inputIndex)?.unknown ?? []), coder.encode(value)],
    });
}

/**
 * getArkadePsbtFields returns all the values of the given coder for the input at inputIndex
 * Multiple fields of the same type can exist in a single input.
 *
 * @example
 * ```typescript
 * const vtxoTaprootTreeFields = getArkadePsbtFields(tx, 0, VtxoTaprootTree);
 * console.log(`input has ${vtxoTaprootTreeFields.length} vtxoTaprootTree fields`);
 */
export function getArkadePsbtFields<T>(
    tx: Transaction,
    inputIndex: number,
    coder: ArkadePsbtFieldCoder<T>,
): T[] {
    const unknown = tx.getInput(inputIndex)?.unknown ?? [];
    return unknown.map((u) => coder.decode(u)).filter((v): v is T => v !== null);
}

/**
 * VtxoTaprootTree is set to pass all spending leaves of the vtxo input
 *
 * @example
 * ```typescript
 * const vtxoTaprootTree = VtxoTaprootTree.encode(myTaprootTree);
 */
export const VtxoTaprootTree: ArkadePsbtFieldCoder<Uint8Array> = {
    key: ArkadePsbtFieldKey.VtxoTaprootTree,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkadePsbtFieldKey.VtxoTaprootTree],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkadePsbtFieldKey.VtxoTaprootTree)) return null;
            return value[1];
        }),
};

/**
 * ConditionWitness is set to pass the witness data used to finalize the conditionMultisigClosure
 *
 * @example
 * ```typescript
 * const conditionWitness = ConditionWitness.encode(myConditionWitness);
 */
export const ConditionWitness: ArkadePsbtFieldCoder<Uint8Array[]> = {
    key: ArkadePsbtFieldKey.ConditionWitness,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkadePsbtFieldKey.ConditionWitness],
        },
        RawWitness.encode(value),
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkadePsbtFieldKey.ConditionWitness)) return null;
            return RawWitness.decode(value[1]);
        }),
};

/**
 * PrevArkadeTxField carries the serialized raw bitcoin tx of the previous Arkade transaction
 * spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY on intent proofs and
 * other contexts where the prevout pkScript must be looked up off-chain.
 *
 * Key: [0xde] || "prevarktx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevArkadeTxField: ArkadePsbtFieldCoder<Uint8Array> = {
    key: ArkadePsbtFieldKey.PrevArkTx,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkadePsbtFieldKey.PrevArkTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkadePsbtFieldKey.PrevArkTx)) return null;
            return value[1];
        }),
};

/**
 * PrevoutTxField carries the serialized raw bitcoin tx that produced the
 * previous output spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY in
 * the SubmitOnchainTx flow, where there is no Arkade transaction but a plain Bitcoin
 * funding tx whose pkScript must be resolvable.
 *
 * Key: [0xde] || "prevouttx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevoutTxField: ArkadePsbtFieldCoder<Uint8Array> = {
    key: ArkadePsbtFieldKey.PrevoutTx,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkadePsbtFieldKey.PrevoutTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkadePsbtFieldKey.PrevoutTx)) return null;
            return value[1];
        }),
};

/**
 * CosignerPublicKey is set on every TxGraph transactions to identify the musig2 public keys
 *
 * @example
 * ```typescript
 * const cosignerPublicKey = CosignerPublicKey.encode(myCosignerPublicKey);
 */
export const CosignerPublicKey: ArkadePsbtFieldCoder<{
    index: number;
    key: Uint8Array;
}> = {
    key: ArkadePsbtFieldKey.Cosigner,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: new Uint8Array([...encodedPsbtFieldKey[ArkadePsbtFieldKey.Cosigner], value.index]),
        },
        value.key,
    ],
    decode: (unknown) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(unknown[0], ArkadePsbtFieldKey.Cosigner, true)) return null;
            return {
                index: unknown[0].key[unknown[0].key.length - 1],
                key: unknown[1],
            };
        }),
};

/**
 * VtxoTreeExpiry is set to pass the expiry time of the input
 *
 * @example
 * ```typescript
 * const vtxoTreeExpiry = VtxoTreeExpiry.encode(myVtxoTreeExpiry);
 */
export const VtxoTreeExpiry: ArkadePsbtFieldCoder<{
    type: "blocks" | "seconds";
    value: bigint;
}> = {
    key: ArkadePsbtFieldKey.VtxoTreeExpiry,
    encode: (value) => [
        {
            type: ArkadePsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkadePsbtFieldKey.VtxoTreeExpiry],
        },
        ScriptNum(6, true).encode(value.value),
    ],
    decode: (unknown) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(unknown[0], ArkadePsbtFieldKey.VtxoTreeExpiry)) return null;
            const v = ScriptNum(6, true).decode(unknown[1]);
            if (!v) return null;
            return sequenceToTimelock(Number(v));
        }),
};

const encodedPsbtFieldKey: Record<string, Uint8Array> = Object.fromEntries(
    Object.values(ArkadePsbtFieldKey).map((key) => [key, new TextEncoder().encode(key)]),
);

const nullIfCatch = <T>(fn: () => T): T | null => {
    try {
        return fn();
    } catch {
        return null;
    }
};

function checkKeyMatch(
    key: { type: number; key: Uint8Array },
    arkadePsbtFieldKey: ArkadePsbtFieldKey,
    prefixOnly: boolean = false,
): boolean {
    if (key.type !== ArkadePsbtFieldKeyType) return false;
    const expected = encodedPsbtFieldKey[arkadePsbtFieldKey];
    if (key.key.length < expected.length) return false;
    if (!prefixOnly && key.key.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        if (key.key[i] !== expected[i]) return false;
    }
    return true;
}
