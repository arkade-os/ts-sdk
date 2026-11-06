import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hex, read, repository, save, sdk, sha256 } from "../native-executor/common.mjs";
import { inputs } from "../native-executor/stack.mjs";

const publicDirectory = join(process.argv[2], "public");
const names = [
    "candidate",
    "services",
    "funded",
    "delegate-binding",
    "legacy-control",
    "legacy-submit",
    "legacy-finalize",
    "proposal",
    "admission-failed",
    "submission-unknown",
    "native-request",
    "native-response",
    "lost-response",
    "local-claim",
    "observer-barrier",
    "observer",
    "restart",
    "process-exits",
    "http",
    "offline",
    "remote-claim",
    "remote-recover",
    "result",
    "cleanup",
];
const present = new Set(await readdir(publicDirectory));
for (const name of names) assert(present.has(`${name}.json`), `Missing public evidence: ${name}`);
assert(
    [...present].every((name) =>
        [...names.map((n) => `${n}.json`), "audit.json", "manifest.json"].includes(name),
    ),
);
assert.equal(present.has("audit.json"), present.has("manifest.json"));
if (present.has("manifest.json")) {
    const manifest = await read(join(publicDirectory, "manifest.json"));
    assert.deepEqual(
        new Set(manifest.files.map((file) => file.path)),
        new Set([...names, "audit"].map((name) => `${name}.json`)),
    );
    for (const file of manifest.files)
        assert.equal(sha256(await readFile(join(publicDirectory, file.path))), file.sha256);
}
const evidence = Object.fromEntries(
    await Promise.all(
        names.map(async (name) => [name, await read(join(publicDirectory, `${name}.json`))]),
    ),
);
const {
    candidate,
    services,
    funded: plan,
    proposal,
    observer,
    restart,
    http,
    offline,
    result,
    cleanup,
} = evidence;
const actors = evidence["process-exits"],
    request = evidence["native-request"],
    response = evidence["native-response"];
const failed = evidence["admission-failed"],
    unknown = evidence["submission-unknown"],
    lost = evidence["lost-response"];
assert.equal(result.passed, true);
assert.equal(candidate.node, "v24.22.1");
assert.equal(plan.runId, result.runId);
assert.equal(observer.runId, result.runId);
assert.equal(restart.runId, result.runId);
assert.deepEqual(
    actors.map((actor) => actor.mode),
    ["fund", "signer", "observer", "restart", "remote-recover"],
);
assert(
    actors.every((actor) => actor.exitCode === 0 && actor.evidence === "child_process close event"),
);
for (let i = 1; i < actors.length; i++) assert(actors[i - 1].exitedAt <= actors[i].startedAt);
assert.equal(plan.fundingOwnerPid, actors[0].pid);
for (const row of [failed, unknown]) assert.equal(row.pid, actors[1].pid);
assert.equal(proposal.signerPid, actors[1].pid);
assert.equal(observer.pid, actors[2].pid);
assert.equal(restart.pid, actors[3].pid);
const barrier = evidence["observer-barrier"];
assert.equal(barrier.allPriorActorsExited, true);
assert.equal(barrier.parentOpenedWalletKey, false);
assert.deepEqual(barrier.actors, actors.slice(0, 2));
assert(actors[1].exitedAt <= barrier.recordedAt && barrier.recordedAt <= actors[2].startedAt);
assert(
    actors[1].startedAt <= proposal.durableBeforeDispatchAt &&
        proposal.durableBeforeDispatchAt <= request.requestedAt,
);
assert(
    response.respondedAt <= lost.droppedAt &&
        lost.droppedAt <= unknown.recordedAt &&
        unknown.recordedAt <= actors[1].exitedAt,
);
assert.equal(failed.sqliteQueryOnly, true);
assert.equal(failed.queryOnlyRestored, true);
assert.equal(failed.slotAbsentAfterRollback, true);
assert.equal(failed.emulatorRequests, 0);
assert.equal(failed.callbacks, 1);
assert.match(failed.error.message, /readonly|read.only/i);
assert.equal(unknown.callbacks, 1);
for (const field of ["callerRejected", "receiptAbsent", "slotStillOccupied"])
    assert.equal(unknown[field], true);
