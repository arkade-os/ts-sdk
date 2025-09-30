import { expect, describe, it } from "vitest";
import {
    isVtxoExpiringSoon,
    getExpiringVtxos,
    calculateExpiryThreshold,
    getMinimumExpiry,
    calculateDynamicThreshold,
    DEFAULT_RENEWAL_CONFIG,
    Renewal,
} from "../src/wallet/renewal";
import { ExtendedVirtualCoin, IWallet } from "../src/wallet";

describe("Renewal utilities", () => {
    describe("DEFAULT_RENEWAL_CONFIG", () => {
        it("should have correct default values", () => {
            expect(DEFAULT_RENEWAL_CONFIG.thresholdPercentage).toBe(10);
            expect(DEFAULT_RENEWAL_CONFIG.checkIntervalMs).toBe(3600000);
            expect(DEFAULT_RENEWAL_CONFIG.autoRenew).toBe(false);
        });
    });

    describe("calculateExpiryThreshold", () => {
        it("should calculate correct threshold percentage", () => {
            const now = Date.now();
            const tenDaysFromNow = now + 10 * 24 * 60 * 60 * 1000;

            // 10% of 10 days = 1 day in milliseconds
            const threshold = calculateExpiryThreshold(tenDaysFromNow, 10);
            const oneDayMs = 24 * 60 * 60 * 1000;

            expect(threshold).toBeCloseTo(oneDayMs, -2);
        });

        it("should return 0 for already expired batch", () => {
            const pastTime = Date.now() - 1000;
            const threshold = calculateExpiryThreshold(pastTime, 10);

            expect(threshold).toBe(0);
        });

        it("should throw error for invalid percentage", () => {
            const future = Date.now() + 10000;

            expect(() => calculateExpiryThreshold(future, -1)).toThrow(
                "Percentage must be between 0 and 100"
            );
            expect(() => calculateExpiryThreshold(future, 101)).toThrow(
                "Percentage must be between 0 and 100"
            );
        });

        it("should handle edge case percentages", () => {
            const now = Date.now();
            const tenDaysFromNow = now + 10 * 24 * 60 * 60 * 1000;

            // 0% should return 0
            expect(calculateExpiryThreshold(tenDaysFromNow, 0)).toBe(0);

            // 100% should return full time
            const fullTime = calculateExpiryThreshold(tenDaysFromNow, 100);
            expect(fullTime).toBeCloseTo(10 * 24 * 60 * 60 * 1000, -2);
        });
    });

    describe("isVtxoExpiringSoon", () => {
        it("should return true for VTXO expiring within threshold", () => {
            const now = Date.now();
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                virtualStatus: {
                    state: "settled",
                    batchExpiry: now + 5000, // expires in 5 seconds
                },
            } as ExtendedVirtualCoin;

            const thresholdMs = 10000; // 10 seconds
            expect(isVtxoExpiringSoon(vtxo, thresholdMs)).toBe(true);
        });

        it("should return false for VTXO expiring beyond threshold", () => {
            const now = Date.now();
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                virtualStatus: {
                    state: "settled",
                    batchExpiry: now + 20000, // expires in 20 seconds
                },
            } as ExtendedVirtualCoin;

            const thresholdMs = 10000; // 10 seconds
            expect(isVtxoExpiringSoon(vtxo, thresholdMs)).toBe(false);
        });

        it("should return false for VTXO with no expiry", () => {
            const vtxo: ExtendedVirtualCoin = {
                txid: "test",
                vout: 0,
                value: 1000,
                virtualStatus: {
                    state: "settled",
                    // no batchExpiry
                },
            } as ExtendedVirtualCoin;

            const thresholdMs = 10000;
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

            const thresholdMs = 10000;
            expect(isVtxoExpiringSoon(vtxo, thresholdMs)).toBe(false);
        });
    });

    describe("getExpiringVtxos", () => {
        it("should filter VTXOs expiring within threshold", () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 1000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000, // expiring soon
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo2",
                    vout: 0,
                    value: 2000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 20000, // not expiring soon
                    },
                } as ExtendedVirtualCoin,
                {
                    txid: "vtxo3",
                    vout: 0,
                    value: 3000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 8000, // expiring soon
                    },
                } as ExtendedVirtualCoin,
            ];

            const thresholdMs = 10000;
            const expiring = getExpiringVtxos(vtxos, thresholdMs);

            expect(expiring).toHaveLength(2);
            expect(expiring[0].txid).toBe("vtxo1");
            expect(expiring[1].txid).toBe("vtxo3");
        });

        it("should return empty array when no VTXOs expiring", () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    txid: "vtxo1",
                    vout: 0,
                    value: 1000,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 20000,
                    },
                } as ExtendedVirtualCoin,
            ];

            const thresholdMs = 10000;
            const expiring = getExpiringVtxos(vtxos, thresholdMs);

            expect(expiring).toHaveLength(0);
        });
    });

    describe("getMinimumExpiry", () => {
        it("should return minimum expiry from VTXOs", () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000,
                    },
                } as ExtendedVirtualCoin,
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 3000,
                    },
                } as ExtendedVirtualCoin,
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 8000,
                    },
                } as ExtendedVirtualCoin,
            ];

            const minExpiry = getMinimumExpiry(vtxos);
            expect(minExpiry).toBe(now + 3000);
        });

        it("should return undefined when no VTXOs have expiry", () => {
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    virtualStatus: { state: "settled" },
                } as ExtendedVirtualCoin,
            ];

            const minExpiry = getMinimumExpiry(vtxos);
            expect(minExpiry).toBeUndefined();
        });

        it("should ignore VTXOs without expiry", () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5000,
                    },
                } as ExtendedVirtualCoin,
                {
                    virtualStatus: { state: "settled" }, // no expiry
                } as ExtendedVirtualCoin,
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 3000,
                    },
                } as ExtendedVirtualCoin,
            ];

            const minExpiry = getMinimumExpiry(vtxos);
            expect(minExpiry).toBe(now + 3000);
        });
    });

    describe("calculateDynamicThreshold", () => {
        it("should calculate threshold based on earliest expiring VTXO", () => {
            const now = Date.now();
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 10 * 24 * 60 * 60 * 1000, // 10 days
                    },
                } as ExtendedVirtualCoin,
                {
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: now + 5 * 24 * 60 * 60 * 1000, // 5 days (earliest)
                    },
                } as ExtendedVirtualCoin,
            ];

            const threshold = calculateDynamicThreshold(vtxos, 10);

            // 10% of 5 days = 0.5 days = 12 hours
            const expectedThreshold = (5 * 24 * 60 * 60 * 1000 * 10) / 100;
            expect(threshold).toBeCloseTo(expectedThreshold, -2);
        });

        it("should return undefined when no VTXOs have expiry", () => {
            const vtxos: ExtendedVirtualCoin[] = [
                {
                    virtualStatus: { state: "settled" },
                } as ExtendedVirtualCoin,
            ];

            const threshold = calculateDynamicThreshold(vtxos, 10);
            expect(threshold).toBeUndefined();
        });
    });
});

