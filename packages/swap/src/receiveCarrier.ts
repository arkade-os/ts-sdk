import { hex } from "@scure/base";
import { asset } from "@arkade-os/sdk";

export const CARRIER_QUOTE_ID_MAX = 128;

export interface RecycleCarrierQuote {
    quoteId: string;
    receiveAddress: string;
    makerPublicKey: string;
    assetId: string;
    physicalSats: bigint;
    loanSats: bigint;
    receiptSats: bigint;
    serviceFareSats: bigint;
    expiresAt: number;
}

export type ArkadeCarrierChoice =
    | { mode: "purchase" }
    | { mode: "recycle"; quote: RecycleCarrierQuote };

export type ArkadeCarrierRequest = { mode: "purchase" } | { mode: "recycle"; quoteId: string };

export interface VerifiedCarrierTerms {
    mode: "purchase" | "recycle";
    physicalSats: bigint;
    loanSats: bigint;
    receiptSats: bigint;
    serviceFareSats: bigint;
    pricedSats: bigint;
    expiresAt: number;
    quoteId?: string;
}

export interface ParsedCarrierEcho extends VerifiedCarrierTerms {}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const XONLY_HEX = /^[0-9a-f]{64}$/;
const MAX_BITCOIN_SATS = 2_100_000_000_000_000n;
const MAX_BITCOIN_SATS_DECIMAL = MAX_BITCOIN_SATS.toString();

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);

export const isCanonicalDecimalString = (v: unknown): v is string =>
    typeof v === "string" && DECIMAL.test(v);

const parseSatsField = (value: unknown, field: string): bigint => {
    if (!isCanonicalDecimalString(value)) {
        throw new Error("carrier echo " + field + " must be a canonical decimal string");
    }
    if (
        value.length > MAX_BITCOIN_SATS_DECIMAL.length ||
        (value.length === MAX_BITCOIN_SATS_DECIMAL.length && value > MAX_BITCOIN_SATS_DECIMAL)
    ) {
        throw new Error("carrier echo " + field + " exceeds the Bitcoin supply");
    }
    return BigInt(value);
};

export const parseTopLevelCarrierSats = (value: unknown): bigint => {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error("top-level carrier_sats must be a non-negative safe integer");
        }
        if (value > Number(MAX_BITCOIN_SATS)) {
            throw new Error("top-level carrier_sats exceeds the Bitcoin supply");
        }
        return BigInt(value);
    }
    return parseSatsField(value, "top-level carrier_sats");
};

const parseExpiresAt = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error("carrier echo expires_at must be a safe positive unix time");
    }
    return value;
};

export function validateRecycleQuoteShape(q: RecycleCarrierQuote): void {
    if (!q || typeof q !== "object") throw new Error("carrier recycle quote is required");
    if (
        typeof q.quoteId !== "string" ||
        !q.quoteId.length ||
        q.quoteId.length > CARRIER_QUOTE_ID_MAX
    ) {
        throw new Error("carrier recycle quoteId must be 1..128 chars");
    }
    if (typeof q.receiveAddress !== "string" || !q.receiveAddress.length) {
        throw new Error("carrier recycle quote needs a receiveAddress");
    }
    if (typeof q.makerPublicKey !== "string" || !XONLY_HEX.test(q.makerPublicKey)) {
        throw new Error("carrier recycle quote makerPublicKey must be lowercase x-only hex");
    }
    if (typeof q.assetId !== "string" || !q.assetId.length) {
        throw new Error("carrier recycle quote needs an assetId");
    }
    try {
        asset.AssetId.fromString(q.assetId);
    } catch {
        throw new Error("carrier recycle quote assetId is not a valid SDK asset id");
    }
    const amounts: Array<[string, unknown]> = [
        ["physicalSats", q.physicalSats],
        ["loanSats", q.loanSats],
        ["receiptSats", q.receiptSats],
        ["serviceFareSats", q.serviceFareSats],
    ];
    for (const [name, v] of amounts) {
        if (typeof v !== "bigint" || v < 0n) {
            throw new Error("carrier recycle quote " + name + " must be a non-negative bigint");
        }
        if (v > MAX_BITCOIN_SATS) {
            throw new Error("carrier recycle quote " + name + " exceeds the Bitcoin supply");
        }
    }
    if (q.physicalSats <= 0n)
        throw new Error("carrier recycle quote physicalSats must be positive");
    if (q.loanSats <= 0n || q.receiptSats <= 0n) {
        throw new Error("carrier recycle quote needs a positive loan and receipt");
    }
    const physical = q.loanSats + q.receiptSats;
    if (physical > MAX_BITCOIN_SATS) {
        throw new Error("carrier recycle quote loan+receipt exceeds the Bitcoin supply");
    }
    if (physical !== q.physicalSats) {
        throw new Error("carrier recycle quote loan+receipt must equal physical");
    }
    if (q.receiptSats + q.serviceFareSats > MAX_BITCOIN_SATS) {
        throw new Error("carrier recycle quote priced sum exceeds the Bitcoin supply");
    }
    if (!Number.isSafeInteger(q.expiresAt) || q.expiresAt <= 0) {
        throw new Error("carrier recycle quote expiresAt must be safe positive unix time");
    }
}

