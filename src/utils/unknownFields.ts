import { RawWitness, ScriptNum, Transaction } from "@scure/btc-signer";
import { TransactionInputUpdate } from "@scure/btc-signer/psbt.js";
import { sequenceToTimelock } from "./timelock";

/**
 * ArkPsbtFieldKey are the available key names for the Arkade PSBT custom fields.
 */
export enum ArkPsbtFieldKey {
    VtxoTaprootTree = "taptree",
    VtxoTreeExpiry = "expiry",
    Cosigner = "cosigner",
    ConditionWitness = "condition",
    PrevArkTx = "prevarktx",
    PrevoutTx = "prevouttx",
}

/**
 * ArkPsbtFieldKeyType is the key type of the Arkade PSBT custom field.
 * Every Arkade PSBT field has key type 222.
 */
export const ArkPsbtFieldKeyType = 222;

/**
 * ArkPsbtFieldCoder is the coder for the Arkade PSBT custom fields.
 * Each type has its own coder.
 */
export interface ArkPsbtFieldCoder<T> {
    key: ArkPsbtFieldKey;
    encode: (
        value: T
    ) => NonNullable<TransactionInputUpdate["unknown"]>[number];
    decode: (
        value: NonNullable<TransactionInputUpdate["unknown"]>[number]
    ) => T | null;
}

/**
 * setArkPsbtField appends a new unknown field to the input at inputIndex
 *
 * @example
 * ```typescript
 * setArkPsbtField(tx, 0, VtxoTaprootTree, myTaprootTree);
 * setArkPsbtField(tx, 0, VtxoTreeExpiry, myVtxoTreeExpiry);
 * ```
 */
export function setArkPsbtField<T>(
    tx: Transaction,
    inputIndex: number,
    coder: ArkPsbtFieldCoder<T>,
    value: T
): void {
    tx.updateInput(inputIndex, {
        unknown: [
            ...(tx.getInput(inputIndex)?.unknown ?? []),
            coder.encode(value),
        ],
    });
}

/**
 * getArkPsbtFields returns all the values of the given coder for the input at inputIndex
 * Multiple fields of the same type can exist in a single input.
 *
 * @example
 * ```typescript
 * const vtxoTaprootTreeFields = getArkPsbtFields(tx, 0, VtxoTaprootTree);
 * console.log(`input has ${vtxoTaprootTreeFields.length} vtxoTaprootTree fields`);
 */
export function getArkPsbtFields<T>(
    tx: Transaction,
    inputIndex: number,
    coder: ArkPsbtFieldCoder<T>
): T[] {
    const unknown = tx.getInput(inputIndex)?.unknown ?? [];

    const fields: T[] = [];
    for (const u of unknown) {
        const v = coder.decode(u);
        if (v !== null) fields.push(v);
    }
    return fields;
}

/**
 * VtxoTaprootTree is set to pass all spending leaves of the vtxo input
 *
 * @example
 * ```typescript
 * const vtxoTaprootTree = VtxoTaprootTree.encode(myTaprootTree);
 */
export const VtxoTaprootTree: ArkPsbtFieldCoder<Uint8Array> = {
    key: ArkPsbtFieldKey.VtxoTaprootTree,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.VtxoTaprootTree],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.VtxoTaprootTree))
                return null;
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
export const ConditionWitness: ArkPsbtFieldCoder<Uint8Array[]> = {
    key: ArkPsbtFieldKey.ConditionWitness,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.ConditionWitness],
        },
        RawWitness.encode(value),
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.ConditionWitness))
                return null;
            return RawWitness.decode(value[1]);
        }),
};

/**
 * PrevArkTxField carries the serialized raw bitcoin tx of the previous Ark tx
 * spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY on intent proofs and
 * other contexts where the prevout pkScript must be looked up off-chain.
 *
 * Key: [0xde] || "prevarktx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevArkTxField: ArkPsbtFieldCoder<Uint8Array> = {
    key: ArkPsbtFieldKey.PrevArkTx,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.PrevArkTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.PrevArkTx))
                return null;
            return value[1];
        }),
};

/**
 * PrevoutTxField carries the serialized raw bitcoin tx that produced the
 * previous output spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY in
 * the SubmitOnchainTx flow, where there is no Ark tx but a plain Bitcoin
 * funding tx whose pkScript must be resolvable.
 *
 * Key: [0xde] || "prevouttx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
export const PrevoutTxField: ArkPsbtFieldCoder<Uint8Array> = {
    key: ArkPsbtFieldKey.PrevoutTx,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.PrevoutTx],
        },
        value,
    ],
    decode: (value) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(value[0], ArkPsbtFieldKey.PrevoutTx))
                return null;
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
export const CosignerPublicKey: ArkPsbtFieldCoder<{
    index: number;
    key: Uint8Array;
}> = {
    key: ArkPsbtFieldKey.Cosigner,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: new Uint8Array([
                ...encodedPsbtFieldKey[ArkPsbtFieldKey.Cosigner],
                value.index,
            ]),
        },
        value.key,
    ],
    decode: (unknown) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(unknown[0], ArkPsbtFieldKey.Cosigner, true))
                return null;
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
export const VtxoTreeExpiry: ArkPsbtFieldCoder<{
    type: "blocks" | "seconds";
    value: bigint;
}> = {
    key: ArkPsbtFieldKey.VtxoTreeExpiry,
    encode: (value) => [
        {
            type: ArkPsbtFieldKeyType,
            key: encodedPsbtFieldKey[ArkPsbtFieldKey.VtxoTreeExpiry],
        },
        ScriptNum(6, true).encode(value.value === 0n ? 0n : value.value),
    ],
    decode: (unknown) =>
        nullIfCatch(() => {
            if (!checkKeyMatch(unknown[0], ArkPsbtFieldKey.VtxoTreeExpiry))
                return null;
            const v = ScriptNum(6, true).decode(unknown[1]);
            if (!v) return null;
            return sequenceToTimelock(Number(v));
        }),
};

const encodedPsbtFieldKey: Record<string, Uint8Array> = Object.fromEntries(
    Object.values(ArkPsbtFieldKey).map((key) => [
        key,
        new TextEncoder().encode(key),
    ])
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
    arkPsbtFieldKey: ArkPsbtFieldKey,
    prefixOnly: boolean = false
): boolean {
    if (key.type !== ArkPsbtFieldKeyType) return false;
    const expected = encodedPsbtFieldKey[arkPsbtFieldKey];
    if (key.key.length < expected.length) return false;
    if (!prefixOnly && key.key.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
        if (key.key[i] !== expected[i]) return false;
    }
    return true;
}
