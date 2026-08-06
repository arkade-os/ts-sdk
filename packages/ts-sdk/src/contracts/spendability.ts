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

/**
 * Report VTXOs the gate excluded — the only field-diagnosable signal that this
 * is what dropped a coin from a spend. Debug level, one line per VTXO.
 */
export function logGatedVtxos(
    source: string,
    vtxos: readonly { txid: string; vout: number; script?: string }[],
    gated: ReadonlyMap<string, string>,
): void {
    if (gated.size === 0) return;
    for (const vtxo of vtxos) {
        const type = vtxo.script === undefined ? undefined : gated.get(vtxo.script);
        if (type === undefined) continue;
        console.debug(
            `[spendability] ${source}: ${vtxo.txid}:${vtxo.vout} at ${vtxo.script} (contract type '${type}') is not generically spendable`,
        );
    }
}
