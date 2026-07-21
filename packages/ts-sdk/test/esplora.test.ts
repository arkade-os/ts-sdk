import { describe, it, expect, vi, beforeEach } from "vitest";
import { EsploraProvider, Coin } from "../src";

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

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

            expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/address/bc1qtest/utxo");
            expect(utxos).toEqual(mockUTXOs);
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Not Found",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getCoins("bc1qtest")).rejects.toThrow(
                "Failed to fetch UTXOs: Not Found",
            );
        });
    });

    describe("getFeeRate", () => {
        const mockFeeResponse = {
            "1": 80,
        };

        it("should fetch and return fee rate", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: () => Promise.resolve(mockFeeResponse),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const feeRate = await provider.getFeeRate();

            expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/fee-estimates");
            expect(feeRate).toBe(80);
        });

        it("should throw error on failed fetch", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                statusText: "Service Unavailable",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getFeeRate()).rejects.toThrow(
                "Failed to fetch fee rate: Service Unavailable",
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
                }),
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
            await expect(provider.broadcastTransaction(mockTxHex)).rejects.toThrow(
                "Failed to broadcast transaction: Invalid transaction",
            );
        });
    });

    describe("getChainTip", () => {
        const mockBlocks = [
            { id: "tip-hash", height: 800000, mediantime: 1700000000 },
            { id: "prev-hash", height: 799999, mediantime: 1699999000 },
        ];
        const expectedTip = { hash: "tip-hash", height: 800000, time: 1700000000 };

        it("should fetch the tip from /blocks", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: () => Promise.resolve(mockBlocks),
            });

            const provider = new EsploraProvider("http://localhost:3000");
            const tip = await provider.getChainTip();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith("http://localhost:3000/blocks");
            expect(tip).toEqual(expectedTip);
        });

        it("should fall back to /v1/blocks when /blocks returns 404", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 404,
                    statusText: "Not Found",
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve(mockBlocks),
                });

            const provider = new EsploraProvider("http://localhost:3000");
            const tip = await provider.getChainTip();

            expect(mockFetch).toHaveBeenNthCalledWith(1, "http://localhost:3000/blocks");
            expect(mockFetch).toHaveBeenNthCalledWith(2, "http://localhost:3000/v1/blocks");
            expect(tip).toEqual(expectedTip);
        });

        it("should throw when the /v1/blocks fallback also fails", async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 404,
                    statusText: "Not Found",
                })
                .mockResolvedValueOnce({
                    ok: false,
                    status: 404,
                    statusText: "Not Found",
                });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getChainTip()).rejects.toThrow(
                "Failed to get chain tip: Not Found",
            );
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("should not fall back on non-404 errors", async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: "Service Unavailable",
            });

            const provider = new EsploraProvider("http://localhost:3000");
            await expect(provider.getChainTip()).rejects.toThrow(
                "Failed to get chain tip: Service Unavailable",
            );
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });
});
