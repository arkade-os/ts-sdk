import { describe, it, expect, vi } from "vitest";
import * as bip68 from "bip68";
import { Unroll, VtxoScript, CSVMultisigTapscript } from "../src";

type VarIntRead = {
    value: number;
    size: number;
};

function readVarInt(buffer: Buffer, offset: number): VarIntRead {
    const first = buffer[offset];
    if (first < 0xfd) {
        return { value: first, size: 1 };
    }
    if (first === 0xfd) {
        return { value: buffer.readUInt16LE(offset + 1), size: 3 };
    }
    if (first === 0xfe) {
        return { value: buffer.readUInt32LE(offset + 1), size: 5 };
    }
    throw new Error("unsupported varint size");
}

function firstInputSequence(rawTxHex: string): number {
    const buffer = Buffer.from(rawTxHex, "hex");
    let offset = 4; // version

    const isSegwit = buffer[offset] === 0x00 && buffer[offset + 1] === 0x01;
    if (isSegwit) {
        offset += 2; // marker + flag
    }

    const vin = readVarInt(buffer, offset);
    offset += vin.size;
    if (vin.value < 1) {
        throw new Error("transaction has no inputs");
    }

    offset += 32; // prev txid
    offset += 4; // prev vout
    const scriptLen = readVarInt(buffer, offset);
    offset += scriptLen.size;
    offset += scriptLen.value;

    return buffer.readUInt32LE(offset) >>> 0;
}

function makeMockWallet(timelock: { type: "blocks" | "seconds"; value: bigint }) {
    const pubkey = new Uint8Array(32).fill(0x02);
    const exit = CSVMultisigTapscript.encode({
        timelock,
        pubkeys: [pubkey],
    });
    const tapTree = new VtxoScript([exit.script]).encode();

    const vtxo = {
        txid: "ab".repeat(32),
        vout: 0,
        value: 10_000,
        isUnrolled: true,
        tapTree,
    };

    const broadcastTransaction = vi.fn().mockResolvedValue("txid");

    const wallet = {
        network: "regtest",
        onchainProvider: {
            getChainTip: vi.fn().mockResolvedValue({
                height: 10_000,
                time: 10_000_000,
                hash: "00".repeat(32),
            }),
            getTxStatus: vi.fn().mockResolvedValue({
                confirmed: true,
                blockHeight: 100,
                blockTime: 100,
            }),
            getFeeRate: vi.fn().mockResolvedValue(1),
            broadcastTransaction,
        },
        getVtxos: vi.fn().mockResolvedValue([vtxo]),
        identity: {
            sign: vi.fn().mockImplementation(async (tx: any) => tx),
        },
    } as any;

    return { wallet, vtxo, broadcastTransaction };
}

describe("Unroll.completeUnroll sequence", () => {
    it("encodes block-based CSV timelock into input nSequence", async () => {
        const timelock = { type: "blocks" as const, value: 144n };
        const { wallet, vtxo, broadcastTransaction } = makeMockWallet(timelock);

        await Unroll.completeUnroll(wallet, [vtxo.txid], "bcrt1q7pqszfvw3kg2w4fyxlrp5f8qq7j8f57d9ct8su");

        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
        const rawTxHex = broadcastTransaction.mock.calls[0][0] as string;
        const seq = firstInputSequence(rawTxHex);
        const expected = bip68.encode({ blocks: Number(timelock.value) });
        expect(seq).toBe(expected);
    });

    it("encodes seconds-based CSV timelock into input nSequence", async () => {
        const timelock = { type: "seconds" as const, value: 604672n };
        const { wallet, vtxo, broadcastTransaction } = makeMockWallet(timelock);

        await Unroll.completeUnroll(wallet, [vtxo.txid], "bcrt1q7pqszfvw3kg2w4fyxlrp5f8qq7j8f57d9ct8su");

        expect(broadcastTransaction).toHaveBeenCalledTimes(1);
        const rawTxHex = broadcastTransaction.mock.calls[0][0] as string;
        const seq = firstInputSequence(rawTxHex);
        const expected = bip68.encode({ seconds: Number(timelock.value) });
        expect(seq).toBe(expected);
    });
});
