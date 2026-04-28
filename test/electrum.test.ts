import { describe, it, expect, vi, beforeEach } from "vitest";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { sha256 } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import type { ElectrumWS } from "ws-electrumx-client";
import { ElectrumOnchainProvider, WsElectrumChainSource } from "../src";
import { networks } from "../src/networks";

function regtestAddressFromHash(hash160: Uint8Array): string {
    return Address(networks.regtest).encode(
        OutScript.decode(p2wpkhScript(hash160))
    );
}

/**
 * Build a P2WPKH scriptPubKey (OP_0 + 20-byte pushdata + hash160).
 * We hand-assemble the script rather than using p2wpkh(), because the
 * helper expects a 33-byte compressed pubkey we don't need here —
 * toScriptHash only cares about the script bytes.
 */
function p2wpkhScript(hash160: Uint8Array): Uint8Array {
    if (hash160.length !== 20) {
        throw new Error("expected 20-byte hash");
    }
    const out = new Uint8Array(22);
    out[0] = 0x00; // OP_0
    out[1] = 0x14; // push 20 bytes
    out.set(hash160, 2);
    return out;
}

/**
 * Minimal mock of ElectrumWS — only the methods used by the provider.
 * Tests drive it by calling `.mockResolvedValueOnce()` on `request`/`batchRequest`
 * in the same order the production code invokes them.
 */
type MockElectrumWS = Pick<
    ElectrumWS,
    "request" | "batchRequest" | "subscribe" | "unsubscribe" | "close"
>;

function createMockWS(): {
    ws: MockElectrumWS;
    request: ReturnType<typeof vi.fn>;
    batchRequest: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
} {
    const request = vi.fn();
    const batchRequest = vi.fn();
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    return {
        ws: {
            request,
            batchRequest,
            subscribe,
            unsubscribe,
            close,
        } as unknown as MockElectrumWS,
        request,
        batchRequest,
        subscribe,
        unsubscribe,
        close,
    };
}

/**
 * Queue N sequential responses on `wsMock.request` to mimic what
 * `safeBatchRequest` (the in-house replacement for the library's leaky
 * `batchRequest`) consumes — one ws.request call per batch element.
 */
function mockBatch<T>(
    mock: ReturnType<typeof vi.fn>,
    responses: T[]
): ReturnType<typeof vi.fn> {
    for (const r of responses) mock.mockResolvedValueOnce(r);
    return mock;
}

// Bitcoin genesis block header (mainnet)
const GENESIS_HEADER_HEX =
    "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
const GENESIS_BLOCK_HASH =
    "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const GENESIS_BLOCK_TIME = 1231006505;

const REGTEST_ADDRESS = "bcrt1q679zsd45msawvr7782r0twvmukns3drlstjt77";

// Build a tx that carries a (fake) witness, so the segwit serialization
// differs from the legacy one. Used to verify that childTxidFromHex
// returns the txid (legacy hash) rather than the wtxid (witness hash) —
// silently emitting the wtxid would break every downstream caller that
// tracks the tx by id.
function buildSegwitTxWithWitness(): {
    txHex: string;
    expectedTxid: string;
    expectedWtxid: string;
} {
    const tx = new Transaction({
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    });
    // Inputs and outputs must be added BEFORE the witness — @scure/btc-signer
    // locks the output set once any input is finalized.
    tx.addInput({
        txid: hex.decode(
            "0000000000000000000000000000000000000000000000000000000000000005"
        ),
        index: 0,
        sequence: 0xffffffff,
    });
    tx.addOutput({
        script: p2wpkhScript(new Uint8Array(20).fill(0x77)),
        amount: 12_345n,
    });
    tx.updateInput(0, {
        finalScriptWitness: [
            new Uint8Array(64).fill(0x99), // signature-shaped bytes
            new Uint8Array(33).fill(0x02), // pubkey-shaped bytes
        ],
    });
    return {
        txHex: tx.hex,
        expectedTxid: tx.id,
        expectedWtxid: tx.hash,
    };
}

// Build a tx with 2 distinct P2WPKH outputs we can reason about.
function buildTestTx(): { txHex: string; scripts: Uint8Array[] } {
    const hash1 = new Uint8Array(20).fill(0xaa);
    const hash2 = new Uint8Array(20).fill(0xbb);
    const script1 = p2wpkhScript(hash1);
    const script2 = p2wpkhScript(hash2);

    const tx = new Transaction({
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    });
    tx.addInput({
        txid: hex.decode(
            "0000000000000000000000000000000000000000000000000000000000000001"
        ),
        index: 0,
        sequence: 0xffffffff,
    });
    tx.addOutput({ script: script1, amount: 10_000n });
    tx.addOutput({ script: script2, amount: 20_000n });

    return {
        txHex: hex.encode(tx.toBytes(false, false)),
        scripts: [script1, script2],
    };
}

