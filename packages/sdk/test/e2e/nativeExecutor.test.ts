import { beforeAll, describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    EsploraProvider,
    IndexedDBWalletRepository,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    RestArkProvider,
    RestEmulatorProvider,
    RestExecutorProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    type EmulatorProvider,
    type EmulatorSubmitProposal,
    type VirtualCoin,
} from "../../src";
import { Arkade } from "../../src/arkade";
import {
    NativeExecutionJournal,
    NativeExecutor,
    type NativeExecution,
} from "../../src/nativeExecutor";
import { emulateOffchainTx } from "../../src/arkade/vm";
import { vmExtensionCodec } from "../../src/extension/vmCodec";
import vhtlc from "../fixtures/template-v1/vhtlc-claim.json";
import example from "../fixtures/template-v1/example-vhtlc-non-interactive-claim.json";
import { ESPLORA_API_URL, OPERATOR_URL, faucetOnchain, waitFor } from "./utils";

// The sdk-executor stack; overridable to run against one on other ports.
const ARK_URL = process.env.ARK_URL ?? OPERATOR_URL;
const ESPLORA_URL = process.env.ESPLORA_URL ?? ESPLORA_API_URL;
const EMULATOR_URL = process.env.EMULATOR_URL ?? "http://localhost:7073";
const EXECUTOR_URL = process.env.EXECUTOR_URL ?? "http://localhost:7280";
const AMOUNT = 20_000;

// No test or hook timeout exists during collection, so an Executor that accepts the connection
// and never answers would hang the file instead of skipping it.
const reachable = await fetch(`${EXECUTOR_URL}/v1/info`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.ok)
    .catch(() => false);
if (!reachable) {
    if (process.env.CI) throw new Error(`no Executor at ${EXECUTOR_URL}`);
    console.warn(`NativeExecutor e2e skipped: no Executor at ${EXECUTOR_URL}`);
}

