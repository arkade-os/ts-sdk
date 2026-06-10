import { describe, it, expect, vi } from "vitest";
import {
    VtxoManager,
    isVtxoExpiringSoon,
    DEFAULT_RENEWAL_CONFIG,
    DEFAULT_SETTLEMENT_CONFIG,
    DEFAULT_THRESHOLD_SECONDS,
    getExpiringAndRecoverableVtxos,
    DEFAULT_THRESHOLD_MS,
    MAX_VTXOS_PER_SETTLEMENT,
    SettlementConfig,
} from "../src/wallet/vtxo-manager";
import { IWallet, ExtendedCoin, ExtendedVirtualCoin } from "../src/wallet";
import { Wallet } from "../src/wallet/wallet";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { hex } from "@scure/base";

type MockWalletOptions = {
    contractManager?: {
        onContractEvent: ReturnType<typeof vi.fn>;
        refreshOutpoints?: ReturnType<typeof vi.fn>;
    };
    delegateManager?: {
        delegate: ReturnType<typeof vi.fn>;
    };
};

// Mock wallet implementation
const createMockWallet = (
    vtxos: ExtendedVirtualCoin[] = [],
    arkAddress = "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
    options: MockWalletOptions = {},
): IWallet => {
    // Provide a default no-op refreshOutpoints stub when the caller-supplied
    // mock omits one — the pre-flight `revalidateBeforeSettle` invokes it
    // before every settle attempt.
    const contractManager = options.contractManager ?? {
        onContractEvent: vi.fn().mockReturnValue(() => {}),
        refreshOutpoints: vi.fn().mockResolvedValue(undefined),
    };
    if (contractManager && !(contractManager as Record<string, unknown>).refreshOutpoints) {
        (contractManager as Record<string, unknown>).refreshOutpoints = vi
            .fn()
            .mockResolvedValue(undefined);
    }

    return {
        getVtxos: vi.fn().mockResolvedValue(vtxos),
        getAddress: vi.fn().mockResolvedValue(arkAddress),
        getDelegateManager: vi.fn().mockResolvedValue(options.delegateManager),
        getContractManager: vi.fn().mockResolvedValue(contractManager),
        settle: vi.fn().mockResolvedValue("mock-txid"),
        dustAmount: 1000n,
    } as any;
};

const flushMicrotasks = async () => {
    // Drain enough cycles to clear the longest async chain in
    // VtxoManager: getExpiringVtxos → revalidateBeforeSettle (which
    // itself does getContractManager + refreshOutpoints +
    // getExpiringVtxos) → settle. Two awaits used to be sufficient
    // before pre-flight was added.
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
};

// Helper to create mock VTXO
const createMockVtxo = (
    value: number,
    state: "settled" | "swept" | "spent" | "preconfirmed" = "settled",
    isSpent = false,
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

            await expect(manager.recoverVtxos()).rejects.toThrow("No recoverable VTXOs found");
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
                undefined,
            );
        });

        const makeRecoverable = (count: number, value: number, prefix: string) =>
            Array.from(
                { length: count },
                (_, i) =>
                    ({
                        txid: `${prefix}-${i}`,
                        vout: 0,
                        value,
                        virtualStatus: { state: "swept" },
                        isSpent: false,
                        status: { confirmed: true },
                        createdAt: new Date(),
                        isUnrolled: false,
                        forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
                        intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
                        tapTree: new Uint8Array(),
                    }) as any,
            );

        it("should cap the number of recovered VTXOs per settlement", async () => {
            const value = 5000;
            const vtxos = makeRecoverable(MAX_VTXOS_PER_SETTLEMENT + 10, value, "swept");
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

            expect(txid).toBe("mock-txid");
            const settleArgs = (wallet.settle as any).mock.calls[0][0];
            expect(settleArgs.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            // Output amount is recomputed from the capped set, not the full list.
            expect(settleArgs.outputs[0].amount).toBe(BigInt(MAX_VTXOS_PER_SETTLEMENT * value));
        });

        it("should recover by value so a subdust prefix doesn't starve regulars", async () => {
            // Subdust (below dust) listed before regular VTXOs. The reference
            // SDKs impose no selection order, so we sort by value before
            // capping: the 10 regulars are rescued ahead of the subdust prefix
            // and the capped batch clears dust instead of being rejected.
            const subdust = makeRecoverable(MAX_VTXOS_PER_SETTLEMENT, 18, "subdust");
            const regular = makeRecoverable(10, 5000, "regular");
            const wallet = createMockWallet([...subdust, ...regular], "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            const txid = await manager.recoverVtxos();

            expect(txid).toBe("mock-txid");
            const settleArgs = (wallet.settle as any).mock.calls[0][0];
            // Capped to 50: 10 regulars (value first) + 40 subdust filling the rest.
            expect(settleArgs.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            const inputTxids = settleArgs.inputs.map((v: any) => v.txid);
            for (let i = 0; i < 10; i++) {
                expect(inputTxids).toContain(`regular-${i}`);
            }
            // Output amount = 10 * 5000 + 40 * 18, recomputed from the capped set.
            expect(settleArgs.outputs[0].amount).toBe(BigInt(10 * 5000 + 40 * 18));
        });

        it("should not submit a below-dust batch when no valid capped subset exists", async () => {
            // 60 subdust VTXOs are viable as a full set (1080 >= dust) but no
            // <=50 subset reaches dust (50 * 18 = 900) — and since they are all
            // equal value, sorting can't rescue it either. Rather than submit a
            // doomed batch that the server rejects every cycle, recovery throws.
            const subdust = makeRecoverable(60, 18, "subdust");
            const wallet = createMockWallet(subdust, "arkade1myaddress");
            const manager = new VtxoManager(wallet);

            // Distinct from the genuine "no recoverable VTXOs" message: this
            // wallet IS funded, the capped batch just can't reach dust yet.
            await expect(manager.recoverVtxos()).rejects.toThrow(
                /Capped recovery batch .* is below the dust threshold/,
            );
            expect((wallet.settle as any).mock.calls).toHaveLength(0);
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
                undefined,
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
                undefined,
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

            await expect(manager.recoverVtxos()).rejects.toThrow("No recoverable VTXOs found");
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
                undefined,
            );
        });

        it("should pass event callback to settle", async () => {
            const vtxos = [createMockVtxo(5000, "swept", false)];
            const wallet = createMockWallet(vtxos);
            const manager = new VtxoManager(wallet);
            const callback = vi.fn();

            await manager.recoverVtxos(callback);

            expect(wallet.settle).toHaveBeenCalledWith(expect.any(Object), callback);
        });
    });
});