const SPENDER_HASH = new Uint8Array(20).fill(0xcc);
const SPENDER_SCRIPT = p2wpkhScript(SPENDER_HASH);

function toScriptHash(script: Uint8Array): string {
    return hex.encode(sha256(script).reverse());
}

// Build a tx that spends output `vout` of `parentTxid`.
function buildSpendingTx(parentTxid: string, vout: number): string {
    const tx = new Transaction({
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    });
    tx.addInput({
        txid: hex.decode(parentTxid),
        index: vout,
        sequence: 0xffffffff,
    });
    tx.addOutput({ script: SPENDER_SCRIPT, amount: 5_000n });
    return hex.encode(tx.toBytes(false, false));
}

describe("ElectrumOnchainProvider", () => {
    let wsMock: ReturnType<typeof createMockWS>;
    let provider: ElectrumOnchainProvider;

    beforeEach(() => {
        wsMock = createMockWS();
        provider = new ElectrumOnchainProvider(
            wsMock.ws as unknown as ElectrumWS,
            networks.regtest
        );
    });

    describe("getCoins", () => {
        it("maps listunspent results to Coin shape", async () => {
            wsMock.request.mockResolvedValueOnce([
                {
                    tx_hash: "abcd1234",
                    tx_pos: 0,
                    value: 100_000,
                    height: 500,
                },
                {
                    tx_hash: "ef567890",
                    tx_pos: 1,
                    value: 50_000,
                    height: 0, // mempool
                },
            ]);

            const coins = await provider.getCoins(REGTEST_ADDRESS);

            expect(wsMock.request).toHaveBeenCalledTimes(1);
            expect(wsMock.request.mock.calls[0][0]).toBe(
                "blockchain.scripthash.listunspent"
            );
            expect(coins).toEqual([
                {
                    txid: "abcd1234",
                    vout: 0,
                    value: 100_000,
                    status: { confirmed: true, block_height: 500 },
                },
                {
                    txid: "ef567890",
                    vout: 1,
                    value: 50_000,
                    status: { confirmed: false, block_height: undefined },
                },
            ]);
        });

        it("returns empty array when no unspents", async () => {
            wsMock.request.mockResolvedValueOnce([]);
            const coins = await provider.getCoins(REGTEST_ADDRESS);
            expect(coins).toEqual([]);
        });
    });

    describe("getFeeRate", () => {
        it("converts BTC/kB to sat/vB with Math.max(1, ceil) guard", async () => {
            wsMock.request.mockResolvedValueOnce(0.00002);
            expect(await provider.getFeeRate()).toBe(2);
        });

        it("rounds up fractional rates", async () => {
            wsMock.request.mockResolvedValueOnce(0.000015);
            expect(await provider.getFeeRate()).toBe(2);
        });

        it("returns at least 1 sat/vB even for tiny rates", async () => {
            wsMock.request.mockResolvedValueOnce(0.000000001);
            expect(await provider.getFeeRate()).toBe(1);
        });

        it("returns undefined when daemon cannot estimate (-1)", async () => {
            wsMock.request.mockResolvedValueOnce(-1);
            expect(await provider.getFeeRate()).toBeUndefined();
        });
    });

    describe("broadcastTransaction", () => {
        it("broadcasts a single tx", async () => {
            wsMock.request.mockResolvedValueOnce("deadbeef");
            const txid = await provider.broadcastTransaction("0200000000");
            expect(txid).toBe("deadbeef");
            expect(wsMock.request).toHaveBeenCalledTimes(1);
            expect(wsMock.request.mock.calls[0][0]).toBe(
                "blockchain.transaction.broadcast"
            );
        });

        it("broadcasts a 1P1C package atomically via broadcast_package and returns the child txid (segwit witness-stripped)", async () => {
            // Use a tx that actually has witness data so the segwit
            // serialization differs from the legacy one. broadcast_package
            // doesn't return a txid; we must derive the *txid* (legacy
            // hash) — emitting the wtxid would silently break downstream
            // tracking on every Ark transaction.
            const {
                txHex: childHex,
                expectedTxid,
                expectedWtxid,
            } = buildSegwitTxWithWitness();
            // Sanity check: the test fixture must actually exercise the
            // bug path (id != hash means witness data is present).
            expect(expectedTxid).not.toBe(expectedWtxid);

            wsMock.request.mockResolvedValueOnce({
                success: true,
                errors: null,
            });

            const result = await provider.broadcastTransaction(
                "parentHex",
                childHex
            );

            expect(result).toBe(expectedTxid);
            expect(result).not.toBe(expectedWtxid);
            expect(wsMock.request).toHaveBeenCalledTimes(1);
            const [method, txArray, verbose] = wsMock.request.mock.calls[0];
            expect(method).toBe("blockchain.transaction.broadcast_package");
            // Parent first, child last — topological order required by the protocol.
            expect(txArray).toEqual(["parentHex", childHex]);
            expect(verbose).toBe(false);
        });

        it("surfaces the server error when broadcast_package returns success=false", async () => {
            wsMock.request.mockResolvedValueOnce({
                success: false,
                errors: [{ txid: "abc", error: "min relay fee not met" }],
            });

            await expect(
                provider.broadcastTransaction("parentHex", "childHex")
            ).rejects.toThrow(/min relay fee not met/);
        });

        it("propagates 'method not found' errors instead of silently falling back", async () => {
            // A server that doesn't implement broadcast_package (ElectrumX,
            // older Fulcrum, or Fulcrum on bitcoind < v28) — we MUST NOT
            // silently downgrade to sequential broadcast because TRUC
            // packages would fail in subtle ways.
            const methodNotFound = new Error(
                "unknown method 'blockchain.transaction.broadcast_package'"
            );
            wsMock.request.mockRejectedValueOnce(methodNotFound);

            await expect(
                provider.broadcastTransaction("parentHex", "childHex")
            ).rejects.toThrow(/broadcast_package/);
            // Critical: only one ws.request call — no sequential fallback.
            expect(wsMock.request).toHaveBeenCalledTimes(1);
        });

        it("throws for 3+ transactions", async () => {
            await expect(
                provider.broadcastTransaction("a", "b", "c")
            ).rejects.toThrow(/Only 1 or 1P1C package/);
        });
    });

    /**
     * Configure the headers subscription mock so subscribe() invokes its
     * callback with the given tip immediately. Mirrors how ws-electrumx-client
     * delivers initial subscribe responses (and ongoing notifications) via
     * the registered callback.
     */
    function deliverHeadersTip(
        subscribeMock: ReturnType<typeof vi.fn>,
        tip: { height: number; hex: string }
    ): void {
        subscribeMock.mockImplementationOnce(
            async (
                method: string,
                cb: (header: { height: number; hex: string }) => void
            ) => {
                if (method === "blockchain.headers") cb(tip);
            }
        );
    }

    describe("getChainTip", () => {
        it("parses block header for hash, timestamp, height", async () => {
            deliverHeadersTip(wsMock.subscribe, {
                height: 0,
                hex: GENESIS_HEADER_HEX,
            });

            const tip = await provider.getChainTip();
            expect(tip.height).toBe(0);
            expect(tip.time).toBe(GENESIS_BLOCK_TIME);
            expect(tip.hash).toBe(GENESIS_BLOCK_HASH);
        });

        it("reuses the cached tip across calls (one server subscription)", async () => {
            deliverHeadersTip(wsMock.subscribe, {
                height: 42,
                hex: GENESIS_HEADER_HEX,
            });

            await provider.getChainTip();
            await provider.getChainTip();
            await provider.getChainTip();

            // Only one subscription registered for the whole sequence —
            // previously each call sent a fresh blockchain.headers.subscribe
            // request that the server treated as a new subscription.
            expect(wsMock.subscribe).toHaveBeenCalledTimes(1);
        });

        it("updates the cached tip when the server pushes a new header", async () => {
            // Stash the callback so we can fire a notification later.
            let pushHeader:
                | ((h: { height: number; hex: string }) => void)
                | undefined;
            wsMock.subscribe.mockImplementationOnce(
                async (
                    _method: string,
                    cb: (h: { height: number; hex: string }) => void
                ) => {
                    pushHeader = cb;
                    cb({ height: 100, hex: GENESIS_HEADER_HEX });
                }
            );

            const tip1 = await provider.getChainTip();
            expect(tip1.height).toBe(100);

            // Server pushes a new tip via the same subscription.
            pushHeader!({ height: 101, hex: GENESIS_HEADER_HEX });

            const tip2 = await provider.getChainTip();
            expect(tip2.height).toBe(101);
            expect(wsMock.subscribe).toHaveBeenCalledTimes(1);
        });
    });

    describe("getTxStatus", () => {
        it("returns confirmed=false when transaction.get_merkle is not yet available (mempool)", async () => {
            // electrs raises an error for txs not yet in a block; fetchTxMerkle
            // catches and returns null. Either error or a resolved {block_height: 0}
            // path is acceptable, but error is the realistic electrs case.
            wsMock.request.mockRejectedValueOnce(
                new Error("Transaction not yet in a block")
            );
            expect(await provider.getTxStatus("abc")).toEqual({
                confirmed: false,
            });
        });

        it("returns confirmed=false when transaction.get_merkle reports block_height <= 0", async () => {
            wsMock.request.mockResolvedValueOnce({ block_height: 0 });
            expect(await provider.getTxStatus("abc")).toEqual({
                confirmed: false,
            });
        });

        it("derives blockHeight from get_merkle and blockTime from the header", async () => {
            wsMock.request
                .mockResolvedValueOnce({ block_height: 100 }) // get_merkle
                .mockResolvedValueOnce(GENESIS_HEADER_HEX); // block.header(100)

            expect(await provider.getTxStatus("abc")).toEqual({
                confirmed: true,
                blockHeight: 100,
                blockTime: GENESIS_BLOCK_TIME,
            });

            // Critical: the path must NOT use blockchain.transaction.get
            // (which electrs rejects with "verbose transactions are
            // currently unsupported"). Verify the methods we used.
            const methods = wsMock.request.mock.calls.map((c) => c[0]);
            expect(methods).toContain("blockchain.transaction.get_merkle");
            expect(methods).toContain("blockchain.block.header");
            expect(methods).not.toContain("blockchain.transaction.get");
        });

        it("propagates non-'not in block' errors from get_merkle (no silent swallow)", async () => {
            // Real backend errors (auth, network, malformed payload) MUST
            // surface — silently treating them as "mempool / unconfirmed"
            // would freeze any caller polling getTxStatus on a confirmed tx.
            wsMock.request.mockRejectedValueOnce(
                new Error("Authentication required")
            );
            await expect(provider.getTxStatus("abc")).rejects.toThrow(
                /Authentication required/
            );
        });

        it("returns confirmed=true with blockTime=0 when block.header races with index lag (missingheight)", async () => {
            // electrs sometimes reports a tx as confirmed via get_merkle
            // before the corresponding block header is indexable. Tolerate
            // this — confirmation + height are still authoritative; only
            // block_time degrades to 0 (same fallback historyToExplorerTxs
            // uses, mirroring the old verbose-tx path's
            // `blocktime || time || 0`).
            wsMock.request
                .mockResolvedValueOnce({ block_height: 200 })
                .mockRejectedValueOnce(new Error("missingheight"));

            expect(await provider.getTxStatus("abc")).toEqual({
                confirmed: true,
                blockHeight: 200,
                blockTime: 0,
            });
        });

        it("propagates non-'missingheight' errors from block.header", async () => {
            // Same fail-loud principle as get_merkle: only the specific
            // index-lag wording is tolerated.
            wsMock.request
                .mockResolvedValueOnce({ block_height: 200 })
                .mockRejectedValueOnce(new Error("Network unreachable"));

            await expect(provider.getTxStatus("abc")).rejects.toThrow(
                /Network unreachable/
            );
        });
    });

    describe("getTransactions", () => {
        it("returns empty array when history is empty", async () => {
            wsMock.request.mockResolvedValueOnce([]);
            const txs = await provider.getTransactions(REGTEST_ADDRESS);
            expect(txs).toEqual([]);
        });

        it("maps history + raw tx + block header to ExplorerTransaction shape", async () => {
            // buildTestTx() yields outputs of 10_000 and 20_000 sats with
            // P2WPKH scriptPubKeys we can decode back to addresses.
            const { txHex } = buildTestTx();

            // 1. fetchHistory(script) — ws.request
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "tx1", height: 100 },
            ]);
            // 2. fetchTransactions([txid]) — ws.batchRequest returns raw hex
            mockBatch(wsMock.request, [txHex]);
            // 3. Per-height fetchBlockHeader for height 100 — ws.request
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX);

            const txs = await provider.getTransactions(REGTEST_ADDRESS);
            expect(txs).toHaveLength(1);
            expect(txs[0].txid).toBe("tx1");
            // Sat amounts come from the parsed raw tx (exact bigints, no float rounding).
            expect(txs[0].vout.map((v) => v.value)).toEqual(["10000", "20000"]);
            // Addresses come from decoding each output's scriptPubKey.
            expect(txs[0].vout[0].scriptpubkey_address).toMatch(/^bcrt1q/);
            expect(txs[0].vout[1].scriptpubkey_address).toMatch(/^bcrt1q/);
            // block_time comes from parsing the block header (genesis here).
            expect(txs[0].status).toEqual({
                confirmed: true,
                block_time: GENESIS_BLOCK_TIME,
            });

            // Critical: must not call the verbose form of transaction.get
            // (electrs rejects "verbose=true" for that method). The
            // non-verbose form is fine and IS used for raw tx hex; the
            // marker for the verbose form is the boolean second param.
            const verboseTxCalls = wsMock.request.mock.calls.filter(
                (c) =>
                    c[0] === "blockchain.transaction.get" &&
                    c[c.length - 1] === true
            );
            expect(verboseTxCalls).toHaveLength(0);
        });

        it("treats height=0 entries as unconfirmed (mempool)", async () => {
            const { txHex } = buildTestTx();
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "txm", height: 0 },
            ]);
            mockBatch(wsMock.request, [txHex]);
            // No block headers fetched: zero unique confirmed heights.

            const txs = await provider.getTransactions(REGTEST_ADDRESS);
            expect(txs[0].status).toEqual({ confirmed: false, block_time: 0 });
        });

        it("deduplicates block-header lookups across history entries that share heights", async () => {
            const { txHex } = buildTestTx();
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "tx-a", height: 200 },
                { tx_hash: "tx-b", height: 200 },
                { tx_hash: "tx-c", height: 201 },
            ]);
            mockBatch(wsMock.request, [txHex, txHex, txHex]);
            // Two unique heights → exactly TWO ws.request calls for headers.
            wsMock.request
                .mockResolvedValueOnce(GENESIS_HEADER_HEX)
                .mockResolvedValueOnce(GENESIS_HEADER_HEX);

            const txs = await provider.getTransactions(REGTEST_ADDRESS);
            expect(txs).toHaveLength(3);
            const headerCalls = wsMock.request.mock.calls.filter(
                (c) => c[0] === "blockchain.block.header"
            );
            expect(headerCalls).toHaveLength(2);
        });

        it("tolerates per-height header failures without losing the rest of the batch (electrs index lag race)", async () => {
            // electrs sometimes returns a tx as confirmed (listunspent height>0)
            // before its block header is indexable. historyToExplorerTxs
            // tries fetchBlockHeaders first (safeBatchRequest, all-or-nothing);
            // if that throws, falls back to per-height fetchBlockHeader under
            // Promise.allSettled so one failure doesn't poison the rest.
            const { txHex } = buildTestTx();
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "tx-good", height: 100 },
                { tx_hash: "tx-lag", height: 999 }, // lagging height
            ]);
            mockBatch(wsMock.request, [txHex, txHex]); // raw tx batch
            // First header attempt (safeBatchRequest): one succeeds,
            // one fails — safeBatchRequest throws, triggering fallback.
            wsMock.request
                .mockResolvedValueOnce(GENESIS_HEADER_HEX) // block.header(100)
                .mockRejectedValueOnce(new Error("missingheight")); // block.header(999)
            // Fallback per-height attempt: same outcome.
            wsMock.request
                .mockResolvedValueOnce(GENESIS_HEADER_HEX)
                .mockRejectedValueOnce(new Error("missingheight"));

            const txs = await provider.getTransactions(REGTEST_ADDRESS);
            expect(txs).toHaveLength(2);
            const good = txs.find((t) => t.txid === "tx-good")!;
            const lag = txs.find((t) => t.txid === "tx-lag")!;
            expect(good.status).toEqual({
                confirmed: true,
                block_time: GENESIS_BLOCK_TIME,
            });
            // The lagging entry still surfaces, just without a block_time.
            expect(lag.status).toEqual({ confirmed: true, block_time: 0 });
        });

        it("never uses the library's leaky batchRequest (uses safeBatchRequest instead)", async () => {
            // The library's batchRequest is implemented as Promise.all over
            // individual request promises — when one element rejects, the
            // others stay pending and their later rejections become
            // unhandled (crashing the test runner). Our safeBatchRequest
            // wraps each request in Promise.allSettled so every promise
            // has an explicit handler. This regression test asserts that
            // the provider's hot path never reaches the leaky primitive.
            const { txHex } = buildTestTx();
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "tx-a", height: 100 },
                { tx_hash: "tx-b", height: 101 },
            ]);
            mockBatch(wsMock.request, [txHex, txHex]); // safeBatchRequest for raw txs
            mockBatch(wsMock.request, [GENESIS_HEADER_HEX, GENESIS_HEADER_HEX]);

            await provider.getTransactions(REGTEST_ADDRESS);

            expect(wsMock.batchRequest).not.toHaveBeenCalled();
        });

        it("rejects malformed addresses with a descriptive error", async () => {
            await expect(
                provider.getTransactions("not-a-real-address")
            ).rejects.toThrow(/Invalid address not-a-real-address/);
        });

        it("propagates parse errors with the offending txid (no silent empty vout)", async () => {
            // If the daemon returns gibberish for a tx, surfacing an empty
            // vout would silently hide outputs (e.g. a deposit). Fail loud
            // instead — let the caller decide whether to retry or skip.
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "txbad", height: 100 },
            ]);
            mockBatch(wsMock.request, ["zz"]); // not valid hex
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX); // header for height 100

            await expect(
                provider.getTransactions(REGTEST_ADDRESS)
            ).rejects.toThrow(/Failed to parse raw tx for txbad/);
        });
    });

    describe("watchAddresses", () => {
        it("registers script subscriptions in parallel and emits new txs via callback", async () => {
            // Derive a second valid regtest address from a known hash so we
            // exercise the parallel-subscribe path with two distinct script
            // hashes (without depending on any external fixture).
            const addr1 = REGTEST_ADDRESS;
            const addr2 = regtestAddressFromHash(new Uint8Array(20).fill(0x42));

            // Initial fetchHistory for each address — empty (no known txids).
            wsMock.request.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

            const subscribeCallbacks = new Map<
                string,
                (scripthash: string, status: string | null) => void
            >();
            wsMock.subscribe.mockImplementation(
                async (
                    method: string,
                    cb: (s: string, status: string | null) => void,
                    scripthash: string
                ) => {
                    if (method === "blockchain.scripthash") {
                        subscribeCallbacks.set(scripthash, cb);
                    }
                }
            );

            const events: unknown[] = [];
            const stop = await provider.watchAddresses([addr1, addr2], (txs) =>
                events.push(txs)
            );

            // Both subscribes must have been registered before resolving.
            expect(subscribeCallbacks.size).toBe(2);

            // Server pushes a status update for addr1 — provider must refetch
            // history and report the new tx via callback.
            const [firstScripthash, firstCb] = [
                ...subscribeCallbacks.entries(),
            ][0];
            const { txHex } = buildTestTx();
            // 1. fetchHistory(script) — sees a new tx on this script
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "newtx", height: 100 },
            ]);
            // 2. fetchTransactions batchRequest for raw tx hex
            mockBatch(wsMock.request, [txHex]);
            // 3. Per-height block.header request (no longer batched)
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX);
            firstCb(firstScripthash, "deadbeef");

            // The chain involves two awaited round-trips before the callback
            // fires; pump the microtask queue a few times rather than relying
            // on a single setTimeout(0).
            for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 0));
            }

            expect(events).toHaveLength(1);
            const delivered = (events[0] as Array<{ txid: string }>)[0];
            expect(delivered.txid).toBe("newtx");

            stop();
            expect(wsMock.unsubscribe).toHaveBeenCalledTimes(2);
        });

        it("re-delivers a tx on the next notification when delivery fails the first time", async () => {
            // Regression: the dedupe set must not be updated until the
            // eventCallback has fired successfully. Previously a failed
            // historyToExplorerTxs / eventCallback would permanently mark
            // the txid as seen and the next notification would skip it.
            const addr = REGTEST_ADDRESS;
            wsMock.request.mockResolvedValueOnce([]); // initial fetchHistory: empty

            const subscribeCallbacks = new Map<
                string,
                (scripthash: string, status: string | null) => void
            >();
            wsMock.subscribe.mockImplementation(
                async (
                    method: string,
                    cb: (s: string, status: string | null) => void,
                    scripthash: string
                ) => {
                    if (method === "blockchain.scripthash") {
                        subscribeCallbacks.set(scripthash, cb);
                    }
                }
            );

            // Callback throws on first invocation, succeeds on second.
            const events: unknown[] = [];
            let firstCallSeen = false;
            const stop = await provider.watchAddresses([addr], (txs) => {
                if (!firstCallSeen) {
                    firstCallSeen = true;
                    throw new Error("simulated downstream failure");
                }
                events.push(txs);
            });

            const [scripthash, cb] = [...subscribeCallbacks.entries()][0];
            const { txHex } = buildTestTx();

            // First notification: history sees newtx, parse succeeds, but
            // the user callback throws.
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "newtx", height: 100 },
            ]);
            mockBatch(wsMock.request, [txHex]); // raw tx
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX); // header
            cb(scripthash, "status1");
            for (let i = 0; i < 6; i++)
                await new Promise((r) => setTimeout(r, 0));
            expect(events).toHaveLength(0); // first call threw

            // Second notification: same newtx still in history. Provider
            // must NOT have marked it seen — should re-attempt delivery.
            wsMock.request.mockResolvedValueOnce([
                { tx_hash: "newtx", height: 100 },
            ]);
            mockBatch(wsMock.request, [txHex]);
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX);
            cb(scripthash, "status2");
            for (let i = 0; i < 6; i++)
                await new Promise((r) => setTimeout(r, 0));

            expect(events).toHaveLength(1);
            const delivered = (events[0] as Array<{ txid: string }>)[0];
            expect(delivered.txid).toBe("newtx");

            stop();
        });
    });

    describe("getTxOutspends", () => {
        const { txHex, scripts } = buildTestTx();
        const parentTxid = hex.encode(
            sha256(sha256(hex.decode(txHex))).reverse()
        );
        const scriptHashes = scripts.map(toScriptHash);

        it("returns all-unspent when both outputs are in listunspent", async () => {
            // Step 1: fetchTransactions for creator tx
            mockBatch(wsMock.request, [txHex]);

            // Step 2: listunspent for each output scripthash — both show our tx
            mockBatch(wsMock.request, [
                [
                    {
                        tx_hash: parentTxid,
                        tx_pos: 0,
                        value: 10_000,
                        height: 100,
                    },
                ],
                [
                    {
                        tx_hash: parentTxid,
                        tx_pos: 1,
                        value: 20_000,
                        height: 100,
                    },
                ],
            ]);

            const results = await provider.getTxOutspends(parentTxid);
            expect(results).toEqual([
                { spent: false, txid: "" },
                { spent: false, txid: "" },
            ]);
        });

        it("resolves simple spent case via single history candidate", async () => {
            const spenderHex = buildSpendingTx(parentTxid, 0);
            const spenderTxid = hex.encode(
                sha256(sha256(hex.decode(spenderHex))).reverse()
            );

            // Step 1: fetchTransactions for creator
            mockBatch(wsMock.request, [txHex]);

            // Step 2: listunspent — vout 0 gone, vout 1 still there
            mockBatch(wsMock.request, [
                [], // vout 0 spent
                [
                    {
                        tx_hash: parentTxid,
                        tx_pos: 1,
                        value: 20_000,
                        height: 100,
                    },
                ],
            ]);

            // Step 3: history for the spent output's scripthash
            // history has [parent, spender] → exactly one candidate that isn't the parent
            mockBatch(wsMock.request, [
                [
                    { tx_hash: parentTxid, height: 100 },
                    { tx_hash: spenderTxid, height: 101 },
                ],
            ]);

            const results = await provider.getTxOutspends(parentTxid);
            expect(results[0]).toEqual({ spent: true, txid: spenderTxid });
            expect(results[1]).toEqual({ spent: false, txid: "" });
        });

        it("disambiguates reused-script history by scanning candidate inputs", async () => {
            // Create two candidate spenders — only one actually spends vout 0
            const realSpenderHex = buildSpendingTx(parentTxid, 0);
            const realSpenderTxid = hex.encode(
                sha256(sha256(hex.decode(realSpenderHex))).reverse()
            );
            const decoyHex = buildSpendingTx(
                "0000000000000000000000000000000000000000000000000000000000000099",
                3
            );
            const decoyTxid = hex.encode(
                sha256(sha256(hex.decode(decoyHex))).reverse()
            );

            // Step 1: fetch parent
            mockBatch(wsMock.request, [txHex]);

            // Step 2: listunspent — vout 0 spent, vout 1 unspent
            mockBatch(wsMock.request, [
                [],
                [
                    {
                        tx_hash: parentTxid,
                        tx_pos: 1,
                        value: 20_000,
                        height: 100,
                    },
                ],
            ]);

            // Step 3: history for script 0 contains parent + two candidates
            mockBatch(wsMock.request, [
                [
                    { tx_hash: parentTxid, height: 100 },
                    { tx_hash: decoyTxid, height: 102 },
                    { tx_hash: realSpenderTxid, height: 103 },
                ],
            ]);

            // Step 4: batch-fetch candidate txs to scan their inputs
            mockBatch(wsMock.request, [decoyHex, realSpenderHex]);

            const results = await provider.getTxOutspends(parentTxid);
            expect(results[0]).toEqual({ spent: true, txid: realSpenderTxid });
            expect(results[1]).toEqual({ spent: false, txid: "" });
        });
    });

    describe("close", () => {
        it("delegates to underlying ws close()", async () => {
            await provider.close();
            expect(wsMock.close).toHaveBeenCalledTimes(1);
        });
    });
});

