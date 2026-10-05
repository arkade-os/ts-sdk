import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { TaxiClient, TaxiError } from "@arkade-taxi/client";
import { TaxiActivityStore, taxiActivityTxids, type TaxiActivity } from "../src/activity";

const transferId = "3ccdf42c-2fc1-444b-8837-5efcae8e7fbc";
const lockupTxid = "a".repeat(64);
const record = (overrides: Partial<TaxiActivity> = {}): TaxiActivity => ({
    role: "sender",
    network: "regtest",
    taxiUrl: "https://taxi.example",
    transferId,
    mode: "recycle",
    units: "50",
    carrierSats: "280",
    lockupTxid,
    state: "quoted",
    updatedAt: 1000,
    createdAt: 1000,
    ...overrides,
});
type Status = Awaited<ReturnType<TaxiClient["status"]>>;
const status = (overrides: Partial<Status> = {}): Status => ({
    transferId,
    state: "locking",
    updatedAt: 1001,
    ...overrides,
});
let entries: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
let store: TaxiActivityStore;
let onError: ReturnType<typeof vi.fn>;
beforeEach(() => {
    entries = new Map();
    storage = {
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => {
            entries.set(key, value);
        },
        removeItem: (key) => {
            entries.delete(key);
        },
    };
    onError = vi.fn();
    store = new TaxiActivityStore({ storage, onError, now: () => 2000 });
});

