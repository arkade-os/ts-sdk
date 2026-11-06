import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqlite from "../../../dist/repositories/sqlite/index.js";
import {
    directory,
    docker,
    hex,
    owned,
    read,
    save,
    savingsTemplate,
    sdk,
    waitFor,
} from "./common.mjs";

const [mode, runDirectory] = process.argv.slice(2);
assert(["fund", "execute", "recover", "remote-recover"].includes(mode));
const run = await read(join(runDirectory, "private/state.json"));
assert.equal(runDirectory, run.run);
const load = (name) => read(join(run.run, `public/${name}.json`));
const record = (name, value) => save(join(run.run, `public/${name}.json`), value);
if (mode === "fund")
    await writeFile(run.privateKeyFile, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
        flush: true,
    });
const { readFile } = await import("node:fs/promises");
const identity = sdk.SingleKey.fromHex(await readFile(run.privateKeyFile, "utf8"));
const db = new DatabaseSync(run.database);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
const sql = {
    run: async (query, params = []) => {
        db.prepare(query).run(...params);
    },
    get: async (query, params = []) => db.prepare(query).get(...params),
    all: async (query, params = []) => db.prepare(query).all(...params),
};
const storage = {
    walletRepository: new sqlite.SQLiteWalletRepository(sql, {
        walletStateTransactions: true,
        persistentWalletState: true,
    }),
    contractRepository: new sqlite.SQLiteContractRepository(sql),
    intentRepository: new sqlite.SQLiteIntentRepository(sql),
    virtualTxRepository: new sqlite.SQLiteVirtualTxRepository(sql),
};
const provider = new sdk.RestArkProvider(run.arkUrl),
    indexer = new sdk.RestIndexerProvider(run.arkUrl),
    emulator = new sdk.RestEmulatorProvider(run.emulatorUrl);
