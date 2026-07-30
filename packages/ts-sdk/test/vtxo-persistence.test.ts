import { describe, expect, it } from "vitest";
import { TaprootControlBlock } from "@scure/btc-signer";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { WalletRepositoryImpl } from "../src/repositories/migrations/walletRepositoryImpl";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { deserializeVtxo, serializeVtxo } from "../src/repositories/serialization";
import { getVtxosForContract } from "../src/contracts/vtxoOwnership";
import { canRecoverOnchain, toVirtualStatus } from "../src/wallet/vtxo";
import type { ExtendedVirtualCoin, VirtualCoin } from "../src/wallet";
import type { StorageAdapter } from "../src/storage";
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
    const facts = {
        isSpent: false,
        isSwept: true,
        isPreconfirmed: false,
        commitmentTxIds: ["22".repeat(32)],
        expiresAt: EXPIRES_AT,
        ...over,
    };
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        spentBy: "",
        ...facts,
        virtualStatus: toVirtualStatus(facts),
        forfeitTapLeafScript: tapLeaf(),
        intentTapLeafScript: tapLeaf(),
        tapTree: new Uint8Array([0x00]),
        ...over,
    } as ExtendedVirtualCoin;
}

/** In-memory StorageAdapter backing the legacy WalletRepositoryImpl path. */
function memoryAdapter(): StorageAdapter {
    const store = new Map<string, string>();
    return {
        getItem: async (k) => store.get(k) ?? null,
        setItem: async (k, v) => void store.set(k, v),
        removeItem: async (k) => void store.delete(k),
    } as StorageAdapter;
}

/**
 * Every canonical fact the capabilities read, plus a real Date for `expiresAt` — the type
 * annotation alone won't catch the ISO string a JSON round-trip leaves behind.
 */
function expectCanonical(v: ExtendedVirtualCoin) {
    expect(v.isSwept).toBe(true);
    expect(v.isSpent).toBe(false);
    expect(v.isPreconfirmed).toBe(false);
    expect(v.spentBy).toBe("");
    expect(v.commitmentTxIds).toEqual(["22".repeat(32)]);
    expect(v.expiresAt).toBeInstanceOf(Date);
    expect(v.expiresAt!.getTime()).toBe(EXPIRES_AT.getTime());
    // The compatibility projection rides along too.
    expect(v.virtualStatus.state).toBe("swept");
}

describe("canonical facts survive save → load", () => {
    it("shared serialization (localStorage / StorageAdapter transport)", () => {
        // JSON.stringify/parse is what the adapter path really does to the row.
        const wire = JSON.parse(JSON.stringify(serializeVtxo(makeVtxo())));
        expectCanonical(deserializeVtxo(wire));
    });

    it("InMemory — stores by reference and never serializes", async () => {
        await using repo = new InMemoryWalletRepository();
        await repo.saveVtxos(ADDRESS, [makeVtxo()]);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });

    it("legacy StorageAdapter path", async () => {
        const repo = new WalletRepositoryImpl(memoryAdapter());
        await repo.saveVtxos(ADDRESS, [makeVtxo()]);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });

    it("IndexedDB — structured clone, so canonical fields and Dates ride along", async () => {
        await using repo = new IndexedDBWalletRepository(`vtxo-canon-${Date.now()}`);
        await repo.saveVtxos(ADDRESS, [makeVtxo()]);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });
});

describe("legacy rows that only have virtualStatus", () => {
    it("load correctly through the shared deserializer", () => {
        const legacy = serializeVtxo(makeVtxo()) as Record<string, unknown>;
        // Strip every canonical fact, leaving the pre-canonical row shape on disk.
        for (const k of ["isSwept", "isPreconfirmed", "commitmentTxIds", "expiresAt"]) {
            delete legacy[k];
        }
        const loaded = deserializeVtxo(JSON.parse(JSON.stringify(legacy)) as never);
        expectCanonical(loaded);
    });

    it("load correctly from a legacy StorageAdapter row", async () => {
        const adapter = memoryAdapter();
        const legacy = serializeVtxo(makeVtxo()) as Record<string, unknown>;
        for (const k of ["isSwept", "isPreconfirmed", "commitmentTxIds", "expiresAt"]) {
            delete legacy[k];
        }
        await adapter.setItem(`vtxos:${ADDRESS}`, JSON.stringify([legacy]));

        const repo = new WalletRepositoryImpl(adapter);
        const [loaded] = await repo.getVtxos(ADDRESS);
        expectCanonical(loaded);
    });
});

describe("normalization is implementation-agnostic", () => {
    it("a consumer-implemented repository returning legacy-only VTXOs still yields correct behavior", async () => {
        // Reaches none of our serialization code — the boundary is what makes the contract true.
        const legacy = makeVtxo() as Record<string, unknown>;
        for (const k of ["isSwept", "isPreconfirmed", "commitmentTxIds", "expiresAt"]) {
            delete legacy[k];
        }
        const repo = {
            getVtxos: async () => [legacy as unknown as ExtendedVirtualCoin],
        } as unknown as WalletRepository;

        const [loaded] = await getVtxosForContract(repo, { script: SCRIPT, address: ADDRESS });

        expect(loaded.isSwept).toBe(true);
        expect(loaded.commitmentTxIds).toEqual(["22".repeat(32)]);
        expect(canRecoverOnchain(loaded, { timestamp: new Date("2026-06-01") })).toBe(true);
    });

    it("normalizes even when the repository never deserializes (InMemory, by reference)", async () => {
        const legacy = makeVtxo() as Record<string, unknown>;
        for (const k of ["isSwept", "isPreconfirmed", "commitmentTxIds", "expiresAt"]) {
            delete legacy[k];
        }
        await using repo = new InMemoryWalletRepository();
        await repo.saveVtxos(ADDRESS, [legacy as unknown as ExtendedVirtualCoin]);

        const [loaded] = await getVtxosForContract(repo, { script: SCRIPT, address: ADDRESS });

        expect(loaded.isSwept).toBe(true);
        expect(loaded.expiresAt).toBeInstanceOf(Date);
    });
});
