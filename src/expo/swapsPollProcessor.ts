import type { TaskItem, TaskResult } from "@arkade-os/sdk/worker/expo";
import type { TaskProcessor } from "@arkade-os/sdk/worker/expo";
import type { SwapTaskDependencies } from "./types";
import {
    isPendingReverseSwap,
    isPendingSubmarineSwap,
    isReverseClaimableStatus,
    isReverseFinalStatus,
    isSubmarineFinalStatus,
    isSubmarineSwapRefundable,
} from "../boltz-swap-provider";
import { ArkadeSwaps } from "../arkade-swaps";
import { logger } from "../logger";

/**
 * Task type identifier for {@link swapsPollProcessor}.
 */
export const SWAP_POLL_TASK_TYPE = "swap-poll";

/**
 * Stateless processor that polls Boltz for swap status updates and
 * attempts best-effort claim/refund for actionable swaps.
 *
 * Designed for Expo background tasks (~30s window) and follows the
 * same `TaskProcessor` pattern as `contractPollProcessor` in ts-sdk.
 *
 * Steps:
 * 1. Read all non-final swaps from SwapRepository
 * 2. Poll Boltz HTTP API for each swap's current status
 * 3. Persist status changes immediately
 * 4. For actionable statuses: attempt claimVHTLC / refundVHTLC (best-effort)
 * 5. Return summary metrics
 */
export const swapsPollProcessor: TaskProcessor<SwapTaskDependencies> = {
    taskType: SWAP_POLL_TASK_TYPE,

    async execute(
        item: TaskItem,
        deps: SwapTaskDependencies
    ): Promise<Omit<TaskResult, "id" | "executedAt">> {
        const {
            swapRepository,
            swapProvider,
            wallet,
            arkProvider,
            indexerProvider,
        } = deps;

        const allSwaps = await swapRepository.getAllSwaps();

        // Filter to non-final swaps
        const pendingSwaps = allSwaps.filter((swap) => {
            if (isPendingReverseSwap(swap))
                return !isReverseFinalStatus(swap.status);
            if (isPendingSubmarineSwap(swap))
                return !isSubmarineFinalStatus(swap.status);
            return false;
        });

        let polled = 0;
        let updated = 0;
        let claimed = 0;
        let refunded = 0;
        let errors = 0;

        // Create a temporary ArkadeSwaps without SwapManager for claim/refund logic
        const tempSwaps = new ArkadeSwaps({
            wallet,
            arkProvider,
            indexerProvider,
            swapProvider,
            swapManager: false,
            swapRepository,
        });

        try {
            for (const swap of pendingSwaps) {
                try {
                    const { status: currentStatus } =
                        await swapProvider.getSwapStatus(swap.id);
                    polled++;

                    // Persist status change if different
                    if (currentStatus !== swap.status) {
                        await swapRepository.saveSwap({
                            ...swap,
                            status: currentStatus,
                        });
                        updated++;
                    }

                    // Attempt claim for reverse swaps with claimable status
                    if (
                        isPendingReverseSwap(swap) &&
                        isReverseClaimableStatus(currentStatus)
                    ) {
                        // Skip restored swaps without preimage
                        if (!swap.preimage) {
                            logger.warn(
                                `[swap-poll] Skipping claim for ${swap.id}: no preimage`
                            );
                            continue;
                        }

                        try {
                            await tempSwaps.claimVHTLC(swap);
                            claimed++;
                        } catch (claimError) {
                            logger.error(
                                `[swap-poll] Claim failed for ${swap.id}:`,
                                claimError
                            );
                            errors++;
                        }
                    }

                    // Attempt refund for submarine swaps with refundable status
                    const swapWithStatus = isPendingSubmarineSwap(swap)
                        ? { ...swap, status: currentStatus }
                        : null;
                    if (
                        isPendingSubmarineSwap(swap) &&
                        isSubmarineSwapRefundable(swapWithStatus!)
                    ) {
                        // Skip restored swaps without invoice or preimageHash
                        if (!swap.request.invoice && !swap.preimageHash) {
                            logger.warn(
                                `[swap-poll] Skipping refund for ${swap.id}: no invoice or preimageHash`
                            );
                            continue;
                        }

                        try {
                            await tempSwaps.refundVHTLC(swapWithStatus!);
                            refunded++;
                        } catch (refundError) {
                            logger.error(
                                `[swap-poll] Refund failed for ${swap.id}:`,
                                refundError
                            );
                            errors++;
                        }
                    }
                } catch (swapError) {
                    logger.error(
                        `[swap-poll] Error processing swap ${swap.id}:`,
                        swapError
                    );
                    errors++;
                }
            }
        } finally {
            await tempSwaps.dispose();
        }

        return {
            taskItemId: item.id,
            type: SWAP_POLL_TASK_TYPE,
            status: errors > 0 && polled === 0 ? "failed" : "success",
            data: { polled, updated, claimed, refunded, errors },
        };
    },
};
