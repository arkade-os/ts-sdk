import { describe, it, expect, vi } from "vitest";
import {
    VtxoManager,
    isVtxoExpiringSoon,
    DEFAULT_RENEWAL_CONFIG,
    DEFAULT_SETTLEMENT_CONFIG,
    DEFAULT_THRESHOLD_SECONDS,
    getExpiringAndRecoverableVtxos,
    DEFAULT_THRESHOLD_MS,
    SettlementConfig,
} from "../src/wallet/vtxo-manager";
import { IWallet, ExtendedCoin, ExtendedVirtualCoin } from "../src/wallet";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { hex } from "@scure/base";

// Mock wallet implementation
const createMockWallet = (
    vtxos: ExtendedVirtualCoin[] = [],
    arkAddress = "arkade1test"
): IWallet => {
    const contractManager = {
        onContractEvent: vi.fn().mockReturnValue(() => {}),
    };

    return {
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        getAddress: vi.fn().mockResolvedValue(arkAddress),
        getDelegatorManager: vi.fn().mockResolvedValue(undefined),
        getContractManager: vi.fn().mockResolvedValue(contractManager),
        settle: vi.fn().mockResolvedValue("mock-txid"),
        dustAmount: 1000n,
    } as any;
};

// Helper to create mock VTXO
const createMockVtxo = (
    value: number,
    state: "settled" | "swept" | "spent" | "preconfirmed" = "settled",
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

describe("VtxoManager - Recovery", () => {
    describe("getRecoverableBalance", () => {
        it("should return zero balance when no recoverable VTXOs", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "settled"),
                createMockVtxo(3000, "spent", true),
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(0n);
            expect(balance.subdust).toBe(0n);
            expect(balance.includesSubdust).toBe(false);
            expect(balance.vtxoCount).toBe(0);
        });

        it("should calculate recoverable balance excluding subdust when total below threshold", async () => {
            // Total (500 + 400 = 900) < dust (1000), so subdust should be excluded
            const wallet = createMockWallet([
                createMockVtxo(500, "swept", false), // Subdust
                createMockVtxo(400, "swept", false), // Subdust
                createMockVtxo(3000, "settled"), // Not recoverable
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(0n);
            expect(balance.subdust).toBe(0n);
            expect(balance.includesSubdust).toBe(false);
            expect(balance.vtxoCount).toBe(0);
        });

        it("should include subdust when combined value exceeds dust threshold", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(600, "swept", false), // Subdust
                createMockVtxo(500, "swept", false), // Subdust
                // Combined subdust: 1100 >= 1000 (dust threshold)
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(6100n);
            expect(balance.subdust).toBe(1100n);
            expect(balance.includesSubdust).toBe(true);
            expect(balance.vtxoCount).toBe(3);
        });

        it("should include subdust based on total amount, not subdust alone", async () => {
            // This tests the fix: both VTXOs are subdust (700 and 300 both < 1000),
            // but total (700 + 300 = 1000) >= dust, so all should be included
            const wallet = createMockWallet([
                createMockVtxo(700, "swept", false), // Subdust
                createMockVtxo(300, "swept", false), // Subdust
                // Subdust total: 700 + 300 = 1000
                // Total: 700 + 300 = 1000 >= 1000 (dust threshold)
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(1000n);
            expect(balance.subdust).toBe(1000n); // Both are subdust
            expect(balance.includesSubdust).toBe(true);
            expect(balance.vtxoCount).toBe(2);
        });

        it("should only count swept and spendable VTXOs as recoverable", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(3000, "swept", true), // Swept but spent - not recoverable
                createMockVtxo(4000, "settled", false), // Not swept - not recoverable
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(5000n);
            expect(balance.vtxoCount).toBe(1);
        });

        it("should include preconfirmed subdust in recoverable balance", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(600, "preconfirmed", false), // Preconfirmed subdust
                createMockVtxo(500, "preconfirmed", false), // Preconfirmed subdust
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            expect(balance.recoverable).toBe(6100n);
            expect(balance.subdust).toBe(1100n);
            expect(balance.includesSubdust).toBe(true);
            expect(balance.vtxoCount).toBe(3);
        });

        it("should NOT include settled subdust (avoiding liquidity lock)", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "swept", false), // Recoverable
                createMockVtxo(600, "settled", false), // Settled subdust - NOT recoverable
                createMockVtxo(500, "settled", false), // Settled subdust - NOT recoverable
            ]);
            const manager = new VtxoManager(wallet);

            const balance = await manager.getRecoverableBalance();

            // Only swept VTXO should be recovered
            expect(balance.recoverable).toBe(5000n);
            expect(balance.subdust).toBe(0n);
            expect(balance.vtxoCount).toBe(1);
        });
    });

    describe("recoverVtxos", () => {
        it("should throw error when no recoverable VTXOs found", async () => {
            const wallet = createMockWallet([
                createMockVtxo(5000, "settled"),
                createMockVtxo(3000, "spent", true),
            ]);
            const manager = new VtxoManager(wallet);

            await expect(manager.recoverVtxos()).rejects.toThrow(
                "No recoverable VTXOs found"
            );
        });

        it("should settle recoverable VTXOs back to wallet address", async () => {
            const vtxos = [
                createMockVtxo(5000, "swept", false),
                createMockVtxo(3000, "swept", false),
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

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
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

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

        it("should include subdust based on total amount, not subdust alone", async () => {
            // This tests the fix: subdust alone (300) < dust (1000),
            // but total (700 + 300 = 1000) >= dust, so subdust should be included
            const vtxos = [
                createMockVtxo(700, "swept", false), // Regular but small
                createMockVtxo(300, "swept", false), // Subdust
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

            expect(txid).toBe("mock-txid");
            expect(wallet.settle).toHaveBeenCalledWith(
                {
                    inputs: vtxos,
                    outputs: [
                        {
                            address: "arkade1myaddress",
                            amount: 1000n,
                        },
                    ],
                },
                undefined
            );
        });

        it("should exclude subdust when total below dust threshold", async () => {
            // Total (500 + 400 = 900) < dust (1000), so only regular (non-subdust) VTXOs recovered
            // But since there are no regular VTXOs, this should actually throw
            const vtxos = [
                createMockVtxo(500, "swept", false), // Subdust
                createMockVtxo(400, "swept", false), // Subdust
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            await expect(manager.recoverVtxos()).rejects.toThrow(
                "No recoverable VTXOs found"
            );
        });

        it("should include preconfirmed subdust in recovery", async () => {
            const vtxos = [
                createMockVtxo(5000, "swept", false),
                createMockVtxo(600, "preconfirmed", false), // Preconfirmed subdust
                createMockVtxo(500, "preconfirmed", false), // Preconfirmed subdust
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

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

        it("should pass event callback to settle", async () => {
            const vtxos = [createMockVtxo(5000, "swept", false)];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet);
            const callback = vi.fn();

            await manager.recoverVtxos(callback);

            expect(wallet.settle).toHaveBeenCalledWith(
                expect.any(Object),
                callback
            );
        });
    });
});

describe("VtxoManager - Renewal utilities", () => {
    describe("DEFAULT_RENEWAL_CONFIG", () => {
        it("should have correct default values", () => {
            expect(DEFAULT_RENEWAL_CONFIG.thresholdMs).toBe(
                DEFAULT_THRESHOLD_MS
            );
        });
    });

    describe("isVtxoExpiringSoon", () => {
        it("should return true for VTXO expiring within threshold", () => {
            const now = Date.now();
            const createdAt = new Date(now - 90_000);
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                createdAt,
                virtualStatus: {
                    state: "settled",
                    batchExpiry: now + 10_000, // expires in 10 seconds
                },
            } as ExtendedVirtualCoin;

            // duration = 10s + 90s = 100s

            // with 5 seconds of duration threshold should be false
            expect(isVtxoExpiringSoon(vtxo, 5_000)).toBe(false);
            // with 11 seconds of duration threshold should be true
            expect(isVtxoExpiringSoon(vtxo, 11_000)).toBe(true);
            // with 20 seconds of duration threshold should be true
            expect(isVtxoExpiringSoon(vtxo, 20_000)).toBe(true);
        });

        it("should return false for VTXO with no expiry", () => {
            const now = Date.now();
            const createdAt = new Date(now - 90_000);
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                createdAt,
                virtualStatus: {
                    state: "settled",
                    // no batchExpiry
                },
            } as ExtendedVirtualCoin;

            const thresholdMs = 10_000; // 10 seconds threshold
            expect(isVtxoExpiringSoon(vtxo, thresholdMs)).toBe(false);
        });

        it("should return false for already expired VTXO", () => {
            const now = Date.now();
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                virtualStatus: {
                    state: "settled",
                    batchExpiry: now - 1000, // already expired
                },
            } as ExtendedVirtualCoin;

            const thresholdMs = 10_000; // 10 seconds threshold
            expect(isVtxoExpiringSoon(vtxo, thresholdMs)).toBe(false);
        });
    });

    describe("getExpiringVtxos", () => {
        it("should filter VTXOs expiring within threshold", () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 1000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5_000, // expiring soon
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo2",
                    vout: 0,
                    value: 2000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 20_000, // not expiring soon
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo3",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 8_000, // expiring soon
                    },
                } as ExtendedVirtualCoin,
            ];

            const thresholdMs = 10_000; // 10 seconds threshold
            const dustAmount = 330n; // dust threshold
            const expiring = getExpiringAndRecoverableVtxos(
                vtxos,
                thresholdMs,
                dustAmount
            );

            expect(expiring).toHaveLength(2);
            expect(expiring[0].txid).toBe("vtxo1");
            expect(expiring[1].txid).toBe("vtxo3");
        });

        it("should return empty array when no VTXOs expiring", () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 1000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 200_000,
                    },
                } as ExtendedVirtualCoin,
            ];

            const thresholdMs = 10_000; // 10 seconds threshold
            const expiring = getExpiringAndRecoverableVtxos(
                vtxos,
                thresholdMs,
                330n
            );

            expect(expiring).toHaveLength(0);
        });

        it("should return recoverable and subdust VTXOs", () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 1000,
                    createdAt,
                    virtualStatus: {
                        state: "swept", // recoverable
                        batchExpiry: now - 5000, // expired
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo2",
                    vout: 0,
                    value: 21, // subdust
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 200_000, // not expiring soon
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo3",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 8_000, // expiring soon
                    },
                } as ExtendedVirtualCoin,
            ];

            const thresholdMs = 10_000; // 10 seconds threshold
            const dustAmount = 330n; // dust threshold
            const expiring = getExpiringAndRecoverableVtxos(
                vtxos,
                thresholdMs,
                dustAmount
            );

            expect(expiring).toHaveLength(3);
            expect(expiring[0].txid).toBe("vtxo1");
            expect(expiring[1].txid).toBe("vtxo2");
            expect(expiring[2].txid).toBe("vtxo3");
        });
    });
});