describe("VtxoManager - Lifecycle", () => {
    it("should subscribe to contract events when settlement is enabled", async () => {
        const unsubscribe = vi.fn();
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(unsubscribe),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        const wallet = createMockWallet(
            [],
            "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
            { contractManager },
        );

        new VtxoManager(wallet, undefined, {});
        await flushMicrotasks();

        expect(wallet.getContractManager).toHaveBeenCalledTimes(1);
        expect(contractManager.onContractEvent).toHaveBeenCalledTimes(1);
    });

    it("should not subscribe to contract events when settlement is disabled", async () => {
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        const wallet = createMockWallet(
            [],
            "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
            { contractManager },
        );

        new VtxoManager(wallet, undefined, false);
        await flushMicrotasks();

        expect(wallet.getContractManager).not.toHaveBeenCalled();
        expect(contractManager.onContractEvent).not.toHaveBeenCalled();
    });

    it("should unsubscribe from contract events on dispose", async () => {
        const unsubscribe = vi.fn();
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(unsubscribe),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        const wallet = createMockWallet(
            [],
            "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
            { contractManager },
        );
        const manager = new VtxoManager(wallet, undefined, {});

        await flushMicrotasks();
        await manager.dispose();

        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});

describe("VtxoManager - Renewal utilities", () => {
    describe("DEFAULT_RENEWAL_CONFIG", () => {
        it("should have correct default values", () => {
            expect(DEFAULT_RENEWAL_CONFIG.thresholdMs).toBe(DEFAULT_THRESHOLD_MS);
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
            const expiring = getExpiringAndRecoverableVtxos(vtxos, thresholdMs, dustAmount);

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
            const expiring = getExpiringAndRecoverableVtxos(vtxos, thresholdMs, 330n);

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
            const expiring = getExpiringAndRecoverableVtxos(vtxos, thresholdMs, dustAmount);

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

            await expect(manager.renewVtxos()).rejects.toThrow("No VTXOs available to renew");
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

        it("should cap the number of renewed VTXOs per settlement", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const count = MAX_VTXOS_PER_SETTLEMENT + 10;
            const value = 5000;
            const vtxos = Array.from(
                { length: count },
                (_, i) =>
                    ({
                        txid: `tx-${i}`,
                        vout: 0,
                        value,
                        createdAt,
                        virtualStatus: {
                            state: "settled",
                            batchExpiry: now + 5000, // expiring soon
                        },
                        status: { confirmed: true },
                        isUnrolled: false,
                        isSpent: false,
                    }) as any,
            );
            const wallet = createMockWallet(vtxos, "arkade1myaddress");
            const manager = new VtxoManager(wallet, undefined, {});

            const txid = await manager.renewVtxos();

            expect(txid).toBe("mock-txid");
            const settleArgs = (wallet.settle as any).mock.calls[0][0];
            expect(settleArgs.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            // Output amount is summed from the capped set, not the full list.
            expect(settleArgs.outputs[0].amount).toBe(BigInt(MAX_VTXOS_PER_SETTLEMENT * value));
        });

        it("should renew the soonest-expiring VTXOs first when capping", async () => {
            // The 10 most urgent VTXOs are listed AFTER 50 less-urgent ones.
            // Sorting by expiry before the cap must rescue them so they don't
            // miss their renewal window and get forced into a unilateral exit.
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const value = 5000;
            const makeExpiring = (count: number, expiry: number, prefix: string) =>
                Array.from(
                    { length: count },
                    (_, i) =>
                        ({
                            txid: `${prefix}-${i}`,
                            vout: 0,
                            value,
                            createdAt,
                            virtualStatus: { state: "settled", batchExpiry: expiry },
                            status: { confirmed: true },
                            isUnrolled: false,
                            isSpent: false,
                        }) as any,
                );
            const lessUrgent = makeExpiring(MAX_VTXOS_PER_SETTLEMENT, now + 200_000, "far");
            const urgent = makeExpiring(10, now + 1_000, "urgent");
            const wallet = createMockWallet([...lessUrgent, ...urgent], "arkade1myaddress");
            const manager = new VtxoManager(wallet, undefined, {});

            const txid = await manager.renewVtxos();

            expect(txid).toBe("mock-txid");
            const settleArgs = (wallet.settle as any).mock.calls[0][0];
            expect(settleArgs.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            const inputTxids = settleArgs.inputs.map((v: any) => v.txid);
            for (let i = 0; i < 10; i++) {
                expect(inputTxids).toContain(`urgent-${i}`);
            }
        });

        it("should prioritize swept recoverable VTXOs without batch expiry when capping", async () => {
            const now = Date.now();
            const createdAt = new Date(now - 100_000);
            const value = 5000;
            const makeVtxo = (
                count: number,
                prefix: string,
                state: "settled" | "swept",
                batchExpiry?: number,
            ) =>
                Array.from(
                    { length: count },
                    (_, i) =>
                        ({
                            txid: `${prefix}-${i}`,
                            vout: 0,
                            value,
                            createdAt,
                            virtualStatus:
                                batchExpiry === undefined ? { state } : { state, batchExpiry },
                            status: { confirmed: true },
                            isUnrolled: false,
                            isSpent: false,
                        }) as any,
                );

            const future = makeVtxo(MAX_VTXOS_PER_SETTLEMENT, "future", "settled", now + 200_000);
            const swept = makeVtxo(10, "swept", "swept");
            const wallet = createMockWallet([...future, ...swept], "arkade1myaddress");
            const manager = new VtxoManager(wallet, undefined, {});

            const txid = await manager.renewVtxos();

            expect(txid).toBe("mock-txid");
            const settleArgs = (wallet.settle as any).mock.calls[0][0];
            expect(settleArgs.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
            const inputTxids = settleArgs.inputs.map((v: any) => v.txid);
            for (let i = 0; i < 10; i++) {
                expect(inputTxids).toContain(`swept-${i}`);
            }
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
                "Total amount 900 is below dust threshold 1000",
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
                undefined,
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

            expect(wallet.settle).toHaveBeenCalledWith(expect.any(Object), callback);
        });
    });
});

describe("SettlementConfig", () => {
    describe("DEFAULT_SETTLEMENT_CONFIG", () => {
        it("should have correct default values", () => {
            expect(DEFAULT_SETTLEMENT_CONFIG.vtxoThreshold).toBe(DEFAULT_THRESHOLD_SECONDS);
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
                { vtxoThreshold: 42, boardingUtxoSweep: true },
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

    describe("Wallet disposal", () => {
        it("should cache the owned VtxoManager", async () => {
            const wallet = Object.create(Wallet.prototype) as Wallet & {
                renewalConfig: Wallet["renewalConfig"];
                settlementConfig: Wallet["settlementConfig"];
            };

            wallet.renewalConfig = {
                enabled: false,
                thresholdMs: DEFAULT_THRESHOLD_MS,
            };
            wallet.settlementConfig = false;

            const manager1 = await wallet.getVtxoManager();
            const manager2 = await wallet.getVtxoManager();

            expect(manager1).toBe(manager2);
        });

        it("should dispose the owned VtxoManager", async () => {
            const managerDispose = vi.fn().mockResolvedValue(undefined);
            const contractManagerDispose = vi.fn();
            const wallet = Object.create(Wallet.prototype) as Wallet & {
                _vtxoManager?: { dispose(): Promise<void> };
                _vtxoManagerInitializing?: Promise<unknown>;
                _contractManager?: { dispose(): void };
                _contractManagerInitializing?: Promise<unknown>;
            };

            wallet._vtxoManager = {
                dispose: managerDispose,
            };
            wallet._contractManager = {
                dispose: contractManagerDispose,
            };

            await wallet.dispose();

            expect(managerDispose).toHaveBeenCalledTimes(1);
            expect(contractManagerDispose).toHaveBeenCalledTimes(1);
        });
    });
});

describe("VtxoManager - Boarding UTXO Sweep", () => {
    // Helper to create mock ExtendedCoin (boarding UTXO)
    const createMockBoardingUtxo = (
        value: number,
        blockTime?: number,
        blockHeight?: number,
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
        } = {},
    ) => {
        const { boardingAddress = "bcrt1qtest", feeRate = 1, chainTipHeight = 1000 } = opts;
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };

        const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]); // P2TR-like

        return {
            getVtxos: vi.fn().mockResolvedValue([]),
            getAddress: vi
                .fn()
                .mockResolvedValue(
                    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                ),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
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
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
            // Descriptor-aware on-chain boarding signer (plan §6-III.3). The
            // mock mirrors the old identity-sign behaviour (returns the tx
            // unchanged) so sweep tests still finalize a "signed" tx.
            signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
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
                "Boarding UTXO sweep is not enabled",
            );

            // Enabled but boardingUtxoSweep explicitly false
            const manager2 = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
            });
            await expect(manager2.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep is not enabled",
            );
        });

        it("should have sweep enabled by default (no config)", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet);

            // Default config enables sweep, so error should be about no UTXOs, not "not enabled"
            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep",
            );
        });

        it("should have sweep enabled with empty settlementConfig (defaults apply)", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet, undefined, {});

            // Empty {} should apply DEFAULT_SETTLEMENT_CONFIG.boardingUtxoSweep (true)
            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep",
            );
        });

        it("should throw when no expired boarding UTXOs found", async () => {
            const wallet = createMockWalletWithBoarding([]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "No expired boarding UTXOs to sweep",
            );
        });

        it("should throw clear error when wallet is not sweep-capable", async () => {
            // A minimal IWallet that lacks boardingTapscript/onchainProvider/network
            const minimalWallet = {
                getVtxos: vi.fn().mockResolvedValue([]),
                getAddress: vi
                    .fn()
                    .mockResolvedValue(
                        "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                    ),
                getDelegateManager: vi.fn().mockResolvedValue(undefined),
                getDelegatorManager: vi.fn().mockResolvedValue(undefined),
                getContractManager: vi.fn().mockResolvedValue({
                    onContractEvent: vi.fn().mockReturnValue(() => {}),
                    refreshOutpoints: vi.fn().mockResolvedValue(undefined),
                }),
                settle: vi.fn().mockResolvedValue("mock-txid"),
                getBoardingUtxos: vi.fn().mockResolvedValue([createMockBoardingUtxo(10000, 1000)]),
                getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
                identity: {
                    sign: vi.fn(),
                    xOnlyPublicKey: vi.fn().mockResolvedValue(new Uint8Array(32)),
                },
            } as any;

            const manager = new VtxoManager(minimalWallet, undefined, {
                boardingUtxoSweep: true,
            });

            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep requires a Wallet instance",
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

        const createBlockBasedWallet = (boardingUtxos: ExtendedCoin[], chainTipHeight: number) => {
            const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]);
            const contractManager = {
                onContractEvent: vi.fn().mockReturnValue(() => {}),
                refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            };

            return {
                getVtxos: vi.fn().mockResolvedValue([]),
                getAddress: vi
                    .fn()
                    .mockResolvedValue(
                        "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                    ),
                getDelegateManager: vi.fn().mockResolvedValue(undefined),
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
                    broadcastTransaction: vi.fn().mockResolvedValue("sweep-txid"),
                    getChainTip: vi.fn().mockResolvedValue({
                        height: chainTipHeight,
                        time: Math.floor(Date.now() / 1000),
                        hash: "0".repeat(64),
                    }),
                },
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
                signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
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

describe("VtxoManager - Renewal loop prevention", () => {
    it("should not trigger concurrent renewals (re-entrancy guard)", async () => {
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

        // settle() that takes a while to complete, giving us time to
        // trigger the event listener while a renewal is in flight
        let resolveSettle!: (v: string) => void;
        const settlePromise = new Promise<string>((r) => (resolveSettle = r));

        let eventHandler: ((event: any) => void) | undefined;
        const contractManager = {
            onContractEvent: vi.fn().mockImplementation((handler) => {
                eventHandler = handler;
                return () => {};
            }),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };

        const wallet = createMockWallet(vtxos, "arkade1myaddress", {
            contractManager,
        });
        (wallet.settle as any).mockReturnValue(settlePromise);

        new VtxoManager(wallet, undefined, {});

        // Wait for initialization
        await flushMicrotasks();
        await flushMicrotasks();
        await flushMicrotasks();

        expect(eventHandler).toBeDefined();

        // First vtxo_received triggers renewVtxos
        eventHandler!({ type: "vtxo_received", vtxos: [] });
        await flushMicrotasks();

        // settle() was called once
        expect(wallet.settle).toHaveBeenCalledTimes(1);

        // Second vtxo_received while first renewal in flight → should be skipped
        eventHandler!({ type: "vtxo_received", vtxos: [] });
        await flushMicrotasks();

        // Still only one settle call
        expect(wallet.settle).toHaveBeenCalledTimes(1);

        // Complete the first renewal
        resolveSettle("mock-txid");
        await flushMicrotasks();
    });

    it("should suppress renewal during cooldown after successful renewal", async () => {
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

        let eventHandler: ((event: any) => void) | undefined;
        const contractManager = {
            onContractEvent: vi.fn().mockImplementation((handler) => {
                eventHandler = handler;
                return () => {};
            }),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };

        const wallet = createMockWallet(vtxos, "arkade1myaddress", {
            contractManager,
        });

        new VtxoManager(wallet, undefined, {});

        await flushMicrotasks();
        await flushMicrotasks();
        await flushMicrotasks();

        expect(eventHandler).toBeDefined();

        // First vtxo_received triggers renewal successfully
        eventHandler!({ type: "vtxo_received", vtxos: [] });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(wallet.settle).toHaveBeenCalledTimes(1);

        // Immediately after, another vtxo_received (from our own settlement output)
        // should be suppressed by the cooldown
        eventHandler!({ type: "vtxo_received", vtxos: [] });
        await flushMicrotasks();
        await flushMicrotasks();

        expect(wallet.settle).toHaveBeenCalledTimes(1);
    });

    it("should clear renewalInProgress on error and honor cooldown on failed renewals", async () => {
        // Must be >= 2025-01-01 to bypass the regtest blockheight-vs-timestamp
        // guard in isVtxoExpiringSoon.
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const createdAt = new Date(baseNow - 100_000);
            const vtxos = [
                {
                    txid: "tx1",
                    vout: 0,
                    value: 5000,
                    createdAt,
                    virtualStatus: {
                        state: "settled",
                        batchExpiry: baseNow + 5000,
                    },
                    status: { confirmed: true },
                    isUnrolled: false,
                    isSpent: false,
                } as any,
            ];

            let eventHandler: ((event: any) => void) | undefined;
            const contractManager = {
                onContractEvent: vi.fn().mockImplementation((handler) => {
                    eventHandler = handler;
                    return () => {};
                }),
                refreshOutpoints: vi.fn().mockResolvedValue(undefined),
            };

            const wallet = createMockWallet(vtxos, "arkade1myaddress", {
                contractManager,
            });
            // First settle fails, then succeeds once cooldown has elapsed.
            (wallet.settle as any)
                .mockRejectedValueOnce(new Error("round failed"))
                .mockResolvedValueOnce("mock-txid-2");

            new VtxoManager(wallet, undefined, {});

            await flushMicrotasks();
            await flushMicrotasks();
            await flushMicrotasks();

            expect(eventHandler).toBeDefined();

            // First call → settle throws, but flag is cleared and the cooldown
            // is armed in the finally block (lastRenewalTimestamp = now).
            eventHandler!({ type: "vtxo_received", vtxos: [] });
            await flushMicrotasks();
            await flushMicrotasks();

            expect(wallet.settle).toHaveBeenCalledTimes(1);

            // Second event within the 30s cooldown must NOT re-enter renewal,
            // even though the previous attempt failed. Without this guard a
            // transient settle failure would re-trigger renewal on every
            // incoming vtxo_received event.
            nowSpy.mockReturnValue(baseNow + 5_000);
            eventHandler!({ type: "vtxo_received", vtxos: [] });
            await flushMicrotasks();
            await flushMicrotasks();

            expect(wallet.settle).toHaveBeenCalledTimes(1);

            // Once the cooldown elapses, the next event proves the flag was
            // actually cleared in the finally block (otherwise renewal would
            // stay blocked forever).
            nowSpy.mockReturnValue(baseNow + 31_000);
            eventHandler!({ type: "vtxo_received", vtxos: [] });
            await flushMicrotasks();
            await flushMicrotasks();

            expect(wallet.settle).toHaveBeenCalledTimes(2);
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe("VtxoManager - Periodic settle cooldown", () => {
    // Reuse the shape of createMockWalletWithBoarding without depending on the
    // closure variables inside the Boarding UTXO Sweep describe block.
    const mockPubkey = new Uint8Array(32).fill(0x01);
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n },
        pubkeys: [mockPubkey],
    });
    const exitScriptHex = hex.encode(csvScript.script);

    const buildBoardingWallet = (boardingUtxos: ExtendedCoin[]) => {
        const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]);
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        return {
            getVtxos: vi.fn().mockResolvedValue([]),
            getAddress: vi
                .fn()
                .mockResolvedValue(
                    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                ),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getDelegatorManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue(contractManager),
            settle: vi.fn().mockResolvedValue("mock-txid"),
            dustAmount: 330n,
            getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
            getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
            boardingTapscript: {
                exitScript: exitScriptHex,
                pkScript: mockPkScript,
            },
            onchainProvider: {
                getFeeRate: vi.fn().mockResolvedValue(1),
                getChainTip: vi.fn().mockResolvedValue({
                    height: 1000,
                    time: Math.floor(Date.now() / 1000),
                    hash: "0".repeat(64),
                }),
            },
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
            // Descriptor-aware on-chain boarding signer (plan §6-III.3). The
            // mock mirrors the old identity-sign behaviour (returns the tx
            // unchanged) so sweep tests still finalize a "signed" tx.
            signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
        } as any;
    };

    // Unexpired boarding UTXO — block_time very recent so the CSV timelock is
    // NOT satisfied, which means it qualifies for settle (not sweep).
    const makeUnexpiredUtxo = (value: number, vout = 0): ExtendedCoin =>
        ({
            txid: `boarding-txid-${value}-${vout}`,
            vout,
            value,
            status: {
                confirmed: true,
                block_time: Math.floor(Date.now() / 1000) - 60,
            },
        }) as ExtendedCoin;

    it("arms cooldown after a failed settle and skips subsequent attempts within the window", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const utxo = makeUnexpiredUtxo(10_000);
            const wallet = buildBoardingWallet([utxo]);
            (wallet.settle as any).mockRejectedValue(new Error("round failed"));

            // Disable polling to avoid the startup poll from racing with our
            // direct invocations — we drive the private method explicitly.
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            // First attempt: settle is invoked and throws. Cooldown is armed
            // in finally, failure counter goes to 1.
            await expect((manager as any).runPeriodicSettle([utxo])).rejects.toThrow(
                "round failed",
            );
            expect(wallet.settle).toHaveBeenCalledTimes(1);

            // Within the cooldown window (default 30s * 2^1 = 60s), a second
            // call must NOT hit settle again — even with the same unsettled
            // UTXO — otherwise we're back to the hot-loop the report
            // describes.
            nowSpy.mockReturnValue(baseNow + 30_000);
            await (manager as any).runPeriodicSettle([utxo]);
            expect(wallet.settle).toHaveBeenCalledTimes(1);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("allows a retry after the cooldown expires and resets counter on success", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const utxo = makeUnexpiredUtxo(10_000);
            const wallet = buildBoardingWallet([utxo]);
            (wallet.settle as any)
                .mockRejectedValueOnce(new Error("round failed"))
                .mockResolvedValueOnce("mock-txid");

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            await expect((manager as any).runPeriodicSettle([utxo])).rejects.toThrow(
                "round failed",
            );
            expect(wallet.settle).toHaveBeenCalledTimes(1);

            // First failure → cooldown = 30s * 2^1 = 60s. Advance past that.
            nowSpy.mockReturnValue(baseNow + 61_000);
            await (manager as any).runPeriodicSettle([utxo]);

            expect(wallet.settle).toHaveBeenCalledTimes(2);
            // Success resets counter; next cooldown should drop back to base.
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("grows cooldown exponentially with consecutive failures (capped)", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const utxo = makeUnexpiredUtxo(10_000);
            const wallet = buildBoardingWallet([utxo]);
            (wallet.settle as any).mockRejectedValue(new Error("round failed"));

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            // Attempt 1 → counter becomes 1, next cooldown = 30s * 2^1 = 60s.
            await expect((manager as any).runPeriodicSettle([utxo])).rejects.toThrow();
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(1);

            // 30s later (inside 60s cooldown) → skipped, counter unchanged.
            nowSpy.mockReturnValue(baseNow + 30_000);
            await (manager as any).runPeriodicSettle([utxo]);
            expect(wallet.settle).toHaveBeenCalledTimes(1);
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(1);

            // 61s later → cooldown elapsed, attempt 2 runs and fails.
            nowSpy.mockReturnValue(baseNow + 61_000);
            await expect((manager as any).runPeriodicSettle([utxo])).rejects.toThrow();
            expect(wallet.settle).toHaveBeenCalledTimes(2);
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(2);

            // Next cooldown = 30s * 2^2 = 120s. 61s after 61s → 122s, still
            // inside the 120s window from last attempt? No: 122 - 61 = 61s
            // since last attempt < 120s cooldown → skipped.
            nowSpy.mockReturnValue(baseNow + 61_000 + 61_000);
            await (manager as any).runPeriodicSettle([utxo]);
            expect(wallet.settle).toHaveBeenCalledTimes(2);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("does not arm cooldown when there is nothing to settle (no boarding, no expiring VTXOs)", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const wallet = buildBoardingWallet([]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            await (manager as any).runPeriodicSettle([]);
            expect(wallet.settle).not.toHaveBeenCalled();
            expect((manager as any).lastPeriodicSettleTimestamp).toBe(0);
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(0);
        } finally {
            nowSpy.mockRestore();
        }
    });

    // Regression: issue #438 — settling an unconfirmed boarding UTXO would hit
    // the server which rejects with INVALID_PSBT_INPUT, and the resulting
    // failure would bump the exponential-backoff counter. Filtering them out
    // pre-flight means no settle call happens and no cooldown is armed.
    const makeUnconfirmedUtxo = (value: number, vout = 0): ExtendedCoin =>
        ({
            txid: `unconfirmed-boarding-${value}-${vout}`,
            vout,
            value,
            status: {
                confirmed: false,
            },
        }) as ExtendedCoin;

    it("skips unconfirmed boarding UTXOs without calling settle or bumping backoff", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const unconfirmed = makeUnconfirmedUtxo(10_000);
            const wallet = buildBoardingWallet([unconfirmed]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            await (manager as any).runPeriodicSettle([unconfirmed]);

            expect(wallet.settle).not.toHaveBeenCalled();
            expect((manager as any).lastPeriodicSettleTimestamp).toBe(0);
            expect((manager as any).consecutivePeriodicSettleFailures).toBe(0);
            // The unconfirmed UTXO must NOT be marked as known — once it
            // confirms, the next poll should pick it up.
            expect(
                (manager as any).knownBoardingUtxos.has(`${unconfirmed.txid}:${unconfirmed.vout}`),
            ).toBe(false);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("settles only the confirmed subset when a mix is present", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const confirmed = makeUnexpiredUtxo(10_000, 0);
            const unconfirmed = makeUnconfirmedUtxo(5_000, 1);
            const wallet = buildBoardingWallet([confirmed, unconfirmed]);
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            await (manager as any).runPeriodicSettle([confirmed, unconfirmed]);

            expect(wallet.settle).toHaveBeenCalledTimes(1);
            const callArgs = (wallet.settle as any).mock.calls[0][0];
            // Only the confirmed UTXO should be in the inputs.
            expect(callArgs.inputs).toHaveLength(1);
            expect(callArgs.inputs[0].txid).toBe(confirmed.txid);
            // Known set only tracks the one we actually tried to settle.
            expect(
                (manager as any).knownBoardingUtxos.has(`${confirmed.txid}:${confirmed.vout}`),
            ).toBe(true);
            expect(
                (manager as any).knownBoardingUtxos.has(`${unconfirmed.txid}:${unconfirmed.vout}`),
            ).toBe(false);
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe("VtxoManager - Combined periodic settle (boarding + VTXOs)", () => {
    const mockPubkey = new Uint8Array(32).fill(0x01);
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n },
        pubkeys: [mockPubkey],
    });
    const exitScriptHex = hex.encode(csvScript.script);

    const buildWallet = (boardingUtxos: ExtendedCoin[], vtxos: ExtendedVirtualCoin[]) => {
        const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]);
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        return {
            getVtxos: vi.fn().mockResolvedValue(vtxos),
            getAddress: vi
                .fn()
                .mockResolvedValue(
                    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                ),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getDelegatorManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue(contractManager),
            settle: vi.fn().mockResolvedValue("mock-txid"),
            dustAmount: 330n,
            getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
            getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
            boardingTapscript: {
                exitScript: exitScriptHex,
                pkScript: mockPkScript,
            },
            onchainProvider: {
                getFeeRate: vi.fn().mockResolvedValue(1),
                getChainTip: vi.fn().mockResolvedValue({
                    height: 1000,
                    time: Math.floor(Date.now() / 1000),
                    hash: "0".repeat(64),
                }),
            },
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
            // Descriptor-aware on-chain boarding signer (plan §6-III.3). The
            // mock mirrors the old identity-sign behaviour (returns the tx
            // unchanged) so sweep tests still finalize a "signed" tx.
            signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
        } as any;
    };

    const makeUnexpiredUtxo = (value: number, vout = 0): ExtendedCoin =>
        ({
            txid: `boarding-txid-${value}-${vout}`,
            vout,
            value,
            status: {
                confirmed: true,
                block_time: Math.floor(Date.now() / 1000) - 60,
            },
        }) as ExtendedCoin;

    // VTXO expiring within 1 hour (well inside the default 3-day threshold).
    const makeExpiringVtxo = (
        value: number,
        vout = 0,
        batchExpiry = Date.now() + 60 * 60 * 1000,
    ): ExtendedVirtualCoin =>
        ({
            txid: `vtxo-txid-${value}-${vout}`,
            vout,
            value,
            virtualStatus: {
                state: "settled",
                batchExpiry,
            },
            isSpent: false,
            status: { confirmed: true },
            createdAt: new Date(),
            isUnrolled: false,
            forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
            intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
            tapTree: new Uint8Array(),
        }) as any;

    it("bundles boarding UTXO and expiring VTXO into a single settle intent", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const wallet = buildWallet([boarding], [vtxo]);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        // Inputs carry both boarding UTXO and VTXO in one intent.
        expect(call.inputs).toHaveLength(2);
        expect(call.inputs[0]).toBe(boarding);
        expect(call.inputs[1]).toBe(vtxo);
        // Output amount is the sum of both inputs.
        expect(call.outputs).toHaveLength(1);
        expect(call.outputs[0].amount).toBe(15_000n);
    });

    it("subtracts the server intent fee from the output so settle is not rejected with INTENT_INSUFFICIENT_FEE", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const wallet = buildWallet([boarding], []);
        // Server charges 200 sats per onchain input and 50 sats per offchain output.
        (wallet.arkProvider.getInfo as any).mockResolvedValue({
            fees: {
                intentFee: {
                    onchainInput: "200.0",
                    offchainOutput: "50.0",
                },
            },
        });

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toEqual([boarding]);
        // 10_000 boarding - 200 input fee - 50 output fee = 9_750
        expect(call.outputs[0].amount).toBe(9_750n);
    });

    it("skips a boarding UTXO whose onchain intent fee is greater than its value", async () => {
        const tiny = makeUnexpiredUtxo(100);
        const normal = makeUnexpiredUtxo(10_000, 1);
        const wallet = buildWallet([tiny, normal], []);
        (wallet.arkProvider.getInfo as any).mockResolvedValue({
            fees: { intentFee: { onchainInput: "200.0" } },
        });

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([tiny, normal]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        // Tiny boarding UTXO is dropped (fee 200 >= value 100); only the 10k one settles.
        expect(call.inputs).toEqual([normal]);
        expect(call.outputs[0].amount).toBe(10_000n - 200n);
    });

    it("settles VTXOs alone when no unsettled boarding UTXOs are present", async () => {
        const vtxo = makeExpiringVtxo(5_000);
        // No boarding UTXOs at all.
        const wallet = buildWallet([], [vtxo]);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toEqual([vtxo]);
        expect(call.outputs[0].amount).toBe(5_000n);
    });

    it("caps viable VTXOs, not an uneconomic prefix", async () => {
        // 50 uneconomic VTXOs ahead of 3 viable ones. The cap must apply to
        // economically viable inputs only — otherwise the uneconomic prefix
        // fills the cap and the viable VTXOs behind it are starved every cycle.
        const tiny = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, (_, i) =>
            makeExpiringVtxo(100, i),
        );
        const normal = Array.from({ length: 3 }, (_, i) => makeExpiringVtxo(10_000, 100 + i));
        const wallet = buildWallet([], [...tiny, ...normal]);
        // Flat 200-sat fee per offchain input makes the 100-sat VTXOs uneconomic.
        (wallet.arkProvider.getInfo as any).mockResolvedValue({
            fees: { intentFee: { offchainInput: "200.0" } },
        });

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toHaveLength(3);
        expect(call.inputs.every((v: any) => v.value === 10_000)).toBe(true);
        expect(call.outputs[0].amount).toBe(BigInt(3 * (10_000 - 200)));
    });

    it("caps the number of VTXOs per periodic settle", async () => {
        const value = 5_000;
        const vtxos = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT + 5 }, (_, i) =>
            makeExpiringVtxo(value, i),
        );
        const wallet = buildWallet([], vtxos);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        expect(call.outputs[0].amount).toBe(BigInt(MAX_VTXOS_PER_SETTLEMENT * value));
    });

    it("settles the soonest-expiring VTXOs first during periodic cap", async () => {
        const now = Date.now();
        const value = 5_000;
        const lessUrgent = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT }, (_, i) =>
            makeExpiringVtxo(value, i, now + 200_000),
        );
        const urgent = Array.from({ length: 10 }, (_, i) =>
            makeExpiringVtxo(value, 1_000 + i, now + 1_000),
        );
        const wallet = buildWallet([], [...lessUrgent, ...urgent]);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
        const inputTxids = call.inputs.map((v: any) => v.txid);
        for (let i = 0; i < 10; i++) {
            expect(inputTxids).toContain(`vtxo-txid-${value}-${1_000 + i}`);
        }
    });

    it("caps periodic VTXOs without capping boarding inputs", async () => {
        const boarding = [makeUnexpiredUtxo(10_000), makeUnexpiredUtxo(12_000, 1)];
        const value = 5_000;
        const vtxos = Array.from({ length: MAX_VTXOS_PER_SETTLEMENT + 5 }, (_, i) =>
            makeExpiringVtxo(value, i),
        );
        const wallet = buildWallet(boarding, vtxos);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle(boarding);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        expect(call.inputs).toHaveLength(boarding.length + MAX_VTXOS_PER_SETTLEMENT);
        expect(call.inputs.slice(0, boarding.length)).toEqual(boarding);
        expect(call.inputs.slice(boarding.length)).toHaveLength(MAX_VTXOS_PER_SETTLEMENT);
    });

    it("skips VTXO collection while an event-driven renewal is in flight", async () => {
        // Simulate the event path currently mid-renewal: the periodic poll
        // must NOT also grab VTXOs, otherwise both paths would submit the
        // same inputs on overlapping intents.
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const wallet = buildWallet([boarding], [vtxo]);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        (manager as any).renewalInProgress = true;

        await (manager as any).runPeriodicSettle([boarding]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        const call = (wallet.settle as any).mock.calls[0][0];
        // Only the boarding UTXO — VTXO fetch was suppressed.
        expect(call.inputs).toEqual([boarding]);
        expect(call.outputs[0].amount).toBe(10_000n);
    });

    it("bumps lastRenewalTimestamp when VTXOs were included (blocks event-path for cooldown)", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const boarding = makeUnexpiredUtxo(10_000);
            const vtxo = makeExpiringVtxo(5_000);
            const wallet = buildWallet([boarding], [vtxo]);

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            expect((manager as any).lastRenewalTimestamp).toBe(0);

            await (manager as any).runPeriodicSettle([boarding]);

            // VTXOs were bundled in → renewal cooldown is armed so the
            // vtxo_received event path respects the recent activity.
            expect((manager as any).lastRenewalTimestamp).toBe(baseNow);
            expect((manager as any).renewalInProgress).toBe(false);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("does NOT bump lastRenewalTimestamp when only boarding UTXOs were settled", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const boarding = makeUnexpiredUtxo(10_000);
            // No VTXOs to renew.
            const wallet = buildWallet([boarding], []);

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            await (manager as any).runPeriodicSettle([boarding]);

            // No VTXOs in the intent → event-path cooldown is NOT armed;
            // a fresh vtxo_received must still be free to trigger renewal.
            expect((manager as any).lastRenewalTimestamp).toBe(0);
            // But the periodic-path cooldown IS armed regardless.
            expect((manager as any).lastPeriodicSettleTimestamp).toBe(baseNow);
        } finally {
            nowSpy.mockRestore();
        }
    });
});

