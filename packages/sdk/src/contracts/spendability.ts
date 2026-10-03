import { contractHandlers } from "./handlers";
import type { Contract } from "./types";

/**
 * Whether generic wallet spending may select this contract's VTXOs. Default closed: a type whose
 * handler declares nothing, or has no handler registered here, is not spendable.
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

/** {@link gatedContracts} over the contract+VTXO snapshot every read path holds. */
export function gatedFrom(snapshot: readonly { contract: Contract }[]): GatedContracts {
    return gatedContracts(snapshot.map((entry) => entry.contract));
}

/** The minimum a VTXO must carry to be matched against an exclusion set. */
export type ExcludableVtxo = { txid: string; vout: number; script?: string };

/** {@link gatedContracts}' answer, as callers that only read it should take it. */
export type GatedContracts = ReadonlyMap<string, string>;

/**
 * The type of the gated contract this VTXO belongs to, or `undefined` when generic spending is
 * open to it. The single spelling of the per-VTXO question. A VTXO with no script is the
 * wallet's own coin.
 *
 * `=== undefined`, not truthiness, so an empty-string script still asks the map (pre-existing
 * semantics, kept because this now decides coin selection and the `available` balance).
 */
function gatedTypeOf(
    vtxo: Pick<ExcludableVtxo, "script">,
    gated: GatedContracts,
): string | undefined {
    return vtxo.script === undefined ? undefined : gated.get(vtxo.script);
}

/** {@link gatedTypeOf} as a predicate, for callers with no use for the type. */
export function isGatedVtxo(vtxo: Pick<ExcludableVtxo, "script">, gated: GatedContracts): boolean {
    return gatedTypeOf(vtxo, gated) !== undefined;
}

/**
 * Why generic spending skips a VTXO, or `undefined` when it does not; phrased to follow the
 * outpoint in a log line. One shape for all exclusions (contract gate, pending recovery, intent
 * locks) so none can drop a coin silently while another logs.
 */
export type VtxoExclusion = (vtxo: ExcludableVtxo) => string | undefined;

/**
 * The contract gate as an exclusion, distinguishing a handler's decline (working as designed)
 * from a missing handler (a row this build can't interpret, e.g. a version mismatch, worth a
 * reader's attention).
 */
export function gateExclusion(gated: GatedContracts): VtxoExclusion {
    return (vtxo) => {
        const type = gatedTypeOf(vtxo, gated);
        if (type === undefined) return undefined;
        // A handler with no `isGenericallySpendable` counts as a decline: not operator-actionable.
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
 * Outpoints excluded for per-input reasons (e.g. a per-input timelock). The handlers' own
 * sentences, unparaphrased: they tell the reader when to retry.
 *
 * @see outpointExclusion for the shared-reason form.
 */
export function outpointReasons(reasons: ReadonlyMap<string, string>): VtxoExclusion {
    return (vtxo) => reasons.get(`${vtxo.txid}:${vtxo.vout}`);
}

/**
 * Report VTXOs an exclusion dropped, the only field-diagnosable signal for a coin missing from a
 * spend. Debug level, one line per VTXO per reason.
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
 * Thrown before submission when a spend names VTXOs whose contract can no longer be annotated
 * (handler unregistered, stored params rejected, or no row). Otherwise the spend would broadcast
 * and fail in the bookkeeping, leaving local state behind the network.
 */
export class UnannotatableInputError extends Error {
    readonly name = "UnannotatableInputError";
}