describe("VtxoManager - Renewal", () => {
    describe("getExpiringVtxos method", () => {
        it("should return expiring VTXOs when renewal is enabled", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 40_000, // expires in 40 seconds
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo2",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 60_000, // expires in 60 seconds
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo3",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 200_000, // expires in 200 seconds
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, {
                enabled: true,
                thresholdMs: 100_000, // 100 seconds
            });

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toHaveLength(2);
            expect(expiring[0].txid).toBe("vtxo1");
            expect(expiring[1].txid).toBe("vtxo2");
        });

        it("should return empty array when no VTXOs have expiry set", async () => {
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    virtualStatus: { state: "settled" }, // No batchExpiry
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet);

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toEqual([]);
        });

        it("should override thresholdMs parameter", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 4 * 86400000, // in 4 days, not expiring soon with default threshold
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet);

            const expiring = await manager.getExpiringVtxos(6 * 86400000); // Override to 3 days

            expect(expiring).toHaveLength(1);
            expect(expiring[0].txid).toBe("vtxo1");
        });

        it("should handle empty VTXO array gracefully", async () => {
            const wallet = createMockWallet([]);
            const manager = new VtxoManager(wallet);

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toEqual([]);
        });

        it("should use default thresholdMs when not specified", async () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 6 * 86_400_000, // 6 days, 86_400_000ms = 1 day
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            // No thresholdMs in config, should use DEFAULT_RENEWAL_CONFIG.thresholdMs (3 days)
            const manager = new VtxoManager(wallet);

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toEqual([]);
        });

        it("should handle already expired VTXOs", async () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now - 1000, // Already expired
                    },
                    isSpent: true,
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet);

            const expiring = await manager.getExpiringVtxos();

            // Already expired VTXOs shouldn't be in "expiring soon" list
            expect(expiring).toEqual([]);
        });

        it("should handle mixed VTXOs with and without expiry", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5_000, // 5 seconds (expiring soon)
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo2",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: { state: "settled" }, // No expiry
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo3",
                    vout: 0,
                    value: 2000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 100_000, // not expiring soon
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, {
                enabled: true,
                thresholdMs: 10_000,
            });

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toHaveLength(1);
            expect(expiring[0].txid).toBe("vtxo1");
        });
    });

    describe("renewVtxos", () => {
        it("should throw error when no VTXOs available", async () => {
            const wallet = createMockWallet([]);
            const manager = new VtxoManager(wallet);

            await expect(manager.renewVtxos()).rejects.toThrow(
                "No VTXOs available to renew"
            );
        });

        it("should settle all VTXOs back to wallet address", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000, // expiring soon
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
                {
                    txid: "tx2",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000, // expiring soon
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet, undefined, {});

            const txid = await manager.renewVtxos();

            expect(txid).toBe("mock-txid");
        });

        it("should throw error when total amount is below dust threshold", async () => {
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 500,
                    virtualStatus: { state: "settled" },
                    status: { confirmed: true },
                    createdAt: new Date(),
                    isUnrolled: false,
                    isSpent: false,
                } as any,
                {
                    txid: "tx2",
                    vout: 0,
                    value: 400,
                    virtualStatus: { state: "settled" },
                    status: { confirmed: true },
                    createdAt: new Date(),
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, undefined, {});

            await expect(manager.renewVtxos()).rejects.toThrow(
                "Total amount 900 is below dust threshold 1000"
            );
        });

        it("should include recoverable VTXOs in renewal", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000, // expiring soon
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
                {
                    txid: "tx2",
                    vout: 0,
                    value: 3000,
                    createdAt,
                    virtualStatus: {
                        state: "swept",
                        batchExpiry: now - 5000, // swept and recoverable
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet, undefined, {});

            const txid = await manager.renewVtxos();

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

        it("should pass event callback to settle", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000,
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, undefined, {});
            const callback = vi.fn();

            await manager.renewVtxos(callback);

            expect(wallet.settle).toHaveBeenCalledWith(
                expect.any(Object),
                callback
            );
        });
    });
});

