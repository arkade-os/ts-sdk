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

/** The contract gate as an exclusion, naming the type that closed it. */
export function gateExclusion(gated: ReadonlyMap<string, string>): VtxoExclusion {
    return (vtxo) => {
        const type = vtxo.script === undefined ? undefined : gated.get(vtxo.script);
        if (type === undefined) return undefined;
        return `at ${vtxo.script} (contract type '${type}') is not generically spendable`;
    };
}

/** Outpoints excluded for a shared reason, e.g. an intent-lock set. */
export function outpointExclusion(outpoints: ReadonlySet<string>, reason: string): VtxoExclusion {
    return (vtxo) => (outpoints.has(`${vtxo.txid}:${vtxo.vout}`) ? reason : undefined);
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
