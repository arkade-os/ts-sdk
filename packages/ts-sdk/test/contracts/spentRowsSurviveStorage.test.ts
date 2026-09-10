import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaprootControlBlock } from "@scure/btc-signer";
import {
    type Contract,
    type ExtendedVirtualCoin,
    IndexedDBWalletRepository,
    InMemoryWalletRepository,
    type TapLeafScript,
} from "../../src";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";
import type { WalletRepository } from "../../src/repositories";
import { getVtxosForContract, saveVtxosForContract } from "../../src/contracts/vtxoOwnership";
import { createMockSQLExecutor } from "../helpers/mockSqlExecutor";
import { TEST_DEFAULT_SCRIPT } from "./helpers";

const CHECKPOINT = "cc".repeat(32);
const ARK_TX = "dd".repeat(32);

const contract: Pick<Contract, "script" | "address"> = {
    script: TEST_DEFAULT_SCRIPT,
    address: "contract-address",
};

function tapLeaf(): TapLeafScript {
    const controlBlock = TaprootControlBlock.decode(new Uint8Array([0xc0, ...new Uint8Array(32)]));
    return [controlBlock, new Uint8Array(20).fill(2)];
}

/** A deposit the sync has already seen spent. */
const spentDeposit = (): ExtendedVirtualCoin => ({
    txid: "ab".repeat(32),
    vout: 0,
    value: 10_000,
    status: { confirmed: true },
    virtualStatus: { state: "spent" },
    createdAt: new Date("2024-01-15T12:00:00Z"),
    isUnrolled: false,
    isSpent: true,
    spentBy: CHECKPOINT,
    arkTxId: ARK_TX,
    script: TEST_DEFAULT_SCRIPT,
    forfeitTapLeafScript: tapLeaf(),
    intentTapLeafScript: tapLeaf(),
    tapTree: new Uint8Array(32).fill(3),
});

const backends: { name: string; make: () => WalletRepository }[] = [
    { name: "InMemoryWalletRepository", make: () => new InMemoryWalletRepository() },
    { name: "IndexedDBWalletRepository", make: () => new IndexedDBWalletRepository() },
    {
        name: "SQLiteWalletRepository",
        make: () => new SQLiteWalletRepository(createMockSQLExecutor()),
    },
];

/**
 * `getContractsWithVtxos` delegates straight to `getVtxosForContract`, so this
 * is the read behind every consumer asking a contract what became of its
 * deposits — and it fails silently: a backend that pruned spent rows, or dropped
 * their txids in its serializer, leaves them finding nothing, suite still green.
 */
describe.each(backends)("spent rows survive $name", ({ make }) => {
    let repository: WalletRepository;

    beforeEach(() => {
        repository = make();
    });

    afterEach(async () => {
        await repository?.clear();
        await repository?.[Symbol.asyncDispose]();
    });

    it("returns the spent deposit, carrying both halves of its spend", async () => {
        await saveVtxosForContract(repository, contract, [spentDeposit()]);

        const vtxos = await getVtxosForContract(repository, contract);

        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({
            txid: "ab".repeat(32),
            vout: 0,
            isSpent: true,
            spentBy: CHECKPOINT,
            arkTxId: ARK_TX,
        });
    });

    it("keeps the spent row alongside an unspent one at the same script", async () => {
        const unspent: ExtendedVirtualCoin = {
            ...spentDeposit(),
            txid: "ef".repeat(32),
            virtualStatus: { state: "settled" },
            isSpent: false,
            spentBy: "",
            arkTxId: undefined,
        };
        await saveVtxosForContract(repository, contract, [spentDeposit(), unspent]);

        const vtxos = await getVtxosForContract(repository, contract);

        expect(vtxos.map((v) => v.txid).sort()).toEqual(["ab".repeat(32), "ef".repeat(32)].sort());
        expect(vtxos.find((v) => v.txid === "ab".repeat(32))?.spentBy).toBe(CHECKPOINT);
    });
});
