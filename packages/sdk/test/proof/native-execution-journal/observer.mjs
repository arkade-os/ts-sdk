import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqlite from "../../../dist/repositories/sqlite/index.js";
import { read, save, sdk } from "../native-executor/common.mjs";

const [mode, runDirectory] = process.argv.slice(2);
assert(["observer", "restart"].includes(mode));
const config = await read(join(runDirectory, "private/keyless.json"));
assert.deepEqual(Object.keys(config).sort(), ["database", "indexerUrl", "runId"]);
const plan = await read(join(runDirectory, "public/funded.json"));
const prepared = (await read(join(runDirectory, "public/proposal.json"))).prepared;
const source = { txid: plan.funding.txid, vout: plan.funding.vout };
const db = new DatabaseSync(config.database);
db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
const sql = sqlite.getSerializedExecutor({
    run: async (query, params = []) => {
        db.prepare(query).run(...params);
    },
    get: async (query, params = []) => db.prepare(query).get(...params),
    all: async (query, params = []) => db.prepare(query).all(...params),
});
const repo = new sqlite.SQLiteWalletRepository(sql, {
    walletStateTransactions: true,
    persistentWalletState: true,
});
const journal = new sdk.arkade.NativeExecutionJournal(repo);
const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    assert.equal(method, "GET", "Keyless observation cannot dispatch financial requests");
    assert(url.startsWith(`${config.indexerUrl}/`));
    requests.push({ method, url, requestedAt: new Date().toISOString() });
    return originalFetch(input, init);
};
try {
    assert.deepEqual(await journal.get(source), prepared);
    const observations = [];
    const provider = (phase) => new sdk.RestIndexerProvider(`${config.indexerUrl}/${phase}`);
    if (mode === "observer") {
        assert.equal(await journal.getReceipt(source), undefined);
        for (const phase of [
            "malformed-coins",
            "incomplete-transactions",
            "oversized-coins",
            "oversized-transactions",
        ]) {
            const before = requests.length;
            const observation = await journal.reconcile(source, provider(phase));
            assert.equal(observation.state, "unknown");
            assert.deepEqual(observation.record, prepared);
            assert.equal(await journal.getReceipt(source), undefined);
            assert.deepEqual(await journal.get(source), prepared);
            await assert.rejects(journal.admit(source, prepared.proposal), /occupied/);
            observations.push({
                phase,
                state: observation.state,
                receiptAbsent: true,
                slotOccupied: true,
                rpcRequests: requests.length - before,
                observedAt: new Date().toISOString(),
            });
        }
        const observation = await journal.reconcile(source, provider("valid"));
        assert.equal(observation.state, "reconciled");
        assert.deepEqual(observation.record, prepared);
    } else {
        assert(await journal.getReceipt(source));
        assert.equal((await journal.reconcile(source, provider("cached"))).state, "reconciled");
        assert.equal(requests.length, 0);
    }
    const receipt = await journal.getReceipt(source);
    assert.equal(receipt.state, "reconciled");
    assert.equal(receipt.operationId, prepared.operationId);
    await assert.rejects(journal.admit(source, prepared.proposal), /occupied/);
    assert.deepEqual(await journal.get(source), prepared);
    await save(join(runDirectory, `public/${mode}.json`), {
        runId: config.runId,
        pid: process.pid,
        source,
        receipt,
        prepared,
        observations,
        requests,
        rpcRequests: requests.length,
        slotStillOccupied: true,
        financialSubmissions: 0,
        walletConstructed: false,
        signingMaterialOpened: false,
        observedAt: new Date().toISOString(),
    });
} finally {
    globalThis.fetch = originalFetch;
    db.close();
}