describe("WsElectrumChainSource", () => {
    let wsMock: ReturnType<typeof createMockWS>;
    let chain: WsElectrumChainSource;

    beforeEach(() => {
        wsMock = createMockWS();
        chain = new WsElectrumChainSource(
            wsMock.ws as unknown as ElectrumWS,
            networks.regtest
        );
    });

    describe("fetchBlockHeader / fetchBlockHeaders", () => {
        it("returns {height, hex} from single request", async () => {
            wsMock.request.mockResolvedValueOnce(GENESIS_HEADER_HEX);
            const header = await chain.fetchBlockHeader(0);
            expect(header).toEqual({ height: 0, hex: GENESIS_HEADER_HEX });
        });

        it("issues per-height ws.request calls in parallel via safeBatchRequest", async () => {
            mockBatch(wsMock.request, ["h1", "h2", "h3"]);
            const headers = await chain.fetchBlockHeaders([10, 20, 30]);
            expect(headers).toEqual([
                { height: 10, hex: "h1" },
                { height: 20, hex: "h2" },
                { height: 30, hex: "h3" },
            ]);
            // Three ws.request calls, no library batchRequest.
            const headerCalls = wsMock.request.mock.calls.filter(
                (c) => c[0] === "blockchain.block.header"
            );
            expect(headerCalls).toHaveLength(3);
            expect(wsMock.batchRequest).not.toHaveBeenCalled();
        });
    });

    describe("fetchVerboseTransactions", () => {
        it("returns empty array without calling ws when input is empty", async () => {
            const out = await chain.fetchVerboseTransactions([]);
            expect(out).toEqual([]);
            expect(wsMock.request).not.toHaveBeenCalled();
            expect(wsMock.batchRequest).not.toHaveBeenCalled();
        });
    });

    describe("fetchTransactions retry on missing tx", () => {
        it("retries after a 'missingtransaction' error then succeeds", async () => {
            // First attempt: ws.request rejects with missingtransaction.
            // safeBatchRequest forwards the rejection; the chain's retry
            // loop catches it and attempts again.
            wsMock.request
                .mockRejectedValueOnce(
                    new Error("daemon error: missingtransaction")
                )
                .mockResolvedValueOnce("0200"); // second attempt succeeds

            const result = await chain.fetchTransactions(["tx1"]);
            expect(result).toEqual([{ txID: "tx1", hex: "0200" }]);
            // Two ws.request calls (one per attempt).
            const txGetCalls = wsMock.request.mock.calls.filter(
                (c) => c[0] === "blockchain.transaction.get"
            );
            expect(txGetCalls).toHaveLength(2);
        });

        it("propagates non-missing errors immediately", async () => {
            wsMock.request.mockRejectedValueOnce(
                new Error("connection refused")
            );
            await expect(chain.fetchTransactions(["tx1"])).rejects.toThrow(
                "connection refused"
            );
        });
    });

    describe("getRelayFee / estimateFees", () => {
        it("returns electrum relay fee as-is (BTC/kB)", async () => {
            wsMock.request.mockResolvedValueOnce(0.00001);
            expect(await chain.getRelayFee()).toBe(0.00001);
        });

        it("requests estimatefee with target block count", async () => {
            wsMock.request.mockResolvedValueOnce(0.0002);
            const rate = await chain.estimateFees(6);
            expect(rate).toBe(0.0002);
            expect(wsMock.request).toHaveBeenCalledWith(
                "blockchain.estimatefee",
                6
            );
        });
    });

    describe("broadcastTransaction", () => {
        it("forwards tx hex to electrum broadcast method", async () => {
            wsMock.request.mockResolvedValueOnce("broadcasttxid");
            expect(await chain.broadcastTransaction("rawhex")).toBe(
                "broadcasttxid"
            );
            expect(wsMock.request).toHaveBeenCalledWith(
                "blockchain.transaction.broadcast",
                "rawhex"
            );
        });
    });

    describe("broadcastPackage", () => {
        it("returns the locally-derived txid (witness-stripped) on success", async () => {
            const {
                txHex: childHex,
                expectedTxid,
                expectedWtxid,
            } = buildSegwitTxWithWitness();
            expect(expectedTxid).not.toBe(expectedWtxid);

            wsMock.request.mockResolvedValueOnce({
                success: true,
                errors: null,
            });

            expect(await chain.broadcastPackage(["parentHex", childHex])).toBe(
                expectedTxid
            );
            expect(wsMock.request).toHaveBeenCalledWith(
                "blockchain.transaction.broadcast_package",
                ["parentHex", childHex],
                false
            );
        });

        it("throws with the underlying error when success=false", async () => {
            wsMock.request.mockResolvedValueOnce({
                success: false,
                errors: [{ error: "txn-mempool-conflict" }],
            });

            await expect(chain.broadcastPackage(["a", "b"])).rejects.toThrow(
                /txn-mempool-conflict/
            );
        });

        it("throws 'unknown error' when success=false but errors is missing", async () => {
            wsMock.request.mockResolvedValueOnce({ success: false });
            await expect(chain.broadcastPackage(["a", "b"])).rejects.toThrow(
                /unknown error/
            );
        });
    });

    describe("addressForScript", () => {
        it("decodes a valid P2WPKH script to an address", async () => {
            const hash = new Uint8Array(20).fill(0x01);
            const script = p2wpkhScript(hash);
            const addr = chain.addressForScript(hex.encode(script));
            expect(addr).toBeDefined();
            expect(addr).toMatch(/^bcrt1q/);
        });

        it("returns undefined for unparseable scripts", async () => {
            expect(chain.addressForScript("00")).toBeUndefined();
        });
    });

    describe("close", () => {
        it("calls ws.close('close')", async () => {
            await chain.close();
            expect(wsMock.close).toHaveBeenCalledWith("close");
        });

        it("swallows errors from ws.close", async () => {
            wsMock.close.mockRejectedValueOnce(new Error("already closed"));
            await expect(chain.close()).resolves.toBeUndefined();
        });
    });
});