describe("SettlementConfig", () => {
    describe("DEFAULT_SETTLEMENT_CONFIG", () => {
        it("should have correct default values", () => {
            expect(DEFAULT_SETTLEMENT_CONFIG.vtxoThreshold).toBe(
                DEFAULT_THRESHOLD_SECONDS
            );
            expect(DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep).toBe(true);
        });

        it("should match DEFAULT_THRESHOLD_MS converted to seconds", () => {
            expect(DEFAULT_THRESHOLD_SECONDS).toBe(DEFAULT_THRESHOLD_MS / 1000);
        });
    });

    describe("VtxoManager constructor normalization", () => {
        it("should enable settlementConfig by default when no config provided", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet);

            expect(manager.settlementConfig).toEqual(DEFAULT_SETTLEMENT_CONFIG);
        });

        it("should use settlementConfig directly when provided", () => {
            const wallet = createMockWallet();
            const config: SettlementConfig = {
                vtxoThreshold: 86400,
                boardingUtxoSweep: true,
            };
            const manager = new VtxoManager(wallet, undefined, config);

            expect(manager.settlementConfig).toEqual(config);
        });

        it("should accept empty object as settlementConfig (enable with defaults)", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet, undefined, {});

            expect(manager.settlementConfig).toEqual({});
        });

        it("should accept false to explicitly disable", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet, undefined, false);

            expect(manager.settlementConfig).toBe(false);
        });

        it("should normalize renewalConfig to settlementConfig when no settlementConfig given", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet, {
                enabled: true,
                thresholdMs: 86400000, // 1 day in ms
            });

            expect(manager.settlementConfig).toEqual({
                vtxoThreshold: 86400, // converted to seconds
            });
        });

        it("should normalize disabled renewalConfig to false", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet, { enabled: false });

            expect(manager.settlementConfig).toBe(false);
        });

        it("should prefer settlementConfig over renewalConfig", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(
                wallet,
                { enabled: true, thresholdMs: 999999 },
                { vtxoThreshold: 42, boardingUtxoSweep: true }
            );

            expect(manager.settlementConfig).toEqual({
                vtxoThreshold: 42,
                boardingUtxoSweep: true,
            });
        });

        it("should normalize renewalConfig without thresholdMs", () => {
            const wallet = createMockWallet();
            const manager = new VtxoManager(wallet, { enabled: true });

            // No thresholdMs → vtxoThreshold should be undefined (use default at runtime)
            expect(manager.settlementConfig).toEqual({
                vtxoThreshold: undefined,
            });
        });

        it("should normalize renewalConfig without enabled to false (opt-in only)", () => {
            const wallet = createMockWallet();
            // enabled defaults to false, so { thresholdMs: 5000 } alone should NOT enable
            const manager = new VtxoManager(wallet, { thresholdMs: 5000 });

            expect(manager.settlementConfig).toBe(false);
        });
    });

    describe("getExpiringVtxos with settlementConfig", () => {
        it("should return empty array when settlementConfig is false", async () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt: new Date(now - 100_000),
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 1000, // about to expire
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, undefined, false);

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toHaveLength(0);
        });

        it("should still allow thresholdMs override even when settlementConfig is false", async () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt: new Date(now - 100_000),
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 1000, // about to expire
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet, undefined, false);

            // Explicit thresholdMs override should work even with false config
            const expiring = await manager.getExpiringVtxos(999_999);

            expect(expiring).toHaveLength(1);
        });

        it("should use vtxoThreshold from settlementConfig (converted to ms)", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 50_000, // expires in 50 seconds
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            // 100 seconds threshold → 50s remaining is within threshold
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 100,
            });

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toHaveLength(1);
        });

        it("should not return VTXOs outside settlementConfig threshold", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 200_000, // expires in 200 seconds
                    },
                } as ExtendedVirtualCoin,
            ];
            const wallet = createMockWallet(vtxos);
            // 100 seconds threshold → 200s remaining is NOT within threshold
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 100,
            });

            const expiring = await manager.getExpiringVtxos();

            expect(expiring).toHaveLength(0);
        });
    });
});