assert.equal(unknown.acceptedResultReturned, false);
assert.deepEqual(unknown.prepared, proposal.prepared);
assert.equal(proposal.immutableProposal, true);
assert.deepEqual(proposal.prepared.proposal, proposal.proposal);
assert.equal(proposal.prepared.operationId, proposal.proposal.txid);
assert.equal(proposal.principal, 50000);
assert.equal(proposal.prepared.source.value, "50000");
assert.equal(proposal.prepared.payout.value, "50000");
assert.equal(proposal.prepared.source.script, plan.script);
assert.equal(proposal.prepared.payout.script, plan.payoutScript);
assert.equal(response.responseStatus, 200);
assert.equal(lost.upstreamStatus, 200);
assert.equal(lost.intentionallyDropped, true);
assert.equal(lost.downstreamHeadersSent, false);
assert.equal(lost.downstreamBodyBytes, 0);
assert.equal(sha256(Buffer.from(request.bodyBase64, "base64")), request.sha256);
assert.equal(sha256(Buffer.from(response.bodyBase64, "base64")), response.sha256);
assert.deepEqual(JSON.parse(Buffer.from(request.bodyBase64, "base64")), request.body);
assert.deepEqual(JSON.parse(Buffer.from(response.bodyBase64, "base64")), response.response);
assert.deepEqual(request.body, {
    arkTx: proposal.proposal.arkTx,
    checkpointTxs: proposal.proposal.checkpointTxs,
});
assert.equal(http.forwarded, 1);
assert.deepEqual(http.faults, []);
assert.equal(http.requests.filter((row) => row.path === "/v1/tx").length, 1);
const expectedHash = sha256(
    JSON.stringify({
        txid: proposal.proposal.txid,
        arkTx: proposal.proposal.arkTx,
        checkpointTxs: proposal.proposal.checkpointTxs,
    }),
);
for (const row of [observer, restart]) {
    assert.deepEqual(row.prepared, proposal.prepared);
    assert.equal(row.receipt.proposalHash, expectedHash);
    assert.equal(row.receipt.operationId, proposal.proposal.txid);
    assert.equal(row.receipt.state, "reconciled");
    assert.deepEqual(row.receipt.source, proposal.source);
    assert.equal(row.slotStillOccupied, true);
    assert.equal(row.financialSubmissions, 0);
    assert.equal(row.walletConstructed, false);
    assert.equal(row.signingMaterialOpened, false);
    assert(row.requests.every((r) => r.method === "GET"));
}
assert.deepEqual(observer.receipt, restart.receipt);
assert.equal(observer.rpcRequests, 10);
assert.equal(restart.rpcRequests, 0);
assert.deepEqual(restart.requests, []);
assert.deepEqual(
    observer.observations.map((row) => row.phase),
    ["malformed-coins", "incomplete-transactions", "oversized-coins", "oversized-transactions"],
);
assert(
    observer.observations.every(
        (row) =>
            row.state === "unknown" &&
            row.receiptAbsent &&
            row.slotOccupied &&
            row.rpcRequests === 2,
    ),
);
const observedRequests = http.requests.filter((row) => row.observation);
assert.equal(observedRequests.length, 10);
for (const row of observedRequests) {
    const url = new URL(row.path, "http://proof.invalid");
    assert.equal(url.searchParams.get("page.index"), "0");
    assert.equal(url.searchParams.get("page.size"), "2");
    assert.equal((row.original.vtxos ?? row.original.txs).length, 2);
    const reconstructed = { ...row.original };
    if (row.responsePage !== undefined) reconstructed.page = row.responsePage;
    if (row.oversized) reconstructed.padding = "x".repeat(4 * 1024 * 1024 + 1);
    const body = JSON.stringify(reconstructed);
    assert.equal(row.responseSha256, sha256(body));
    assert.equal(row.responseBytes, Buffer.byteLength(body));
    if (row.oversized) assert(row.responseBytes > 4 * 1024 * 1024);
}
assert.equal(observedRequests.filter((row) => row.oversized).length, 2);
assert(
    observedRequests.some(
        (row) => row.observation === "malformed-coins" && row.responsePage.current === 99,
    ),
);
assert(
    observedRequests.some(
        (row) => row.observation === "incomplete-transactions" && row.responsePage.total === 2,
    ),
);
const parse = (encoded) => sdk.Transaction.fromPSBT(Buffer.from(encoded, "base64"));
function verifyInput(transaction, previous, prepared) {
    const input = transaction.getInput(0);
    assert.equal(input.witnessUtxo.amount, previous.amount);
    assert.equal(hex(input.witnessUtxo.script), hex(previous.script));
    assert.equal(input.tapLeafScript.length, 1);
    if (prepared) assert.deepEqual(input.tapLeafScript, prepared.getInput(0).tapLeafScript);
    const leaf = sdk.decodeTapscript(sdk.scriptFromTapLeafScript(input.tapLeafScript[0]));
    const required = leaf.params.pubkeys.map((key) => hex(sdk.toXOnly(key)));
    assert.equal(new Set(required).size, 2);
    assert.equal(input.tapScriptSig.length, required.length);
    assert.equal(
        new Set(input.tapScriptSig.map(([data]) => hex(data.pubKey))).size,
        required.length,
    );
    assert(
        input.tapScriptSig.every(
            ([data, sig]) => required.includes(hex(data.pubKey)) && sig.length === 64,
        ),
    );
    sdk.verifyTapscriptSignatures(transaction, 0, required);
}
function lineage(position, observed, localProposal) {
    assert.equal(observed.transactions.txs.length, 3);
    const transactions = new Map(
        observed.transactions.txs.map((encoded) => {
            const tx = parse(encoded);
            return [tx.id, tx];
        }),
    );
    assert.equal(transactions.size, 3);
    const source = transactions.get(position.funding.txid),
        checkpoint = transactions.get(observed.source.spentBy),
        payout = transactions.get(observed.destination.txid);
    assert(source && checkpoint && payout);
    assert.equal(observed.source.isSpent, true);
    assert.equal(observed.source.txid, position.funding.txid);
    assert.equal(observed.source.vout, position.funding.vout);
    assert.equal(observed.source.arkTxId, payout.id);
    assert.equal(source.getOutput(position.funding.vout).amount, 50000n);
    assert.equal(hex(source.getOutput(position.funding.vout).script), position.script);
    assert.equal(checkpoint.inputsLength, 1);
    assert.equal(hex(checkpoint.getInput(0).txid), source.id);
    assert.equal(checkpoint.getInput(0).index, position.funding.vout);
    verifyInput(
        checkpoint,
        source.getOutput(position.funding.vout),
        localProposal && parse(localProposal.checkpointTxs[0]),
    );
    assert.equal(payout.inputsLength, 1);
    assert.equal(hex(payout.getInput(0).txid), checkpoint.id);
    assert.equal(payout.getInput(0).index, 0);
    verifyInput(payout, checkpoint.getOutput(0), localProposal && parse(localProposal.arkTx));
    assert.equal(payout.getOutput(0).amount, 50000n);
    assert.equal(hex(payout.getOutput(0).script), position.payoutScript);
    assert.equal(observed.destination.value, 50000);
    assert.equal(observed.destination.script, position.payoutScript);
    return {
        source: { txid: source.id, vout: position.funding.vout },
        checkpoint: checkpoint.id,
        payout: payout.id,
        principal: 50000,
        payoutScript: position.payoutScript,
        signaturesVerified: true,
        witnessPrevoutsBound: true,
    };
}
const local = lineage(plan, evidence["local-claim"], proposal.proposal);
assert.equal(local.payout, proposal.proposal.txid);
assert.equal(parse(response.response.signedArkTx).id, local.payout);
assert.equal(parse(response.response.signedCheckpointTxs[0]).id, local.checkpoint);
const creating = evidence["local-claim"].transactions.txs
    .map(parse)
    .find((tx) => tx.id === local.source.txid);
