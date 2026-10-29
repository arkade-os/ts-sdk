/**
 * Rewrites offer rows an SDK before Program v1 stored (0.1.0-rc.31) from the row alone: no swap
 * record, server or wallet key involved. The v0 program string is deterministic — `JSON.stringify`
 * of one of two frozen files, with or without the exit closure — so a row is migrated only by
 * exact match, and `createContract` re-derives the script before replacing it.
 */
import { arkade, type IContractManager, type RelativeTimelock } from "@arkade-os/sdk";

import wantAssetV0 from "./legacy/swap-want-asset.program.v0.json";
import wantBtcV0 from "./legacy/swap-want-btc.program.v0.json";
import { OFFER_CONTRACT_KIND, swapPrograms, withExitClosure } from "./offer";

type ContractManager = Pick<IContractManager, "getUnsupportedContracts" | "createContract">;
type ProgramJson = { params: unknown[]; functions: Record<string, unknown> };

/** `withExitClosure` over plain JSON, matching what a v0 release serialized. */
function withExitV0(program: ProgramJson, exit: RelativeTimelock["type"] | undefined): ProgramJson {
    if (!exit) return program;
    return {
        ...program,
        params: [...program.params, { name: "exitDelay", type: "int" }],
        functions: {
            ...program.functions,
            exit: { tapscript: { signers: ["$user"], csv: { type: exit, value: "$exitDelay" } } },
        },
    };
}

/** v0 program string → the v1 string the record path writes for the same offer. */
const V0_TO_V1 = new Map<string, string>();
for (const [v0, v1] of [
    [wantBtcV0, swapPrograms.wantBtc],
    [wantAssetV0, swapPrograms.wantAsset],
] as const) {
    for (const exit of [undefined, "blocks", "seconds"] as const) {
        // the delay's value is `$exitDelay` in both, so one entry covers every delay
        const timelock = exit && { type: exit, value: BigInt(0) };
        V0_TO_V1.set(
            JSON.stringify(withExitV0(v0, exit)),
            arkade.stringifyArtifact(withExitClosure(v1, timelock)),
        );
    }
}

/**
 * Migrate every unsupported offer row matching a bundled v0 program to v1, in place. Rows of other
 * kinds are left alone and not reported; a second run is a no-op.
 */
export async function migrateV0OfferRows(contractManager: ContractManager): Promise<{
    migrated: string[];
    skipped: { script: string; reason: string }[];
}> {
    const migrated: string[] = [];
    const skipped: { script: string; reason: string }[] = [];
    for (const row of await contractManager.getUnsupportedContracts()) {
        if (row.type !== "arkade" || row.metadata?.kind !== OFFER_CONTRACT_KIND) continue;
        const program = V0_TO_V1.get(row.params.program);
        if (!program) {
            skipped.push({ script: row.script, reason: "not a bundled Program v0 offer" });
            continue;
        }
        try {
            await contractManager.createContract({
                type: row.type,
                script: row.script,
                address: row.address,
                params: { ...row.params, program },
                label: row.label,
                metadata: row.metadata,
            });
            migrated.push(row.script);
        } catch (error) {
            skipped.push({
                script: row.script,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { migrated, skipped };
}
