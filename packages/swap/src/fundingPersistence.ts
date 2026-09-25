import { schnorr } from "@noble/curves/secp256k1.js";
import { asset } from "@arkade-os/sdk";
import { BTC_ASSET_ID, type AssetSwap, type FundingIntent, type FundingIntentState } from "./store";

export const FUNDING_INTENT_INPUT_LIMIT = 256;

export type FundingStateAdvance =
    | { state: "submitted" }
    | { state: "bound"; fundingTxid: string }
    | { state: "abandoned" };

const SATS_MAX = 2_100_000_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const TXID = /^[0-9a-f]{64}$/;
const XONLY = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const STATES = new Set<FundingIntentState>(["prepared", "submitted", "bound", "abandoned"]);

const plain = (value: unknown, field: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${field} must be a plain JSON object`);
    }
    return value as Record<string, unknown>;
};

const exactKeys = (
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
    field: string,
): void => {
    const allowed = new Set([...required, ...optional]);
    for (const key of required) {
        if (!Object.hasOwn(value, key)) throw new Error(`${field} is missing ${key}`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`${field} has unknown field ${key}`);
    }
};

const decimal = (value: unknown, max: bigint, field: string): bigint => {
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new Error(`${field} must be a canonical decimal string`);
    }
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > max) throw new Error(`${field} is outside its positive bound`);
    return parsed;
};

const assetId = (value: unknown, field: string): string => {
    if (typeof value !== "string") throw new Error(`${field} must be an asset id`);
    try {
        if (asset.AssetId.fromString(value).toString() !== value) throw new Error();
    } catch {
        throw new Error(`${field} must be a canonical SDK asset id`);
    }
    return value;
};

const swapAsset = (value: unknown, field: string): string => {
    if (value === BTC_ASSET_ID) return BTC_ASSET_ID;
    return assetId(value, field);
};

const amountFor = (value: unknown, assetName: string, field: string): bigint =>
    decimal(value, assetName === BTC_ASSET_ID ? SATS_MAX : U64_MAX, field);

const canonicalHex = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !HEX.test(value)) {
        throw new Error(`${field} must be non-empty lowercase byte hex`);
    }
    return value;
};

const canonicalUrl = (value: unknown): string => {
    if (typeof value !== "string") throw new Error("fundingIntent.arkServerUrl must be a URL");
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("fundingIntent.arkServerUrl must be a URL");
    }
    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        parsed.toString() !== value
    ) {
        throw new Error("fundingIntent.arkServerUrl must be a canonical HTTP(S) URL");
    }
    return value;
};

const canonicalServerKey = (value: unknown): string => {
    if (typeof value !== "string" || !XONLY.test(value)) {
        throw new Error("fundingIntent.serverPubkey must be lowercase x-only hex");
    }
    try {
        schnorr.utils.lift_x(BigInt(`0x${value}`));
    } catch {
        throw new Error("fundingIntent.serverPubkey must be a canonical curve key");
    }
    return value;
};

const validateIntent = (swap: AssetSwap): FundingIntent => {
    const intent = plain(swap.fundingIntent, "fundingIntent");
    exactKeys(
        intent,
        ["version", "state", "inputs", "serverPubkey", "arkServerUrl", "output"],
        [],
        "fundingIntent",
    );
    if (intent.version !== 1) throw new Error("fundingIntent.version must be 1");
    if (typeof intent.state !== "string" || !STATES.has(intent.state as FundingIntentState)) {
        throw new Error("fundingIntent.state is invalid");
    }
    if (!Array.isArray(intent.inputs) || intent.inputs.length === 0) {
        throw new Error("fundingIntent.inputs must be non-empty");
    }
    if (intent.inputs.length > FUNDING_INTENT_INPUT_LIMIT) {
        throw new Error(`fundingIntent.inputs exceeds ${FUNDING_INTENT_INPUT_LIMIT}`);
    }
    const seen = new Set<string>();
    for (const [index, raw] of intent.inputs.entries()) {
        const input = plain(raw, `fundingIntent.inputs[${index}]`);
        exactKeys(input, ["txid", "vout"], [], `fundingIntent.inputs[${index}]`);
        if (typeof input.txid !== "string" || !TXID.test(input.txid)) {
            throw new Error(
                `fundingIntent.inputs[${index}].txid must be lowercase transaction hex`,
            );
        }
        if (
            typeof input.vout !== "number" ||
            !Number.isSafeInteger(input.vout) ||
            input.vout < 0 ||
            input.vout > 0xffffffff
        ) {
            throw new Error(`fundingIntent.inputs[${index}].vout is invalid`);
        }
        const key = `${input.txid}:${input.vout}`;
        if (seen.has(key)) throw new Error(`fundingIntent.inputs duplicates ${key}`);
        seen.add(key);
    }
    canonicalServerKey(intent.serverPubkey);
    canonicalUrl(intent.arkServerUrl);
    const output = plain(intent.output, "fundingIntent.output");
    exactKeys(output, ["script", "value"], ["assetId", "assetAmount"], "fundingIntent.output");
    canonicalHex(output.script, "fundingIntent.output.script");
    decimal(output.value, SATS_MAX, "fundingIntent.output.value");
    const hasAssetId = Object.hasOwn(output, "assetId");
    const hasAssetAmount = Object.hasOwn(output, "assetAmount");
    if (hasAssetId !== hasAssetAmount) {
        throw new Error("fundingIntent.output asset fields must appear together");
    }
    if (hasAssetId) {
        assetId(output.assetId, "fundingIntent.output.assetId");
        decimal(output.assetAmount, U64_MAX, "fundingIntent.output.assetAmount");
    }
    const state = intent.state as FundingIntentState;
    if (state === "bound") {
        if (typeof swap.fundingTxid !== "string" || !TXID.test(swap.fundingTxid))
            throw new Error("bound fundingTxid must be lowercase hex");
    } else if (swap.fundingTxid !== "") {
        throw new Error(`${state} fundingTxid must be empty`);
    }
    return intent as unknown as FundingIntent;
};

const validatePinnedSwap = (swap: AssetSwap): FundingIntent => {
    if (
        typeof swap.id !== "string" ||
        swap.id.length === 0 ||
        swap.id.length > 128 ||
        swap.id.trim() !== swap.id ||
        /[\u0000-\u001f\u007f]/.test(swap.id)
    ) {
        throw new Error("prepared swap id must be a stable 1..128 character operation id");
    }
    const fromAsset = swapAsset(swap.fromAsset, "fromAsset");
    const toAsset = swapAsset(swap.toAsset, "toAsset");
    amountFor(swap.fromAmount, fromAsset, "fromAmount");
    amountFor(swap.toAmount, toAsset, "toAmount");
    if (typeof swap.swapAddress !== "string" || swap.swapAddress.length === 0) {
        throw new Error("swapAddress must be non-empty");
    }
    canonicalHex(swap.swapPkScript, "swapPkScript");
    canonicalHex(swap.offerHex, "offerHex");
    if (!Number.isSafeInteger(swap.createdAt) || swap.createdAt <= 0) {
        throw new Error("createdAt must be a positive safe integer");
    }
    const intent = validateIntent(swap);
    if (intent.output.script !== swap.swapPkScript) {
        throw new Error("fundingIntent.output.script must equal swapPkScript");
    }
    if (fromAsset === BTC_ASSET_ID) {
        if (intent.output.assetId !== undefined || intent.output.assetAmount !== undefined) {
            throw new Error("BTC funding output must not carry asset fields");
        }
        if (intent.output.value !== swap.fromAmount) {
            throw new Error("BTC funding output value must equal fromAmount");
        }
    } else if (
        intent.output.assetId !== fromAsset ||
        intent.output.assetAmount !== swap.fromAmount
    ) {
        throw new Error("asset funding output must equal fromAsset and fromAmount");
    }
    return intent;
};

export function assertPreparedFundingSwap(swap: AssetSwap): void {
    const intent = validatePinnedSwap(swap);
    if (intent.state !== "prepared")
        throw new Error("initial fundingIntent.state must be prepared");
}

export function assertFundingSwap(swap: AssetSwap): void {
    validatePinnedSwap(swap);
}

export function hasBoundFunding(swap: AssetSwap): boolean {
    if (swap.fundingIntent === undefined) return swap.fundingTxid.length > 0;
    assertFundingSwap(swap);
    return swap.fundingIntent.state === "bound" && swap.fundingTxid.length > 0;
}

export function mayHaveSubmittedFunding(swap: AssetSwap): boolean {
    if (swap.fundingIntent === undefined) return swap.fundingTxid.length > 0;
    assertFundingSwap(swap);
    return swap.fundingIntent.state === "submitted" || swap.fundingIntent.state === "bound";
}

const sameInputs = (a: FundingIntent, b: FundingIntent): boolean =>
    a.inputs.length === b.inputs.length &&
    a.inputs.every((input, index) => {
        const other = b.inputs[index];
        return input.txid === other.txid && input.vout === other.vout;
    });

const sameOutput = (a: FundingIntent["output"], b: FundingIntent["output"]): boolean =>
    a.script === b.script &&
    a.value === b.value &&
    a.assetId === b.assetId &&
    a.assetAmount === b.assetAmount;

const assertImmutableFacts = (existing: AssetSwap, incoming: AssetSwap): void => {
    for (const field of [
        "id",
        "fromAsset",
        "toAsset",
        "fromAmount",
        "toAmount",
        "swapAddress",
        "swapPkScript",
        "offerHex",
        "createdAt",
    ] as const) {
        if (incoming[field] !== existing[field])
            throw new Error(`prepared swap ${field} is immutable`);
    }
    if (incoming.fundingIntent === undefined) return;
    const current = existing.fundingIntent!;
    const next = incoming.fundingIntent;
    if (
        next.version !== current.version ||
        next.serverPubkey !== current.serverPubkey ||
        next.arkServerUrl !== current.arkServerUrl ||
        !sameInputs(next, current) ||
        !sameOutput(next.output, current.output)
    ) {
        throw new Error("prepared funding descriptor facts are immutable");
    }
};

const mergeDefined = (existing: AssetSwap, incoming: AssetSwap): AssetSwap => {
    const merged = { ...existing } as AssetSwap & Record<string, unknown>;
    for (const [key, value] of Object.entries(incoming)) {
        if (value !== undefined) merged[key] = value;
    }
    return merged;
};

export function mergeFundingProtectedSwap(
    existing: AssetSwap | undefined,
    incoming: AssetSwap,
): AssetSwap {
    if (!existing) {
        if (incoming.fundingIntent !== undefined) {
            throw new Error("prepared swaps must use insertPreparedSwap");
        }
        return incoming;
    }
    if (existing.fundingIntent === undefined) {
        if (incoming.fundingIntent !== undefined) {
            throw new Error("fundingIntent cannot retrofit a legacy swap");
        }
        return incoming;
    }
    assertFundingSwap(existing);
    if (incoming.fundingIntent !== undefined) assertFundingSwap(incoming);
    assertImmutableFacts(existing, incoming);
    if (incoming.fundingTxid && incoming.fundingTxid !== existing.fundingTxid) {
        throw new Error("fundingTxid is write-once");
    }
    return {
        ...mergeDefined(existing, incoming),
        fundingIntent: existing.fundingIntent,
        fundingTxid: existing.fundingTxid,
    };
}

const reservationKeys = (swap: AssetSwap): string[] => {
    if (swap.fundingIntent === undefined) return [];
    assertFundingSwap(swap);
    if (swap.fundingIntent.state !== "prepared" && swap.fundingIntent.state !== "submitted") {
        return [];
    }
    return swap.fundingIntent.inputs.map((input) => `${input.txid}:${input.vout}`);
};

export function canInsertPreparedSwap(
    existing: readonly AssetSwap[],
    incoming: AssetSwap,
): boolean {
    assertPreparedFundingSwap(incoming);
    if (existing.some((swap) => swap.id === incoming.id)) return false;
    const wanted = new Set(
        incoming.fundingIntent!.inputs.map((input) => `${input.txid}:${input.vout}`),
    );
    for (const swap of existing) {
        if (reservationKeys(swap).some((key) => wanted.has(key))) return false;
    }
    return true;
}

export function advanceFundingSwap(
    existing: AssetSwap | undefined,
    expected: "prepared" | "submitted",
    next: FundingStateAdvance,
): { ok: boolean; swap?: AssetSwap } {
    if (expected !== "prepared" && expected !== "submitted") return { ok: false };
    const rawNext = plain(next, "funding state advance");
    exactKeys(
        rawNext,
        next.state === "bound" ? ["state", "fundingTxid"] : ["state"],
        [],
        "funding state advance",
    );
    if (!existing || existing.fundingIntent === undefined) return { ok: false };
    assertFundingSwap(existing);
    if (next.state === "bound") {
        if (typeof next.fundingTxid !== "string" || !TXID.test(next.fundingTxid))
            throw new Error("bound fundingTxid must be lowercase hex");
        if (existing.fundingIntent.state === "bound") {
            return { ok: expected === "submitted" && existing.fundingTxid === next.fundingTxid };
        }
    }
    if (existing.fundingIntent.state !== expected) return { ok: false };
    // `submitted -> abandoned` is for one caller: `fundOffer` catching the
    // wallet's pre-submit deadline refusal. Nothing less may take it.
    const allowed =
        (expected === "prepared" && (next.state === "submitted" || next.state === "abandoned")) ||
        (expected === "submitted" && (next.state === "bound" || next.state === "abandoned"));
    if (!allowed) return { ok: false };
    const swap: AssetSwap = {
        ...existing,
        status: next.state === "abandoned" ? "cancelled" : existing.status,
        fundingTxid: next.state === "bound" ? next.fundingTxid : "",
        fundingIntent: { ...existing.fundingIntent, state: next.state },
    };
    assertFundingSwap(swap);
    return { ok: true, swap };
}

export const fundingSnapshot = (swap: AssetSwap): AssetSwap => structuredClone(swap);
