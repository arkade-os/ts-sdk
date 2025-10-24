import { describe, it, expect, beforeEach, vi } from "vitest";
import { ElectrumProvider } from "../src/providers/onchain";
import { getNetwork, NetworkName } from "../src/networks";
import { Address, OutScript } from "@scure/btc-signer/payment.js";
import { p2tr } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

type ElectrumHistoryItem = {
    tx_hash: string;
    height: number;
};

type ElectrumUnspent = {
    tx_hash: string;
    tx_pos: number;
    value: number;
    height: number;
};

type ElectrumVerboseVin = {
    txid?: string;
    vout?: number;
};

type ElectrumVerboseVout = {
    n: number;
    value: number;
    scriptPubKey: {
        hex?: string;
        address?: string;
        addresses?: string[];
        type?: string;
    };
};

type ElectrumVerboseTx = {
    txid: string;
    hex: string;
    vout: ElectrumVerboseVout[];
    vin: ElectrumVerboseVin[];
    blockhash?: string;
    blocktime?: number;
    time?: number;
    confirmations?: number;
    height?: number;
};

type ScriptHash = string;

type BroadcastResults = {
    txid: string;
    hex: string;
};

class MockElectrumClient {
    readonly data = {
        header: {
            hex: createHeaderHex(1700000500),
            height: 200,
        },
        unspents: new Map<ScriptHash, ElectrumUnspent[]>(),
        histories: new Map<ScriptHash, ElectrumHistoryItem[]>(),
        transactions: new Map<string, ElectrumVerboseTx>(),
        heights: new Map<string, number>(),
        blockHeaders: new Map<number, string>(),
        broadcastResults: new Map<string, BroadcastResults>(),
        scriptStatuses: new Map<ScriptHash, string>(),
        feeEstimate: 0.00025,
    };

    private scriptCallbacks = new Map<
        ScriptHash,
        (...payload: unknown[]) => unknown
    >();
    private headerCallback: ((...payload: unknown[]) => unknown) | null = null;

    async request(method: string, ...params: any[]): Promise<any> {
        switch (method) {
            case "blockchain.scripthash.listunspent": {
                const [scriptHash] = params as [ScriptHash];
                return this.cloneArray(
                    this.data.unspents.get(scriptHash) ?? []
                );
            }
            case "blockchain.block.header": {
                const [height] = params as [number];
                const header =
                    this.data.blockHeaders.get(height) ?? this.data.header.hex;
                return header;
            }
            case "blockchain.estimatefee": {
                return this.data.feeEstimate;
            }
            case "blockchain.transaction.broadcast": {
                const [hexTx] = params as [string];
                const preset = this.data.broadcastResults.get(hexTx);
                if (preset) {
                    return preset.txid;
                }
                return `mock-${hexTx.slice(0, 8)}`;
            }
            case "blockchain.transaction.get": {
                const [txid] = params as [string];
                const tx = this.data.transactions.get(txid);
                if (!tx) {
                    throw new Error(`Missing verbose tx for ${txid}`);
                }
                return this.cloneObject(tx);
            }
            case "blockchain.scripthash.get_history": {
                const [scriptHash] = params as [ScriptHash];
                return this.cloneArray(
                    this.data.histories.get(scriptHash) ?? []
                );
            }
            case "blockchain.transaction.get_height": {
                const [txid] = params as [string];
                const height = this.data.heights.get(txid);
                if (height === undefined) {
                    throw new Error(`Missing height for ${txid}`);
                }
                return { height };
            }
            default:
                throw new Error(`Unexpected request method ${method}`);
        }
    }

    async subscribe(
        method: string,
        callback: (...payload: unknown[]) => unknown,
        ...params: any[]
    ): Promise<void> {
        if (method === "blockchain.headers") {
            this.headerCallback = callback;
            callback({
                hex: this.data.header.hex,
                height: this.data.header.height,
            });
            return;
        }

        if (method === "blockchain.scripthash") {
            const [scriptHash] = params as [ScriptHash];
            this.scriptCallbacks.set(scriptHash, callback);
            const status = this.data.scriptStatuses.get(scriptHash) ?? "";
            callback(scriptHash, status);
            return;
        }

        throw new Error(`Unsupported subscribe method ${method}`);
    }

