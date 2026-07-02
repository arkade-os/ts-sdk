import { describe, it, expect } from "vitest";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    type Contract,
} from "@arkade-os/sdk";
import {
    ContractSource,
    WalletStateSource,
    CONTRACT_PREFIX,
    WALLET_STATE_KEY,
} from "../src/sync/sources";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const contract = (script: string, type = "default"): Contract => ({
    type,
    params: { foo: "bar" },
    script,
    address: `ark1${script}`,
    state: "active",
    createdAt: 1_700_000_000_000,
});

describe("ContractSource", () => {
    it("snapshots all contracts as contract:{script} → JSON plaintext", async () => {
        const repo = new InMemoryContractRepository();
        await repo.saveContract(contract("aaaa"));
        await repo.saveContract(contract("bbbb", "vhtlc"));

        const snap = await new ContractSource(repo).snapshot();
        expect([...snap.keys()].sort()).toEqual([
            CONTRACT_PREFIX + "aaaa",
            CONTRACT_PREFIX + "bbbb",
        ]);
        expect(JSON.parse(dec(snap.get(CONTRACT_PREFIX + "bbbb")!)).type).toBe("vhtlc");
    });

    it("applies a pulled contract into the repo", async () => {
        const repo = new InMemoryContractRepository();
        await new ContractSource(repo).apply(
            CONTRACT_PREFIX + "cccc",
            enc(JSON.stringify(contract("cccc", "vhtlc"))),
        );
        const [got] = await repo.getContracts();
        expect(got.script).toBe("cccc");
        expect(got.type).toBe("vhtlc");
    });

    it("applies a tombstone as a delete", async () => {
        const repo = new InMemoryContractRepository();
        await repo.saveContract(contract("dddd"));
        await new ContractSource(repo).apply(CONTRACT_PREFIX + "dddd", null);
        expect(await repo.getContracts()).toHaveLength(0);
    });

    it("owns only the contract: namespace", () => {
        const src = new ContractSource(new InMemoryContractRepository());
        expect(src.owns(CONTRACT_PREFIX + "x")).toBe(true);
        expect(src.owns(WALLET_STATE_KEY)).toBe(false);
    });

    it("round-trips a full snapshot into a fresh repo", async () => {
        const a = new InMemoryContractRepository();
        await a.saveContract(contract("1111"));
        await a.saveContract(contract("2222", "vhtlc"));
        const snap = await new ContractSource(a).snapshot();

        const b = new InMemoryContractRepository();
        const srcB = new ContractSource(b);
        for (const [k, v] of snap) await srcB.apply(k, v);

        expect((await b.getContracts()).map((c) => c.script).sort()).toEqual(["1111", "2222"]);
    });
});

describe("WalletStateSource", () => {
    it("snapshots only settings, not the device-local lastSyncTime", async () => {
        const repo = new InMemoryWalletRepository();
        await repo.saveWalletState({ settings: { network: "mainnet" }, lastSyncTime: 12345 });
        const snap = await new WalletStateSource(repo).snapshot();
        const payload = JSON.parse(dec(snap.get(WALLET_STATE_KEY)!));
        expect(payload.settings.network).toBe("mainnet");
        expect(payload.lastSyncTime).toBeUndefined();
    });

    it("merges applied settings and preserves the local lastSyncTime", async () => {
        const repo = new InMemoryWalletRepository();
        await repo.saveWalletState({ settings: { a: "1" }, lastSyncTime: 999 });
        await new WalletStateSource(repo).apply(
            WALLET_STATE_KEY,
            enc(JSON.stringify({ settings: { b: "2" } })),
        );

        const state = await repo.getWalletState();
        expect(state?.settings).toEqual({ a: "1", b: "2" });
        expect(state?.lastSyncTime).toBe(999); // device-local indexer cursor preserved
    });

    it("produces an empty snapshot when there is no state", async () => {
        const snap = await new WalletStateSource(new InMemoryWalletRepository()).snapshot();
        expect(snap.size).toBe(0);
    });
});
