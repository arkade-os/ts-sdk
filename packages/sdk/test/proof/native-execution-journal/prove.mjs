import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
    command,
    directory as nativeDirectory,
    docker,
    owned,
    read,
    repository,
    save,
    sdk,
    sha256,
    waitFor,
} from "../native-executor/common.mjs";
import { createStack, startStack, stopStack } from "../native-executor/stack.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const state = await createStack(
    process.argv[2] ?? join(repository, ".tmp/native-execution-journal"),
);
const record = (name, value) => save(join(state.run, `public/${name}.json`), value);
const load = (name) => read(join(state.run, `public/${name}.json`));
const actors = [],
    requests = [],
    faults = [];
let server,
    forwarded = 0,
    phase = "bootstrap";
console.log(`Fresh journal proof ${state.runId}: ${state.run}`);
async function actor(mode) {
    phase = mode;
    const parent = ["fund", "remote-recover"].includes(mode);
    const script = join(
        parent ? nativeDirectory : directory,
        mode === "signer" ? "actor.mjs" : parent ? "actor.mjs" : "observer.mjs",
    );
    const args = mode === "signer" ? [state.run] : [mode, state.run];
    const log = createWriteStream(join(state.run, `private/actor-${mode}.log`), { mode: 0o600 });
    const startedAt = new Date().toISOString();
    let pid;
    const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            cwd: repository,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        pid = child.pid;
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        child.once("error", reject);
        child.once("close", (code) => log.end(() => resolve(code)));
    });
    actors.push({
        mode,
        pid,
        startedAt,
        exitedAt: new Date().toISOString(),
        exitCode,
        evidence: "child_process close event",
    });
    await record("process-exits", actors);
    assert.equal(exitCode, 0, `Inspect private/actor-${mode}.log`);
}
async function fingerprint() {
    const paths = (
        await command("git", [
            "ls-files",
            "-z",
            "packages/sdk/src",
            "packages/sdk/package.json",
            "package.json",
            "pnpm-lock.yaml",
            ".github/workflows/native-executor-proof.yml",
        ])
    )
        .split("\0")
        .filter(Boolean);
    for (const folder of [join(repository, "packages/sdk/dist"), nativeDirectory, directory])
        for (const file of await readdir(folder, { recursive: true, withFileTypes: true }))
            if (file.isFile())
                paths.push(
                    relative(repository, join(file.parentPath, file.name)).replaceAll("\\", "/"),
                );
    const files = Object.fromEntries(
        await Promise.all(
            [...new Set(paths)]
                .sort()
                .map(async (path) => [path, sha256(await readFile(join(repository, path)))]),
        ),
    );
    const artifact = await read(join(nativeDirectory, "timed-savings.json"));
    assert.equal(
        artifact.source.files["timed-savings.ark"],
        (await readFile(join(nativeDirectory, "timed-savings.ark"), "utf8")).replaceAll(
            "\r\n",
            "\n",
        ),
    );
    assert.equal(typeof sdk.arkade.NativeExecutionJournal, "function");
    return {
        head: await command("git", ["rev-parse", "HEAD"]),
        workingTree: await command("git", ["status", "--porcelain"]),
        node: process.version,
        sdkVersion: (await read(join(repository, "packages/sdk/package.json"))).version,
        compiler: artifact.compiler,
        files,
    };
}
async function lineage(position) {
    const indexer = new sdk.RestIndexerProvider(state.arkUrl);
    return waitFor("complete indexed financial lineage", async () => {
        const source = (await indexer.getVtxos({ outpoints: [position.funding] })).vtxos[0];
        if (!source?.isSpent || !source.arkTxId || !source.spentBy) return false;
        const destination = (
            await indexer.getVtxos({ outpoints: [{ txid: source.arkTxId, vout: 0 }] })
        ).vtxos[0];
        if (!destination) return false;
        assert.equal(destination.value, 50000);
        assert.equal(destination.script, position.payoutScript);
        const transactions = await indexer.getVirtualTxs([
            source.txid,
            source.spentBy,
            source.arkTxId,
        ]);
        return transactions.txs.length === 3
            ? { source, destination, transactions, observedAt: new Date().toISOString() }
            : false;
    });
}
try {
    await record("candidate", await fingerprint());
    await startStack(state);
    server = createServer(async (request, response) => {
        try {
            if (["/proof/native-state", "/proof/remote-state"].includes(request.url)) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify(
                        request.url.endsWith("native-state")
                            ? { forwarded }
                            : {
                                  watchRequests: requests.filter(
                                      (row) => row.path === "/v1/delegate" && row.method === "POST",
                                  ).length,
                              },
                    ),
                );
                return;
            }
            const observer = request.url.match(/^\/observer\/([^/]+)(\/.*)$/);
            if (observer) {
                assert.equal(request.method, "GET");
                const [, observation, path] = observer;
                assert.notEqual(observation, "cached", "Cached restart must issue zero RPCs");
                assert(
                    [
                        "malformed-coins",
                        "incomplete-transactions",
                        "oversized-coins",
                        "oversized-transactions",
                        "valid",
                    ].includes(observation),
                );
                assert(path.startsWith("/v1/indexer/"));
                const upstream = await fetch(`${state.arkUrl}${path}`);
                assert.equal(upstream.status, 200);
                const original = await upstream.json();
                const coins = path.startsWith("/v1/indexer/vtxos?");
                const outgoing = { ...original };
                if (observation === "malformed-coins" && coins)
                    outgoing.page = { current: 99, next: 0, total: 1 };
                if (observation === "incomplete-transactions" && !coins)
                    outgoing.page = { current: 1, next: 2, total: 2 };
                const oversized =
                    (observation === "oversized-coins" && coins) ||
                    (observation === "oversized-transactions" && !coins);
                if (oversized) outgoing.padding = "x".repeat(4 * 1024 * 1024 + 1);
                const text = JSON.stringify(outgoing);
                requests.push({
                    method: "GET",
                    path,
                    observation,
                    original,
                    responsePage: outgoing.page,
                    oversized,
                    responseBytes: Buffer.byteLength(text),
                    responseSha256: sha256(text),
                    recordedAt: new Date().toISOString(),
                });
                response.writeHead(200, { "content-type": "application/json" });
                response.end(text);
                return;
            }
            const delegatee = request.url.startsWith("/delegatee/"),
                wallet = request.url.startsWith("/wallet/");
            const path = delegatee
                ? request.url.slice("/delegatee".length)
                : wallet
                  ? request.url.slice("/wallet".length)
                  : request.url;
            const body = Buffer.concat(await Array.fromAsync(request)).toString();
            const row = {
                method: request.method,
                path,
                body: body ? JSON.parse(body) : undefined,
                requestedAt: new Date().toISOString(),
            };
            if (!delegatee && !wallet) {
                assert.equal(request.method, "POST");
                assert.equal(path, "/v1/tx");
                assert.equal(++forwarded, 1);
                const { proposal } = await load("proposal");
                assert.deepEqual(row.body, {
                    arkTx: proposal.arkTx,
                    checkpointTxs: proposal.checkpointTxs,
                });
                assert.deepEqual((await load("proposal")).prepared.proposal, proposal);
                await record("native-request", {
                    ...row,
                    bodyBase64: Buffer.from(body).toString("base64"),
                    sha256: sha256(body),
                });
            }
            if (wallet) {
                assert(
                    request.method === "GET" ||
                        (request.method === "POST" &&
                            ["/v1/tx/submit", "/v1/tx/finalize"].includes(path)),
                );
                if (request.method === "POST")
                    await record(
                        path.endsWith("submit") ? "legacy-submit" : "legacy-finalize",
                        row,
                    );
            }
            const destination = delegatee
                ? state.delegateeUrl
                : wallet
                  ? state.arkUrl
                  : state.emulatorUrl;
            const upstream = await fetch(`${destination}${path}`, {
                method: request.method,
                headers: { "content-type": "application/json" },
                ...(body ? { body } : {}),
            });
            const text = await upstream.text();
            row.responseStatus = upstream.status;
            row.response = JSON.parse(text);
            row.respondedAt = new Date().toISOString();
            requests.push(row);
            if (!delegatee && !wallet) {
                assert.equal(upstream.status, 200, text);
                assert.equal(
                    sdk.Transaction.fromPSBT(Buffer.from(row.response.signedArkTx, "base64")).id,
                    (await load("proposal")).proposal.txid,
                );
                await record("native-response", {
                    ...row,
                    bodyBase64: Buffer.from(text).toString("base64"),
                    sha256: sha256(text),
                });
                assert.equal(response.headersSent, false);
                await record("lost-response", {
                    upstreamStatus: 200,
                    capturedAt: row.respondedAt,
                    downstreamHeadersSent: false,
                    downstreamBodyBytes: 0,
                    intentionallyDropped: true,
                    droppedAt: new Date().toISOString(),
                });
                response.destroy();
                return;
            }
            response.writeHead(upstream.status, { "content-type": "application/json" });
            response.end(text);
        } catch (error) {
            faults.push({ message: error.message, at: new Date().toISOString() });
            response.destroy(error);
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    state.recorderUrl = `http://127.0.0.1:${server.address().port}`;
    await save(join(state.run, "private/state.json"), state);
    await save(join(state.run, "private/keyless.json"), {
        runId: state.runId,
        database: state.database,
        indexerUrl: `${state.recorderUrl}/observer`,
    });
    await actor("fund");
    await actor("signer");
    const plan = await load("funded");
    await record("local-claim", await lineage(plan));
    for (const row of actors) assert.throws(() => process.kill(row.pid, 0));
    await record("observer-barrier", {
        actors: [...actors],
        allPriorActorsExited: true,
        parentOpenedWalletKey: false,
        observedWith: "child close events and process.kill(pid, 0)",
        recordedAt: new Date().toISOString(),
    });
    await actor("observer");
    await actor("restart");
    assert.equal(forwarded, 1);
    assert.deepEqual(faults, []);
    for (const row of actors) assert.throws(() => process.kill(row.pid, 0));
    const delegatee = await owned(state, `${state.prefix}delegatee`);
    assert.equal(delegatee.State.Paused, true);
    phase = "offline delegatee payout";
    await record("offline", {
        actors: [...actors],
        allPriorActorsExited: true,
        parentOpenedWalletKey: false,
        delegateeContainerId: delegatee.Id,
        pausedBeforeFundingAt: plan.remote.pausedAt,
        resumeAfterWalletExitAt: new Date().toISOString(),
        observedWith: "child close events and process.kill(pid, 0)",
    });
    await docker("unpause", delegatee.Id);
    await record("remote-claim", await lineage(plan.remote));
    await actor("remote-recover");
    assert.equal(forwarded, 1);
    assert.deepEqual(faults, []);
    assert.deepEqual(
        await fingerprint(),
        await load("candidate"),
        "Sources/build changed during proof",
    );
    await record("result", {
        passed: true,
        runId: state.runId,
        completedAt: new Date().toISOString(),
        scope: "Fresh funded SQLite admission failure, accepted-but-lost native response, exact prepared request and keyless REST reconciliation, cached process restart with occupied slot, offline delegatee payout and same-wallet restart. No renewal, replay, scheduler handoff or default-wallet cutover claim.",
    });
} catch (error) {
    await writeFile(join(state.run, "private/failure.txt"), error.stack ?? String(error), {
        mode: 0o600,
    });
    await record("failure", {
        phase,
        name: error.name,
        failedAt: new Date().toISOString(),
        details: "private/failure.txt",
    });
    throw error;
} finally {
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    await record("http", { requests, forwarded, faults });
    await stopStack(state);
}
console.log(await command(process.execPath, [join(directory, "audit.mjs"), state.run]));
