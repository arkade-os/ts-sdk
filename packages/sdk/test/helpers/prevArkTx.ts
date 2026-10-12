import { base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Transaction } from "../../src";

/**
 * Emulator v0.0.7+ makes a covenant spend resolve the previous ark tx of every
 * input through the indexer, and the resolver keys results by the txid each PSBT
 * actually computes to. So a test coin can no longer carry a made-up txid: it
 * has to be the real id of a tx the mock indexer can serve.
 */
const minted = new Map<string, string>();

/** A coin whose txid is the real id of a servable stand-in previous ark tx. */
export function mintCoin(value: number, vout = 0): { txid: string; vout: number; value: number } {
    const seed = minted.size + 1;
    const script = new Uint8Array([
        0x51,
        0x20,
        ...schnorr.getPublicKey(new Uint8Array(32).fill(seed & 0xff || 1)),
    ]);
    const tx = new Transaction({ version: 3 });
    tx.addInput({
        txid: new Uint8Array(32).fill(seed & 0xff),
        index: seed,
        witnessUtxo: { script, amount: BigInt(value) },
    });
    tx.addOutput({ script, amount: BigInt(value) });
    minted.set(tx.id, base64.encode(tx.toPSBT()));
    return { txid: tx.id, vout, value };
}

/** `IndexerProvider.getVirtualTxs` over everything {@link mintCoin} has minted. */
export async function getVirtualTxs(txids: string[]): Promise<{ txs: string[] }> {
    return { txs: txids.map((t) => minted.get(t)).filter((p): p is string => p !== undefined) };
}
