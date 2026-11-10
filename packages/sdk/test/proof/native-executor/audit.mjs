import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hex, read, repository, save, sdk, sha256 } from "./common.mjs";

const publicDirectory = join(process.argv[2], "public");
const load = (name) => read(join(publicDirectory, `${name}.json`));
const [
    result,
    candidate,
    services,
    plan,
    proposal,
    rejected,
    accepted,
    mutation,
    nativeRequest,
    nativeResponse,
    http,
    actors,
    offline,
    claim,
    recovery,
    remoteRecovery,
    binding,
    legacy,
    cleanup,
] = await Promise.all(
    [
        "result",
        "candidate",
        "services",
        "funded",
        "proposal",
        "hook-rejected",
        "accepted",
        "mutation",
        "native-request",
        "native-response",
        "http",
        "process-exits",
        "offline",
        "remote-claim",
        "recover",
        "remote-recover",
        "delegate-binding",
        "legacy-control",
        "cleanup",
    ].map(load),
);
assert.equal(result.passed, true);
assert.equal(actors.length, 4);
assert.deepEqual(
    actors.map((actor) => actor.mode),
    ["fund", "execute", "recover", "remote-recover"],
);
assert(
    actors.every((actor) => actor.exitCode === 0 && actor.evidence === "child_process close event"),
);
for (let i = 1; i < actors.length; i++) assert(actors[i - 1].exitedAt <= actors[i].startedAt);
assert.equal(plan.fundingOwnerPid, actors[0].pid);
assert.equal(proposal.executionOwnerPid, actors[1].pid);
assert(actors[1].startedAt <= proposal.recordedBeforeDispatchAt);
assert(proposal.recordedBeforeDispatchAt <= nativeRequest.requestedAt);
assert(nativeResponse.respondedAt <= actors[1].exitedAt);
assert.equal(offline.allPriorActorsExited, true);
assert.deepEqual(offline.actors, actors.slice(0, 3));
assert(actors[2].exitedAt <= offline.resumeAfterWalletExitAt);
assert(offline.resumeAfterWalletExitAt <= claim.observedAt);
assert(claim.observedAt <= actors[3].startedAt);
assert.equal(offline.parentOpenedWalletKey, false);
assert.equal(rejected.hookCalls, 1);
assert.equal(rejected.emulatorSubmissions, 0);
assert.equal(rejected.sameErrorIdentity, true);
assert.equal(http.forwarded, 1);
assert.deepEqual(http.faults, []);
assert.equal(accepted.nativeSubmissions, 1);
assert(accepted.postRefreshCalls >= 1);
assert.equal(accepted.result.txid, proposal.proposalId);
assert.equal(nativeResponse.responseStatus, 200);
assert.equal(sha256(Buffer.from(nativeRequest.bodyBase64, "base64")), nativeRequest.sha256);
assert.equal(sha256(Buffer.from(nativeResponse.bodyBase64, "base64")), nativeResponse.sha256);
assert.deepEqual(JSON.parse(Buffer.from(nativeRequest.bodyBase64, "base64")), nativeRequest.body);
assert.deepEqual(
    JSON.parse(Buffer.from(nativeResponse.bodyBase64, "base64")),
    nativeResponse.response,
);
assert.deepEqual(nativeRequest.body, {
    arkTx: proposal.arkTx,
    checkpointTxs: proposal.checkpointTxs,
});
assert.equal(mutation.requested.txid, plan.funding.txid);
assert.equal(mutation.callerAfterMutation.txid, plan.decoy.txid);
assert.notDeepEqual(mutation.requested, mutation.callerAfterMutation);
assert.equal(mutation.committedPayout, plan.payoutScript);
assert.notEqual(mutation.exposedBefore, plan.payoutScript);
assert.notEqual(mutation.exposedWhileQueued, plan.payoutScript);
assert.equal(binding.mismatchedWatchRequests, 0);
assert.equal(binding.matchingWatchRequests, 1);
assert.deepEqual(binding.wrong.inputs, binding.document.inputs);
assert.notEqual(binding.wrong.outputs[0].locking, binding.document.outputs[0].locking);
const watches = http.requests.filter((row) => row.method === "POST" && row.path === "/v1/delegate");
assert.equal(watches.length, 1);
assert.equal(watches[0].body.templateId, binding.matchingTemplateId);
assert(watches[0].respondedAt <= binding.pausedAt);
assert.equal(legacy.lockedPositionsExcluded, true);
assert.equal(http.requests.filter((row) => row.path === "/v1/tx/submit").length, 1);
assert.equal(http.requests.filter((row) => row.path === "/v1/tx/finalize").length, 1);
const parse = (encoded) => sdk.Transaction.fromPSBT(Buffer.from(encoded, "base64"));
function verifyInput(transaction, previousOutput) {
    const input = transaction.getInput(0);
    assert.equal(input.witnessUtxo.amount, previousOutput.amount);
    assert.equal(hex(input.witnessUtxo.script), hex(previousOutput.script));
    assert.equal(input.tapLeafScript.length, 1);
    const leaf = sdk.decodeTapscript(sdk.scriptFromTapLeafScript(input.tapLeafScript[0]));
    const requiredSigners = leaf.params.pubkeys.map((key) => hex(sdk.toXOnly(key)));
    assert.equal(new Set(requiredSigners).size, 2);
    assert.equal(input.tapScriptSig.length, requiredSigners.length);
    sdk.verifyTapscriptSignatures(
        transaction,
        0,
        requiredSigners,
        [],
        undefined,
        input.tapScriptSig[0][0].leafHash,
    );
}
function lineage(position, observed) {
    const txs = new Map(
        observed.transactions.txs.map((encoded) => {
            const tx = parse(encoded);
            return [tx.id, tx];
        }),
    );
    const source = txs.get(position.funding.txid),
        checkpoint = txs.get(observed.source.spentBy),
        payout = txs.get(observed.destination.txid);
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
    verifyInput(checkpoint, source.getOutput(position.funding.vout));
    assert.equal(payout.inputsLength, 1);
    assert.equal(hex(payout.getInput(0).txid), checkpoint.id);
    assert.equal(payout.getInput(0).index, 0);
    verifyInput(payout, checkpoint.getOutput(0));
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
const local = lineage(plan, recovery),
    remote = lineage(plan.remote, claim);
assert.equal(local.payout, proposal.proposalId);
assert.equal(parse(proposal.arkTx).id, local.payout);
assert.equal(parse(nativeResponse.response.signedArkTx).id, local.payout);
assert.equal(proposal.checkpointTxs.length, 1);
assert.equal(parse(proposal.checkpointTxs[0]).id, local.checkpoint);
assert.equal(parse(nativeResponse.response.signedCheckpointTxs[0]).id, local.checkpoint);
assert.equal(parse(proposal.arkTx).getOutput(0).amount, 50000n);
assert.equal(hex(parse(proposal.arkTx).getOutput(0).script), plan.payoutScript);
for (const observation of [recovery, remoteRecovery]) {
    assert.equal(observation.samePersistedWallet, true);
    assert.equal(observation.ownerPublicKey, plan.ownerPublicKey);
    assert.equal(observation.financialSubmissions, 0);
    assert.equal(observation.decoy.txid, plan.decoy.txid);
    assert.equal(observation.decoy.vout, plan.decoy.vout);
    assert.equal(observation.decoy.value, 50000);
    assert.equal(observation.decoy.isSpent, false);
}
assert.equal(remoteRecovery.destination.txid, remote.payout);
assert.match(services.backendBinarySha256, /^[0-9a-f]{64}$/);
assert.equal(services.identities.length, 13);
for (const { name, configuredImage } of services.identities)
    assert.equal(configuredImage, services.images[name], `Unexpected image for ${name}`);
assert.equal(cleanup.volumesDeleted, false);
assert.deepEqual(
    new Set(cleanup.stoppedContainerIds),
    new Set(services.identities.map((service) => service.containerId)),
);
for (const [path, expected] of Object.entries(candidate.files))
    assert.equal(
        sha256(await readFile(join(repository, path))),
        expected,
        `Changed source/build: ${path}`,
    );
const audit = {
    passed: true,
    runId: result.runId,
    sdkHead: candidate.head,
    auditedAt: new Date().toISOString(),
    auditorPid: process.pid,
    walletKeysAndDatabaseOpened: false,
    local,
    remote,
    decoy: plan.decoy,
    nativeDispatches: 1,
    rejectedCallbackDispatches: 0,
    acceptedResultSurvivedRefreshFailure: true,
    sourceAndPayoutMutationIgnored: true,
    mismatchedTemplateWatches: 0,
    walletExitedBeforeDelegateeResume: true,
    sameSqliteWalletReconciled: true,
    backendBinarySha256: services.backendBinarySha256,
    scope: result.scope,
};
await save(join(publicDirectory, "audit.json"), audit);
const names = [
    "candidate",
    "services",
    "funded",
    "proposal",
    "hook-rejected",
    "accepted",
    "mutation",
    "native-request",
    "native-response",
    "http",
    "process-exits",
    "offline",
    "remote-claim",
    "recover",
    "remote-recover",
    "delegate-binding",
    "legacy-control",
    "legacy-submit",
    "legacy-finalize",
    "result",
    "cleanup",
    "audit",
];
const files = await Promise.all(
    names.map(async (name) => ({
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
console.log(
    JSON.stringify({
        passed: true,
        sdkHead: candidate.head,
        local,
        remote,
        audit: join(publicDirectory, "audit.json"),
    }),
);
