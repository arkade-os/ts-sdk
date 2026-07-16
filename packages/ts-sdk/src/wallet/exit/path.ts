import { hex } from "@scure/base";
import { contractHandlers } from "../../contracts/handlers";
import { PathSelection } from "../../contracts/types";
import { ContractRepository } from "../../repositories/contractRepository";
import { VtxoScript } from "../../script/base";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";

export type ResolvedExitPath = { selection: PathSelection; label: string };

export class ExitPathError extends Error {
    constructor(
        readonly reason: "no-unilateral-path" | "no-handler" | "additional-signers",
        message: string,
    ) {
        super(message);
        this.name = "ExitPathError";
    }
}

/** Delay in "blocks-equivalent" for comparison only (seconds ≈ /600). */
function delayWeight(sequence: number): number {
    const t = sequenceToTimelock(sequence);
    return t.type === "blocks" ? Number(t.value) : Number(t.value) / 600;
}

/**
 * Resolve the unilateral spending path to pre-sign a VTXO's exit sweep with.
 *
 * Contract-aware: when the VTXO belongs to a known contract, the contract
 * handler enumerates candidate paths via `getAllSpendingPaths` with
 * `collaborative: false`. Deliberately NOT `getSpendablePaths`/`selectPath`:
 * those gate on *current* CSV spendability, but at prepare time the CSV
 * clock has not started (the leaf tx is not even onchain yet). Pre-signing
 * needs "paths that will become valid" — the no-timelock-checks variant.
 *
 * VTXOs without a contract row fall back to scanning the tap tree's exit
 * paths, mirroring the historical `completeUnroll` behavior.
 */
export async function resolveUnilateralPath(params: {
    vtxo: { txid: string; vout: number; tapTree: Uint8Array };
    scriptHex: string;
    contractRepository?: ContractRepository;
    walletDescriptor?: string;
    walletPubKeyHex?: string;
    currentTime: number;
}): Promise<ResolvedExitPath> {
    const { vtxo, scriptHex, contractRepository } = params;

    const contract = contractRepository
        ? (await contractRepository.getContracts({ script: scriptHex }))[0]
        : undefined;

    if (contract) {
        const handler = contractHandlers.get(contract.type);
        if (!handler) {
            throw new ExitPathError(
                "no-handler",
                `no contract handler registered for type '${contract.type}'`,
            );
        }
        const script = handler.createScript(contract.params);
        const paths = handler
            .getAllSpendingPaths(script, contract, {
                collaborative: false,
                currentTime: params.currentTime,
                walletDescriptor: params.walletDescriptor,
                walletPubKey: params.walletPubKeyHex,
            })
            .filter((p) => p.sequence !== undefined);
        if (paths.length === 0) {
            throw new ExitPathError(
                "no-unilateral-path",
                `no unilateral path for vtxo ${vtxo.txid}:${vtxo.vout} (type '${contract.type}')`,
            );
        }
        paths.sort((a, b) => delayWeight(a.sequence!) - delayWeight(b.sequence!));
        return { selection: paths[0], label: `${contract.type}:unilateral` };
    }

    // Legacy fallback: no contract row — scan the tap tree like completeUnroll did.
    const decoded = VtxoScript.decode(vtxo.tapTree);
    let best: { selection: PathSelection; weight: number } | undefined;
    for (const exit of decoded.exitPaths()) {
        const leaf = decoded.findLeaf(hex.encode(exit.script));
        if (!leaf) continue;
        const sequence = timelockToSequence(exit.params.timelock);
        const weight = delayWeight(sequence);
        if (!best || weight < best.weight) {
            best = { selection: { leaf, sequence }, weight };
        }
    }
    if (!best) {
        throw new ExitPathError(
            "no-unilateral-path",
            `no exit path found for vtxo ${vtxo.txid}:${vtxo.vout}`,
        );
    }
    return { selection: best.selection, label: "default:exit" };
}
