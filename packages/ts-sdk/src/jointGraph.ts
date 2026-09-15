import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

export interface JointGraphAsset {
    readonly assetId: string;
    readonly units: string;
}

export interface JointGraphOutput {
    readonly role: string;
    readonly vout: number;
    readonly script: string;
    readonly sats: string;
    readonly assets: readonly JointGraphAsset[];
}

export interface JointOutpoint {
    readonly txid: string;
    readonly vout: number;
}

export interface JointGraph {
    readonly arkTx: string;
    readonly checkpoints: readonly string[];
    readonly graphId: string;
    readonly inputOwners: readonly (string | null)[];
    readonly inputOutpoints: readonly JointOutpoint[];
    readonly outputs: readonly JointGraphOutput[];
}

export interface JointVocabulary {
    readonly allowedOwners?: readonly (string | null)[];
    readonly allowedRoles?: readonly string[];
}

export function digestJointGraph(plan: Omit<JointGraph, "graphId">, template: string): string {
    return hex.encode(
        sha256(
            new TextEncoder().encode(
                JSON.stringify({
                    template,
                    arkTx: plan.arkTx,
                    checkpoints: plan.checkpoints,
                    inputOwners: plan.inputOwners,
                    inputOutpoints: plan.inputOutpoints,
                    outputs: plan.outputs,
                }),
            ),
        ),
    );
}

export function verifyJointGraph(
    plan: JointGraph,
    template: string,
    vocab?: JointVocabulary,
): boolean {
    try {
        if (!plan || typeof plan !== "object") return false;
        if (
            !hasExactKeys(plan, [
                "arkTx",
                "checkpoints",
                "graphId",
                "inputOwners",
                "inputOutpoints",
                "outputs",
            ])
        )
            return false;
        if (typeof plan.arkTx !== "string" || plan.arkTx.length === 0) return false;
        if (
            !Array.isArray(plan.checkpoints) ||
            plan.checkpoints.length < 1 ||
            plan.checkpoints.some((c) => typeof c !== "string" || c.length === 0)
        )
            return false;
        if (!/^[0-9a-f]{64}$/.test(plan.graphId)) return false;
        if (!Array.isArray(plan.inputOwners) || plan.inputOwners.some((o) => !isOwner(o, vocab)))
            return false;
        if (!Array.isArray(plan.inputOutpoints) || plan.inputOutpoints.length < 1) return false;
        if (
            plan.inputOwners.length !== plan.inputOutpoints.length ||
            plan.checkpoints.length !== plan.inputOutpoints.length
        )
            return false;
        if (
            plan.inputOutpoints.some(
                (o) =>
                    !hasExactKeys(o, ["txid", "vout"]) ||
                    typeof o.txid !== "string" ||
                    !/^[0-9a-f]{64}$/.test(o.txid) ||
                    !isVout(o.vout),
            )
        )
            return false;
        if (!Array.isArray(plan.outputs) || plan.outputs.length < 1) return false;
        if (
            plan.outputs.some(
                (o, i) =>
                    !hasExactKeys(o, ["role", "vout", "script", "sats", "assets"]) ||
                    !isRole(o.role, vocab) ||
                    o.vout !== i ||
                    typeof o.script !== "string" ||
                    !isScriptHex(o.script) ||
                    !isBoundedDecimal(o.sats, MAX_SAFE_SATS) ||
                    !Array.isArray(o.assets) ||
                    o.assets.some(
                        (a: JointGraphAsset) =>
                            !hasExactKeys(a, ["assetId", "units"]) ||
                            !/^[0-9a-f]{68}$/.test(a.assetId) ||
                            !isBoundedDecimal(a.units, U64_MAX),
                    ),
            )
        )
            return false;
        return digestJointGraph(plan, template) === plan.graphId;
    } catch {
        return false;
    }
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER);

function isOwner(owner: unknown, vocab?: JointVocabulary): owner is string | null {
    if (owner === null)
        return vocab?.allowedOwners === undefined || vocab.allowedOwners.includes(null);
    if (typeof owner !== "string" || owner.length === 0) return false;
    return vocab?.allowedOwners === undefined || vocab.allowedOwners.includes(owner);
}

function isRole(role: unknown, vocab?: JointVocabulary): role is string {
    if (typeof role !== "string" || role.length === 0) return false;
    return vocab?.allowedRoles === undefined || vocab.allowedRoles.includes(role);
}

function isScriptHex(script: string): boolean {
    return script.length > 0 && script.length % 2 === 0 && /^[0-9a-f]+$/.test(script);
}

function isVout(vout: unknown): vout is number {
    return typeof vout === "number" && Number.isInteger(vout) && vout >= 0 && vout <= 0xffffffff;
}

function isBoundedDecimal(value: unknown, max: bigint): value is string {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
    return BigInt(value) <= max;
}

function hasExactKeys(value: object, keys: string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