export function encodeCarrierRequest(choice: ArkadeCarrierRequest): Record<string, unknown> {
    if (!isPlainObject(choice)) throw new Error("carrier request must be an object");
    if (choice.mode !== "purchase" && choice.mode !== "recycle") {
        throw new Error("carrier request mode must be purchase or recycle");
    }
    const allowed = choice.mode === "purchase" ? new Set(["mode"]) : new Set(["mode", "quoteId"]);
    for (const key of Object.keys(choice)) {
        if (!allowed.has(key)) throw new Error("carrier request carries unknown field " + key);
    }
    if (choice.mode === "purchase") return { mode: "purchase" };
    if (
        typeof choice.quoteId !== "string" ||
        !choice.quoteId.length ||
        choice.quoteId.length > CARRIER_QUOTE_ID_MAX
    ) {
        throw new Error("carrier recycle quoteId must be 1..128 chars");
    }
    return { mode: "recycle", quote_id: choice.quoteId };
}

export function assertCarrierRequestAllowed(
    choice: ArkadeCarrierRequest | undefined,
    assets: { wantAsset?: asset.AssetId; offerAsset?: asset.AssetId },
): void {
    if (choice === undefined) return;
    if (assets.wantAsset === undefined || assets.offerAsset !== undefined) {
        throw new Error("carrier negotiation is only available for BTC->asset swaps");
    }
}

export function parseCarrierEcho(
    raw: unknown,
    expected: { mode: "purchase" | "recycle"; quoteId?: string },
): ParsedCarrierEcho {
    if (!isPlainObject(raw)) throw new Error("carrier echo must be an object");
    if (raw.mode !== expected.mode) throw new Error("carrier echo mode differs from the request");
    const keys = new Set(Object.keys(raw));
    const base = new Set([
        "mode",
        "physical_sats",
        "loan_sats",
        "receipt_sats",
        "service_fare_sats",
        "priced_sats",
        "expires_at",
    ]);
    const allowed = expected.mode === "recycle" ? new Set([...base, "quote_id"]) : base;
    for (const k of keys) {
        if (!allowed.has(k)) throw new Error("carrier echo carries unknown field " + k);
    }
    for (const k of allowed) {
        if (!keys.has(k)) throw new Error("carrier echo is missing " + k);
    }
    const r = raw as Record<string, unknown>;
    let quoteId: string | undefined;
    if (expected.mode === "recycle") {
        const qid = r.quote_id;
        if (typeof qid !== "string" || !qid.length || qid.length > CARRIER_QUOTE_ID_MAX) {
            throw new Error("carrier echo quote_id must be 1..128 chars");
        }
        if (qid !== expected.quoteId)
            throw new Error("carrier echo quote_id differs from the request");
        quoteId = qid;
    }
    const physical = parseSatsField(r.physical_sats, "physical_sats");
    const loan = parseSatsField(r.loan_sats, "loan_sats");
    const receipt = parseSatsField(r.receipt_sats, "receipt_sats");
    const serviceFare = parseSatsField(r.service_fare_sats, "service_fare_sats");
    const priced = parseSatsField(r.priced_sats, "priced_sats");
    const expiresAt = parseExpiresAt(r.expires_at);
    if (physical <= 0n) throw new Error("carrier echo physical_sats must be positive");
    if (expected.mode === "purchase") {
        if (loan !== 0n || receipt !== 0n || serviceFare !== 0n) {
            throw new Error("carrier purchase echo must carry zero loan/receipt/fare");
        }
        if (priced !== physical) throw new Error("carrier purchase priced must equal physical");
    } else {
        if (loan <= 0n || receipt <= 0n) {
            throw new Error("carrier recycle echo needs positive loan and receipt");
        }
        const full = loan + receipt;
        if (full > MAX_BITCOIN_SATS) {
            throw new Error("carrier echo loan+receipt exceeds the Bitcoin supply");
        }
        if (full !== physical) {
            throw new Error("carrier echo loan+receipt must equal physical");
        }
        const pricedSum = receipt + serviceFare;
        if (pricedSum > MAX_BITCOIN_SATS) {
            throw new Error("carrier echo priced sum exceeds the Bitcoin supply");
        }
        if (priced !== pricedSum) {
            throw new Error("carrier echo priced must equal receipt+serviceFare");
        }
    }
    return {
        mode: expected.mode,
        physicalSats: physical,
        loanSats: loan,
        receiptSats: receipt,
        serviceFareSats: serviceFare,
        pricedSats: priced,
        expiresAt,
        ...(quoteId !== undefined ? { quoteId } : {}),
    };
}

export function assertRecycleEchoMatchesExpected(
    echo: ParsedCarrierEcho,
    expected: RecycleCarrierQuote,
): void {
    if (echo.mode !== "recycle" || echo.quoteId !== expected.quoteId) {
        throw new Error("carrier echo quote differs from the expected descriptor");
    }
    if (
        echo.physicalSats !== expected.physicalSats ||
        echo.loanSats !== expected.loanSats ||
        echo.receiptSats !== expected.receiptSats ||
        echo.serviceFareSats !== expected.serviceFareSats ||
        echo.pricedSats !== expected.receiptSats + expected.serviceFareSats
    ) {
        throw new Error("carrier echo amounts differ from the expected descriptor");
    }
    if (echo.expiresAt > expected.expiresAt) {
        throw new Error("carrier echo must not extend the expected expiry");
    }
}

export const carrierNow = (now?: number): number => now ?? Math.floor(Date.now() / 1000);

export const normalizeXonlyHex = (value: Uint8Array | string): string => {
    const encoded = typeof value === "string" ? value : hex.encode(value);
    if (!XONLY_HEX.test(encoded)) throw new Error("expected lowercase x-only hex");
    return encoded;
};
