import { afterEach, describe, expect, it, vi } from "vitest";
import {
    collectIntents,
    InMemoryBatchRegistrationRepository,
    InMemoryIntentRepository,
    INTENT_TERMINAL_STATES,
    Intent,
    isTerminalIntentState,
    Proof,
    ReadonlyWallet,
    RestArkProvider,
    RestDelegateProvider,
    RestEmulatorProvider,
    Wallet,
    type ArkIntent,
    type IntentFeeConfig,
    type IntentRepository,
    type SignedIntent,
} from "../src";
import { batchFeeConfig } from "../src/arkfee";
import { AssetInput, AssetInputType } from "../src/extension/asset";
import { TAG_PROOF } from "../src/proof";
import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import {
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_BATCH_REGISTRATIONS,
} from "../src/repositories/indexedDB/batchesSchema";
import { IndexedDBBatchRegistrationRepository } from "../src/repositories/indexedDB/batchRegistrationRepository";
import { closeDatabase, openDatabase } from "../src/repositories/indexedDB/manager";
import { SQLiteBatchRegistrationRepository } from "../src/repositories/sqlite/batchRegistrationRepository";
import {
    MalformedArkInfoSnapshotError,
    hydrateArkInfo,
    parseStoredArkInfoSnapshot,
} from "../src/wallet/arkInfoSnapshot";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";

const registerMessage: Proof.RegisterMessage = {
    type: "register",
    onchain_output_indexes: [],
    valid_at: 0,
    expire_at: 0,
    cosigners_public_keys: [],
};
const signedProof = { proof: "cHJvb2Y=", message: registerMessage };
const deleteProof = {
    proof: "cHJvb2Y=",
    message: { type: "delete", expire_at: 0 } as Proof.DeleteMessage,
};

const registration: ArkIntent = {
    proofTxId: "a",
    registrationId: "r",
    state: "waiting_for_batch",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    inputs: [{ txid: "t", vout: 0 }],
};

