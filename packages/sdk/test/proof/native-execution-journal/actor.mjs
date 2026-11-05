import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqlite from "../../../dist/repositories/sqlite/index.js";
import { hex, read, save, sdk } from "../native-executor/common.mjs";

const [runDirectory] = process.argv.slice(2);
const run = await read(join(runDirectory, "private/state.json"));
assert.equal(runDirectory, run.run);
const load = (name) => read(join(run.run, `public/${name}.json`));
const record = (name, value) => save(join(run.run, `public/${name}.json`), value);
const plan = await load("funded");
const identity = sdk.SingleKey.fromHex(await readFile(run.privateKeyFile, "utf8"));
assert.equal(hex(await identity.compressedPublicKey()), plan.ownerPublicKey);
const db = new DatabaseSync(run.database);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
const sql = sqlite.getSerializedExecutor({
    run: async (query, params = []) => {
        db.prepare(query).run(...params);
    },
    get: async (query, params = []) => db.prepare(query).get(...params),
    all: async (query, params = []) => db.prepare(query).all(...params),
});
const walletRepository = new sqlite.SQLiteWalletRepository(sql, {
    walletStateTransactions: true,
    persistentWalletState: true,
});
const arkade = new sdk.RestArkProvider(run.arkUrl);
const indexer = new sdk.RestIndexerProvider(run.arkUrl);
const emulator = new sdk.RestEmulatorProvider(run.emulatorUrl);
const wallet = await sdk.Wallet.create({
    identity,
    arkProvider: arkade,
    indexerProvider: indexer,
    onchainProvider: new sdk.EsploraProvider(run.esploraUrl, {
        forcePolling: true,
        pollingInterval: 2000,
    }),
    storage: {
        walletRepository,
        contractRepository: new sqlite.SQLiteContractRepository(sql),
        intentRepository: new sqlite.SQLiteIntentRepository(sql),
        virtualTxRepository: new sqlite.SQLiteVirtualTxRepository(sql),
    },
    settlementConfig: false,
    oneShotSubmit: false,
    walletMode: "static",
});
const contractManager = await wallet.getContractManager();
const facade = await sdk.arkade.Arkade.connect({
    arkade,
    indexer,
    emulator,
    identity,
    contractManager,
    network: sdk.networks.regtest,
    oneShotSubmit: false,
    emulatorPubkey: run.emulatorPublicKey,
});
try {
    const native = new sdk.arkade.NativeExecutor(facade, wallet);
    const execution = await native.restore(plan.script);
    const source = { txid: plan.funding.txid, vout: plan.funding.vout };
    const journal = new sdk.arkade.NativeExecutionJournal(walletRepository);
    assert.equal(await journal.get(source), undefined);
    emulator.serverUrl = run.recorderUrl;
    let admissionError,
        rejectedCallbacks = 0;
    await assert.rejects(
        native.execute(execution, source, {
            beforeEmulatorSubmit: async (proposal) => {
                rejectedCallbacks++;
                await sql.run("PRAGMA query_only = ON");
                try {
                    assert.equal((await sql.get("PRAGMA query_only")).query_only, 1);
                    await journal.admit(source, proposal);
                    assert.fail("query_only must reject durable admission");
                } catch (error) {
                    admissionError = error;
                    throw error;
                } finally {
                    await sql.run("PRAGMA query_only = OFF");
                }
            },
        }),
        (error) => error === admissionError && /readonly|read.only/i.test(error.message),
    );
    assert.equal(rejectedCallbacks, 1);
    assert.equal((await sql.get("PRAGMA query_only")).query_only, 0);
    assert.equal(await journal.get(source), undefined);
    assert.equal(await journal.getReceipt(source), undefined);
    const dispatch = await (await fetch(`${run.recorderUrl}/proof/native-state`)).json();
    assert.deepEqual(dispatch, { forwarded: 0 });
    await record("admission-failed", {
        pid: process.pid,
        source,
        callbacks: rejectedCallbacks,
        emulatorRequests: 0,
        error: {
            name: admissionError.name,
            code: admissionError.code,
            message: admissionError.message,
        },
        sqliteQueryOnly: true,
        queryOnlyRestored: true,
        slotAbsentAfterRollback: true,
        observedAt: new Date().toISOString(),
    });
    let acceptedCallbacks = 0,
        admitted;
    const outcome = await native
        .execute(execution, source, {
            beforeEmulatorSubmit: async (proposal) => {
                acceptedCallbacks++;
                assert(Object.isFrozen(proposal));
                assert(Object.isFrozen(proposal.checkpointTxs));
                admitted = await journal.admit(source, proposal);
                assert.deepEqual(await journal.get(source), admitted);
                await record("proposal", {
                    proposal,
                    prepared: admitted,
                    source,
                    principal: 50000,
                    payoutScript: plan.payoutScript,
                    signerPid: process.pid,
                    immutableProposal: true,
                    durableBeforeDispatchAt: new Date().toISOString(),
                });
            },
        })
        .then(
            (value) => ({ value }),
            (error) => ({ error }),
        );
    assert.equal(acceptedCallbacks, 1);
    assert(outcome.error instanceof Error, "Lost response must not become an accepted result");
    assert.equal(outcome.value, undefined);
    assert.deepEqual(await journal.get(source), admitted);
    assert.equal(await journal.getReceipt(source), undefined);
    assert.deepEqual(await (await fetch(`${run.recorderUrl}/proof/native-state`)).json(), {
        forwarded: 1,
    });
    await assert.rejects(journal.admit(source, admitted.proposal), /occupied/);
    await record("submission-unknown", {
        pid: process.pid,
        source,
        prepared: admitted,
        callbacks: acceptedCallbacks,
        callerRejected: true,
        acceptedResultReturned: false,
        receiptAbsent: true,
        slotStillOccupied: true,
        error: { name: outcome.error.name, message: outcome.error.message },
        recordedAt: new Date().toISOString(),
    });
} finally {
    facade.dispose();
    await wallet.dispose();
    db.close();
}
