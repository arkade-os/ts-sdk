import { describe, it, expect } from "vitest";
import { SingleKey, InMemoryContractRepository, type Contract } from "@arkade-os/sdk";
import {
    BucketSyncClient,
    BucketSync,
    deriveKwk,
    WalletSync,
    ContractSource,
    SyncedContractRepository,
} from "../../src";

const contract = (script: string, type = "default"): Contract => ({
    type,
    params: { foo: "bar" },
    script,
    address: `ark1${script}`,
    state: "active",
    createdAt: 1_700_000_000_000,
});

/**
 * End-to-end integration against a real bucket-sync-server. Opt-in: set
 * BUCKET_SYNC_URL to a running server (in-memory backend is fine), e.g.
 *
 *   dotnet run --project src/BucketSync.Api --urls http://localhost:5080
 *   BUCKET_SYNC_URL=http://localhost:5080 pnpm --filter @arkade-os/sync test:integration
 *
 * Skips cleanly when the URL is absent (so CI without the server is green).
 * Uses a real Arkade `SingleKey` identity — proving the SDK's BIP-340 signer
 * authenticates against the server's schnorr scheme unchanged.
 */
const URL = process.env.BUCKET_SYNC_URL;
const suite = URL ? describe : describe.skip;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const freshKwk = () => deriveKwk(crypto.getRandomValues(new Uint8Array(64)));

suite("e2e: @arkade-os/sync <-> real bucket-sync server", () => {
    it("authenticates a SingleKey identity, backs up, and restores on a fresh client", async () => {
        const identity = SingleKey.fromRandomBytes();
        const kwk = freshKwk();

        const client = new BucketSyncClient({ baseUrl: URL!, device: "device-A" });
        await client.authenticate(identity);
        expect(client.authenticated).toBe(true);

        const sync = new BucketSync(client, kwk);
        await sync.put(
            new Map([
                [
                    "contract:aaaa",
                    enc(JSON.stringify({ type: "vhtlc", script: "aaaa", state: "active" })),
                ],
                [
                    "contract:bbbb",
                    enc(JSON.stringify({ type: "default", script: "bbbb", state: "active" })),
                ],
                ["state:wallet", enc(JSON.stringify({ settings: { network: "mainnet" } }))],
            ]),
        );

        // Fresh client, SAME identity + KWK → verify path + full restore.
        const client2 = new BucketSyncClient({ baseUrl: URL!, device: "device-B" });
        await client2.authenticate(identity);
        const restored = new BucketSync(client2, kwk);
        const got: Record<string, string> = {};
        await restored.pullAll((k, pt) => {
            if (pt) got[k] = dec(pt)!;
        });

        expect(Object.keys(got).sort()).toEqual(["contract:aaaa", "contract:bbbb", "state:wallet"]);
        expect(JSON.parse(got["contract:aaaa"]).type).toBe("vhtlc");
        expect(JSON.parse(got["state:wallet"]).settings.network).toBe("mainnet");
    });

    it("keeps two identities' buckets isolated (server-derived bucketId)", async () => {
        const kwk = freshKwk();

        const alice = new BucketSyncClient({ baseUrl: URL! });
        await alice.authenticate(SingleKey.fromRandomBytes());
        await new BucketSync(alice, kwk).putOne("contract:secret", enc("alice-only"));

        const bob = new BucketSyncClient({ baseUrl: URL! });
        await bob.authenticate(SingleKey.fromRandomBytes());
        const bobSaw: string[] = [];
        await new BucketSync(bob, kwk).pullAll((k) => {
            bobSaw.push(k);
        });
        expect(bobSaw).toEqual([]); // Bob's bucket is empty; he cannot reach Alice's data.
    });

    it("resolves a CAS conflict (local-wins) against the live server", async () => {
        const identity = SingleKey.fromRandomBytes();
        const kwk = freshKwk();

        const client = new BucketSyncClient({ baseUrl: URL! });
        await client.authenticate(identity);
        await new BucketSync(client, kwk).putOne("contract:x", enc("v1"));

        // A second device that has never seen the key writes it → CAS conflict → local-wins retry.
        const client2 = new BucketSyncClient({ baseUrl: URL! });
        await client2.authenticate(identity);
        await new BucketSync(client2, kwk).putOne("contract:x", enc("v2"));

        const verify = new BucketSync(client, kwk);
        const got: Record<string, string> = {};
        await verify.pullAll((k, pt) => {
            if (pt) got[k] = dec(pt)!;
        });
        expect(got["contract:x"]).toBe("v2");
    });

    it("propagates a delete (tombstone) across clients", async () => {
        const identity = SingleKey.fromRandomBytes();
        const kwk = freshKwk();

        const client = new BucketSyncClient({ baseUrl: URL! });
        await client.authenticate(identity);
        const a = new BucketSync(client, kwk);
        await a.putOne("contract:tmp", enc("temporary"));
        await a.putOne("contract:tmp", null); // delete

        const client2 = new BucketSyncClient({ baseUrl: URL! });
        await client2.authenticate(identity);
        const seen: Record<string, string | null> = {};
        await new BucketSync(client2, kwk).pullAll((k, pt) => {
            seen[k] = dec(pt);
        });
        expect(seen["contract:tmp"]).toBeNull(); // tombstone visible, value gone
    });

    it("WalletSync backs up contracts and restores them on a fresh device", async () => {
        const identity = SingleKey.fromRandomBytes();
        const kwk = freshKwk();

        const repoA = new InMemoryContractRepository();
        await repoA.saveContract(contract("aaaa", "vhtlc"));
        await repoA.saveContract(contract("bbbb"));
        const syncA = await WalletSync.create({
            baseUrl: URL!,
            identity,
            encryptionKey: kwk,
            sources: [new ContractSource(repoA)],
        });
        await syncA.backup();

        const repoB = new InMemoryContractRepository();
        const syncB = await WalletSync.create({
            baseUrl: URL!,
            identity,
            encryptionKey: kwk,
            sources: [new ContractSource(repoB)],
        });
        const applied = await syncB.restore();
        expect(applied).toBe(2);
        expect((await repoB.getContracts()).map((c) => c.script).sort()).toEqual(["aaaa", "bbbb"]);
    });

    it("SyncedContractRepository auto-pushes writes; a fresh device restores the net state", async () => {
        const identity = SingleKey.fromRandomBytes();
        const kwk = freshKwk();

        const repoA = new InMemoryContractRepository();
        const syncA = await WalletSync.create({
            baseUrl: URL!,
            identity,
            encryptionKey: kwk,
            sources: [new ContractSource(repoA)],
        });
        const errors: unknown[] = [];
        const wrapped = new SyncedContractRepository(repoA, syncA, (e) => errors.push(e));

        await wrapped.saveContract(contract("cccc", "vhtlc"));
        await wrapped.deleteContract("cccc"); // created then deleted → net gone
        await wrapped.saveContract(contract("dddd"));
        await syncA.push(new Map()); // flush the serialized fire-and-forget queue
        expect(errors).toEqual([]);

        const repoB = new InMemoryContractRepository();
        const syncB = await WalletSync.create({
            baseUrl: URL!,
            identity,
            encryptionKey: kwk,
            sources: [new ContractSource(repoB)],
        });
        await syncB.restore();
        expect((await repoB.getContracts()).map((c) => c.script)).toEqual(["dddd"]);
    });
});
