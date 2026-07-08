import { NetworkName } from "../../networks";

/** Relative delay before a sweep becomes valid, decoded from BIP-68. */
export type ExitDelay = { type: "blocks" | "seconds"; value: number };

/** Broadcast a single pre-signed transaction (the funding splitter). */
export type BroadcastStep = { kind: "broadcast"; txid: string; hex: string };

/** Broadcast a 1P1C package: virtual tx + its pre-signed CPFP fee child. */
export type PackageStep = {
    kind: "package";
    parentTxid: string;
    parentHex: string;
    childTxid: string;
    childHex: string;
    /** Outpoints (txid:vout) of the VTXOs this step serves. */
    forVtxos: string[];
};

/**
 * A virtual tx that must go onchain but whose CPFP fee child is NOT
 * pre-signed (graph mode). The executor builds and signs the child at
 * execution time using its own fee wallet — this is how "send funds to
 * this address and we proceed" works: funding is deferred, not baked in.
 */
export type BumpStep = {
    kind: "bump";
    parentTxid: string;
    parentHex: string;
    /** Outpoints (txid:vout) of the VTXOs this step serves. */
    forVtxos: string[];
};

/** Broadcast a pre-signed CSV sweep once its dependency matured. */
export type SweepStep = {
    kind: "sweep";
    vtxo: string;
    txid: string;
    hex: string;
    /** The VTXO-creating leaf tx whose confirmation starts the CSV clock. */
    dependsOnTxid: string;
    delay: ExitDelay;
};

export type ExitStep = BroadcastStep | PackageStep | BumpStep | SweepStep;

/**
 * How fee funding is provided:
 * - `"funded"`: a splitter tx (broadcast at prepare time) pre-funds
 *   pre-signed fee children — execution is fully keyless.
 * - `"graph"`: only the tx graph + sweeps are transported; the executor
 *   funds and signs the CPFP bumps at execution time from its own fee
 *   wallet ("send funds to this address and we proceed").
 */
export type ExitMode = "funded" | "graph";

/** Per-VTXO metadata; skipped VTXOs carry a human-readable reason. */
export type ExitVtxoInfo = {
    outpoint: string;
    value?: number;
    sweepFee?: number;
    /** `${contractType}:${pathLabel}` for observability, e.g. "vhtlc:unilateral". */
    path?: string;
    delay?: ExitDelay;
    skipped?: string;
};

export type ExitTotals = {
    /** Distinct transactions the executor ensures onchain. */
    txCount: number;
    totalFeeSats: number;
    /** Sats consumed from the onchain wallet by the splitter (fees + funding outputs). */
    fundingRequiredSats: number;
    /** Sats arriving at the sweep address once all sweeps confirm. */
    recoveredSats: number;
};

/**
 * Versioned, language-agnostic unilateral exit package.
 * Everything inside is pre-signed; executing it requires no keys and no
 * Arkade infrastructure — only an Esplora-compatible API.
 */
export type ExitPackage = {
    version: 1;
    /** Fee-funding strategy. Absent is treated as "funded" (v1 default). */
    mode?: ExitMode;
    network: NetworkName;
    createdAt: number;
    /** Min batch expiry (unix seconds) across included txs. Informational. */
    validUntil?: number;
    feeRate: number;
    sweepAddress: string;
    totals: ExitTotals;
    vtxos: ExitVtxoInfo[];
    /** Topologically ordered: a step's txs confirm before dependents proceed. */
    steps: ExitStep[];
};

/** Cost/size quote returned by `UnilateralExit.estimate` — no funds needed. */
export type ExitQuote = {
    feeRate: number;
    fundingAddress: string;
    currentBalanceSats: number;
    shortfallSats: number;
    validUntil?: number;
    totals: ExitTotals;
    vtxos: ExitVtxoInfo[];
};

export function serializeExitPackage(pkg: ExitPackage): string {
    return JSON.stringify(pkg);
}

export function deserializeExitPackage(json: string): ExitPackage {
    const data = JSON.parse(json);
    if (data?.version !== 1) {
        throw new Error(`unsupported exit package version: ${data?.version}`);
    }
    if (typeof data.network !== "string" || typeof data.sweepAddress !== "string") {
        throw new Error("invalid exit package: missing network or sweepAddress");
    }
    if (typeof data.feeRate !== "number" || typeof data.createdAt !== "number") {
        throw new Error("invalid exit package: missing feeRate or createdAt");
    }
    if (!Array.isArray(data.steps) || !Array.isArray(data.vtxos)) {
        throw new Error("invalid exit package: steps and vtxos must be arrays");
    }
    for (const step of data.steps) {
        if (!isValidStep(step)) {
            throw new Error(`invalid step: ${JSON.stringify(step)}`);
        }
    }
    return data as ExitPackage;
}

function isValidDelay(d: unknown): d is ExitDelay {
    const delay = d as ExitDelay;
    return (
        !!delay &&
        (delay.type === "blocks" || delay.type === "seconds") &&
        typeof delay.value === "number"
    );
}

function isValidStep(step: unknown): step is ExitStep {
    const s = step as ExitStep;
    if (!s || typeof s !== "object") return false;
    switch (s.kind) {
        case "broadcast":
            return typeof s.txid === "string" && typeof s.hex === "string";
        case "package":
            return (
                typeof s.parentTxid === "string" &&
                typeof s.parentHex === "string" &&
                typeof s.childTxid === "string" &&
                typeof s.childHex === "string" &&
                Array.isArray(s.forVtxos)
            );
        case "bump":
            return (
                typeof s.parentTxid === "string" &&
                typeof s.parentHex === "string" &&
                Array.isArray(s.forVtxos)
            );
        case "sweep":
            return (
                typeof s.vtxo === "string" &&
                typeof s.txid === "string" &&
                typeof s.hex === "string" &&
                typeof s.dependsOnTxid === "string" &&
                isValidDelay(s.delay)
            );
        default:
            return false;
    }
}
