import { describe, it, expect, beforeEach, vi } from "vitest";
import { Recovery } from "../src/wallet/recovery";
import { IWallet, ExtendedVirtualCoin } from "../src/wallet";
import { SettlementEvent } from "../src/providers/ark";

// Mock wallet implementation
const createMockWallet = (
    vtxos: ExtendedVirtualCoin[] = [],
    arkAddress = "arkade1test"
): IWallet => {
    return {
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        getAddress: vi.fn().mockResolvedValue(arkAddress),
        settle: vi.fn().mockResolvedValue("mock-txid"),
        dustAmount: 1000n,
    } as any;
};

// Helper to create mock VTXO
const createMockVtxo = (
    value: number,
    state: "settled" | "swept" | "spent" = "settled",
    isSpent = false
): ExtendedVirtualCoin => {
    return {
        txid: `txid-${value}`,
        vout: 0,
        value,
        virtualStatus: { state },
        isSpent,
        status: { confirmed: true },
        createdAt: new Date(),
        isUnrolled: false,
        forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
        intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
        tapTree: new Uint8Array(),
    } as any;
};

describe("Recovery", () => {
    describe("getRecoverableBalance", () => {
        it("should return zero balance when no recoverable VTXOs", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "settled"),
                createMockVtxo(3000, "spent", true),
            ]);
            const recovery = new Recovery(wallet);

            const balance = await recovery.getRecoverableBalance();

            expect(balance.recoverable).toBe(0n);
            expect(balance.subdust).toBe(0n);
            expect(balance.includesSubdust).toBe(false);
            expect(balance.vtxoCount).toBe(0);
        });

        it("should calculate recoverable balance excluding subdust when below threshold", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(500, "swept", false), // Subdust, but alone < dust
                createMockVtxo(3000, "settled"), // Not recoverable
            ]);
            const recovery = new Recovery(wallet);

            const balance = await recovery.getRecoverableBalance();

            expect(balance.recoverable).toBe(5000n);
            expect(balance.subdust).toBe(0n);
            expect(balance.includesSubdust).toBe(false);
            expect(balance.vtxoCount).toBe(1);
        });

        it("should include subdust when combined value exceeds dust threshold", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(600, "swept", false), // Subdust
                createMockVtxo(500, "swept", false), // Subdust
                // Combined subdust: 1100 >= 1000 (dust threshold)
            ]);
            const recovery = new Recovery(wallet);

            const balance = await recovery.getRecoverableBalance();

            expect(balance.recoverable).toBe(6100n);
            expect(balance.subdust).toBe(1100n);
            expect(balance.includesSubdust).toBe(true);
            expect(balance.vtxoCount).toBe(3);
        });

        it("should only count swept and spendable VTXOs as recoverable", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(3000, "swept", true), // Swept but spent - not recoverable
                createMockVtxo(4000, "settled", false), // Not swept - not recoverable
            ]);
            const recovery = new Recovery(wallet);

            const balance = await recovery.getRecoverableBalance();

            expect(balance.recoverable).toBe(5000n);
            expect(balance.vtxoCount).toBe(1);
        });
    });

    describe("recoverVtxos", () => {
        it("should throw error when no recoverable VTXOs found", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "settled"),
                createMockVtxo(3000, "spent", true),
            ]);
            const recovery = new Recovery(wallet);

            await expect(recovery.recoverVtxos()).rejects.toThrow(
                "No recoverable VTXOs found"
            );
        });

        it("should settle recoverable VTXOs back to wallet address", async () => {
            const vtxos = [
                createMockVtxo(5000, "swept", false),
                createMockVtxo(3000, "swept", false),
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const recovery = new Recovery(wallet);

            const txid = await recovery.recoverVtxos();

            expect(txid).toBe("mock-txid");
            expect(wallet.settle).toHaveBeenCalledWith(
                {
                    inputs: vtxos,
                    outputs: [
                        {
                            address: "arkade1myaddress",
                            amount: 8000n,
                        },
                    ],
                },
                undefined
            );
        });

        it("should include subdust when combined value exceeds dust threshold", async () => {
            const vtxos = [
                createMockVtxo(5000, "swept", false),
                createMockVtxo(600, "swept", false), // Subdust
                createMockVtxo(500, "swept", false), // Subdust
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const recovery = new Recovery(wallet);

            const txid = await recovery.recoverVtxos();

            expect(txid).toBe("mock-txid");
            expect(wallet.settle).toHaveBeenCalledWith(
                {
                    inputs: vtxos,
                    outputs: [
                        {
                            address: "arkade1myaddress",
                            amount: 6100n,
                        },
                    ],
                },
                undefined
            );
        });

        it("should exclude subdust when below dust threshold", async () => {
            const vtxos = [
                createMockVtxo(5000, "swept", false),
                createMockVtxo(500, "swept", false), // Subdust, alone < dust
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const recovery = new Recovery(wallet);

            const txid = await recovery.recoverVtxos();

            expect(wallet.settle).toHaveBeenCalledWith(
                {
                    inputs: [vtxos[0]], // Only the 5000 sat VTXO
                    outputs: [
                        {
                            address: "arkade1myaddress",
                            amount: 5000n,
                        },
                    ],
                },
                undefined
            );
        });

        it("should pass event callback to settle", async () => {
            const vtxos = [createMockVtxo(5000, "swept", false)];
            const wallet = createMockWallet(vtxos);
            const recovery = new Recovery(wallet);
            const callback = vi.fn();

            await recovery.recoverVtxos(callback);

            expect(wallet.settle).toHaveBeenCalledWith(
                expect.any(Object),
                callback
            );
        });
    });
});