describe("VtxoManager - Cross-instance poll guard", () => {
    const mockPubkey = new Uint8Array(32).fill(0x01);
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n },
        pubkeys: [mockPubkey],
    });
    const exitScriptHex = hex.encode(csvScript.script);

    const buildBoardingWallet = (boardingUtxos: ExtendedCoin[]) => {
        const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]);
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        return {
            getVtxos: vi.fn().mockResolvedValue([]),
            getAddress: vi
                .fn()
                .mockResolvedValue(
                    "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                ),
            getDelegateManager: vi.fn().mockResolvedValue(undefined),
            getContractManager: vi.fn().mockResolvedValue(contractManager),
            settle: vi.fn().mockResolvedValue("mock-txid"),
            dustAmount: 330n,
            getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
            getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
            boardingTapscript: {
                exitScript: exitScriptHex,
                pkScript: mockPkScript,
            },
            onchainProvider: {
                getFeeRate: vi.fn().mockResolvedValue(1),
                getChainTip: vi.fn().mockResolvedValue({
                    height: 1000,
                    time: Math.floor(Date.now() / 1000),
                    hash: "0".repeat(64),
                }),
            },
            arkProvider: {
                getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
            // Descriptor-aware on-chain boarding signer (plan §6-III.3). The
            // mock mirrors the old identity-sign behaviour (returns the tx
            // unchanged) so sweep tests still finalize a "signed" tx.
            signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
        } as any;
    };

    it("skips the poll body when navigator.locks returns a null lock (held by another tab)", async () => {
        // Simulate "another tab already holds the lock": the Web Locks API
        // invokes the callback with `null` when ifAvailable:true is set and
        // the lock is contended. Our wrapper should bail before calling
        // getBoardingUtxos.
        const requestSpy = vi
            .fn()
            .mockImplementation(async (_name: string, _opts: unknown, cb: (l: any) => any) => {
                return cb(null);
            });
        vi.stubGlobal("navigator", { locks: { request: requestSpy } });
        vi.useFakeTimers();

        try {
            const utxo = {
                txid: "boarding-txid-x",
                vout: 0,
                value: 10_000,
                status: {
                    confirmed: true,
                    block_time: Math.floor(Date.now() / 1000) - 60,
                },
            } as ExtendedCoin;
            const wallet = buildBoardingWallet([utxo]);

            new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });

            // initializeSubscription delays the first poll by 1000ms; advance
            // past it so the Web Locks gate is exercised.
            await vi.advanceTimersByTimeAsync(1_100);

            expect(requestSpy).toHaveBeenCalled();
            // Lock was unavailable → poll body skipped → no network fetch,
            // no settle attempt.
            expect(wallet.getBoardingUtxos).not.toHaveBeenCalled();
            expect(wallet.settle).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it("runs the poll body when navigator.locks grants the lock", async () => {
        const requestSpy = vi
            .fn()
            .mockImplementation(async (_name: string, _opts: unknown, cb: (l: any) => any) => {
                return cb({
                    name: "arkade-boarding-poll",
                    mode: "exclusive",
                });
            });
        vi.stubGlobal("navigator", { locks: { request: requestSpy } });
        vi.useFakeTimers();

        try {
            const wallet = buildBoardingWallet([]);

            new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });

            await vi.advanceTimersByTimeAsync(1_100);

            expect(requestSpy).toHaveBeenCalled();
            // Lock granted → poll body executed → boarding fetch attempted.
            expect(wallet.getBoardingUtxos).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });
});

