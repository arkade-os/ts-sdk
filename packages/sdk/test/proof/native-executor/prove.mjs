import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import {
    command,
    directory,
    docker,
    owned,
    read,
    repository,
    save,
    sdk,
    sha256,
    waitFor,
} from "./common.mjs";
import { createStack, startStack, stopStack } from "./stack.mjs";

const state = await createStack(process.argv[2] ?? join(repository, ".tmp/native-executor"));
const record = (name, value) => save(join(state.run, `public/${name}.json`), value);
const load = (name) => read(join(state.run, `public/${name}.json`));
const actors = [],
    requests = [],
    faults = [];
let server,
    forwarded = 0,
    phase = "build and bootstrap";
console.log(`Fresh native proof ${state.runId}: ${state.run}`);
async function actor(mode) {
    phase = mode;
    console.log(`Wallet actor: ${mode}`);
    const log = createWriteStream(join(state.run, `private/actor-${mode}.log`), { mode: 0o600 });
    const startedAt = new Date().toISOString();
    let pid;
    const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(directory, "actor.mjs"), mode, state.run], {
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
    for (const folder of [join(repository, "packages/sdk/dist"), directory]) {
        for (const file of await readdir(folder, { recursive: true, withFileTypes: true }))
            if (file.isFile())
                paths.push(
                    relative(repository, join(file.parentPath, file.name)).replaceAll("\\", "/"),
                );
    }
    const files = Object.fromEntries(
        await Promise.all(
            [...new Set(paths)]
                .sort()
                .map(async (path) => [path, sha256(await readFile(join(repository, path)))]),
        ),
    );
    const artifact = await read(join(directory, "timed-savings.json"));
    assert.equal(
        artifact.source.files["timed-savings.ark"],
        (await readFile(join(directory, "timed-savings.ark"), "utf8")).replaceAll("\r\n", "\n"),
    );
    return {
        head: await command("git", ["rev-parse", "HEAD"]),
        workingTree: await command("git", ["status", "--porcelain"]),
        node: process.version,
        sdkVersion: (await read(join(repository, "packages/sdk/package.json"))).version,
        compiler: artifact.compiler,
        files,
    };
}
try {
    await record("candidate", await fingerprint());
    await startStack(state);
    server = createServer(async (request, response) => {
        try {
            if (request.url === "/proof/native-state") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ forwarded }));
                return;
            }
            if (request.url === "/proof/remote-state") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        watchRequests: requests.filter(
                            (row) => row.path === "/v1/delegate" && row.method === "POST",
                        ).length,
                    }),
                );
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
            const destination = delegatee
                ? state.delegateeUrl
                : wallet
                  ? state.arkUrl
                  : state.emulatorUrl;
            if (!delegatee && !wallet) {
                assert.equal(request.method, "POST");
                assert.equal(path, "/v1/tx");
                assert.equal(++forwarded, 1);
                const proposal = await load("proposal");
                assert.deepEqual(row.body, {
                    arkTx: proposal.arkTx,
                    checkpointTxs: proposal.checkpointTxs,
                });
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
            await record("http", { requests, forwarded, faults });
            if (!delegatee && !wallet) {
                assert.equal(upstream.status, 200, text);
                assert.equal(
                    sdk.Transaction.fromPSBT(Buffer.from(row.response.signedArkTx, "base64")).id,
                    (await load("proposal")).proposalId,
                );
                await record("native-response", {
                    ...row,
                    bodyBase64: Buffer.from(text).toString("base64"),
                    sha256: sha256(text),
                });
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
    for (const mode of ["fund", "execute", "recover"]) await actor(mode);
    assert.equal(forwarded, 1);
    assert.deepEqual(faults, []);
    for (const row of actors) assert.throws(() => process.kill(row.pid, 0));
    const plan = await load("funded"),
        delegatee = await owned(state, `${state.prefix}delegatee`);
    assert.equal(delegatee.State.Paused, true);
    phase = "offline delegatee payout";
    console.log("All signing wallet processes exited; resuming delegatee");
    await record("offline", {
        actors: [...actors],
        allPriorActorsExited: true,
        observedWith: "child close events and process.kill(pid, 0)",
        delegateeContainerId: delegatee.Id,
        pausedBeforeFundingAt: plan.remote.pausedAt,
        resumeAfterWalletExitAt: new Date().toISOString(),
        parentOpenedWalletKey: false,
    });
    await docker("unpause", delegatee.Id);
    const indexer = new sdk.RestIndexerProvider(state.arkUrl);
    const claim = await waitFor("offline full-principal payout", async () => {
        const source = (await indexer.getVtxos({ outpoints: [plan.remote.funding] })).vtxos[0];
        if (!source?.isSpent || !source.arkTxId || !source.spentBy) return false;
        const destination = (
            await indexer.getVtxos({ outpoints: [{ txid: source.arkTxId, vout: 0 }] })
        ).vtxos[0];
        if (!destination) return false;
        assert.equal(destination.value, 50000);
        assert.equal(destination.script, plan.remote.payoutScript);
        const transactions = await indexer.getVirtualTxs([
            source.arkTxId,
            source.spentBy,
            source.txid,
        ]);
        if (transactions.txs.length !== 3) return false;
        return { source, destination, transactions, observedAt: new Date().toISOString() };
    });
    await record("remote-claim", claim);
    await actor("remote-recover");
    assert.deepEqual(
        await fingerprint(),
        await load("candidate"),
        "Sources/build changed during proof",
    );
    await record("result", {
        passed: true,
        runId: state.runId,
        completedAt: new Date().toISOString(),
        scope: "Native offchain release, callback rejection, immutable source/payout, accepted result after refresh error, matching remote delegation and offline full-principal payout, same SQLite wallet restart. No renewal, journal, scheduler handoff or default-wallet cutover claim.",
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
