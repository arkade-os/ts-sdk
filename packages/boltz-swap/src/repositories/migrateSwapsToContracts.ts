import { ArkInfo, IContractManager } from "@arkade-os/sdk";
import { logger } from "../logger";
import { BoltzSwap } from "../types";
import { registerSwapContract } from "../utils/swap-contract";
import { SwapRepository } from "./swap-repository";

export type MigrateSwapsToContractsDeps = {
    swapRepository: SwapRepository;
    contractManager: IContractManager;
    arkInfo: ArkInfo;
    isTerminal: (swap: BoltzSwap) => boolean;
};

export type MigrateSwapsToContractsResult = {
    migrated: number;
    failed: number;
};

/**
 * One-shot migration: registers all in-flight (non-terminal) swaps as tracked
 * contracts in the SDK's ContractManager.
 *
 * Idempotent: ContractManager.createContract deduplicates on script, so running
 * this multiple times for the same swap is safe.
 *
 * Per-swap errors are caught and counted rather than aborting the whole run.
 * A swap whose VHTLC cannot be reconstructed (e.g. resolveSwapVhtlc throws
 * because the lockup predates a pruned deprecated signer) is logged and skipped
 * so the remaining swaps still get registered.
 *
 * Processing is sequential to avoid a thundering-herd on the indexer at startup
 * (createContract fetches VTXOs per contract).
 */
export const migrateSwapsToContracts = async (
    deps: MigrateSwapsToContractsDeps,
): Promise<MigrateSwapsToContractsResult> => {
    const { swapRepository, contractManager, arkInfo, isTerminal } = deps;

    const allSwaps = await swapRepository.getAllSwaps();
    const inFlight = allSwaps.filter((swap) => !isTerminal(swap));

    let migrated = 0;
    let failed = 0;

    for (const swap of inFlight) {
        try {
            await registerSwapContract(contractManager, swap, arkInfo);
            migrated++;
        } catch (err) {
            logger.error(
                `migrateSwapsToContracts: failed to register contract for swap ${swap.id}:`,
                err,
            );
            failed++;
        }
    }

    return { migrated, failed };
};