describe("VtxoManager - VTXO_ALREADY_SPENT reconciliation", () => {
    const mockPubkey = new Uint8Array(32).fill(0x01);
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { type: "seconds", value: 604672n },
        pubkeys: [mockPubkey],
    });
    const exitScriptHex = hex.encode(csvScript.script);

    const buildWallet = (boardingUtxos: ExtendedCoin[], vtxos: ExtendedVirtualCoin[]) => {
        const mockPkScript = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0)]);
        const contractManager = {
            onContractEvent: vi.fn().mockReturnValue(() => {}),
            refreshVtxos: vi.fn().mockResolvedValue(undefined),
            refreshOutpoints: vi.fn().mockResolvedValue(undefined),
        };
        return {
            wallet: {
                getVtxos: vi.fn().mockResolvedValue(vtxos),
                getAddress: vi
                    .fn()
                    .mockResolvedValue(
                        "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
                    ),
                getDelegateManager: vi.fn().mockResolvedValue(undefined),
                getDelegatorManager: vi.fn().mockResolvedValue(undefined),
                getContractManager: vi.fn().mockResolvedValue(contractManager),
                settle: vi.fn().mockResolvedValue("mock-txid"),
                dustAmount: 330n,
                getBoardingUtxos: vi.fn().mockResolvedValue(boardingUtxos),
                getBoardingAddress: vi.fn().mockResolvedValue("bcrt1qtest"),
                boardingTapscript: {
                    exitScript: exitScriptHex,
                    pkScript: mockPkScript,
                },
                onchainProvider: {
                    getFeeRate: vi.fn().mockResolvedValue(1),
                    getChainTip: vi.fn().mockResolvedValue({
                        height: 1000,
                        time: Math.floor(Date.now() / 1000),
                        hash: "0".repeat(64),
                    }),
                },
                arkProvider: {
                    getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {} } }),
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
                signOnchainBoardingTx: vi.fn().mockImplementation((tx: any) => tx),
            } as any,
            contractManager,
        };
    };

    const makeUnexpiredUtxo = (value: number, vout = 0): ExtendedCoin =>
        ({
            txid: `boarding-txid-${value}-${vout}`,
            vout,
            value,
            status: {
                confirmed: true,
                block_time: Math.floor(Date.now() / 1000) - 60,
            },
        }) as ExtendedCoin;

    const makeExpiringVtxo = (value: number, vout = 0): ExtendedVirtualCoin =>
        ({
            txid: `vtxo-txid-${value}-${vout}`,
            vout,
            value,
            virtualStatus: {
                state: "settled",
                batchExpiry: Date.now() + 60 * 60 * 1000,
            },
            isSpent: false,
            status: { confirmed: true },
            createdAt: new Date(),
            isUnrolled: false,
            forfeitTapLeafScript: [new Uint8Array(), new Uint8Array()],
            intentTapLeafScript: [new Uint8Array(), new Uint8Array()],
            tapTree: new Uint8Array(),
        }) as any;

    it("calls contractManager.refreshVtxos() when poll-path settle fails with VTXO_ALREADY_SPENT", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([boarding], [vtxo]);
        (wallet.settle as any).mockRejectedValue(new Error("VTXO_ALREADY_SPENT"));

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        // Must NOT rethrow: VTXO_ALREADY_SPENT is a stale-cache signal, the
        // poll loop treats it as "skip this cycle" not a transient failure.
        await (manager as any).runPeriodicSettle([boarding]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        // Full refresh (no args) — advances the global sync cursor.
        expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);
        expect(contractManager.refreshVtxos).toHaveBeenCalledWith();
    });

    it("does not bump consecutivePeriodicSettleFailures on VTXO_ALREADY_SPENT", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet } = buildWallet([boarding], [vtxo]);
        (wallet.settle as any).mockRejectedValue(new Error("VTXO_ALREADY_SPENT"));

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        // Stale cache is NOT a transient failure → counter must stay at 0 so
        // the next cycle can retry immediately once the refresh lands.
        expect((manager as any).consecutivePeriodicSettleFailures).toBe(0);
    });

    it("still bumps consecutivePeriodicSettleFailures on non-VTXO_ALREADY_SPENT errors", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const { wallet, contractManager } = buildWallet([boarding], []);
        (wallet.settle as any).mockRejectedValue(new Error("round failed"));

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await expect((manager as any).runPeriodicSettle([boarding])).rejects.toThrow(
            "round failed",
        );

        expect((manager as any).consecutivePeriodicSettleFailures).toBe(1);
        // Refresh is reserved for stale-cache signals; generic failures
        // must not trigger indexer re-sync.
        expect(contractManager.refreshVtxos).not.toHaveBeenCalled();
    });

    it("throttles refreshVtxos() within the cooldown window", async () => {
        const baseNow = new Date("2026-01-01T00:00:00Z").getTime();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);

        try {
            const boarding = makeUnexpiredUtxo(10_000);
            const { wallet, contractManager } = buildWallet([boarding], []);
            (wallet.settle as any).mockRejectedValue(new Error("VTXO_ALREADY_SPENT"));

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: false,
                pollIntervalMs: 60_000,
            });
            manager.dispose();

            // First SPENT-signalled settle → refresh triggered.
            await (manager as any).runPeriodicSettle([boarding]);
            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);

            // Clear the periodic-settle cooldown so we get to the settle
            // call again, but stay inside the refresh cooldown window (30s).
            (manager as any).lastPeriodicSettleTimestamp = 0;
            nowSpy.mockReturnValue(baseNow + 10_000); // 10s later

            await (manager as any).runPeriodicSettle([boarding]);
            expect(wallet.settle).toHaveBeenCalledTimes(2);
            // Throttled → still exactly one refresh call.
            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);

            // Past the refresh cooldown (30s + margin) → a fresh refresh is
            // allowed.
            (manager as any).lastPeriodicSettleTimestamp = 0;
            nowSpy.mockReturnValue(baseNow + 31_000);

            await (manager as any).runPeriodicSettle([boarding]);
            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(2);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it("deduplicates concurrent refreshVtxos() calls while a refresh is in flight", async () => {
        const { wallet, contractManager } = buildWallet([], []);
        let resolveRefresh!: () => void;
        const refreshPromise = new Promise<void>((resolve) => {
            resolveRefresh = resolve;
        });
        contractManager.refreshVtxos.mockReturnValue(refreshPromise);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        try {
            const first = (manager as any).maybeRefreshAfterVtxoSpent();
            const second = (manager as any).maybeRefreshAfterVtxoSpent();

            expect(first).toBe(second);

            await flushMicrotasks();
            await flushMicrotasks();

            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);

            resolveRefresh();
            await Promise.all([first, second]);

            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);
        } finally {
            await manager.dispose();
        }
    });

    // Helper: produce an error message whose body is the JSON-serialised
    // gRPC-gateway error envelope the server actually emits, so
    // `maybeArkError` can extract the `vtxo_outpoint` metadata.
    const makeStructuredVtxoSpentError = (outpoint: string): Error => {
        const body = JSON.stringify({
            code: 3,
            message: `VTXO_ALREADY_SPENT (6): input ${outpoint} already spent`,
            details: [
                {
                    "@type": "type.googleapis.com/ark.v1.ErrorDetails",
                    code: 6,
                    name: "VTXO_ALREADY_SPENT",
                    message: `VTXO_ALREADY_SPENT (6): input ${outpoint} already spent`,
                    metadata: { vtxo_outpoint: outpoint },
                },
            ],
        });
        return new Error(body);
    };

    it("calls contractManager.refreshOutpoints() with the offending outpoint when the server attaches metadata", async () => {
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([boarding], [vtxo]);
        const outpoint = "640048627268a0f1acb9920daaf5a3c6e237cafc707b007afbbd450031038e63:0";
        (wallet.settle as any).mockRejectedValue(makeStructuredVtxoSpentError(outpoint));

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        expect(wallet.settle).toHaveBeenCalledTimes(1);
        // Two refreshOutpoints calls in this test:
        //   1. pre-flight validation against the chosen candidate
        //   2. post-failure recovery on the server-supplied outpoint
        // The recovery call (last) is what verifies the structured-error
        // metadata is parsed correctly.
        expect(contractManager.refreshOutpoints).toHaveBeenCalledTimes(2);
        expect(contractManager.refreshOutpoints).toHaveBeenLastCalledWith([
            {
                txid: "640048627268a0f1acb9920daaf5a3c6e237cafc707b007afbbd450031038e63",
                vout: 0,
            },
        ]);
        expect(contractManager.refreshVtxos).not.toHaveBeenCalled();
    });

    it("falls back to refreshVtxos() when the error has no parsable outpoint metadata", async () => {
        // Plain string error — no JSON envelope, no metadata. The
        // recovery path is the cursor-based broad refresh.
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([boarding], [vtxo]);
        (wallet.settle as any).mockRejectedValue(new Error("VTXO_ALREADY_SPENT"));

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        // refreshOutpoints fires once for the pre-flight validation; the
        // post-failure recovery has no outpoint to target so it falls back
        // to refreshVtxos.
        expect(contractManager.refreshOutpoints).toHaveBeenCalledTimes(1);
        expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);
        expect(contractManager.refreshVtxos).toHaveBeenCalledWith();
    });

    it("pre-flight refreshOutpoints runs before settle on the periodic poll path", async () => {
        // Verify the pre-flight validation step happens BEFORE the
        // settle attempt — even on the success path.
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([boarding], [vtxo]);
        (wallet.settle as any).mockResolvedValue("mock-txid");

        const callOrder: string[] = [];
        contractManager.refreshOutpoints.mockImplementation(async () => {
            callOrder.push("refreshOutpoints");
        });
        (wallet.settle as any).mockImplementation(async () => {
            callOrder.push("settle");
            return "mock-txid";
        });

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        // Pre-flight is called with the chosen vtxo's outpoint, then settle.
        expect(callOrder).toEqual(["refreshOutpoints", "settle"]);
        expect(contractManager.refreshOutpoints).toHaveBeenCalledWith([
            { txid: vtxo.txid, vout: vtxo.vout },
        ]);
    });

    it("pre-flight drops candidates the indexer reports as spent and skips a fully-stale settle", async () => {
        // The pre-flight calls refreshOutpoints (which would mark the
        // candidate spent in the wallet repo). When we re-pull via
        // getExpiringVtxos, a real wallet would now return [] — simulate
        // that by switching the wallet's getVtxos mock to return an
        // empty array on the second call.
        const boarding = makeUnexpiredUtxo(10_000);
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([boarding], [vtxo]);

        // First getVtxos call (initial selection) returns the stale vtxo.
        // Second call (post-refresh) returns nothing — the refresh
        // "discovered" the vtxo is spent.
        (wallet.getVtxos as any).mockResolvedValueOnce([vtxo]).mockResolvedValue([]);

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });
        manager.dispose();

        await (manager as any).runPeriodicSettle([boarding]);

        // No settle attempt at all — pre-flight saved us the round-trip.
        // (Boarding-only settles still run but the test setup has the
        // boarding utxo unsettled, so a settle fires for it. We assert
        // the failing-vtxo path didn't trigger the recovery handler.)
        expect(contractManager.refreshOutpoints).toHaveBeenCalledTimes(1);
        expect(contractManager.refreshVtxos).not.toHaveBeenCalled();
    });

    it("triggers refreshVtxos() from the event-driven renewal path on VTXO_ALREADY_SPENT", async () => {
        // Drive the actual onContractEvent -> renewVtxos().catch(...) branch:
        // a vtxo_received event triggers renewal, settle rejects with
        // VTXO_ALREADY_SPENT, and the event handler must reconcile via
        // refreshVtxos() without surfacing the error.
        const vtxo = makeExpiringVtxo(5_000);
        const { wallet, contractManager } = buildWallet([], [vtxo]);
        (wallet.settle as any).mockRejectedValue(new Error("VTXO_ALREADY_SPENT"));

        let eventHandler: ((event: any) => void) | undefined;
        contractManager.onContractEvent.mockImplementation((handler) => {
            eventHandler = handler;
            return () => {};
        });

        const manager = new VtxoManager(wallet, undefined, {
            boardingUtxoSweep: false,
            pollIntervalMs: 60_000,
        });

        try {
            await flushMicrotasks();
            await flushMicrotasks();
            await flushMicrotasks();

            expect(eventHandler).toBeDefined();

            eventHandler!({ type: "vtxo_received", vtxos: [] });

            await flushMicrotasks();
            await flushMicrotasks();
            await flushMicrotasks();

            expect(wallet.settle).toHaveBeenCalledTimes(1);
            expect(contractManager.refreshVtxos).toHaveBeenCalledTimes(1);
            expect(contractManager.refreshVtxos).toHaveBeenCalledWith();
        } finally {
            await manager.dispose();
        }
    });
});
