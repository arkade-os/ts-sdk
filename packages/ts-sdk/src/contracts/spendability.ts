import { contractHandlers } from "./handlers";
import type { Contract } from "./types";

/**
 * Whether generic wallet spending may select this contract's VTXOs.
 *
 * Default closed: a type whose handler declares nothing — a custom type, a
 * plugin type, a row whose handler is not registered in this context — is not
 * spendable. Every shipped handler answers explicitly.
 *
 * @see ContractHandler.isGenericallySpendable
 */
export function isContractGenericallySpendable(contract: Contract): boolean {
    return contractHandlers.get(contract.type)?.isGenericallySpendable?.(contract) === true;
}

/**
 * The contracts generic spending must skip, as `script → type`. VTXOs are keyed
 * to their contract by `script`, so membership answers the per-VTXO question too.
 */
export function gatedContracts(contracts: readonly Contract[]): Map<string, string> {
    const gated = new Map<string, string>();
    for (const contract of contracts) {
        if (!isContractGenericallySpendable(contract)) gated.set(contract.script, contract.type);
    }
    return gated;
}

/** The minimum a VTXO must carry to be matched against an exclusion set. */
export type ExcludableVtxo = { txid: string; vout: number; script?: string };

/**
 * Why generic spending skips a VTXO, or `undefined` when it does not — phrased
 * to follow the outpoint in a log line.
 *
 * Generic spending applies three exclusions (the contract gate, pending
 * recovery, intent locks) that key on different things — script, script,
 * outpoint. Stating each as a reason-or-undefined lets all three report through
 * one path, so no exclusion can drop a coin silently while another logs.
 */
export type VtxoExclusion = (vtxo: ExcludableVtxo) => string | undefined;

/**
 * The contract gate as an exclusion, naming why it closed: a handler ran and
 * declined, or this build has no handler for the type at all.
 *
 * The two want opposite reactions from whoever reads the log. A decline is
 * the gate working as designed — nothing to do. A missing handler means a
 * contract row this build cannot interpret, e.g. a vendoring or version
 * mismatch, which is worth a reader's attention. `contractHandlers` is
 * already available here, so the message can tell them apart instead of
 * collapsing both into one sentence that reads as the same case either way.
 */
export function gateExclusion(gated: ReadonlyMap<string, string>): VtxoExclusion {
    return (vtxo) => {
        const type = vtxo.script === undefined ? undefined : gated.get(vtxo.script);
        if (type === undefined) return undefined;
        // A handler present but declaring no `isGenericallySpendable` predicate
        // reads the same as an explicit decline here: both are this build
        // recognizing the type and landing on "closed", not failing to
        // interpret the row. Splitting that case out further would flag a
        // plugin-authoring gap, not something an operator can act on.
        if (!contractHandlers.has(type)) {
            return `at ${vtxo.script} (contract type '${type}') has no handler registered in this build`;
        }
        return `at ${vtxo.script} (contract type '${type}') is not generically spendable`;
    };
}

/** Outpoints excluded for a shared reason, e.g. an intent-lock set. */
export function outpointExclusion(outpoints: ReadonlySet<string>, reason: string): VtxoExclusion {
    return (vtxo) => (outpoints.has(`${vtxo.txid}:${vtxo.vout}`) ? reason : undefined);
}

/**
 * Outpoints excluded for individually-named reasons — a per-input timelock,
 * where one shared reason would be wrong because the inputs differ.
 *
 * Unlike {@link gateExclusion}, the reasons are the handlers' own sentences and
 * are not rephrased to follow the outpoint: that text is what tells the reader
 * when to retry, and a paraphrase here would be a second spelling to keep in
 * step with it.
 *
 * @see outpointExclusion for the shared-reason form.
 */
export function outpointReasons(reasons: ReadonlyMap<string, string>): VtxoExclusion {
    return (vtxo) => reasons.get(`${vtxo.txid}:${vtxo.vout}`);
}

/**
 * Report VTXOs an exclusion dropped — the only field-diagnosable signal for why
 * a coin is missing from a spend, or why an explicitly named one will fail.
 * Debug level, one line per VTXO per reason.
 */
export function logExcludedVtxos(
    source: string,
    vtxos: readonly ExcludableVtxo[],
    exclusions: readonly VtxoExclusion[],
): void {
    if (exclusions.length === 0) return;
    for (const vtxo of vtxos) {
        for (const exclusion of exclusions) {
            const reason = exclusion(vtxo);
            if (reason === undefined) continue;
            console.debug(`[spendability] ${source}: ${vtxo.txid}:${vtxo.vout} ${reason}`);
        }
    }
}

/**
 * Thrown when a spend names VTXOs whose contract can no longer be annotated —
 * its handler is not registered here, its handler rejects the stored params, or
 * it has no contract row at all.
 *
 * Raised before submission on purpose. Spending reads the tapscripts stored on
 * each coin rather than re-deriving them, so such a spend would otherwise build
 * and broadcast normally and only fail in the bookkeeping afterwards, leaving
 * the transaction on the network and the local state behind it.
 */
export class UnannotatableInputError extends Error {
    readonly name = "UnannotatableInputError";
}
