import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BitcoinRpcProvider, BitcoinRpcError } from "../../src/providers/bitcoinRpc.js";

describe("BitcoinRpcProvider", () => {
    let provider: BitcoinRpcProvider;
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        provider = new BitcoinRpcProvider("http://localhost:18443", "user", "pass");
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    function mockRpc(handler: (method: string, params: any[]) => any) {
        globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
            const body = JSON.parse(options.body);
            const res = handler(body.method, body.params);
            if (res && res.error) {
                return {
                    ok: true,
                    json: async () => ({
                        result: null,
                        error: res.error,
                        id: body.id,
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({
                    result: res,
                    error: null,
                    id: body.id,
                }),
            };
        });
    }

    describe("isTxIndexEnabled", () => {
        it("returns true and caches when getindexinfo shows txindex.synced = true", async () => {
            let calls = 0;
            mockRpc((method) => {
                if (method === "getindexinfo") {
                    calls++;
                    return { txindex: { synced: true, best_block_height: 500 } };
                }
                throw new Error("unexpected method");
            });

            const result1 = await provider.isTxIndexEnabled();
            expect(result1).toBe(true);
            const result2 = await provider.isTxIndexEnabled();
            expect(result2).toBe(true);
            expect(calls).toBe(1); // Cached
        });

        it("returns false when txindex is not synced or absent without caching true", async () => {
            mockRpc((method) => {
                if (method === "getindexinfo") {
                    return { txindex: { synced: false } };
                }
                throw new Error("unexpected method");
            });

            const result = await provider.isTxIndexEnabled();
            expect(result).toBe(false);
        });

        it("propagates error when getindexinfo fails and does not cache true", async () => {
            mockRpc((method) => {
                if (method === "getindexinfo") {
                    return { error: { code: -32601, message: "Method not found" } };
                }
                throw new Error("unexpected method");
            });

            await expect(provider.isTxIndexEnabled()).rejects.toThrow(BitcoinRpcError);
        });
    });

    describe("getTxStatus", () => {
        it("resolves confirmed status and block height via getblockheader", async () => {
            const fakeTxid = "a".repeat(64);
            const fakeBlockhash = "b".repeat(64);

            mockRpc((method, params) => {
                if (method === "getrawtransaction") {
                    expect(params[0]).toBe(fakeTxid);
                    expect(params[1]).toBe(true);
                    return {
                        txid: fakeTxid,
                        confirmations: 6,
                        blockhash: fakeBlockhash,
                        blocktime: 1700000000,
                    };
                }
                if (method === "getblockheader") {
                    expect(params[0]).toBe(fakeBlockhash);
                    return {
                        height: 850123,
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid);
            expect(status.confirmed).toBe(true);
            expect(status.blockHeight).toBe(850123);
            expect(status.blockTime).toBe(1700000000);
            expect(status.blockHash).toBe(fakeBlockhash);
        });

        it("returns undefined blockHeight if getblockheader fails", async () => {
            const fakeTxid = "a".repeat(64);
            const fakeBlockhash = "b".repeat(64);

            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return {
                        txid: fakeTxid,
                        confirmations: 2,
                        blockhash: fakeBlockhash,
                        blocktime: 1700000000,
                    };
                }
                if (method === "getblockheader") {
                    return { error: { code: -5, message: "Block not found" } };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid);
            expect(status.confirmed).toBe(true);
            expect(status.blockHeight).toBeUndefined();
            expect(status.blockHash).toBe(fakeBlockhash);
        });

        it("passes blockhash to getrawtransaction when provided", async () => {
            const fakeTxid = "a".repeat(64);
            const fakeBlockhash = "c".repeat(64);

            mockRpc((method, params) => {
                if (method === "getrawtransaction") {
                    expect(params[0]).toBe(fakeTxid);
                    expect(params[1]).toBe(true);
                    expect(params[2]).toBe(fakeBlockhash);
                    return {
                        txid: fakeTxid,
                        confirmations: 1,
                        blockhash: fakeBlockhash,
                    };
                }
                if (method === "getblockheader") {
                    return { height: 100 };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid, fakeBlockhash);
            expect(status.confirmed).toBe(true);
            expect(status.blockHeight).toBe(100);
        });
    });

    describe("getRawTransaction", () => {
        it("passes txid and blockhash to getrawtransaction", async () => {
            const fakeTxid = "a".repeat(64);
            const fakeBlockhash = "d".repeat(64);

            mockRpc((method, params) => {
                if (method === "getrawtransaction") {
                    expect(params[0]).toBe(fakeTxid);
                    expect(params[1]).toBe(false);
                    expect(params[2]).toBe(fakeBlockhash);
                    return "02000000010000000000";
                }
                throw new Error(`unexpected method ${method}`);
            });

            const raw = await provider.getRawTransaction(fakeTxid, fakeBlockhash);
            expect(raw).toBe("02000000010000000000");
        });
    });
});
