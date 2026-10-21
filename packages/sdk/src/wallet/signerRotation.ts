import { hex } from "@scure/base";
import type { ArkadeInfo } from "../providers/ark";
import { toXOnly } from "../utils/keys";

/**
 * Classification of a contract's server signer against a fresh {@link ArkadeInfo} snapshot.
 * Always derived at read time from `params.serverPubKey` and the advertised signer set; no
 * stale-key metadata is persisted.
 *
 * - `CURRENT`: minted under the active signer; no migration needed.
 * - `MIGRATABLE`: signer deprecated, cutoff not passed; cooperative migration still possible.
 * - `DUE_NOW`: signer deprecated with no cutoff (arkd advertises `0n`); migrate immediately.
 * - `EXPIRED`: signer deprecated, cutoff passed; cooperative migration closed. NOT stranded:
 *   the server sweeps the batch at expiry and the swept VTXO recovers into the active signer via
 *   the normal recovery settle. Unilateral exit stays an opt-in escape hatch.
 * - `UNKNOWN_SIGNER`: neither active nor advertised deprecated; the SDK does not migrate these.
 */
export type SignerStatus = "CURRENT" | "MIGRATABLE" | "DUE_NOW" | "EXPIRED" | "UNKNOWN_SIGNER";

/** Result of classifying one contract's server signer. */
export interface SignerClassification {
    status: SignerStatus;
    /** The contract's server signer, normalized to x-only (32-byte) hex. */
    signerPubKey: string;
    /** Absolute cutoff (Unix seconds), present only when advertised for this deprecated signer. */
    cutoffDate?: bigint;
    /**
     * `cutoffDate - now` in seconds, present only for `MIGRATABLE`/`EXPIRED`; negative once
     * passed.
     */
    secondsUntilCutoff?: number;
}

/**
 * The server's signer set, pre-normalized to x-only hex, built once per pass via
 * {@link signerSetFromInfo}.
 */
export interface SignerSet {
    /** Active signer, x-only (32-byte) hex. */
    active: string;
    /**
     * Deprecated signers (x-only hex) → cutoff; `0n` means none advertised (→ `DUE_NOW`).
     *
     * Read-only: the wallet hands out its live `_deprecatedSigners`, which drives coin selection
     * and the pendingRecovery balance bucket. Never write through it.
     */
    deprecated: ReadonlyMap<string, bigint>;
}

/**
 * Normalize a server signer pubkey hex to the lowercase x-only (32-byte) form of
 * `params.serverPubKey`; arkd may advertise signers compressed (33 bytes).
 */
export function toXOnlySignerHex(pubkeyHex: string): string {
    const bytes = hex.decode(pubkeyHex);
    if (bytes.length === 32 || bytes.length === 33) return hex.encode(toXOnly(bytes, "signer key"));
    throw new Error(`invalid signer pubkey length: expected 32 or 33 bytes, got ${bytes.length}`);
}

/** Build the {@link SignerSet} from a server-info snapshot, skipping empty deprecated pubkeys. */
export function signerSetFromInfo(info: ArkadeInfo): SignerSet {
    const active = toXOnlySignerHex(info.signerPubkey);
    const deprecated = new Map<string, bigint>();
    for (const signer of info.deprecatedSigners) {
        if (!signer.pubkey) continue;
        deprecated.set(toXOnlySignerHex(signer.pubkey), signer.cutoffDate);
    }
    return { active, deprecated };
}

/**
 * Classify a contract's server signer against a pre-built {@link SignerSet}.
 *
 * @param contractServerPubKeyHex - the contract's `params.serverPubKey`
 * @param nowSeconds - current Unix time in seconds, compared against the cutoff
 */
export function classifyAgainstSignerSet(
    contractServerPubKeyHex: string,
    signerSet: SignerSet,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): SignerClassification {
    const signerPubKey = toXOnlySignerHex(contractServerPubKeyHex);

    if (signerPubKey === signerSet.active) {
        return { status: "CURRENT", signerPubKey };
    }

    if (!signerSet.deprecated.has(signerPubKey)) {
        return { status: "UNKNOWN_SIGNER", signerPubKey };
    }

    // `0n` is arkd's "no cutoff advertised" sentinel → due immediately.
    const cutoffDate = signerSet.deprecated.get(signerPubKey)!;
    if (cutoffDate === 0n) {
        return { status: "DUE_NOW", signerPubKey };
    }

    const secondsUntilCutoff = Number(cutoffDate) - nowSeconds;
    if (secondsUntilCutoff <= 0) {
        return { status: "EXPIRED", signerPubKey, cutoffDate, secondsUntilCutoff };
    }
    return { status: "MIGRATABLE", signerPubKey, cutoffDate, secondsUntilCutoff };
}

/**
 * Classify one contract signer against {@link ArkadeInfo}. For many contracts, prefer
 * {@link classifyAgainstSignerSet} with a shared signer set.
 */
export function classifyContractSigner(
    contractServerPubKeyHex: string,
    info: ArkadeInfo,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): SignerClassification {
    return classifyAgainstSignerSet(contractServerPubKeyHex, signerSetFromInfo(info), nowSeconds);
}

/** Whether a `settle()` migration intent should be built for VTXOs under this signer status. */
export function isCooperativelyMigratable(status: SignerStatus): boolean {
    return status === "MIGRATABLE" || status === "DUE_NOW";
}
