import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@arkade-os/sdk";

export interface JointGraph {
    readonly arkTx: string;
    readonly checkpoints: readonly string[];
    readonly graphId: string;
    readonly inputOwners: readonly (string | null)[];
}

// Length-prefix unsigned PSBT bytes, template and owners to bind each signing round.
export function digestJointGraph(plan: Omit<JointGraph, "graphId">, template: string): string {
    const parts: Uint8Array[] = [];
    const pushU32 = (value: number): void => {
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, value, false);
        parts.push(len);
    };
    const pushField = (bytes: Uint8Array): void => {
        pushU32(bytes.length);
        parts.push(bytes);
    };
    pushField(new TextEncoder().encode(template));
    pushField(unsignedPsbtBytes(parseGraphTx(plan.arkTx)));
    pushU32(plan.checkpoints.length);
    for (const checkpoint of plan.checkpoints) {
        pushField(unsignedPsbtBytes(parseGraphTx(checkpoint)));
    }
    pushU32(plan.inputOwners.length);
    for (const owner of plan.inputOwners) {
        if (owner === null) {
            parts.push(new Uint8Array([0]));
        } else {
            const bytes = new TextEncoder().encode(owner);
            parts.push(new Uint8Array([1]));
            pushField(bytes);
        }
    }
    const preimage = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        preimage.set(part, at);
        at += part.length;
    }
    return hex.encode(sha256(preimage));
}

export function verifyJointGraph(plan: JointGraph, template: string): boolean {
    try {
        if (!plan || typeof plan !== "object") return false;
        if (typeof plan.arkTx !== "string" || plan.arkTx.length === 0) return false;
        if (
            !Array.isArray(plan.checkpoints) ||
            plan.checkpoints.length < 1 ||
            plan.checkpoints.some((c) => typeof c !== "string" || c.length === 0)
        )
            return false;
        if (!/^[0-9a-f]{64}$/.test(plan.graphId)) return false;
        if (
            !Array.isArray(plan.inputOwners) ||
            plan.inputOwners.some((o) => o !== null && (typeof o !== "string" || o.length === 0))
        )
            return false;
        if (plan.inputOwners.length !== plan.checkpoints.length) return false;
        const arkInputs = parseGraphTx(plan.arkTx).inputsLength;
        if (plan.checkpoints.length !== arkInputs) return false;
        if (plan.inputOwners.length !== arkInputs) return false;
        return (
            digestJointGraph(
                {
                    arkTx: plan.arkTx,
                    checkpoints: [...plan.checkpoints],
                    inputOwners: [...plan.inputOwners],
                },
                template,
            ) === plan.graphId
        );
    } catch {
        return false;
    }
}

function parseGraphTx(psbt: string): Transaction {
    return Transaction.fromPSBT(base64.decode(psbt));
}

export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/** Removes only tapscript signatures, preserving all other PSBT commitments. */
export function unsignedPsbtBytes(tx: Transaction): Uint8Array {
    const stripped = tx.clone();
    for (let i = 0; i < stripped.inputsLength; i++) {
        // `[]` would merge (a no-op); an explicit `undefined` deletes.
        stripped.updateInput(i, { tapScriptSig: undefined });
    }
    return stripped.toPSBT();
}
