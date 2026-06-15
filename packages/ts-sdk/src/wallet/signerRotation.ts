import { hex } from "@scure/base";
import type { ArkInfo } from "../providers/ark";

/**
 * Machine-readable classification of a contract's server signer relative to a
 * fresh {@link ArkInfo} snapshot. Drives both the migration selection (Section
 * 3) and the user-facing cutoff reporting (Section 6) without persisting any
 * stale-key metadata: staleness is always derived at read time from the
 * contract's `params.serverPubKey` plus the server's advertised signer set.
 *
 * - `CURRENT`: the contract was minted under the server's active signer; no
 *   migration needed.
 * - `MIGRATABLE`: the contract's signer is advertised as deprecated and its
 *   cutoff has not passed — cooperative migration is still possible.
 * - `DUE_NOW`: the contract's signer is advertised as deprecated with no cutoff
 *   date (arkd advertises this as a `0n` cutoff), so migration should start
 *   immediately.
 * - `EXPIRED`: the contract's signer is deprecated and its cutoff has passed —
 *   cooperative migration is closed. These funds are NOT stranded: the VTXO
 *   keeps its own batch expiry, the server sweeps that batch at expiry, and the
 *   swept VTXO then recovers into the active signer through the normal recovery
 *   settle (no deprecated key, no forfeit, no on-chain exit). Unilateral exit
 *   remains an opt-in escape hatch, not a requirement (Section 6 / post-cutoff).
 * - `UNKNOWN_SIGNER`: the contract's signer is neither the active signer nor an
 *   advertised deprecated signer. The SDK does not attempt to migrate these.
 */
export type SignerStatus = "CURRENT" | "MIGRATABLE" | "DUE_NOW" | "EXPIRED" | "UNKNOWN_SIGNER";

/**
 * Result of classifying a single contract's server signer against the current
 * {@link ArkInfo} signer set.
 */
export interface SignerClassification {
    status: SignerStatus;
    /** The contract's server signer, normalized to x-only (32-byte) hex. */
    signerPubKey: string;
    /**
     * Absolute cutoff as a Unix timestamp in seconds, present only when the
     * server advertised one for this deprecated signer.
     */
    cutoffDate?: bigint;
    /**
     * Derived seconds until the advertised cutoff (`cutoffDate - now`), present
     * only for `MIGRATABLE`/`EXPIRED` (i.e. an advertised cutoff exists).
     * Negative once the cutoff has passed.
     */
    secondsUntilCutoff?: number;
}

/**
 * The server's signer set, pre-normalized to x-only hex for cheap repeated
 * lookups. Built once per migration/reporting pass from a fresh
 * {@link ArkInfo} snapshot via {@link signerSetFromInfo}.
 */
export interface SignerSet {
    /** Active signer, x-only (32-byte) hex. */
    active: string;
    /**
     * Deprecated signers keyed by x-only hex, mapped to their cutoff. The cutoff
     * is always a bigint (arkd advertises it non-nullable); `0n` means "no cutoff
     * advertised" (→ `DUE_NOW`).
     */
    deprecated: Map<string, bigint>;
}

/**
 * Normalize a server signer pubkey hex to the x-only (32-byte) form contract
 * scripts and `params.serverPubKey` use. A 33-byte compressed key drops its
 * parity prefix; a 32-byte key is canonicalized to lowercase. Mirrors the
 * wallet's `hex.decode(info.signerPubkey).slice(1)` setup path so the active
 * signer and the deprecated signers (which arkd may advertise compressed)
 * compare equal to the x-only `params.serverPubKey` persisted on contracts.
 */
export function toXOnlySignerHex(pubkeyHex: string): string {
    const bytes = hex.decode(pubkeyHex);
    if (bytes.length === 33) return hex.encode(bytes.slice(1));
    if (bytes.length === 32) return hex.encode(bytes);
    throw new Error(`invalid signer pubkey length: expected 32 or 33 bytes, got ${bytes.length}`);
}

/**
 * Build the {@link SignerSet} from a server-info snapshot. Deprecated signers
 * with an empty pubkey are skipped.
 */
export function signerSetFromInfo(info: ArkInfo): SignerSet {
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
 * @param signerSet - the server's signer set
 * @param nowSeconds - current Unix time in seconds (compared against the
 *   advertised cutoff). Defaults to `Math.floor(Date.now() / 1000)`.
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

    // `.has()` above guarantees a value; `0n` is arkd's sentinel for "no cutoff
    // advertised" → due for migration immediately.
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
 * Convenience wrapper that builds the signer set from {@link ArkInfo} and
 * classifies a single contract signer. Prefer {@link classifyAgainstSignerSet}
 * with a shared signer set when classifying many contracts in one pass.
 */
export function classifyContractSigner(
    contractServerPubKeyHex: string,
    info: ArkInfo,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): SignerClassification {
    return classifyAgainstSignerSet(contractServerPubKeyHex, signerSetFromInfo(info), nowSeconds);
}

/**
 * Whether a signer status admits cooperative migration (i.e. a `settle()`
 * intent should be built for VTXOs under this signer). True for `MIGRATABLE`
 * and `DUE_NOW`; false for `CURRENT`, `EXPIRED`, and `UNKNOWN_SIGNER`.
 */
export function isCooperativelyMigratable(status: SignerStatus): boolean {
    return status === "MIGRATABLE" || status === "DUE_NOW";
}
