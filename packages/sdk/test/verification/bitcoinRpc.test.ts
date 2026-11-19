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

    function mockRpc(
        handler: (method: string, params: any[]) => any,
        opts?: { useCoreHttpStatus?: boolean },
    ) {
        const useCoreHttpStatus = opts?.useCoreHttpStatus ?? true;
        globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
            const body = JSON.parse(options.body);
            const res = handler(body.method, body.params);
            if (res && res.error) {
                const status = useCoreHttpStatus ? (res.error.code === -32601 ? 404 : 500) : 200;
                return {
                    ok: status >= 200 && status < 300,
                    status,
                    statusText: status === 404 ? "Not Found" : "Internal Server Error",
                    json: async () => ({
                        result: null,
                        error: res.error,
                        id: body.id,
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                statusText: "OK",
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

        it("returns false when getindexinfo is an unsupported RPC method (-32601)", async () => {
            mockRpc((method) => {
                if (method === "getindexinfo") {
                    return { error: { code: -32601, message: "Method not found" } };
                }
                throw new Error("unexpected method");
            });

            const result = await provider.isTxIndexEnabled();
            expect(result).toBe(false);
        });

        it("propagates error when getindexinfo encounters transient network/auth failure and does not cache", async () => {
            mockRpc((method) => {
                if (method === "getindexinfo") {
                    return { error: { code: -32603, message: "Internal server error" } };
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
            if (!status.confirmed) throw new Error("expected confirmed status");
            expect(status.blockHeight).toBe(850123);
            expect(status.blockTime).toBe(1700000000);
            expect(status.blockHash).toBe(fakeBlockhash);
            expect(status.confirmations).toBe(6);
        });

        it("propagates BitcoinRpcError when getblockheader returns -5 (Finding F1)", async () => {
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

            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(BitcoinRpcError);
            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(/Block not found/);
        });

        it("throws BitcoinRpcError when getblockheader omits numeric height", async () => {
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
                    return { hash: fakeBlockhash };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(BitcoinRpcError);
            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(
                /Failed to get block height/,
            );
        });

        it("throws BitcoinRpcError when confirmed tx is missing blockhash or blocktime", async () => {
            const fakeTxid = "a".repeat(64);
            const fakeBlockhash = "b".repeat(64);

            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return {
                        txid: fakeTxid,
                        confirmations: 1,
                        blocktime: 1700000000,
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(BitcoinRpcError);
            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(/missing blockhash/);

            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return {
                        txid: fakeTxid,
                        confirmations: 1,
                        blockhash: fakeBlockhash,
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(BitcoinRpcError);
            await expect(provider.getTxStatus(fakeTxid)).rejects.toThrow(/missing blocktime/);
        });

        it("returns { confirmed: false, inMempool: false } when Core returns HTTP 500 with RPC -5 unknown tx", async () => {
            const fakeTxid = "a".repeat(64);
            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return {
                        error: {
                            code: -5,
                            message: "No such mempool or blockchain transaction.",
                        },
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid);
            expect(status).toEqual({ confirmed: false, inMempool: false });
        });

        it("throws BitcoinRpcError(-5) when Core returns HTTP 500 requiring -txindex", async () => {
            const fakeTxid = "a".repeat(64);
            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return {
                        error: {
                            code: -5,
                            message:
                                "No such mempool transaction. Use -txindex or provide a block hash to enable blockchain transaction queries. Use gettransaction for wallet transactions.",
                        },
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(provider.getTxStatus(fakeTxid)).rejects.toMatchObject({
                name: "BitcoinRpcError",
                code: -5,
            });
        });

        it("returns { confirmed: false, inMempool: true } when tx has 0 confirmations", async () => {
            const fakeTxid = "a".repeat(64);
            mockRpc((method) => {
                if (method === "getrawtransaction") {
                    return { txid: fakeTxid, confirmations: 0 };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid);
            expect(status).toEqual({ confirmed: false, inMempool: true });
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
                        blocktime: 1700000000,
                    };
                }
                if (method === "getblockheader") {
                    return { height: 100 };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const status = await provider.getTxStatus(fakeTxid, fakeBlockhash);
            expect(status.confirmed).toBe(true);
            if (!status.confirmed) throw new Error("expected confirmed status");
            expect(status.blockHeight).toBe(100);
        });
    });

    describe("transport & timeout hardening", () => {
        it("rejects remote http:// RPC endpoints while allowing loopback http:// and remote https://", () => {
            expect(
                () => new BitcoinRpcProvider("http://rpc.example.com:8332", "user", "pass"),
            ).toThrow(BitcoinRpcError);
            expect(
                () => new BitcoinRpcProvider("http://192.168.1.50:8332", "user", "pass"),
            ).toThrow(BitcoinRpcError);
            expect(
                () => new BitcoinRpcProvider("http://127.0.0.1:18443", "user", "pass"),
            ).not.toThrow();
            expect(
                () => new BitcoinRpcProvider("http://[::1]:18443", "user", "pass"),
            ).not.toThrow();
            expect(
                () => new BitcoinRpcProvider("https://rpc.example.com:8332", "user", "pass"),
            ).not.toThrow();
        });

        it("keeps timeout active until response.json() settles and wraps body AbortError as BitcoinRpcError(408)", async () => {
            const fastTimeoutProvider = new BitcoinRpcProvider(
                "http://localhost:18443",
                "user",
                "pass",
                25,
            );

            globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
                const signal: AbortSignal = options.signal;
                return {
                    ok: true,
                    json: () =>
                        new Promise((_resolve, reject) => {
                            signal.addEventListener("abort", () => {
                                const err = new Error("The operation was aborted");
                                err.name = "AbortError";
                                reject(err);
                            });
                        }),
                };
            });

            await expect(fastTimeoutProvider.getBlockchainInfo()).rejects.toMatchObject({
                name: "BitcoinRpcError",
                code: 408,
            });
        });
    });

    describe("non-OK HTTP error handling and package broadcast", () => {
        it("surfaces Bitcoin Core JSON-RPC -27 error on HTTP 500 during sendrawtransaction", async () => {
            mockRpc((method) => {
                if (method === "sendrawtransaction") {
                    return {
                        error: {
                            code: -27,
                            message: "Transaction already in block chain",
                        },
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(provider.broadcastTransaction("02000000")).rejects.toMatchObject({
                name: "BitcoinRpcError",
                code: -27,
                message: expect.stringContaining("Transaction already in block chain"),
            });
        });

        it("falls back to HTTP Error when non-OK response does not contain a JSON-RPC error object", async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 502,
                statusText: "Bad Gateway",
                json: async () => {
                    throw new SyntaxError("Unexpected token <");
                },
            });

            await expect(provider.getBlockchainInfo()).rejects.toMatchObject({
                name: "BitcoinRpcError",
                code: 502,
                message: expect.stringContaining("HTTP Error: 502 Bad Gateway"),
            });
        });

        it("submits multi-tx 1P1C packages via submitpackage and validates package_msg", async () => {
            const parentTxid = "1".repeat(64);
            const childTxid = "2".repeat(64);

            mockRpc((method, params) => {
                if (method === "submitpackage") {
                    expect(params).toEqual([["parent_hex", "child_hex"]]);
                    return {
                        package_msg: "success",
                        "tx-results": {
                            ["a".repeat(64)]: { txid: parentTxid },
                            ["b".repeat(64)]: { txid: childTxid },
                        },
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            const txid = await provider.broadcastTransaction("parent_hex", "child_hex");
            expect(txid).toBe(parentTxid);
        });

        it("throws BitcoinRpcError(-26) when submitpackage reports package rejection", async () => {
            const parentTxid = "1".repeat(64);
            mockRpc((method) => {
                if (method === "submitpackage") {
                    return {
                        package_msg: "transaction failed",
                        "tx-results": {
                            ["a".repeat(64)]: {
                                txid: parentTxid,
                                error: "bad-txns-inputs-missingorspent",
                            },
                        },
                    };
                }
                throw new Error(`unexpected method ${method}`);
            });

            await expect(
                provider.broadcastTransaction("parent_hex", "child_hex"),
            ).rejects.toMatchObject({
                name: "BitcoinRpcError",
                code: -26,
                message: expect.stringContaining("bad-txns-inputs-missingorspent"),
            });
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