describe("Taxi activity persistence", () => {
    it("loads existing wallet records, isolates networks and rejects each corrupt field", () => {
        const valid = record({
            assetId: "b".repeat(68),
            units: "500",
            fare: { currency: "asset", units: "3" },
            destination: "tark1receiver",
            returnsTo: "receiver",
        });
        const invalid = [
            { role: "payer" },
            { taxiUrl: "ftp://taxi.example" },
            { transferId: "bad id" },
            { units: "01" },
            { units: (2n ** 64n).toString() },
            { carrierSats: "-1" },
            { assetId: "zz" },
            { lockupTxid: "zz" },
            { failureDetail: "x".repeat(513) },
            { state: "toString" },
            { createdAt: 9_000_000_000_000 },
        ].map((overrides) => ({ ...valid, ...overrides }));
        entries.set(
            "taxiActivity",
            JSON.stringify([valid, ...invalid, record({ network: "mutinynet" }), null]),
        );
        expect(store.read("regtest")).toEqual([valid]);
        expect(store.read("mutinynet")).toEqual([record({ network: "mutinynet" })]);
        for (const raw of ["{", "null", "{}", "7"]) {
            entries.set("taxiActivity", raw);
            expect(store.read("regtest")).toEqual([]);
        }
    });

    it("retains creation time and terminal outcomes across stale reads and reloads", () => {
        store.record(record({ createdAt: 500, updatedAt: 9000 }));
        store.recordStatus(record(), status({ state: "locked", updatedAt: 1 }));
        store.recordStatus(record(), status({ state: "locking", updatedAt: 9500 }));
        store.recordStatus(
            record(),
            status({ state: "recycled", updatedAt: 2, spentTxid: "b".repeat(64) }),
        );
        store.recordStatus(record(), status({ state: "locked", updatedAt: 10000 }));
        const reloaded = new TaxiActivityStore({ storage });
        expect(reloaded.read("regtest")[0]).toMatchObject({
            state: "recycled",
            updatedAt: 2,
            createdAt: 500,
            spentTxid: "b".repeat(64),
        });
        expect(taxiActivityTxids(reloaded.read("regtest")[0])).toEqual([
            lockupTxid,
            "b".repeat(64),
        ]);
    });

    it("persists failed locking details and clears them only on a newer accepted status", () => {
        store.recordStatus(
            record(),
            status({
                updatedAt: 2000,
                submissionPhase: "failed",
                failureCode: "invalid_provider_response",
                failureDetail: "checkpoint changed",
            }),
        );
        store.recordStatus(record(), status({ updatedAt: 1500, submissionPhase: "claimed" }));
        expect(store.read("regtest")[0]).toMatchObject({
            submissionPhase: "failed",
            failureCode: "invalid_provider_response",
        });
        store.recordStatus(
            record(),
            status({ state: "locked", updatedAt: 2001, outpoint: { txid: lockupTxid, vout: 0 } }),
        );
        expect(store.read("regtest")[0]).not.toHaveProperty("failureCode");
        expect(store.read("regtest")[0]).not.toHaveProperty("failureDetail");
    });

    it("ignores foreign transfer and sender lockup statuses, and logs unknown states once", () => {
        store.record(record());
        store.recordStatus(record(), status({ transferId: "other", state: "locked" }));
        store.recordStatus(
            record(),
            status({ state: "locked", outpoint: { txid: "b".repeat(64), vout: 0 } }),
        );
        store.recordStatus(record(), status({ state: "teleported" }));
        store.recordStatus(record(), status({ state: "teleported" }));
        expect(store.read("regtest")[0].state).toBe("quoted");
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("deduplicates writes, notifies subscribers and remains nonfatal on unavailable storage", () => {
        const listener = vi.fn();
        const stop = store.subscribe(listener);
        store.record(record());
        store.record(record());
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getVersion()).toBe(1);
        stop();
        store.forget();
        expect(store.read("regtest")).toEqual([]);
        expect(listener).toHaveBeenCalledTimes(1);
        storage.setItem = () => {
            throw new Error("quota exceeded");
        };
        expect(() => store.record(record())).not.toThrow();
        expect(store.read("regtest")).toEqual([]);
        expect(onError).toHaveBeenCalledWith(
            expect.any(Error),
            expect.stringContaining(transferId),
        );
    });

    it("caps only closed records and preserves every unclaimed delivery", () => {
        entries.set(
            "taxiActivity",
            JSON.stringify(
                Array.from({ length: 205 }, (_, index) =>
                    record({ transferId: `closed-${index}`, state: "recycled", createdAt: index }),
                ),
            ),
        );
        store.record(record({ transferId: "awaiting", state: "locked", createdAt: 0 }));
        store.record(record({ transferId: "sending", createdAt: 0 }));
        const ids = store.read("regtest").map((entry) => entry.transferId);
        expect(ids).toHaveLength(202);
        expect(ids).toContain("awaiting");
        expect(ids).toContain("sending");
        expect(ids).not.toContain("closed-4");
        expect(ids).toContain("closed-5");
    });
});

describe("Taxi status reconciliation", () => {
    it("coalesces concurrent reads and releases the flight on failure for a retry", async () => {
        let reject!: (reason: Error) => void;
        const client = {
            status: vi.fn(
                () =>
                    new Promise<Status>((_, fail) => {
                        reject = fail;
                    }),
            ),
            sponsoredStatus: vi.fn(),
        };
        store.record(record());
        const first = store.refresh(record(), client);
        const second = store.refresh(record(), client);
        expect(first).toBe(second);
        reject(new Error("offline"));
        await expect(first).rejects.toThrow("offline");
        expect(store.read("regtest")[0].state).toBe("quoted");
        client.status.mockImplementation(async () => status({ state: "locked" }));
        await store.refresh(record(), client);
        expect(client.status).toHaveBeenCalledTimes(2);
        expect(store.read("regtest")[0].state).toBe("locked");
    });

    it("marks forgotten pending payments gone while retaining an established terminal outcome", async () => {
        const client = {
            status: async () => {
                throw new TaxiError("not_found", "forgotten");
            },
            sponsoredStatus: async () => status(),
        };
        store.record(record({ state: "locked" }));
        await store.refresh(record(), client);
        expect(store.read("regtest")[0]).toMatchObject({ state: "gone", updatedAt: 2000 });
        store.forget();
        store.record(record({ state: "recycled" }));
        await store.refresh(record(), client);
        expect(store.read("regtest")[0].state).toBe("recycled");
    });

    it("polls only compatible open records and suppresses repeated failures until recovery", async () => {
        const client = {
            status: vi.fn(async (id: string) => {
                if (id === "down") throw new Error("offline");
                return status({ transferId: id, state: "locking" });
            }),
            sponsoredStatus: vi.fn(),
        };
        store = new TaxiActivityStore({ storage, onError, client: () => client });
        for (const entry of [
            record({ transferId: "open" }),
            record({ transferId: "down" }),
            record({ transferId: "closed", state: "recycled" }),
            record({ transferId: "plain", taxiUrl: "http://taxi.example" }),
            record({ transferId: "sponsored", mode: "sponsored", state: "locked" }),
        ])
            store.record(entry);
        await store.poll("regtest", "https:");
        await store.poll("regtest", "https:");
        expect(client.status.mock.calls.map(([id]) => id).sort()).toEqual([
            "down",
            "down",
            "open",
            "open",
        ]);
        expect(onError).toHaveBeenCalledTimes(1);
        client.status.mockImplementation(async (id) => status({ transferId: id }));
        await store.poll("regtest", "https:");
        client.status.mockImplementation(async () => {
            throw new Error("offline again");
        });
        await store.poll("regtest", "https:");
        expect(onError).toHaveBeenCalledTimes(3);
    });

    it("uses the real Taxi client decoder and normal/sponsored HTTP endpoints", async () => {
        const paths: string[] = [];
        const server = createServer((request, response) => {
            paths.push(request.url!);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
                JSON.stringify(
                    status({ state: "locked", outpoint: { txid: lockupTxid, vout: 0 } }),
                ),
            );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            const address = server.address() as { port: number };
            const taxiUrl = `http://127.0.0.1:${address.port}`;
            await store.refresh(record({ taxiUrl }));
            await store.refresh(record({ taxiUrl, role: "receiver", mode: "sponsored" }));
            expect(paths).toEqual([
                `/v1/transfers/${transferId}`,
                `/v1/sponsored-transfers/${transferId}`,
            ]);
            expect(store.read("regtest").map((entry) => entry.state)).toEqual(["locked", "locked"]);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});
