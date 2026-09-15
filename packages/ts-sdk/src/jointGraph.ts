import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "./utils/transaction";
import { unsignedPsbtBytes } from "./utils/arkTransaction";

export interface JointGraph {
    readonly arkTx: string;
    readonly checkpoints: readonly string[];
    readonly graphId: string;
    readonly inputOwners: readonly (string | null)[];
}

// graphId commits to unsigned PSBT bytes (never base64/JSON: both are
// serializer-dependent), each field length-prefixed so fields cannot be
// confused with each other:
//   u32be(len) || utf8(template)
//   u32be(len) || unsignedPsbtBytes(ark)
//   u32be(count) || for each checkpoint: u32be(len) || unsignedPsbtBytes(cp_i)
//   u32be(count) || for each owner: 0x00, or 0x01 || u32be(len) || utf8(owner)
// Unsigned PSBT bytes (not consensus bytes) keep tap leaves, the declared
// sighash and the emulator/asset packets inside the commitment, and strip
// only signatures — so the id verifies at every signing round.
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