describe("VtxoManager - Boarding UTXO Sweep", () => {
    // Helper to create mock ExtendedCoin (boarding UTXO)
    const createMockBoardingUtxo = (
        value: number,
        blockTime?: number,
        blockHeight?: number
    ): ExtendedCoin => {
        return {
            txid: `boarding-txid-${value}`,
            vout: 0,
            value,
            status: {
                confirmed: !!blockTime,
                block_time: blockTime,
                block_height: blockHeight,
            },
        } as ExtendedCoin;
    };

    // Build a valid exit script for mocking the boarding tapscript
    const mockPubkey = new Uint8Array(32).fill(0x01);
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n }, // ~7 days, multiple of 512
        pubkeys: [mockPubkey],
    });
    const exitScriptHex = hex.encode(csvScript.script);

    // Mock wallet with boarding UTXO support
    const createMockWalletWithBoarding = (
        boardingUtxos: ExtendedCoin[] = [],
        opts: {
            boardingAddress?: string;
            feeRate?: number;
            chainTipHeight?: number;
        } = {}
    ) => {
        const {
            boardingAddress = "bcrt1qtest",
            feeRate = 1,
            chainTipHeight = 1000,
        } = opts;
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
        };

        const mockPkScript = new Uint8Array([
            0x51,
            0x20,
            ...new Array(32).fill(0),
        ]); // P2TR-like

        return {
            getVtxos: vi.fn().mockResolvedValue([]),
            getAddress: vi.fn().mockResolvedValue("arkade1test"),
            getDelegatorManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue(contractManager),
            settle: vi.fn().mockResolvedValue("mock-txid"),
            dustAmount: 330n,
            getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
            getBoardingAddress: vi.fn().mockResolvedValue(boardingAddress),
            boardingTapscript: {
                exitScript: exitScriptHex,
                pkScript: mockPkScript,
                exit: vi.fn().mockReturnValue([
                    {
                        version: 0xc0,
                        internalKey: new Uint8Array(32),
                        merklePath: [new Uint8Array(32)],
                    },
                    new Uint8Array([0xc0, 0x01, 0x02, 0x03]),
                ]),
            },
            onchainProvider: {
                getFeeRate: vi.fn().mockResolvedValue(feeRate),
                broadcastTransaction: vi.fn().mockResolvedValue("sweep-txid"),
                getChainTip: vi.fn().mockResolvedValue({
                    height: chainTipHeight,
                    time: Math.floor(Date.now() / 1000),
                    hash: "0".repeat(64),
                }),
            },
            network: {
                bech32: "bcrt",
                pubKeyHash: 0x6f,
                scriptHash: 0xc4,
                wif: 0xef,
            },
            identity: {
                sign: vi.fn().mockImplementation((tx: any) => tx),
                xOnlyPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
            },
        } as any;
    };

    describe("getExpiredBoardingUtxos", () => {
        it("should return empty array when no boarding UTXOs", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(0);
        });

        it("should filter out unconfirmed UTXOs (no block_time)", async () => {
            const utxos = [createMockBoardingUtxo(10000, undefined)];
            const wallet = createMockWalletWithBoarding(utxos);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(0);
        });

        it("should return expired UTXOs when timelock is satisfied", async () => {
            // The CSV timelock is 604672 seconds (~7 days)
            // block_time far in the past → timelock satisfied
            const pastBlockTime = Math.floor(Date.now() / 1000) - 700_000;
            const utxos = [
                createMockBoardingUtxo(50000, pastBlockTime),
                createMockBoardingUtxo(30000, pastBlockTime),
            ];
            const wallet = createMockWalletWithBoarding(utxos);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(2);
        });

        it("should filter out UTXOs whose timelock is not yet satisfied", async () => {
            // block_time is very recent → timelock NOT satisfied
            const recentBlockTime = Math.floor(Date.now() / 1000) - 60;
            const utxos = [createMockBoardingUtxo(50000, recentBlockTime)];
            const wallet = createMockWalletWithBoarding(utxos);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(0);
        });

        it("should return mixed results (some expired, some not)", async () => {
            const pastBlockTime = Math.floor(Date.now() / 1000) - 700_000;
            const recentBlockTime = Math.floor(Date.now() / 1000) - 60;
            const utxos = [
                createMockBoardingUtxo(50000, pastBlockTime), // expired
                createMockBoardingUtxo(30000, recentBlockTime), // not expired
                createMockBoardingUtxo(20000, undefined), // unconfirmed
            ];
            const wallet = createMockWalletWithBoarding(utxos);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(1);
            expect(expired[0].value).toBe(50000);
        });
    });

    describe("sweepExpiredBoardingUtxos", () => {
        it("should throw when boarding UTXO sweep is not enabled", async () => {
            const wallet = createMockWalletWithBoarding();

            // Explicitly false
            const manager1 = new VtxoManager(wallet, undefined, false);
            await expect(manager1.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep is not enabled"
            );

            // Enabled but boardingUtxoSweep explicitly false
            const manager2 = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
            });
            await expect(manager2.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep is not enabled"
            );
        });

        it("should have sweep enabled by default (no config)", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet);

            // Default config enables sweep, so error should be about no UTXOs, not "not enabled"
            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep"
            );
        });

        it("should have sweep enabled with empty settlementConfig (defaults apply)", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet, undefined, {});

            // Empty {} should apply DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep (true)
            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep"
            );
        });

        it("should throw when no expired boarding UTXOs found", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep"
            );
        });

        it("should throw clear error when wallet is not sweep-capable", async () => {
            // A minimal IWallet that lacks boardingTapscript/onchainProvider/network
            const minimalWallet = {
                getVtxos: vi.fn().mockResolvedValue([]),
                getAddress: vi.fn().mockResolvedValue("arkade1test"),
                getDelegatorManager: vi.fn().mockResolvedValue(undefined),
                getContractManager: vi.fn().mockResolvedValue({
                    onContractEvent: vi.fn().mockReturnValue(() => {}),
                }),
                settle: vi.fn().mockResolvedValue("mock-txid"),
                getBoardingUtxos: vi
                    .fn()
                    .mockResolvedValue([createMockBoardingUtxo(10000, 1000)]),
                getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
                identity: {
                    sign: vi.fn(),
                    xOnlyPublicKey: vi
                        .fn()
                        .mockResolvedValue(new Uint8Array(32)),
                },
            } as any;

            const manager = new VtxoManager(minimalWallet, undefined, {
                boardingUtxoSweep: true,
            });

            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep requires a Wallet instance"
            );
        });
    });

    describe("getExpiredBoardingUtxos with block-based timelocks", () => {
        // Use a block-based timelock (value < 512 → "blocks")
        const blockMockPubkey = new Uint8Array(32).fill(0x02);
        const blockCsvScript = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [blockMockPubkey],
        });
        const blockExitScriptHex = hex.encode(blockCsvScript.script);

        const createBlockBasedWallet = (
            boardingUtxos: ExtendedCoin[],
            chainTipHeight: number
        ) => {
            const mockPkScript = new Uint8Array([
                0x51,
                0x20,
                ...new Array(32).fill(0),
            ]);
            const contractManager = {
                onContractEvent: vi.fn().mockReturnValue(() => {}),
            };

            return {
                getVtxos: vi.fn().mockResolvedValue([]),
                getAddress: vi.fn().mockResolvedValue("arkade1test"),
                getDelegatorManager: vi.fn().mockResolvedValue(undefined),
                getContractManager: vi.fn().mockResolvedValue(contractManager),
                settle: vi.fn().mockResolvedValue("mock-txid"),
                dustAmount: 330n,
                getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
                getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
                boardingTapscript: {
                    exitScript: blockExitScriptHex,
                    pkScript: mockPkScript,
                    exit: vi.fn().mockReturnValue([
                        {
                            version: 0xc0,
                            internalKey: new Uint8Array(32),
                            merklePath: [new Uint8Array(32)],
                        },
                        new Uint8Array([0xc0, 0x01, 0x02, 0x03]),
                    ]),
                },
                onchainProvider: {
                    getFeeRate: vi.fn().mockResolvedValue(1),
                    broadcastTransaction: vi
                        .fn()
                        .mockResolvedValue("sweep-txid"),
                    getChainTip: vi.fn().mockResolvedValue({
                        height: chainTipHeight,
                        time: Math.floor(Date.now() / 1000),
                        hash: "0".repeat(64),
                    }),
                },
                network: {
                    bech32: "bcrt",
                    pubKeyHash: 0x6f,
                    scriptHash: 0xc4,
                    wif: 0xef,
                },
                identity: {
                    sign: vi.fn().mockImplementation((tx: any) => tx),
                    xOnlyPublicKey: vi
                        .fn()
                        .mockResolvedValue(new Uint8Array(32)),
                },
            } as any;
        };

        it("should detect expired UTXOs using block-based timelock", async () => {
            // Timelock is 10 blocks, UTXO at height 100, chain tip at 110+
            const utxos = [createMockBoardingUtxo(50000, 1000, 100)];
            const wallet = createBlockBasedWallet(utxos, 110);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(1);
        });

        it("should not detect UTXOs before block-based timelock expires", async () => {
            // Timelock is 10 blocks, UTXO at height 100, chain tip at 105 (only 5 blocks elapsed)
            const utxos = [createMockBoardingUtxo(50000, 1000, 100)];
            const wallet = createBlockBasedWallet(utxos, 105);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(0);
        });

        it("should skip UTXOs without block_height for block-based timelocks", async () => {
            // UTXO confirmed but missing block_height
            const utxos = [createMockBoardingUtxo(50000, 1000, undefined)];
            const wallet = createBlockBasedWallet(utxos, 200);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            const expired = await manager.getExpiredBoardingUtxos();

            expect(expired).toHaveLength(0);
        });
    });
});