let forbiddenCalls = 0;
if (mode.endsWith("recover")) {
    const deny = async () => {
        forbiddenCalls++;
        throw new Error("Recovery must not submit");
    };
    for (const name of [
        "submitTx",
        "finalizeTx",
        "registerIntent",
        "deleteIntent",
        "confirmRegistration",
        "submitTreeNonces",
        "submitTreeSignatures",
        "submitSignedForfeitTxs",
    ])
        provider[name] = deny;
    emulator.submitTx = deny;
}
const wallet = await sdk.Wallet.create({
    identity,
    arkProvider: provider,
    indexerProvider: indexer,
    onchainProvider: new sdk.EsploraProvider(run.esploraUrl, {
        forcePolling: true,
        pollingInterval: 2000,
    }),
    storage,
    settlementConfig: false,
    oneShotSubmit: false,
    walletMode: "static",
});
const manager = await wallet.getContractManager();
const facade = await sdk.arkade.Arkade.connect({
    arkade: provider,
    indexer,
    emulator,
    identity,
    contractManager: manager,
    network: sdk.networks.regtest,
    oneShotSubmit: false,
    emulatorPubkey: run.emulatorPublicKey,
});
const native = new sdk.arkade.NativeExecutor(facade, wallet);
try {
    assert.equal((await emulator.getInfo()).signerPubkey, run.emulatorPublicKey);
    if (mode === "fund") {
        const address = await wallet.getAddress(),
            boarding = await wallet.getBoardingAddress();
        await owned(run, `${run.prefix}bitcoin`);
        const rpc = (...args) =>
            docker(
                "exec",
                `${run.prefix}bitcoin`,
                "bitcoin-cli",
                "-regtest",
                "-rpcuser=admin1",
                "-rpcpassword=123",
                ...args.map(String),
            );
        const onchainTxid = await rpc("sendtoaddress", boarding, "0.002");
        await rpc("-generate", 1);
        await waitFor("confirmed boarding", async () =>
            (await wallet.getBoardingUtxos()).some(
                (coin) => coin.txid === onchainTxid && coin.status.confirmed,
            ),
        );
        const commitment = await wallet.settle();
        await waitFor("wallet funding", async () => {
            await manager.refreshVtxos();
            return (await wallet.getSpendableVtxos()).some((coin) => coin.value >= 200000);
        });
        const artifact = await read(join(directory, "timed-savings.json"));
        const artifactId = "86331bad367603ecbe78d19adf200efa410ad70afbff64cf1f53d06cc040cd57";
        const payout = hex(sdk.ArkAddress.decode(address).vtxoTaprootKey),
            delay = facade.serverExitDelay;
        const args = {
            owner: hex(await identity.compressedPublicKey()),
            payout,
            exitSequence: hex(
                sdk.arkade.BigNum.encode(
                    BigInt(
                        sdk.timelockToSequence({
                            type: delay < 512n ? "blocks" : "seconds",
                            value: delay,
                        }),
                    ),
                ),
            ),
            releaseAt: hex(sdk.arkade.BigNum.encode(BigInt(Math.floor(Date.now() / 1000) - 86400))),
        };
        const execution = await native.importTemplate(savingsTemplate(artifactId, args), {
            [artifactId]: artifact,
        });
        assert.equal(
            hex(execution.contract.keys.emulatorKey).slice(-64),
            run.emulatorPublicKey.slice(-64),
        );
        const fund = async (execution) => {
            const txid = await native.fund(execution, 50000);
            return waitFor("funded position", async () => {
                await manager.refreshVtxos();
                return (await execution.contract.getUtxos()).find(
                    (coin) => coin.txid === txid && coin.value === 50000,
                );
            });
        };
        const funding = await fund(execution),
            decoy = await fund(execution);
        assert.notEqual(funding.txid, decoy.txid);
        assert.equal((await execution.contract.getUtxos()).length, 2);
        assert(
            !(await wallet.getSpendableVtxos()).some((coin) =>
                [funding, decoy].some(
                    (locked) => locked.txid === coin.txid && locked.vout === coin.vout,
                ),
            ),
        );
        const plan = {
            runId: run.runId,
            ownerPublicKey: hex(await identity.compressedPublicKey()),
            fundingOwnerPid: process.pid,
            script: hex(execution.contract.pkScript),
            address: execution.contract.address,
            payoutScript: `5120${payout}`,
            funding,
            decoy,
            boarding: { onchainTxid, commitment },
            preparedAt: new Date().toISOString(),
        };
        const remoteArgs = {
            ...args,
            releaseAt: hex(
                sdk.arkade.BigNum.encode(BigInt(Math.floor(Date.now() / 1000) - 172800)),
            ),
        };
        const remoteExecution = await native.importTemplate(
            savingsTemplate(artifactId, remoteArgs),
            { [artifactId]: artifact },
        );
        assert.notEqual(remoteExecution.contract.address, execution.contract.address);
        const remote = new sdk.RestDelegateeProvider(`${run.recorderUrl}/delegatee`);
        const registered = await remote.registerArtifact(artifact);
        assert.equal(registered.id, artifactId);
        const document = savingsTemplate(registered.id, remoteArgs),
            wrong = structuredClone(document);
        wrong.outputs[0].locking = `5120${hex(await identity.xOnlyPublicKey())}`;
        assert.notEqual(wrong.outputs[0].locking, document.outputs[0].locking);
        const wrongTemplate = await remote.registerTemplate(wrong),
            matching = await remote.registerTemplate(document);
        await assert.rejects(
            native.delegate(remoteExecution, remote, wrongTemplate.id),
            /template ID does not match/,
        );
        assert.equal(
            (await (await fetch(`${run.recorderUrl}/proof/remote-state`)).json()).watchRequests,
            0,
        );
        const delegated = await native.delegate(remoteExecution, remote, matching.id);
        assert.equal(delegated.address, remoteExecution.contract.address);
        assert.equal(delegated.status, "active");
        assert.equal(
            (await (await fetch(`${run.recorderUrl}/proof/remote-state`)).json()).watchRequests,
            1,
        );
        const delegatee = await owned(run, `${run.prefix}delegatee`);
        await docker("pause", delegatee.Id);
        assert.equal((await owned(run, delegatee.Id)).State.Paused, true);
        const pausedAt = new Date().toISOString(),
            remoteFunding = await fund(remoteExecution);
        plan.remote = {
            script: hex(remoteExecution.contract.pkScript),
            address: delegated.address,
            funding: remoteFunding,
            payoutScript: plan.payoutScript,
            templateId: matching.id,
            pausedAt,
        };
        await record("delegate-binding", {
            wrong,
            document,
            wrongTemplateId: wrongTemplate.id,
            matchingTemplateId: matching.id,
            mismatchedWatchRequests: 0,
            matchingWatchRequests: 1,
            delegated,
            pausedAt,
            funding: remoteFunding,
        });
        await record("funded", plan);
        provider.serverUrl = `${run.recorderUrl}/wallet`;
        const controlId = await wallet.send({ address, amount: 10000 });
        const control = await waitFor("legacy control payout", async () =>
            (await indexer.getVtxos({ outpoints: [{ txid: controlId, vout: 0 }] })).vtxos.find(
                (coin) => coin.value === 10000,
            ),
        );
        assert.equal(control.script, plan.payoutScript);
        const request = await load("legacy-submit"),
            finalized = await load("legacy-finalize");
        assert.equal(
            sdk.Transaction.fromPSBT(Buffer.from(request.body.signedArkTx, "base64")).id,
            controlId,
        );
        assert.equal(finalized.body.arkTxid, controlId);
        for (const encoded of request.body.checkpointTxs) {
            const input = sdk.Transaction.fromPSBT(Buffer.from(encoded, "base64")).getInput(0);
            assert.equal(input.tapScriptSig?.length ?? 0, 0);
            assert(
                ![funding, decoy, remoteFunding].some(
                    (locked) => locked.txid === hex(input.txid) && locked.vout === input.index,
                ),
            );
        }
        await record("legacy-control", {
            proposalId: controlId,
            indexedOutput: control,
            lockedPositionsExcluded: true,
            unsignedCheckpointSubmitThenFinalize: true,
        });
    } else {
        const plan = await load("funded");
        assert.equal(hex(await identity.compressedPublicKey()), plan.ownerPublicKey);
        const execution = await native.restore(plan.script);
        assert.equal(execution.contract.address, plan.address);
        if (mode === "execute") {
            emulator.serverUrl = run.recorderUrl;
            execution.destination[2] ^= 1;
            const before = hex(execution.destination),
                source = { txid: plan.funding.txid, vout: plan.funding.vout };
            let enterFirst, releaseFirst, releaseSecond;
            const entered = new Promise((resolve) => {
                    enterFirst = resolve;
                }),
                firstGate = new Promise((resolve) => {
                    releaseFirst = resolve;
                }),
                secondGate = new Promise((resolve) => {
                    releaseSecond = resolve;
                });
            const injected = new Error("Rejected before dispatch"),
                refresh = manager.refreshOutpoints,
                refreshAll = manager.refreshVtxos;
            let rejectedCalls = 0,
                calls = 0,
                postRefreshCalls = 0;
            const first = native.execute(execution, source, {
                beforeEmulatorSubmit: async () => {
                    rejectedCalls++;
                    enterFirst();
                    await firstGate;
                    throw injected;
                },
            });
            const rejected = assert.rejects(first, (error) => error === injected);
            await entered;
            const mutableSource = { ...source };
            const second = native.execute(execution, mutableSource, {
                beforeEmulatorSubmit: async (proposal) => {
                    calls++;
                    await secondGate;
                    await record("proposal", {
                        proposalId: proposal.txid,
                        arkTx: proposal.arkTx,
                        checkpointTxs: proposal.checkpointTxs,
                        source,
                        payoutScript: plan.payoutScript,
                        principal: 50000,
                        executionOwnerPid: process.pid,
                        recordedBeforeDispatchAt: new Date().toISOString(),
                    });
                    manager.refreshOutpoints = async () => {
                        postRefreshCalls++;
                        throw new Error("Injected refresh failure after acceptance");
                    };
                    manager.refreshVtxos = manager.refreshOutpoints;
                },
            });
            mutableSource.txid = plan.decoy.txid;
            mutableSource.vout = plan.decoy.vout;
            execution.destination[3] ^= 1;
            await record("mutation", {
                requested: source,
                callerAfterMutation: mutableSource,
                committedPayout: plan.payoutScript,
                exposedBefore: before,
                exposedWhileQueued: hex(execution.destination),
            });
            releaseFirst();
            await rejected;
            assert.equal(rejectedCalls, 1);
            assert.deepEqual(await (await fetch(`${run.recorderUrl}/proof/native-state`)).json(), {
                forwarded: 0,
            });
            await record("hook-rejected", {
                hookCalls: rejectedCalls,
                emulatorSubmissions: 0,
                sameErrorIdentity: true,
            });
            releaseSecond();
            const result = await second;
            manager.refreshOutpoints = refresh;
            manager.refreshVtxos = refreshAll;
            assert.equal(calls, 1);
            assert(postRefreshCalls >= 1);
            assert.equal(result.txid, (await load("proposal")).proposalId);
            const decoy = (await indexer.getVtxos({ outpoints: [plan.decoy] })).vtxos[0];
            assert(decoy && !decoy.isSpent && decoy.value === 50000);
            await record("accepted", {
                result,
                postRefreshCalls,
                nativeSubmissions: calls,
                decoy,
                acceptedAt: new Date().toISOString(),
            });
        } else {
            const remote = mode === "remote-recover",
                target = remote ? plan.remote : plan;
            const selected = remote ? await native.restore(target.script) : execution;
            assert.equal(selected.contract.address, target.address);
            const source = await waitFor("spent source", async () => {
                const coin = (await indexer.getVtxos({ outpoints: [target.funding] })).vtxos[0];
                return coin?.isSpent && coin.spentBy && coin.arkTxId ? coin : false;
            });
            const destination = (
                await indexer.getVtxos({ outpoints: [{ txid: source.arkTxId, vout: 0 }] })
            ).vtxos[0];
            assert.equal(destination.value, 50000);
            assert.equal(destination.script, target.payoutScript);
            const transactions = await waitFor("indexed source/checkpoint/payout", async () => {
                const observed = await indexer.getVirtualTxs([
                    source.arkTxId,
                    source.spentBy,
                    source.txid,
                ]);
                return observed.txs.length === 3 ? observed : false;
            });
            await manager.refreshOutpoints([target.funding, destination]);
            await manager.refreshVtxos();
            assert.equal((await selected.contract.getUtxos()).length, remote ? 0 : 1);
            assert(
                (await execution.contract.getUtxos()).some(
                    (coin) =>
                        coin.txid === plan.decoy.txid &&
                        coin.vout === plan.decoy.vout &&
                        coin.value === 50000,
                ),
            );
            const decoy = (await indexer.getVtxos({ outpoints: [plan.decoy] })).vtxos[0];
            assert(decoy && !decoy.isSpent && decoy.value === 50000);
            const spendable = await wallet.getSpendableVtxos();
            assert(
                spendable.some(
                    (coin) =>
                        coin.txid === destination.txid &&
                        coin.vout === destination.vout &&
                        coin.value === 50000,
                ),
            );
            assert(
                !spendable.some(
                    (coin) => coin.txid === plan.decoy.txid && coin.vout === plan.decoy.vout,
                ),
            );
            assert.equal(forbiddenCalls, 0);
            await record(mode, {
                source,
                destination,
                transactions,
                decoy,
                samePersistedWallet: true,
                ownerPublicKey: hex(await identity.compressedPublicKey()),
                financialSubmissions: forbiddenCalls,
                reconciledAt: new Date().toISOString(),
            });
        }
    }
} finally {
    facade.dispose();
    await wallet.dispose();
    db.close();
}