    async unsubscribe(method: string, ...params: any[]): Promise<void> {
        if (method === "blockchain.scripthash") {
            const [scriptHash] = params as [ScriptHash];
            this.scriptCallbacks.delete(scriptHash);
        }
    }

    triggerScriptHash(scriptHash: ScriptHash, status = ""): void {
        const callback = this.scriptCallbacks.get(scriptHash);
        if (!callback) return;
        const nextStatus =
            status || `status-${Math.floor(Math.random() * 1e6)}`;
        this.data.scriptStatuses.set(scriptHash, nextStatus);
        callback(scriptHash, nextStatus);
    }

    private cloneArray<T>(arr: T[]): T[] {
        return arr.map((item) =>
            typeof item === "object"
                ? this.cloneObject(item as Record<string, unknown>)
                : item
        );
    }

    private cloneObject<T extends Record<string, unknown>>(obj: T): T {
        return JSON.parse(JSON.stringify(obj));
    }
}

const TEST_NETWORK: NetworkName = "testnet";
const NETWORK = getNetwork(TEST_NETWORK);
const INTERNAL_KEY_HEX =
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const TAPROOT = p2tr(hex.decode(INTERNAL_KEY_HEX), undefined, NETWORK);
const TEST_ADDRESS = TAPROOT.address ?? "";
if (!TEST_ADDRESS) {
    throw new Error("Failed to derive taproot address for tests");
}
const SCRIPT_HEX = hex.encode(TAPROOT.script);
const SCRIPT_HASH = toScriptHash(TEST_ADDRESS, TEST_NETWORK);

let mock: MockElectrumClient;
let provider: ElectrumProvider;

beforeEach(() => {
    mock = new MockElectrumClient();
    mock.data.blockHeaders.set(5, createHeaderHex(1700000000));
    provider = new ElectrumProvider("wss://mock", TEST_NETWORK, {
        electrum: mock as unknown as any,
    });
});