/** Stubs `fetch`, answering every call with `body`, and returns the calls it saw. */
function stubFetch(body: unknown) {
    const spy = vi.fn(
        async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    return {
        url: () => spy.mock.calls[0][0],
        body: () => JSON.parse(String(spy.mock.calls[0][1]?.body)),
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("what the operator and emulator parse is unchanged", () => {
    it("keeps the proof message tag", () => {
        expect(TAG_PROOF).toBe("ark-intent-proof-message");
    });

    it("registers under the operator's RegisterIntent contract", async () => {
        const http = stubFetch({ intentId: "r" });
        await expect(new RestArkProvider("http://o").registerProof(signedProof)).resolves.toBe("r");
        expect(http.url()).toBe("http://o/v1/batch/registerIntent");
        expect(http.body()).toEqual({
            intent: {
                proof: signedProof.proof,
                message: Proof.encodeMessage(registerMessage),
            },
        });
    });

    it("deletes under the operator's DeleteIntent contract", async () => {
        const http = stubFetch({});
        await new RestArkProvider("http://o").deleteRegistration(deleteProof);
        expect(http.url()).toBe("http://o/v1/batch/deleteIntent");
        expect(Object.keys(http.body())).toEqual(["intent"]);
    });

    it("confirms a registration with the operator's intentId key", async () => {
        const http = stubFetch({});
        await new RestArkProvider("http://o").confirmRegistration("r");
        expect(http.body()).toEqual({ intentId: "r" });
    });

    it("reads the operator's intentFee into both fee keys", async () => {
        const fees = { intentFee: { offchainInput: "1.0" }, txFeeRate: "2" };
        stubFetch({ fees, scheduledSession: { fees } });
        const info = await new RestArkProvider("http://o").getInfo();
        for (const f of [info.fees, info.scheduledSession?.fees]) {
            expect(f).toEqual({
                batchFee: fees.intentFee,
                intentFee: fees.intentFee,
                txFeeRate: "2",
            });
        }
    });

    it("sends the emulator its intent and signedIntent keys", async () => {
        let http = stubFetch({ signedProof: "s" });
        const emulator = new RestEmulatorProvider("http://e");
        await emulator.submitProof(signedProof);
        expect(http.url()).toBe("http://e/v1/intent");
        expect(Object.keys(http.body())).toEqual(["intent"]);

        http = stubFetch({ signedForfeits: [] });
        await emulator.submitFinalization(signedProof, [], null, "c");
        expect(http.body()).toHaveProperty("signedIntent");
    });

    it("sends the delegate its intent key", async () => {
        const http = stubFetch({});
        await new RestDelegateProvider("http://d").delegate(signedProof, []);
        expect(http.body()).toHaveProperty("intent");
    });
});

describe("old names still work", () => {
    it("aliases the Intent namespace, with its Proof type", () => {
        expect(Intent).toBe(Proof);
        const message: Intent.RegisterMessage = registerMessage;
        const signed: SignedIntent<Intent.Message> = { proof: "p", message };
        expect(Intent.encodeMessage(signed.message)).toBe(Proof.encodeMessage(registerMessage));
        // Compile-time pin: the old `Intent.Proof` type names the new `Proof` type.
        const proofType = (p: Proof): Intent.Proof => p;
        expect(proofType).toBeTypeOf("function");
    });

    it("aliases the repository names and methods", async () => {
        expect(InMemoryIntentRepository).toBe(InMemoryBatchRegistrationRepository);
        const repository: IntentRepository = new InMemoryIntentRepository();
        await repository.saveIntent(registration);
        const page = await repository.getIntentsPage(undefined, { limit: 10 });
        expect(page.items.map((r) => r.proofTxId)).toEqual(["a"]);
        expect(await collectIntents(repository)).toHaveLength(1);
        expect(isTerminalIntentState("cancelled")).toBe(true);
        expect(INTENT_TERMINAL_STATES.has("waiting_for_batch")).toBe(false);
    });

    it("aliases provider methods", async () => {
        let http = stubFetch({ intentId: "r" });
        await new RestArkProvider("http://o").registerIntent(signedProof);
        expect(http.url()).toContain("/registerIntent");

        http = stubFetch({});
        await new RestArkProvider("http://o").deleteIntent(deleteProof);
        expect(http.url()).toContain("/deleteIntent");

        http = stubFetch({ signedProof: "s" });
        await new RestEmulatorProvider("http://e").submitIntent(signedProof);
        expect(http.url()).toContain("/v1/intent");
    });

    it("aliases the wallet's repository property", () => {
        const wallet = Object.create(ReadonlyWallet.prototype) as ReadonlyWallet;
        const repository = new InMemoryBatchRegistrationRepository();
        wallet.intentRepository = repository;
        expect(wallet.batchRegistrationRepository).toBe(repository);
        expect(wallet.intentRepository).toBe(repository);
    });

    it("aliases the wallet's proof methods", async () => {
        const wallet = Object.create(Wallet.prototype) as Wallet;
        const signed = { proof: "p", message: registerMessage };
        wallet.safeRegisterProof = vi.fn().mockResolvedValue("r");
        wallet.makeRegisterProof = vi.fn().mockResolvedValue(signed);
        wallet.makeDeleteProof = vi.fn().mockResolvedValue(signed);
        wallet.makeGetPendingTxProof = vi.fn().mockResolvedValue(signed);
        expect(await wallet.safeRegisterIntent(signed, [])).toBe("r");
        expect(await wallet.makeRegisterIntentSignature([], [], [], [])).toBe(signed);
        expect(await wallet.makeDeleteIntentSignature([])).toBe(signed);
        expect(await wallet.makeGetPendingTxIntentSignature([])).toBe(signed);
    });

    it("aliases the asset input type", () => {
        expect(AssetInputType.Intent).toBe(AssetInputType.Proof);
        expect(AssetInputType[2]).toBe("Proof");
        const txid = "ab".repeat(32);
        expect(AssetInput.createIntent(txid, 0, 1).toString()).toBe(
            AssetInput.createProof(txid, 0, 1).toString(),
        );
    });

    it("reads fees from either key, preferring batchFee", () => {
        const old: IntentFeeConfig = { offchainInput: "1.0" };
        expect(batchFeeConfig({ intentFee: old })).toBe(old);
        expect(batchFeeConfig({ batchFee: {}, intentFee: old })).toEqual({});
        expect(batchFeeConfig(undefined)).toEqual({});
    });
});

describe("data written before the rename still loads", () => {
    const snapshot = (fees: unknown) => ({
        version: 1,
        savedAt: 1,
        source: "arkade.getInfo",
        arkInfo: {
            network: "regtest",
            signerPubkey: "s",
            checkpointTapscript: "c",
            forfeitAddress: "f",
            forfeitPubkey: "p",
            digest: "d",
            version: "v",
            unilateralExitDelay: "1",
            boardingExitDelay: "1",
            sessionDuration: "1",
            dust: "1",
            vtxoMinAmount: "1",
            vtxoMaxAmount: "1",
            utxoMinAmount: "1",
            utxoMaxAmount: "1",
            deprecatedSigners: [],
            fees,
        },
    });

    it("fills batchFee on an old server-info snapshot", () => {
        const intentFee = { offchainInput: "1.0" };
        const parsed = parseStoredArkInfoSnapshot(snapshot({ intentFee, txFeeRate: "1" }));
        expect(hydrateArkInfo(parsed).fees).toMatchObject({ batchFee: intentFee, intentFee });
    });

    it("keeps intentFee on a new snapshot, so an older SDK can still read it", () => {
        const batchFee = { offchainInput: "1.0" };
        const parsed = parseStoredArkInfoSnapshot(snapshot({ batchFee, txFeeRate: "1" }));
        expect(hydrateArkInfo(parsed).fees.intentFee).toEqual(batchFee);
    });

    it("still rejects a snapshot with neither fee key", () => {
        expect(() => parseStoredArkInfoSnapshot(snapshot({ txFeeRate: "1" }))).toThrow(
            MalformedArkInfoSnapshotError,
        );
    });

    it("reads an IndexedDB record stored under the old keys, and writes the same keys", async () => {
        const name = "pre-rename-records";
        const db = await openDatabase(name, BATCHES_DB_VERSION, initBatchesDatabase);
        const { proofTxId, registrationId, inputs, ...rest } = registration;
        const stored = {
            ...rest,
            intentTxId: proofTxId,
            intentId: registrationId,
            intentVtxos: inputs,
        };
        const store = (mode: IDBTransactionMode) =>
            db
                .transaction([STORE_BATCH_REGISTRATIONS], mode)
                .objectStore(STORE_BATCH_REGISTRATIONS);
        await new Promise((resolve, reject) => {
            const put = store("readwrite").put(stored);
            put.onsuccess = resolve;
            put.onerror = reject;
        });

        const repository = new IndexedDBBatchRegistrationRepository(name);
        expect(await collectBatchRegistrations(repository)).toEqual([registration]);
        expect(await repository.getLockedVtxoOutpoints()).toEqual(inputs);

        await repository.saveRegistration({ ...registration, proofTxId: "b", registrationId: "s" });
        const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const get = store("readonly").get("b");
            get.onsuccess = () => resolve(get.result);
            get.onerror = reject;
        });
        expect(raw).toMatchObject({ intentTxId: "b", intentId: "s", intentVtxos: inputs });
        expect(raw).not.toHaveProperty("proofTxId");
        await closeDatabase(name);
    });

    it("keeps the SQLite table and column names", async () => {
        const db = createNodeSQLExecutor();
        await new SQLiteBatchRegistrationRepository(db).saveRegistration(registration);
        expect(await db.all("SELECT intent_tx_id, intent_id FROM ark_intents")).toEqual([
            { intent_tx_id: "a", intent_id: "r" },
        ]);
    });
});
