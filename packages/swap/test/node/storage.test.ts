/**
 * The Node storage default: where the database goes, and who closes it.
 *
 * Node-only by construction — it opens a real `node:sqlite` handle on a real
 * file — which is why it lives under `test/node/` rather than beside the client
 * tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    configDir,
    createNodeSqlExecutor,
    nodeSwapRepository,
    swapDatabasePath,
} from "../../src/node";
import type { AtomicDecimal } from "../../src/client/amount";
import type { OfferSwapRecord } from "../../src/client/record";

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "swap-node-"));
});
afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

describe("the default database path", () => {
    it("puts one file per network under arkade/swaps", () => {
        // Per network on purpose: a record's covenant, solver and market are
        // all network-scoped, and one file holding two networks would let a
        // mainnet restore read a regtest record as its own.
        const mainnet = swapDatabasePath("mainnet");
        const regtest = swapDatabasePath("regtest");
        expect(mainnet).not.toBe(regtest);
        expect(mainnet.endsWith(join("arkade", "swaps", "swaps-mainnet.sqlite"))).toBe(true);
        expect(regtest.endsWith(join("arkade", "swaps", "swaps-regtest.sqlite"))).toBe(true);
    });

    it("rejects network names that are not single safe path segments", () => {
        for (const network of [
            "",
            "1regtest",
            "reg/test",
            "reg\\test",
            "x/../../../outside",
            "regtest.sqlite",
            "reg_test",
            "Regtest",
        ]) {
            expect(() => swapDatabasePath(network)).toThrow(/invalid network name/i);
        }

        expect(() => swapDatabasePath("regtest")).not.toThrow();
        expect(() => swapDatabasePath("mutiny-net")).not.toThrow();
    });

    it("follows XDG when it names an absolute path", () => {
        if (process.platform !== "linux") return;
        expect(configDir({ XDG_CONFIG_HOME: "/custom/config" })).toBe("/custom/config");
    });

    it("ignores a relative XDG value rather than resolving it against the cwd", () => {
        if (process.platform !== "linux") return;
        // The spec says a relative value "should be ignored". Resolving it
        // would put the database wherever the process happened to start.
        expect(configDir({ XDG_CONFIG_HOME: "relative/path" })).not.toContain("relative/path");
        expect(configDir({ XDG_CONFIG_HOME: "relative/path" }).endsWith(".config")).toBe(true);
    });
});

describe("the file-backed executor", () => {
    it("creates the parent directory and the file", async () => {
        const path = join(scratch, "nested", "deeper", "swaps.sqlite");
        const executor = createNodeSqlExecutor(path);
        // The config dir exists on a real machine but `arkade/swaps` under it
        // does not, and failing a first run for a directory the caller never
        // chose would be a poor default.
        await executor.run("CREATE TABLE t (x TEXT)");
        expect(existsSync(path)).toBe(true);
        await executor.close();
    });

    it("round-trips through real SQL", async () => {
        const executor = createNodeSqlExecutor(join(scratch, "swaps.sqlite"));
        await executor.run("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
        await executor.run("INSERT INTO t (k, v) VALUES (?, ?)", ["a", "1"]);
        expect(await executor.get<{ v: string }>("SELECT v FROM t WHERE k = ?", ["a"])).toEqual({
            v: "1",
        });
        expect(await executor.all("SELECT k FROM t")).toEqual([{ k: "a" }]);
        await executor.close();
    });

    it("binds undefined as null rather than throwing", async () => {
        const executor = createNodeSqlExecutor(join(scratch, "swaps.sqlite"));
        await executor.run("CREATE TABLE t (k TEXT, v TEXT)");
        // `node:sqlite` rejects a bound `undefined`; `null` is what it means.
        await executor.run("INSERT INTO t (k, v) VALUES (?, ?)", ["a", undefined]);
        expect(await executor.get("SELECT v FROM t")).toEqual({ v: null });
        await executor.close();
    });

    it("closes idempotently", async () => {
        const executor = createNodeSqlExecutor(join(scratch, "swaps.sqlite"));
        await executor.close();
        // Disposal and an explicit shutdown-handler close both happen; the
        // second `db.close()` would throw.
        await expect(executor.close()).resolves.toBeUndefined();
    });
});

describe("the Node repository default", () => {
    it("persists a record to the file and reads it back from a new handle", async () => {
        const path = join(scratch, "swaps.sqlite");
        const record: OfferSwapRecord = {
            id: "q1",
            family: "offer",
            route: {
                give: {
                    corridor: "arkade",
                    asset: "arkade:regtest/slip44:0",
                    instrument: { kind: "wallet" },
                },
                take: {
                    corridor: "arkade",
                    asset: "arkade:regtest/slip44:0",
                    instrument: { kind: "wallet" },
                },
            },
            give: { asset: "arkade:regtest/slip44:0", amount: "1000" as AtomicDecimal },
            take: { asset: "arkade:regtest/slip44:0", amount: "990" as AtomicDecimal },
            fee: { asset: "arkade:regtest/slip44:0", amount: "10" as AtomicDecimal },
            market: {
                kind: "card",
                key: "k",
                backend: "feed",
                source: "https://r.example",
                sourceType: "registry",
                solver: "s",
                pair: "BTC/USD",
                snapshot: { fetchedAt: 1, live: true, source: "live" },
            },
            expiresAt: 2,
            status: "pending",
            offerHex: "0100",
            swapAddress: "tark1q",
            swapPkScript: "5120",
            createdAt: 1,
            updatedAt: 1,
        };

        {
            await using repository = nodeSwapRepository({ network: "regtest", path });
            await repository.saveSwapRecord(record);
        }
        // A second handle over the same file: durability is the whole point of
        // the Node default, so it has to survive the connection that wrote it.
        await using reopened = nodeSwapRepository({ network: "regtest", path });
        expect(await reopened.getSwapRecord("q1")).toEqual(record);
    });

    it("closes the connection it opened, unlike every injected backend", async () => {
        const path = join(scratch, "swaps.sqlite");
        const repository = nodeSwapRepository({ network: "regtest", path });
        await repository.getAllSwapRecords();
        await repository[Symbol.asyncDispose]();

        // Disposal closed the handle this repository opened — an injected one
        // is the caller's to close, which is why every other backend's
        // disposal is a no-op.
        await expect(repository.getAllSwapRecords()).rejects.toThrow();
    });
});
