import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import { SchemaError, NetworkError } from "../src/errors";
import {
    extractInvoiceAmount,
    extractTimeLockFromLeafOutput,
} from "../src/utils/restoration";
import { FeesResponse } from "../src/types";

// Scaffolding test file for BoltzSwapProvider
// This file will be updated when implementing features from README.md

function createFetchResponse(mockData: any) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockData),
        status: 200,
        statusText: "OK",
        clone: function () {
            return { ...this };
        },
        headers: {
            get: (arg: string) => "mock-header-value",
        },
    });
}

describe("BoltzSwapProvider", () => {
    let provider: BoltzSwapProvider;
    const mockHexCompressedPubKey =
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const invoice =
        "lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w" +
        "8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar" +
        "gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz" +
        "wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw" +
        "4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs" +
        "wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46" +
        "zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg" +
        "53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt";

    beforeEach(() => {
        provider = new BoltzSwapProvider({
            network: "regtest",
            apiUrl: "http://localhost:9090",
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should be instantiated with network config", () => {
        expect(provider).toBeInstanceOf(BoltzSwapProvider);
        expect(provider.getNetwork()).toBe("regtest");
    });

    describe("configuration", () => {
        it("should return correct API URL", () => {
            expect(provider.getApiUrl()).toBe("http://localhost:9090");
        });

        it("should return correct WebSocket URL", () => {
            const wsUrl = provider.getWsUrl();
            expect(wsUrl).toBe("ws://localhost:9090/v2/ws");
        });

        it("should use default API URL for mutinynet", () => {
            const mutinynetProvider = new BoltzSwapProvider({
                network: "mutinynet",
            });
            expect(mutinynetProvider.getApiUrl()).toBe(
                "https://api.boltz.mutinynet.arkade.sh"
            );
        });

        it("should convert https to wss for WebSocket URL", () => {
            const httpsProvider = new BoltzSwapProvider({
                network: "mutinynet",
                apiUrl: "https://api.example.com",
            });
            expect(httpsProvider.getWsUrl()).toBe(
                "wss://api.example.com/v2/ws"
            );
        });
    });

    describe("getFees", () => {
        it("should fetch fees from API", async () => {
            // arrange
            const mockSubmarineResponse = {
                ARK: {
                    BTC: {
                        hash: "mock-hash",
                        rate: 0.0001,
                        limits: {
                            maximal: 4294967,
                            minimal: 1000,
                            maximalZeroConf: 0,
                        },
                        fees: {
                            percentage: 0.01,
                            minerFees: 0,
                        },
                    },
                },
            };
            const mockReverseResponse = {
                BTC: {
                    ARK: {
                        hash: "mock-hash",
                        rate: 1,
                        limits: {
                            maximal: 4294967,
                            minimal: 1000,
                        },
                        fees: {
                            percentage: 0.4,
                            minerFees: {
                                claim: 0,
                                lockup: 0,
                            },
                        },
                    },
                },
            };
            // mock fetch response
            const mockFetch = vi.fn();
            vi.stubGlobal("fetch", mockFetch);
            mockFetch
                .mockReturnValueOnce(createFetchResponse(mockSubmarineResponse))
                .mockReturnValueOnce(createFetchResponse(mockReverseResponse));

            // act
            const fees = await provider.getFees();
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(fees).toEqual({
                submarine: {
                    percentage: 0.01,
                    minerFees: 0,
                },
                reverse: {
                    percentage: 0.4,
                    minerFees: {
                        claim: 0,
                        lockup: 0,
                    },
                },
            });
        });

        it("should throw on invalid fees response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getFees()).rejects.toThrow(SchemaError);
        });
    });

    describe("getLimits", () => {
        it("should fetch limits from API", async () => {
            // arrange
            const mockResponse = {
                ARK: {
                    BTC: {
                        hash: "mock-hash",
                        rate: 0.0001,
                        limits: {
                            maximal: 1000000,
                            minimal: 1000,
                            maximalZeroConf: 500000,
                        },
                        fees: {
                            percentage: 0.01,
                            minerFees: 1000,
                        },
                    },
                },
            };
            // mock fetch response
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );

            // act
            const limits = await provider.getLimits();
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(limits).toEqual({ min: 1000, max: 1000000 });
        });

        it("should throw on invalid limits response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getLimits()).rejects.toThrow(SchemaError);
        });
    });

    describe("getSwapStatus", () => {
        it("should fetch swap status by ID", async () => {
            // arrange
            const mockResponse = {
                status: "swap.created",
                zeroConfRejected: false,
                transaction: {
                    id: "mock-txid",
                    hex: "mock-hex",
                    preimage: "mock-preimage",
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const status = await provider.getSwapStatus("mock-id");
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/mock-id",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(status).toEqual(mockResponse);
        });

        it("should throw on invalid swap status response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getSwapStatus("mock-id")).rejects.toThrow(
                SchemaError
            );
        });
    });

    describe("getReverseSwapTxId", () => {
        it("should fetch reverse swap transaction ID", async () => {
            // arrange
            const mockResponse = {
                id: "mock-txid-123",
                hex: "abcdef123456",
                timeoutBlockHeight: 800000,
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const result = await provider.getReverseSwapTxId("mock-swap-id");
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse/mock-swap-id/transaction",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(result).toEqual(mockResponse);
        });

        it("should throw on invalid reverse swap txid response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(
                provider.getReverseSwapTxId("mock-id")
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("getSwapPreimage", () => {
        it("should fetch swap preimage", async () => {
            // arrange
            const mockResponse = {
                preimage: "mock-preimage-hex",
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const result = await provider.getSwapPreimage("mock-swap-id");
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine/mock-swap-id/preimage",
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                }
            );
            expect(result).toEqual(mockResponse);
        });

        it("should throw on invalid preimage response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(provider.getSwapPreimage("mock-id")).rejects.toThrow(
                SchemaError
            );
        });
    });

    describe("submarine swaps", () => {
        it("should create a submarine swap", async () => {
            // arrange
            const mockResponse = {
                id: "mock-id",
                address: "mock-address",
                expectedAmount: 21000,
                claimPublicKey: mockHexCompressedPubKey,
                acceptZeroConf: true,
                timeoutBlockHeight: 21,
                timeoutBlockHeights: {
                    refund: 17,
                    unilateralClaim: 21,
                    unilateralRefund: 42,
                    unilateralRefundWithoutReceiver: 63,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createSubmarineSwap({
                invoice,
                refundPublicKey: mockHexCompressedPubKey,
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "ARK",
                        to: "BTC",
                        invoice,
                        refundPublicKey: mockHexCompressedPubKey,
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should throw on invalid swap response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(
                provider.createSubmarineSwap({
                    invoice,
                    refundPublicKey: mockHexCompressedPubKey,
                })
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("reverse swaps", () => {
        it("should create a reverse swap", async () => {
            // arrange
            const mockResponse = {
                id: "mock-id",
                invoice: "mock-invoice",
                onchainAmount: 21000,
                lockupAddress: "mock-lockupAddress",
                refundPublicKey: mockHexCompressedPubKey,
                timeoutBlockHeight: 21,
                timeoutBlockHeights: {
                    refund: 17,
                    unilateralClaim: 21,
                    unilateralRefund: 42,
                    unilateralRefundWithoutReceiver: 63,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockHexCompressedPubKey,
                preimageHash: "mock-preimage-hash",
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockHexCompressedPubKey,
                        preimageHash: "mock-preimage-hash",
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should include description in reverse swap request when provided", async () => {
            // arrange
            const mockResponse = {
                id: "mock-swap-id",
                invoice: invoice,
                onchainAmount: 21000,
                lockupAddress: "mock-lockup-address",
                refundPublicKey: "mock-refund-public-key",
                timeoutBlockHeight: 21,
                timeoutBlockHeights: {
                    refund: 800000,
                    unilateralClaim: 800050,
                    unilateralRefund: 800100,
                    unilateralRefundWithoutReceiver: 800150,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockHexCompressedPubKey,
                preimageHash: "mock-preimage-hash",
                description: "Test payment for coffee",
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockHexCompressedPubKey,
                        preimageHash: "mock-preimage-hash",
                        description: "Test payment for coffee",
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should replace whitespace-only descriptions from reverse swap request", async () => {
            // arrange
            const mockResponse = {
                id: "mock-swap-id",
                invoice: invoice,
                onchainAmount: 21000,
                lockupAddress: "mock-lockup-address",
                refundPublicKey: "mock-refund-public-key",
                timeoutBlockHeight: 21,
                timeoutBlockHeights: {
                    refund: 800000,
                    unilateralClaim: 800050,
                    unilateralRefund: 800100,
                    unilateralRefundWithoutReceiver: 800150,
                },
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );
            // act
            const response = await provider.createReverseSwap({
                invoiceAmount: 21000,
                claimPublicKey: mockHexCompressedPubKey,
                preimageHash: "mock-preimage-hash",
                description: "   ", // whitespace-only description
            });
            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/reverse",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        from: "BTC",
                        to: "ARK",
                        invoiceAmount: 21000,
                        claimPublicKey: mockHexCompressedPubKey,
                        preimageHash: "mock-preimage-hash",
                        description: "Send to Arkade address",
                        // description should be replaced with default
                    }),
                }
            );
            expect(response).toEqual(mockResponse);
        });

        it("should throw on invalid reverse swap response", async () => {
            // arrange
            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );
            // act & assert
            await expect(
                provider.createReverseSwap({
                    invoiceAmount: 21000,
                    claimPublicKey: mockHexCompressedPubKey,
                    preimageHash: "mock-preimage-hash",
                })
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("Swap restoration", () => {
        describe("Time lock extraction from script", () => {
            it("reverse swaps", () => {
                const expected = {
                    refund: 1765366349,
                    unilateralClaim: 9728,
                    unilateralRefund: 19456,
                    unilateralRefundWithoutReceiver: 38400,
                };

                const tree = {
                    claimLeaf: {
                        version: 0,
                        output: "a914709b098708fed95c0d8c19fda64f630887f4f4988769200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    refundLeaf: {
                        version: 0,
                        output: "20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    refundWithoutBoltzLeaf: {
                        version: 0,
                        output: "044d5a3969b17520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    unilateralClaimLeaf: {
                        version: 0,
                        output: "a914709b098708fed95c0d8c19fda64f630887f4f498876903130040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                    },
                    unilateralRefundLeaf: {
                        version: 0,
                        output: "03260040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                    },
                    unilateralRefundWithoutBoltzLeaf: {
                        version: 0,
                        output: "034b0040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                    },
                };

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.refundWithoutBoltzLeaf.output
                    )
                ).toBe(expected.refund);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralClaimLeaf.output
                    )
                ).toBe(expected.unilateralClaim);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralRefundLeaf.output
                    )
                ).toBe(expected.unilateralRefund);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralRefundWithoutBoltzLeaf.output
                    )
                ).toBe(expected.unilateralRefundWithoutReceiver);
            });

            it("submarine swaps", () => {
                const expected = {
                    refund: 1765885005,
                    unilateralClaim: 9728,
                    unilateralRefund: 19456,
                    unilateralRefundWithoutReceiver: 38400,
                };

                const tree = {
                    claimLeaf: {
                        version: 0,
                        output: "a914685ba29acce5320ab1ed90cd24e6a125b88835ce876920c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    refundLeaf: {
                        version: 0,
                        output: "200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    refundWithoutBoltzLeaf: {
                        version: 0,
                        output: "044d444169b175200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
                    },
                    unilateralClaimLeaf: {
                        version: 0,
                        output: "a914685ba29acce5320ab1ed90cd24e6a125b88835ce876903130040b27520c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                    },
                    unilateralRefundLeaf: {
                        version: 0,
                        output: "03260040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daad20c432d8c2f7191f2ffe380cdcd995d53492aa1af60a92f1be6698971c03ee5d6dac",
                    },
                    unilateralRefundWithoutBoltzLeaf: {
                        version: 0,
                        output: "034b0040b275200da6a9cbcebd245df8ac2f7e6520f2fd46e2da3990a74f701db1df92ffe3a9daac",
                    },
                };

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.refundWithoutBoltzLeaf.output
                    )
                ).toBe(expected.refund);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralClaimLeaf.output
                    )
                ).toBe(expected.unilateralClaim);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralRefundLeaf.output
                    )
                ).toBe(expected.unilateralRefund);

                expect(
                    extractTimeLockFromLeafOutput(
                        tree.unilateralRefundWithoutBoltzLeaf.output
                    )
                ).toBe(expected.unilateralRefundWithoutReceiver);
            });
        });

        describe("Amount extraction", () => {
            it("invoice amount extraction", () => {
                const fees: FeesResponse = {
                    submarine: {
                        percentage: 0.1,
                        minerFees: 0,
                    },
                    reverse: {
                        percentage: 0.4,
                        minerFees: {
                            claim: 0,
                            lockup: 0,
                        },
                    },
                };

                expect(extractInvoiceAmount(1000, fees)).toBe(1005);
                expect(extractInvoiceAmount(1992, fees)).toBe(2000);
                expect(extractInvoiceAmount(2091, fees)).toBe(2100);
            });
        });
    });

    // TODO: Implement tests for features shown in README.md
    // Basic operations:
    // - Creating submarine swaps
    // - Creating reverse submarine swaps
    // - Getting swap status
    // - Getting trading pairs
    // - Fee estimation
    // - Invoice validation
    describe("refundSubmarineSwap", () => {
        it("should refund a submarine swap with signed transactions", async () => {
            // arrange
            const mockSwapId = "mock-swap-id";
            // Minimal valid PSBT v0 with empty unsigned transaction
            // PSBT magic bytes "psbt\xff\x01" + unsigned tx key (0x00) + minimal tx (version 2, 0 inputs, 0 outputs, locktime 0)
            const validPsbtBase64 = "cHNidP8BAAoCAAAAAAAAAAAAAA==";
            const mockTransaction = {
                toPSBT: vi.fn(() => Buffer.from(validPsbtBase64, "base64")),
            };
            const mockCheckpoint = {
                toPSBT: vi.fn(() => Buffer.from(validPsbtBase64, "base64")),
            };

            const mockResponse = {
                transaction: validPsbtBase64,
                checkpoint: validPsbtBase64,
            };

            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse(mockResponse))
            );

            // act
            const result = await provider.refundSubmarineSwap(
                mockSwapId,
                mockTransaction as any,
                mockCheckpoint as any
            );

            // assert
            expect(fetch).toHaveBeenCalledWith(
                "http://localhost:9090/v2/swap/submarine/mock-swap-id/refund/ark",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        checkpoint: validPsbtBase64,
                        transaction: validPsbtBase64,
                    }),
                }
            );
            expect(mockTransaction.toPSBT).toHaveBeenCalled();
            expect(mockCheckpoint.toPSBT).toHaveBeenCalled();
            expect(result).toHaveProperty("transaction");
            expect(result).toHaveProperty("checkpoint");
        });

        it("should throw SchemaError on invalid refund response", async () => {
            // arrange
            const validPsbtBase64 = "cHNidP8BAAoCAAAAAAAAAAAAAA==";
            const mockTransaction = {
                toPSBT: vi.fn(() => Buffer.from(validPsbtBase64, "base64")),
            };
            const mockCheckpoint = {
                toPSBT: vi.fn(() => Buffer.from(validPsbtBase64, "base64")),
            };

            vi.stubGlobal(
                "fetch",
                vi.fn(() => createFetchResponse({ invalid: "response" }))
            );

            // act & assert
            await expect(
                provider.refundSubmarineSwap(
                    "mock-swap-id",
                    mockTransaction as any,
                    mockCheckpoint as any
                )
            ).rejects.toThrow(SchemaError);
        });
    });

    describe("monitorSwap", () => {
        let mockWebSocket: any;
        let webSocketCallbacks: any;

        beforeEach(() => {
            webSocketCallbacks = {};
            mockWebSocket = {
                send: vi.fn(),
                close: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            };

            // Mock WebSocket constructor
            vi.stubGlobal(
                "WebSocket",
                vi.fn(() => {
                    return mockWebSocket;
                })
            );
        });

        it("should monitor swap updates via WebSocket", async () => {
            // arrange
            const swapId = "mock-swap-id";
            const updates: any[] = [];
            const updateCallback = vi.fn((status, data) => {
                updates.push({ status, data });
            });

            // Set up WebSocket to immediately open and send updates
            setTimeout(() => {
                if (mockWebSocket.onopen) mockWebSocket.onopen();
            }, 0);

            setTimeout(() => {
                if (mockWebSocket.onmessage) {
                    // Send non-terminal status update
                    mockWebSocket.onmessage({
                        data: JSON.stringify({
                            event: "update",
                            args: [
                                { id: swapId, status: "transaction.mempool" },
                            ],
                        }),
                    });
                    // Send terminal status update
                    mockWebSocket.onmessage({
                        data: JSON.stringify({
                            event: "update",
                            args: [{ id: swapId, status: "invoice.settled" }],
                        }),
                    });
                }
                if (mockWebSocket.onclose) mockWebSocket.onclose();
            }, 10);

            // act
            await provider.monitorSwap(swapId, updateCallback);

            // assert
            expect(globalThis.WebSocket).toHaveBeenCalledWith(
                "ws://localhost:9090/v2/ws"
            );
            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: [swapId],
                })
            );
            expect(updateCallback).toHaveBeenCalledWith("transaction.mempool", {
                id: swapId,
                status: "transaction.mempool",
            });
            expect(updateCallback).toHaveBeenCalledWith("invoice.settled", {
                id: swapId,
                status: "invoice.settled",
            });
            expect(mockWebSocket.close).toHaveBeenCalled();
        });

        it("should ignore updates for other swaps", async () => {
            // arrange
            const swapId = "mock-swap-id";
            const updateCallback = vi.fn();

            setTimeout(() => {
                if (mockWebSocket.onopen) mockWebSocket.onopen();
            }, 0);

            setTimeout(() => {
                if (mockWebSocket.onmessage) {
                    // Send update for different swap ID
                    mockWebSocket.onmessage({
                        data: JSON.stringify({
                            event: "update",
                            args: [
                                {
                                    id: "different-swap-id",
                                    status: "transaction.mempool",
                                },
                            ],
                        }),
                    });
                    // Send terminal status for our swap
                    mockWebSocket.onmessage({
                        data: JSON.stringify({
                            event: "update",
                            args: [{ id: swapId, status: "invoice.settled" }],
                        }),
                    });
                }
                if (mockWebSocket.onclose) mockWebSocket.onclose();
            }, 10);

            // act
            await provider.monitorSwap(swapId, updateCallback);

            // assert
            expect(updateCallback).toHaveBeenCalledTimes(1);
            expect(updateCallback).toHaveBeenCalledWith("invoice.settled", {
                id: swapId,
                status: "invoice.settled",
            });
        });

        it("should reject on WebSocket error", async () => {
            // arrange
            const swapId = "mock-swap-id";
            const updateCallback = vi.fn();

            setTimeout(() => {
                if (mockWebSocket.onerror) {
                    mockWebSocket.onerror({ message: "Connection failed" });
                }
            }, 0);

            // act & assert
            await expect(
                provider.monitorSwap(swapId, updateCallback)
            ).rejects.toThrow(NetworkError);
        });

        it("should close WebSocket and reject on swap error message", async () => {
            // arrange
            const swapId = "mock-swap-id";
            const updateCallback = vi.fn();

            setTimeout(() => {
                if (mockWebSocket.onopen) mockWebSocket.onopen();
            }, 0);

            setTimeout(() => {
                if (mockWebSocket.onmessage) {
                    mockWebSocket.onmessage({
                        data: JSON.stringify({
                            event: "update",
                            args: [
                                {
                                    id: swapId,
                                    error: "Swap failed due to insufficient funds",
                                },
                            ],
                        }),
                    });
                }
            }, 10);

            // act & assert
            await expect(
                provider.monitorSwap(swapId, updateCallback)
            ).rejects.toThrow();
            expect(mockWebSocket.close).toHaveBeenCalled();
        });

        it("should close WebSocket on all terminal statuses", async () => {
            // arrange
            const terminalStatuses = [
                "invoice.settled",
                "transaction.claimed",
                "transaction.refunded",
                "invoice.expired",
                "invoice.failedToPay",
                "transaction.failed",
                "transaction.lockupFailed",
                "swap.expired",
            ];

            for (const status of terminalStatuses) {
                const swapId = `swap-${status}`;
                const updateCallback = vi.fn();

                // Reset mock
                mockWebSocket.close.mockClear();

                setTimeout(() => {
                    if (mockWebSocket.onopen) mockWebSocket.onopen();
                }, 0);

                setTimeout(() => {
                    if (mockWebSocket.onmessage) {
                        mockWebSocket.onmessage({
                            data: JSON.stringify({
                                event: "update",
                                args: [{ id: swapId, status }],
                            }),
                        });
                    }
                    if (mockWebSocket.onclose) mockWebSocket.onclose();
                }, 10);

                // act
                await provider.monitorSwap(swapId, updateCallback);

                // assert
                expect(mockWebSocket.close).toHaveBeenCalled();
                expect(updateCallback).toHaveBeenCalledWith(status, {
                    id: swapId,
                    status,
                });
            }
        });
    });

    it("should have expected interface methods", () => {
        expect(provider.createSubmarineSwap).toBeInstanceOf(Function);
        expect(provider.getSwapStatus).toBeInstanceOf(Function);
        expect(provider.getNetwork).toBeInstanceOf(Function);
        expect(provider.refundSubmarineSwap).toBeInstanceOf(Function);
        expect(provider.monitorSwap).toBeInstanceOf(Function);
    });

    describe("error handling", () => {
        it("should parse JSON error responses from Boltz API", async () => {
            // arrange
            const errorResponse = {
                error: "27 is less than minimal of 333",
            };
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 400,
                        text: () =>
                            Promise.resolve(JSON.stringify(errorResponse)),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(400);
                expect((error as NetworkError).errorData).toEqual(
                    errorResponse
                );
                expect((error as NetworkError).message).toBe(
                    'Boltz API error: 400 {"error":"27 is less than minimal of 333"}'
                );
            }
        });

        it("should handle non-JSON error responses from Boltz API", async () => {
            // arrange
            const errorText = "Internal Server Error";
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 500,
                        text: () => Promise.resolve(errorText),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(500);
                expect((error as NetworkError).errorData).toBeUndefined();
                expect((error as NetworkError).message).toBe(
                    "Boltz API error: 500 Internal Server Error"
                );
            }
        });

        it("should handle malformed JSON error responses from Boltz API", async () => {
            // arrange
            const malformedJson = "{invalid json}";
            vi.stubGlobal(
                "fetch",
                vi.fn(() =>
                    Promise.resolve({
                        ok: false,
                        status: 400,
                        text: () => Promise.resolve(malformedJson),
                        headers: {
                            get: () => null,
                        },
                    })
                )
            );

            // act & assert
            try {
                await provider.getLimits();
                expect.fail("Should have thrown NetworkError");
            } catch (error) {
                expect(error).toBeInstanceOf(NetworkError);
                expect((error as NetworkError).statusCode).toBe(400);
                expect((error as NetworkError).errorData).toBeUndefined();
                expect((error as NetworkError).message).toBe(
                    "Boltz API error: 400 {invalid json}"
                );
            }
        });
    });
});