// Mock wallet for Renewal class tests
const createMockWallet = (
    vtxos: ExtendedVirtualCoin[] = [],
    arkAddress = "arkade1test"
): IWallet => {
    return {
        getVtxos: () => Promise.resolve(vtxos),
        getAddress: () => Promise.resolve(arkAddress),
        settle: () => Promise.resolve("mock-txid"),
    } as any;
};

describe("Renewal class", () => {
    describe("renewVtxos", () => {
        it("should throw error when no VTXOs available", async () => {
            const wallet = createMockWallet([]);
            const renewal = new Renewal(wallet);

            await expect(renewal.renewVtxos()).rejects.toThrow(
                "No VTXOs available to renew"
            );
        });

        it("should settle all VTXOs back to wallet address", async () => {
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 5000,
                    virtualStatus: { state: "settled" },
                    status: { confirmed: true },
                    createdAt: new Date(),
                    isUnrolled: false,
                    isSpent: false,
                } as any,
                {
                    txid: "tx2",
                    vout: 0,
                    value: 3000,
                    virtualStatus: { state: "settled" },
                    status: { confirmed: true },
                    createdAt: new Date(),
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const renewal = new Renewal(wallet);

            const txid = await renewal.renewVtxos();

            expect(txid).toBe("mock-txid");
        });
    });
});