const acceptedCheckpoint = parse(response.response.signedCheckpointTxs[0]);
verifyInput(
    acceptedCheckpoint,
    creating.getOutput(local.source.vout),
    parse(proposal.proposal.checkpointTxs[0]),
);
verifyInput(
    parse(response.response.signedArkTx),
    acceptedCheckpoint.getOutput(0),
    parse(proposal.proposal.arkTx),
);
const remote = lineage(plan.remote, evidence["remote-claim"]);
assert.equal(offline.allPriorActorsExited, true);
assert.equal(offline.parentOpenedWalletKey, false);
assert.deepEqual(offline.actors, actors.slice(0, 4));
assert(actors[3].exitedAt <= offline.resumeAfterWalletExitAt);
assert(offline.resumeAfterWalletExitAt <= evidence["remote-claim"].observedAt);
assert(evidence["remote-claim"].observedAt <= actors[4].startedAt);
const recovered = evidence["remote-recover"];
assert.equal(recovered.samePersistedWallet, true);
assert.equal(recovered.ownerPublicKey, plan.ownerPublicKey);
assert.equal(recovered.financialSubmissions, 0);
assert.equal(recovered.destination.txid, remote.payout);
assert.equal(recovered.decoy.isSpent, false);
assert.equal(recovered.decoy.value, 50000);
assert.equal(recovered.decoy.txid, plan.decoy.txid);
assert.equal(recovered.decoy.vout, plan.decoy.vout);
assert.equal(recovered.decoy.script, plan.script);
const binding = evidence["delegate-binding"];
assert.equal(binding.mismatchedWatchRequests, 0);
assert.equal(binding.matchingWatchRequests, 1);
const watches = http.requests.filter((row) => row.path === "/v1/delegate" && row.method === "POST");
assert.equal(watches.length, 1);
assert.equal(watches[0].body.templateId, binding.matchingTemplateId);
assert(watches[0].respondedAt <= binding.pausedAt);
assert.equal(evidence["legacy-control"].lockedPositionsExcluded, true);
for (const path of ["/v1/tx/submit", "/v1/tx/finalize"])
    assert.equal(http.requests.filter((row) => row.path === path).length, 1);
