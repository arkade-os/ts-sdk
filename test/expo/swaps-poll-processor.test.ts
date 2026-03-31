import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemorySwapRepository } from "../../src/repositories/inMemory/swap-repository";
import {
    swapsPollProcessor,
    SWAP_POLL_TASK_TYPE,
} from "../../src/expo/swapsPollProcessor";
import type { SwapTaskDependencies } from "../../src/expo/types";
import type { BoltzReverseSwap, BoltzSubmarineSwap } from "../../src/types";
import type { BoltzSwapProvider } from "../../src/boltz-swap-provider";
import type { TaskItem } from "@arkade-os/sdk/worker/expo";
import { ArkadeSwaps } from "../../src/arkade-swaps";

// ── Helpers ──────────────────────────────────────────────────────────

const createReverseSwap = (
    id: string,
    status: BoltzReverseSwap["status"],
    preimage = "a".repeat(64)
): BoltzReverseSwap => ({
    id,
    type: "reverse",
    createdAt: Math.floor(Date.now() / 1000),
    preimage,
    status,
    request: {
        claimPublicKey: "0".repeat(66),
        invoiceAmount: 10000,
        preimageHash: "0".repeat(64),
    },
    response: {
        id,
        invoice: "lnbc100n1p0",
        onchainAmount: 10000,
        lockupAddress: "ark1test",
        refundPublicKey: "0".repeat(66),
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createSubmarineSwap = (
    id: string,
    status: BoltzSubmarineSwap["status"],
    opts: { invoice?: string; preimageHash?: string; refundable?: boolean } = {}
): BoltzSubmarineSwap => ({
    id,
    type: "submarine",
    createdAt: Math.floor(Date.now() / 1000),
    status,
    refundable: opts.refundable,
    request: {
        invoice: opts.invoice ?? "lnbc100n1p0",
        refundPublicKey: "0".repeat(66),
    },
    response: {
        id,
        address: "ark1test",
        expectedAmount: 10000,
        claimPublicKey: "0".repeat(66),
        acceptZeroConf: false,
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createTaskItem = (): TaskItem => ({
    id: "task-1",
    type: SWAP_POLL_TASK_TYPE,
    data: {},
    createdAt: Date.now(),
});

// ── Mock ArkadeSwaps to avoid import side effects ────────────────

vi.mock("../../src/arkade-swaps", () => {
    return {
        ArkadeSwaps: vi.fn().mockImplementation(() => ({
            claimVHTLC: vi.fn().mockResolvedValue(undefined),
            refundVHTLC: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn().mockResolvedValue(undefined),
        })),
    };
});

// ── Tests ────────────────────────────────────────────────────────────

describe("swapsPollProcessor", () => {
    let swapRepository: InMemorySwapRepository;
    let mockSwapProvider: Partial<BoltzSwapProvider>;
    let deps: SwapTaskDependencies;

    beforeEach(() => {
        vi.clearAllMocks();
        swapRepository = new InMemorySwapRepository();

        mockSwapProvider = {
            getSwapStatus: vi
                .fn()
                .mockResolvedValue({ status: "swap.created" }),
            getApiUrl: vi.fn().mockReturnValue("http://localhost:9069"),
            getNetwork: vi.fn().mockReturnValue("regtest"),
        };

        deps = {
            swapRepository,
            swapProvider: mockSwapProvider as BoltzSwapProvider,
            arkProvider: {} as any,
            indexerProvider: {} as any,
            identity: {} as any,
            wallet: {} as any,
        };
    });

    it("should have the correct task type", () => {
        expect(swapsPollProcessor.taskType).toBe(SWAP_POLL_TASK_TYPE);
    });

    it("should return success with no swaps", async () => {
        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.status).toBe("success");
        expect(result.data).toEqual({
            polled: 0,
            updated: 0,
            claimed: 0,
            refunded: 0,
            errors: 0,
        });
    });

    it("should skip swaps with final status", async () => {
        // Final reverse statuses
        await swapRepository.saveSwap(
            createReverseSwap("r1", "invoice.settled")
        );
        await swapRepository.saveSwap(
            createReverseSwap("r2", "transaction.refunded")
        );
        // Final submarine statuses
        await swapRepository.saveSwap(
            createSubmarineSwap("s1", "transaction.claimed")
        );
        await swapRepository.saveSwap(
            createSubmarineSwap("s2", "invoice.failedToPay")
        );

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toEqual({
            polled: 0,
            updated: 0,
            claimed: 0,
            refunded: 0,
            errors: 0,
        });
        expect(mockSwapProvider.getSwapStatus).not.toHaveBeenCalled();
    });

    it("should poll non-final swaps", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));
        await swapRepository.saveSwap(createSubmarineSwap("s1", "invoice.set"));

        (mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({ status: "swap.created" })
            .mockResolvedValueOnce({ status: "invoice.set" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 2,
            updated: 0, // no status change
        });
        expect(mockSwapProvider.getSwapStatus).toHaveBeenCalledTimes(2);
    });

    it("should persist status changes", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "transaction.mempool" });

        await swapsPollProcessor.execute(createTaskItem(), deps);

        const swaps = await swapRepository.getAllSwaps();
        expect(swaps[0].status).toBe("transaction.mempool");
    });

    it("should skip claim for restored reverse swap without preimage", async () => {
        const swap = createReverseSwap("r1", "swap.created", "");
        await swapRepository.saveSwap(swap);

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "transaction.confirmed" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 1,
            updated: 1,
            claimed: 0,
        });
    });

    it("should skip refund for restored submarine swap without invoice or preimageHash", async () => {
        const swap = createSubmarineSwap("s1", "invoice.set", {
            invoice: "",
        });
        await swapRepository.saveSwap(swap);

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "invoice.failedToPay" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 1,
            updated: 1,
            refunded: 0,
        });
    });

    it("should attempt claim for claimable reverse swap", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "transaction.confirmed" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 1,
            updated: 1,
            claimed: 1,
        });
    });

    it("should attempt refund for refundable submarine swap", async () => {
        const swap = createSubmarineSwap("s1", "invoice.set", {
            invoice: "lnbc100n1p0",
            refundable: undefined,
        });
        await swapRepository.saveSwap(swap);

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "invoice.failedToPay" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 1,
            updated: 1,
            refunded: 1,
        });
    });

    it("should count errors when getSwapStatus fails", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockRejectedValueOnce(new Error("Network error"));

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 0,
            errors: 1,
        });
    });

    it("should return failed when all polls error", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockRejectedValueOnce(new Error("Network error"));

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.status).toBe("failed");
    });

    it("should continue processing other swaps when one fails", async () => {
        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));
        await swapRepository.saveSwap(createReverseSwap("r2", "swap.created"));

        (mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>)
            .mockRejectedValueOnce(new Error("Network error"))
            .mockResolvedValueOnce({ status: "swap.created" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.status).toBe("success"); // at least one polled
        expect(result.data).toMatchObject({
            polled: 1,
            errors: 1,
        });
    });

    it("should handle claim error gracefully", async () => {
        (ArkadeSwaps as any).mockImplementation(() => ({
            claimVHTLC: vi.fn().mockRejectedValue(new Error("Claim failed")),
            refundVHTLC: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn().mockResolvedValue(undefined),
        }));

        await swapRepository.saveSwap(createReverseSwap("r1", "swap.created"));

        (
            mockSwapProvider.getSwapStatus as ReturnType<typeof vi.fn>
        ).mockResolvedValueOnce({ status: "transaction.confirmed" });

        const result = await swapsPollProcessor.execute(createTaskItem(), deps);

        expect(result.data).toMatchObject({
            polled: 1,
            claimed: 0,
            errors: 1,
        });
    });
});
