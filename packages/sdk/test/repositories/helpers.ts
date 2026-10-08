import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import type { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin, TxType } from "../../src/wallet";
import type { TapLeafScript } from "../../src/script/base";

export type RepositoryTestItem<T> = {
    name: string;
    factory: () => Promise<T>;
};

function createMockTapLeafScript(): TapLeafScript {
    const version = 0xc0;
    const internalKey = new Uint8Array(32).fill(1);
    const controlBlockBytes = new Uint8Array([version, ...internalKey]);
    const controlBlock = TaprootControlBlock.decode(controlBlockBytes);
    const script = new Uint8Array(20).fill(2);
    return [controlBlock, script];
}

export function createMockVtxo(txid: string, vout: number, value: number): ExtendedVirtualCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: Date.now(),
        },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: true,
        commitmentTxIds: [],
        spentBy: "",
        script: hex.encode(new Uint8Array(32).fill(4)),
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

export function createMockUtxo(txid: string, vout: number, value: number): ExtendedCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: Date.now(),
        },
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

let txCounter = 0;
export function createMockTransaction(
    key: { boardingTxid?: string; commitmentTxid?: string; arkTxid?: string },
    type: TxType,
    amount: number,
): ArkTransaction {
    if (!key.boardingTxid && !key.commitmentTxid && !key.arkTxid) {
        throw new Error("Key must have one of boardingTxid, commitmentTxid, or arkTxid");
    }
    return {
        key: {
            boardingTxid: key.boardingTxid || "",
            commitmentTxid: key.commitmentTxid || "",
            arkTxid: key.arkTxid || "",
        },
        type,
        amount,
        settled: false,
        createdAt: Date.now() + txCounter++,
    };
}