assert.deepEqual(services.inputs, inputs);
assert.equal(services.identities.length, 12);
assert.match(services.backendBinarySha256, /^[0-9a-f]{64}$/);
for (const [service, image] of [
    ["emulator", inputs.emulator],
    ["delegatee", inputs.delegatee],
    ["arkd-wallet", inputs.wallet],
])
    assert.equal(
        services.identities.find((entry) => entry.name === service).configuredImage,
        image,
    );
assert.equal(cleanup.volumesDeleted, false);
assert.deepEqual(
    new Set(cleanup.stoppedContainerIds),
    new Set(services.identities.map((service) => service.containerId)),
);
for (const path of [
    "packages/sdk/src/arkade/executionJournal.ts",
    "packages/sdk/test/proof/native-executor/actor.mjs",
    "packages/sdk/test/proof/native-executor/stack.mjs",
    "packages/sdk/test/proof/native-executor/Dockerfile",
    "packages/sdk/test/proof/native-execution-journal/actor.mjs",
    "packages/sdk/test/proof/native-execution-journal/observer.mjs",
    "packages/sdk/test/proof/native-execution-journal/prove.mjs",
    "packages/sdk/test/proof/native-execution-journal/audit.mjs",
])
    assert(candidate.files[path], `Unbound proof input: ${path}`);
for (const [path, expected] of Object.entries(candidate.files)) {
    assert(!path.includes("..") && !path.includes("\\"));
    assert(
        [
            "package.json",
            "pnpm-lock.yaml",
            ".github/workflows/native-executor-proof.yml",
            "packages/sdk/package.json",
        ].includes(path) ||
            [
                "packages/sdk/src/",
                "packages/sdk/dist/",
                "packages/sdk/test/proof/native-executor/",
                "packages/sdk/test/proof/native-execution-journal/",
            ].some((prefix) => path.startsWith(prefix)),
    );
    assert.equal(
        sha256(await readFile(join(repository, path))),
        expected,
        `Changed source/build: ${path}`,
    );
}
const priorAudit = present.has("audit.json")
    ? await read(join(publicDirectory, "audit.json"))
    : undefined;
assert(!actors.some((actor) => actor.pid === process.pid));
const audit = {
    passed: true,
    runId: result.runId,
    sdkHead: candidate.head,
    auditorPid: priorAudit?.auditorPid ?? process.pid,
    auditedAt: priorAudit?.auditedAt ?? new Date().toISOString(),
    local,
    remote,
    nativeDispatches: 1,
    failedAdmissionDispatches: 0,
    acceptedResponseDeliberatelyLost: true,
    signerExitedBeforeKeylessObserver: true,
    cachedRestartRpc: 0,
    preparedSlotStillOccupied: true,
    walletExitedBeforeDelegateeResume: true,
    walletKeysAndDatabaseOpened: false,
    backendBinarySha256: services.backendBinarySha256,
    scope: result.scope,
};
assert(!actors.some((actor) => actor.pid === audit.auditorPid));
if (priorAudit) assert.deepEqual(priorAudit, audit);
else {
    await save(join(publicDirectory, "audit.json"), audit);
    const files = await Promise.all(
        [...names, "audit"].map(async (name) => ({
            path: `${name}.json`,
            sha256: sha256(await readFile(join(publicDirectory, `${name}.json`))),
        })),
    );
    await save(join(publicDirectory, "manifest.json"), {
        runId: result.runId,
        files,
        excluded: [
            "private keys",
            "SQLite, DB and WAL files",
            "generated compose and environment",
            "raw process logs",
        ],
    });
}
console.log(
    JSON.stringify({
        passed: true,
        sdkHead: candidate.head,
        local,
        remote,
        audit: join(publicDirectory, "audit.json"),
    }),
);