/** The vectors' bindings with a fresh payout program and preimage, so each test owns its contract. */
function claimVariables() {
    const program = hex.encode(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
    const variables = {
        ...vhtlc.bindings.variables,
        receiver_program: program,
        preimage: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
    };
    return { variables, payout: `5120${program}` };
}

// One wallet funds every test in turn; each waits on its own coins.
describe.skipIf(!reachable).sequential("NativeExecutor template/v1 on the Executor stack", () => {
    const indexer = new RestIndexerProvider(ARK_URL);
    const emulator = new RestEmulatorProvider(EMULATOR_URL);
    let wallet: Wallet;
    let executor: NativeExecutor;
    let submits = 0;

    async function nativeExecutor(submitTx: EmulatorProvider["submitTx"]) {
        const arkade = await Arkade.connect({
            arkade: new RestArkProvider(ARK_URL),
            emulator: { submitTx } as unknown as EmulatorProvider,
            indexer,
            network: networks.regtest,
            contractManager: await wallet.getContractManager(),
        });
        return new NativeExecutor(arkade, wallet);
    }

    const vtxosAt = async (script: string) => (await indexer.getVtxos({ scripts: [script] })).vtxos;

    async function funded(execution: NativeExecution) {
        let coin: VirtualCoin | undefined;
        await waitFor(async () => {
            [coin] = await vtxosAt(hex.encode(execution.contract.pkScript));
            return coin !== undefined;
        });
        return { txid: coin!.txid, vout: coin!.vout };
    }

    async function paidTo(script: string, timeout = 25_000) {
        await waitFor(async () => (await vtxosAt(script)).length > 0, { timeout, interval: 1_000 });
        return vtxosAt(script);
    }

    beforeAll(async () => {
        wallet = await Wallet.create({
            identity: SingleKey.fromRandomBytes(),
            arkProvider: new RestArkProvider(ARK_URL),
            onchainProvider: new EsploraProvider(ESPLORA_URL, {
                forcePolling: true,
                pollingInterval: 2000,
            }),
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
            settlementConfig: false,
            minBatchExpirySeconds: 1n,
        });
        faucetOnchain(await wallet.getBoardingAddress(), 5 * AMOUNT);
        await waitFor(async () => (await wallet.getBalance()).boarding.confirmed === 5 * AMOUNT, {
            timeout: 170_000,
            interval: 2_000,
        });
        await wallet.settle();
        await waitFor(async () => (await wallet.getBalance()).available === 5 * AMOUNT, {
            timeout: 60_000,
        });
        executor = await nativeExecutor((arkTx, checkpoints) => {
            submits++;
            return emulator.submitTx(arkTx, checkpoints);
        });
    }, 300_000);

    it("executes a funded VHTLC claim natively, paying the committed receiver", {
        timeout: 120_000,
    }, async () => {
        const { variables, payout } = claimVariables();
        const execution = await executor.importTemplate(vhtlc.template, { variables });
        await executor.fund(execution, AMOUNT);
        const coin = await funded(execution);

        let request: EmulatorSubmitProposal | undefined;
        const result = await executor.execute(execution, coin, {
            beforeEmulatorSubmit: (proposal) => {
                request = proposal;
            },
        });
        // the dry-run request is the one the emulator accepted, and the VM still passes it
        expect(request?.txid).toBe(result.txid);
        const requests = emulateOffchainTx({
            arkPsbt: base64.decode(request!.arkTx),
            checkpoints: request!.checkpointTxs.map((tx) => base64.decode(tx)),
            vtxoExpiries: new Map(),
            codec: vmExtensionCodec,
        });
        expect(requests.length).toBeGreaterThan(0);

        const [paid] = await paidTo(payout);
        expect(paid).toMatchObject({ txid: result.txid, vout: 0, value: AMOUNT, script: payout });
    });

    it("dispatches nothing when beforeEmulatorSubmit rejects", { timeout: 120_000 }, async () => {
        const { variables, payout } = claimVariables();
        const execution = await executor.importTemplate(vhtlc.template, { variables });
        await executor.fund(execution, AMOUNT);
        const coin = await funded(execution);

        const before = submits;
        const refused = new Error("refused before dispatch");
        await expect(
            executor.execute(execution, coin, {
                beforeEmulatorSubmit: () => {
                    throw refused;
                },
            }),
        ).rejects.toBe(refused);
        expect(submits).toBe(before);
        const [kept] = (await indexer.getVtxos({ outpoints: [coin] })).vtxos;
        expect(kept.isSpent).toBeFalsy();
        expect(await vtxosAt(payout)).toHaveLength(0);
    });

    it("reconciles an execution whose emulator response was lost", {
        timeout: 120_000,
    }, async () => {
        const lost = new Error("emulator response lost");
        const lossy = await nativeExecutor(async (arkTx, checkpoints) => {
            await emulator.submitTx(arkTx, checkpoints);
            throw lost;
        });
        const journal = new NativeExecutionJournal(
            new IndexedDBWalletRepository(`native-journal-${crypto.randomUUID()}`, {
                persistentWalletState: true,
            }),
        );
        const { variables, payout } = claimVariables();
        const execution = await lossy.importTemplate(vhtlc.template, { variables });
        await lossy.fund(execution, AMOUNT);
        const coin = await funded(execution);

        await expect(
            lossy.execute(execution, coin, {
                beforeEmulatorSubmit: async (proposal) => {
                    await journal.admit(coin, proposal);
                },
            }),
        ).rejects.toBe(lost);
        const record = await journal.get(coin);
        expect(record?.payout).toEqual({ script: payout, value: String(AMOUNT) });

        const reconciled = async () =>
            (await journal.reconcile(coin, indexer))?.state === "reconciled";
        await waitFor(reconciled, { interval: 1_000 });
        expect(await journal.getReceipt(coin)).toMatchObject({
            operationId: record!.operationId,
            source: coin,
        });
    });

    // Last: the Executor retries a failed attempt about a minute later.
    it("delegates a VHTLC claim to the Executor, which spends the funded coin", {
        timeout: 300_000,
    }, async () => {
        const { variables, payout } = claimVariables();
        const execution = await executor.importTemplate(example.template, {
            artifacts: example.artifacts,
            variables,
        });
        const provider = new RestExecutorProvider(EXECUTOR_URL);
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const delegation = await executor.delegate(execution, provider, expiresAt);
        expect(delegation).toMatchObject({ status: "active", expiresAt });
        expect(await provider.getTemplate(execution.templateId)).toMatchObject({
            status: "active",
            artifactIds: Object.keys(example.artifacts),
        });

        await executor.fund(execution, AMOUNT);
        const coin = await funded(execution);
        // no schedule: the Executor claims as soon as it sees the coin, revealing the sealed preimage
        const [paid] = await paidTo(payout, 240_000);
        expect(paid).toMatchObject({ vout: 0, value: AMOUNT, script: payout });
        const [spent] = (await indexer.getVtxos({ outpoints: [coin] })).vtxos;
        expect(spent).toMatchObject({ isSpent: true, arkTxId: paid.txid });
    });
});
