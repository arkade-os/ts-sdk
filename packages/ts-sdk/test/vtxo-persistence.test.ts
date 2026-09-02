import { describe, expect, it } from "vitest";
import { TaprootControlBlock } from "@scure/btc-signer";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { deserializeVtxo, serializeVtxo } from "../src/repositories/serialization";
import { getVtxosForContract } from "../src/contracts/vtxoOwnership";
import type { ExtendedVirtualCoin, VirtualCoin } from "../src/wallet";
import type { WalletRepository } from "../src/repositories/walletRepository";
import type { TapLeafScript } from "../src/script/base";

const SCRIPT = "51".repeat(17);
const ADDRESS = "ark1canonical";
const EXPIRES_AT = new Date("2027-01-01T00:00:00.000Z");

const tapLeaf = (): TapLeafScript => [
    TaprootControlBlock.decode(new Uint8Array([0xc0, ...new Uint8Array(32).fill(1)])),
    new Uint8Array(20).fill(2),
];

function makeVtxo(over: Partial<VirtualCoin> = {}): ExtendedVirtualCoin {
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        isSpent: false,
        isSwept: true,
        isPreconfirmed: false,
        commitmentTxIds: ["22".repeat(32)],
        expiresAt: EXPIRES_AT,
        spentBy: "",
        forfeitTapLeafScript: tapLeaf(),
        intentTapLeafScript: tapLeaf(),
        tapTree: new Uint8Array([0x00]),
        ...over,
    } as ExtendedVirtualCoin;
}

function expectCanonical(v: ExtendedVirtualCoin) {
    expect(v.isSwept).toBe(true);
    expect(v.isSpent).toBe(false);
    expect(v.isPreconfirmed).toBe(false);
    expect(v.spentBy).toBe("");
    expect(v.commitmentTxIds).toEqual(["22".repeat(32)]);
    expect(v.expiresAt).toBeInstanceOf(Date);
    expect(v.expiresAt!.getTime()).toBe(EXPIRES_AT.getTime());
}

describe("canonical facts survive save to load", () => {
    it("shared serialization rehydrates Dates and binary tapscript data", () => {
        const wire = JSON.parse(JSON.stringify(serializeVtxo(makeVtxo())));
        expectCanonical(deserializeVtxo(wire));
    });

    it("InMemory stores by reference and preserves canonical fields", async () => {
        await using repo = new InMemoryWalletRepository();
        await repo.saveVtxos(ADDRESS, [makeVtxo()]);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });

    it("IndexedDB structured clone preserves canonical fields and Dates", async () => {
        await using repo = new IndexedDBWalletRepository(`vtxo-canon-${Date.now()}`);
        await repo.saveVtxos(ADDRESS, [makeVtxo()]);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });
});

describe("deserialization normalization", () => {
    it("fills omitted optional facts with canonical defaults", () => {
        const row = serializeVtxo(makeVtxo({ isSwept: false, expiresAt: undefined })) as Record<
            string,
            unknown
        >;
        for (const key of ["isSwept", "isPreconfirmed", "isSpent", "commitmentTxIds", "spentBy"]) {
            delete row[key];
        }

        const loaded = deserializeVtxo(JSON.parse(JSON.stringify(row)) as never);

        expect(loaded.isSwept).toBe(false);
        expect(loaded.isPreconfirmed).toBe(false);
        expect(loaded.isSpent).toBe(false);
        expect(loaded.commitmentTxIds).toEqual([]);
        expect(loaded.spentBy).toBe("");
        expect(loaded.expiresAt).toBeUndefined();
    });
});

describe("normalization is implementation-agnostic", () => {
    it("normalizes a consumer repository that returns minimal optional facts", async () => {
        const partial = makeVtxo({
            isSwept: undefined,
            isPreconfirmed: undefined,
            isSpent: undefined,
            commitmentTxIds: undefined,
            spentBy: undefined,
            expiresAt: undefined,
        }) as ExtendedVirtualCoin;
        const repo = {
            getVtxos: async () => [partial],
        } as unknown as WalletRepository;

        const [loaded] = await getVtxosForContract(repo, { script: SCRIPT, address: ADDRESS });

        expect(loaded.isSwept).toBe(false);
        expect(loaded.isSpent).toBe(false);
        expect(loaded.commitmentTxIds).toEqual([]);
        expect(loaded.spentBy).toBe("");
    });

    it("normalizes even when the repository never deserializes", async () => {
        const partial = makeVtxo({
            isSwept: undefined,
            isPreconfirmed: undefined,
            isSpent: undefined,
            commitmentTxIds: undefined,
            spentBy: undefined,
            expiresAt: undefined,
        });
        await using repo = new InMemoryWalletRepository();
        await repo.saveVtxos(ADDRESS, [partial]);

        const [loaded] = await getVtxosForContract(repo, { script: SCRIPT, address: ADDRESS });

        expect(loaded.isSwept).toBe(false);
        expect(loaded.expiresAt).toBeUndefined();
    });
});
