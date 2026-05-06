import type { ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import type { WalletRepository } from "../repositories/walletRepository";
import type { Contract } from "./types";

/**
 * Tier 1 helpers that enforce VTXO ownership at call sites that already know
 * the intended contract script. Address-keyed repositories may still hand back
 * legacy duplicate rows under the wrong bucket; these helpers gate reads and
 * writes so a wrong-script row never wins.
 *
 * `script` is the authoritative ownership key. Equality is strict: a missing
 * or empty `vtxo.script` never matches.
 */

export function vtxoOutpoint(vtxo: Pick<VirtualCoin, "txid" | "vout">): string {
    return `${vtxo.txid}:${vtxo.vout}`;
}

export function isVtxoForScript(
    vtxo: Pick<VirtualCoin, "script">,
    script: string
): boolean {
    return !!vtxo.script && vtxo.script === script;
}

export function filterVtxosForScript<T extends Pick<VirtualCoin, "script">>(
    vtxos: T[],
    script: string
): T[] {
    return vtxos.filter((v) => isVtxoForScript(v, script));
}

/**
 * Background/indexer sync flavour: drop wrong-script rows and log enough
 * context to identify each rejection. Returns only matching rows so the
 * caller can keep going.
 */
export function warnAndFilterVtxosForScript<
    T extends Pick<VirtualCoin, "txid" | "vout" | "script">,
>(vtxos: T[], script: string, context: string): T[] {
    const matches: T[] = [];
    const rejected: string[] = [];
    for (const v of vtxos) {
        if (isVtxoForScript(v, script)) {
            matches.push(v);
        } else {
            rejected.push(`${vtxoOutpoint(v)}(script=${v.script ?? ""})`);
        }
    }
    if (rejected.length > 0) {
        console.warn(
            `${context}: dropped ${rejected.length} wrong-script VTXO(s) for script ${script}: ${rejected.join(", ")}`
        );
    }
    return matches;
}

/**
 * User-initiated transaction/signing flavour: throw before persisting or
 * signing inconsistent ownership state. Silently skipping here would hide a
 * serious bug in the wallet's spend path.
 */
export function validateVtxosForScript(
    vtxos: Array<Pick<VirtualCoin, "txid" | "vout" | "script">>,
    script: string,
    context: string
): void {
    const mismatches = vtxos.filter((v) => !isVtxoForScript(v, script));
    if (mismatches.length === 0) return;
    const detail = mismatches
        .map((v) => `${vtxoOutpoint(v)}(script=${v.script ?? ""})`)
        .join(", ");
    throw new Error(
        `${context}: refusing to persist ${mismatches.length} VTXO(s) whose script does not match ${script}: ${detail}`
    );
}

/**
 * Tier 2 dispatch helpers: route to script-scoped repository methods when
 * available, falling back to Tier 1 address-based filtering otherwise.
 */
export async function getVtxosForContract(
    repo: WalletRepository,
    contract: Pick<Contract, "script" | "address">
): Promise<ExtendedVirtualCoin[]> {
    return repo.getVtxosForScript
        ? repo.getVtxosForScript(contract.script)
        : filterVtxosForScript(
              await repo.getVtxos(contract.address),
              contract.script
          );
}

export async function saveVtxosForContract(
    repo: WalletRepository,
    contract: Pick<Contract, "script" | "address">,
    vtxos: ExtendedVirtualCoin[]
): Promise<void> {
    return repo.saveVtxosForScript
        ? repo.saveVtxosForScript(
              { script: contract.script, address: contract.address },
              vtxos
          )
        : repo.saveVtxos(contract.address, vtxos);
}