describe("ElectrumProvider", () => {
    it("returns coins with confirmation metadata", async () => {
        mock.data.unspents.set(SCRIPT_HASH, [
            {
                tx_hash: "tx-1",
                tx_pos: 0,
                value: 5_000,
                height: 5,
            },
        ]);

        const coins = await provider.getCoins(TEST_ADDRESS);
        expect(coins).toHaveLength(1);
        expect(coins[0]?.txid).toBe("tx-1");
        expect(coins[0]?.vout).toBe(0);
        expect(coins[0]?.value).toBe(5_000);
        expect(coins[0]?.status.confirmed).toBe(true);
        expect(coins[0]?.status.block_time).toBe(1700000000);
    });

    it("converts fee estimates to sat/vbyte", async () => {
        mock.data.feeEstimate = 0.00025; // 25 sat/vbyte
        const feeRate = await provider.getFeeRate();
        expect(feeRate).toBe(25);
    });

    it("broadcasts parent and child transactions sequentially", async () => {
        mock.data.broadcastResults.set("parenthex", {
            hex: "parenthex",
            txid: "parent-txid",
        });
        mock.data.broadcastResults.set("childhex", {
            hex: "childhex",
            txid: "child-txid",
        });

        const txid = await provider.broadcastTransaction(
            "parenthex",
            "childhex"
        );
        expect(txid).toBe("child-txid");
    });

    it("fetches transactions with decoded outputs", async () => {
        mock.data.histories.set(SCRIPT_HASH, [
            { tx_hash: "tx-confirmed", height: 10 },
            { tx_hash: "tx-mempool", height: 0 },
        ]);

        mock.data.transactions.set("tx-confirmed", {
            txid: "tx-confirmed",
            hex: "deadbeef",
            vout: [
                {
                    n: 0,
                    value: 0.0001,
                    scriptPubKey: {
                        hex: SCRIPT_HEX,
                    },
                },
            ],
            vin: [],
            blocktime: 1700001000,
            confirmations: 1,
            height: 10,
        });
        mock.data.transactions.set("tx-mempool", {
            txid: "tx-mempool",
            hex: "feedbabe",
            vout: [
                {
                    n: 0,
                    value: 0.0002,
                    scriptPubKey: {
                        hex: SCRIPT_HEX,
                    },
                },
            ],
            vin: [],
            time: 1700002000,
        });

        const txs = await provider.getTransactions(TEST_ADDRESS);
        expect(txs).toHaveLength(2);

        const confirmed = txs.find((tx) => tx.txid === "tx-confirmed");
        expect(confirmed?.status.confirmed).toBe(true);
        expect(confirmed?.status.block_time).toBe(1700001000);
        expect(confirmed?.vout[0]?.value).toBe("10000");

        const mempool = txs.find((tx) => tx.txid === "tx-mempool");
        expect(mempool?.status.confirmed).toBe(false);
        expect(mempool?.vout[0]?.value).toBe("20000");
    });

    it("detects outspends from history", async () => {
        mock.data.histories.set(SCRIPT_HASH, [
            { tx_hash: "tx-origin", height: 12 },
            { tx_hash: "tx-spender", height: 13 },
        ]);

        mock.data.transactions.set("tx-origin", {
            txid: "tx-origin",
            hex: "00",
            vout: [
                {
                    n: 0,
                    value: 0.0003,
                    scriptPubKey: { hex: SCRIPT_HEX },
                },
            ],
            vin: [],
            confirmations: 1,
            height: 12,
        });
        mock.data.transactions.set("tx-spender", {
            txid: "tx-spender",
            hex: "01",
            vout: [],
            vin: [{ txid: "tx-origin", vout: 0 }],
            confirmations: 1,
            height: 13,
        });

        const outspends = await provider.getTxOutspends("tx-origin");
        expect(outspends).toEqual([{ spent: true, txid: "tx-spender" }]);
    });

    it("reports confirmation status for transactions", async () => {
        mock.data.transactions.set("tx-status", {
            txid: "tx-status",
            hex: "02",
            vout: [],
            vin: [],
            confirmations: 3,
            blocktime: 1700003000,
            height: 42,
        });
        mock.data.heights.set("tx-status", 42);

        const status = await provider.getTxStatus("tx-status");
        expect(status.confirmed).toBe(true);
        if (status.confirmed) {
            expect(status.blockHeight).toBe(42);
            expect(status.blockTime).toBe(1700003000);
        }
    });

    it("invokes watchers when new transactions arrive", async () => {
        mock.data.histories.set(SCRIPT_HASH, [
            { tx_hash: "tx-existing", height: 20 },
        ]);
        mock.data.transactions.set("tx-existing", {
            txid: "tx-existing",
            hex: "03",
            vout: [
                {
                    n: 0,
                    value: 0.0001,
                    scriptPubKey: { hex: SCRIPT_HEX },
                },
            ],
            vin: [],
            confirmations: 1,
            height: 20,
        });

        const callback = vi.fn();
        const stop = await provider.watchAddresses([TEST_ADDRESS], callback);

        mock.data.transactions.set("tx-new", {
            txid: "tx-new",
            hex: "04",
            vout: [
                {
                    n: 0,
                    value: 0.0004,
                    scriptPubKey: { hex: SCRIPT_HEX },
                },
            ],
            vin: [],
            time: 1700004000,
        });
        mock.data.histories.set(SCRIPT_HASH, [
            { tx_hash: "tx-existing", height: 20 },
            { tx_hash: "tx-new", height: 0 },
        ]);

        mock.triggerScriptHash(SCRIPT_HASH, "new-status");

        await vi.waitUntil(() => callback.mock.calls.length > 0, {
            timeout: 500,
        });

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback.mock.calls[0][0][0].txid).toBe("tx-new");

        stop();
    });
});

function createHeaderHex(time: number): string {
    const buffer = Buffer.alloc(80, 0);
    buffer.writeUInt32LE(time, 68);
    return buffer.toString("hex");
}

function toScriptHash(address: string, networkName: NetworkName): string {
    const network = getNetwork(networkName);
    const script = OutScript.encode(Address(network).decode(address));
    const digest = sha256(script);
    const reversed = Uint8Array.from(digest);
    reversed.reverse();
    return hex.encode(reversed);
}
