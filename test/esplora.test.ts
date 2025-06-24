import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import { EsploraProvider, Coin } from "../src";
import WebSocket from "isomorphic-ws";
import { ExplorerTransaction } from "../src/providers/onchain";

// Create a mock WebSocket class with vi.fn() methods
const mockWs = {
    on: vi.fn(),
    send: vi.fn(),
    // Add other WebSocket methods as needed
};

// Mock the ws module
vi.mock("isomorphic-ws", () => {
    return {
        default: vi.fn(() => mockWs),
    };
});

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("EsploraProvider", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    describe("getCoins", () => {
        const mockUTXOs: Coin[] = [
            {
                txid: "1234",
                vout: 0,
                value: 100000,
                status: {
                    confirmed: true,
                    block_height: 100,
                    block_hash: "abcd",
                    block_time: 1600000000,
                },
            },
        ];

        it("should fetch and convert UTXOs to coins", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockUTXOs),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const utxos = await provider.getCoins("bc1qtest");

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/address/bc1qtest/utxo"
            );
            expect(utxos).toEqual(mockUTXOs);
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Not Found",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getCoins("bc1qtest")).rejects.toThrow(
                "Failed to fetch UTXOs: Not Found"
            );
        });
    });

    describe("getFeeRate", () => {
        const mockFeeResponse = {
            fastestFee: 100,
            halfHourFee: 80,
            hourFee: 60,
            economyFee: 40,
            minimumFee: 20,
        };

        it("should fetch and return fee rate", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockFeeResponse),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const feeRate = await provider.getFeeRate();

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/v1/fees/recommended"
            );
            expect(feeRate).toBe(80); // halfHourFee
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Service Unavailable",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getFeeRate()).rejects.toThrow(
                "Failed to fetch fee rate: Service Unavailable"
            );
        });
    });

    describe("broadcastTransaction", () => {
        const mockTxHex = "0200000001...";
        const mockTxid = "abcd1234";

        it("should broadcast transaction and return txid", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: () => Promise.resolve(mockTxid),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const txid = await provider.broadcastTransaction(mockTxHex);

            expect(mockFetch).toHaveBeenCalledWith(
                "http://localhost:3000/tx",
                expect.objectContaining({
                    method: "POST",
                    headers: { "Content-Type": "text/plain" },
                    body: mockTxHex,
                })
            );
            expect(txid).toBe(mockTxid);
        });

        it("should throw error on failed broadcast", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Bad Request",
                text: () => Promise.resolve("Invalid transaction"),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(
                provider.broadcastTransaction(mockTxHex)
            ).rejects.toThrow(
                "Failed to broadcast transaction: Invalid transaction"
            );
        });
    });

    describe("watchAddresses", () => {
        let mockWs: any;
        let callback: Mock;
        const address = "bcrt1q24qjaswxsa24tvrd7n2huxdakd4x2k4t846qfh";
        const provider = new EsploraProvider("http://localhost:3000");
        const mockTx1: ExplorerTransaction = {
            txid: "12345",
            vout: [{ value: "100000", scriptpubkey_address: "" }],
            status: {
                confirmed: false,
                block_time: 0,
            },
        };
        const mockTx2: ExplorerTransaction = {
            txid: "67890",
            vout: [{ value: "200000", scriptpubkey_address: "" }],
            status: {
                confirmed: true,
                block_time: 1700000000,
            },
        };

        beforeEach(() => {
            // reset mocks
            vi.clearAllMocks();
            callback = vi.fn();
            mockFetch.mockReset();
            // get the mocked WebSocket instance
            mockWs = new WebSocket("ws://test");
        });

        it("should subscribe to the correct address on web socket open", () => {
            // arrange
            let openHandler: Function;
            mockWs.on.mockImplementation((event: string, handler: Function) => {
                if (event === "open") openHandler = handler;
            });

            // act
            provider.watchAddresses([address], callback);
            openHandler!(); // simulate WebSocket open event

            // assert
            expect(mockWs.send).toHaveBeenCalledWith(
                JSON.stringify({ "track-addresses": [address] })
            );
        });

        it("should invoke callback with transaction when multi-address-transactions message is received", () => {
            // arrange
            const mockMessage = {
                "multi-address-transactions": {
                    [address]: {
                        mempool: [mockTx1],
                    },
                },
            };
            let messageHandler: Function;
            mockWs.on.mockImplementation((event: string, handler: Function) => {
                if (event === "message") messageHandler = handler;
            });

            // act
            provider.watchAddresses([address], callback);
            messageHandler!(JSON.stringify(mockMessage));

            // assert
            expect(callback).toHaveBeenCalledWith([mockTx1]);
            expect(callback).toHaveBeenCalledTimes(1);
        });

        it("should handle multiple transactions in a single message", () => {
            // arrange
            const mockMessage = {
                "multi-address-transactions": {
                    [address]: {
                        mempool: [mockTx1],
                        confirmed: [mockTx2],
                    },
                },
            };
            let messageHandler: Function;
            mockWs.on.mockImplementation((event: string, handler: Function) => {
                if (event === "message") messageHandler = handler;
            });

            // act
            provider.watchAddresses([address], callback);
            messageHandler!(JSON.stringify(mockMessage));

            // assert
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith([mockTx1, mockTx2]);
        });

        it("should not invoke callback on invalid message", () => {
            // arrange
            let messageHandler: Function;
            mockWs.on.mockImplementation((event: string, handler: Function) => {
                if (event === "message") messageHandler = handler;
            });

            // act
            provider.watchAddresses([address], callback);
            messageHandler!("invalid JSON"); // simulate invalid message

            // assert
            expect(callback).not.toHaveBeenCalled();
        });

        it("should not invoke callback on message without address-transactions", () => {
            // arrange
            const mockMessage = { ping: "pong" };
            let messageHandler: Function;
            mockWs.on.mockImplementation((event: string, handler: Function) => {
                if (event === "message") messageHandler = handler;
            });

            // act
            provider.watchAddresses([address], callback);
            messageHandler!(JSON.stringify(mockMessage));

            // assert
            expect(callback).not.toHaveBeenCalled();
        });

        it(
            "should handle web socket errors and fallback to polling",
            { timeout: 15000 },
            async () => {
                // arrange
                let errorHandler: Function;
                mockWs.on.mockImplementation(
                    (event: string, handler: Function) => {
                        if (event === "error") errorHandler = handler;
                    }
                );

                mockFetch
                    .mockResolvedValueOnce({
                        ok: true,
                        json: () => Promise.resolve([]),
                    })
                    .mockResolvedValueOnce({
                        ok: true,
                        json: () => Promise.resolve([mockTx1]),
                    })
                    .mockResolvedValueOnce({
                        ok: true,
                        json: () => Promise.resolve([mockTx1, mockTx2]),
                    });

                // act
                provider.watchAddresses([address], callback);
                const error = new Error("WebSocket error");
                errorHandler!(error);

                // wait for polling
                await new Promise((resolve) => setTimeout(resolve, 6000));

                // assert
                expect(callback).toHaveBeenCalledTimes(1);
                expect(callback).toHaveBeenCalledWith([mockTx1]);

                // wait for polling
                await new Promise((resolve) => setTimeout(resolve, 6000));

                // assert
                expect(callback).toHaveBeenCalledTimes(2);
                expect(callback).toHaveBeenCalledWith([mockTx2]);
            }
        );
    });
});
