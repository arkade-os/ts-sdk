import { describe, it, expect, vi, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

// The handler must delegate graph/recipient validation to the shared
// validators; mock both so the test drives only the wiring.
vi.mock("../src/tree/validation", () => ({
    validateVtxoTxGraph: vi.fn(),
    validateConnectorsTxGraph: vi.fn(),
}));
vi.mock("../src/wallet/validation", () => ({
    validateBatchRecipients: vi.fn(),
}));

import { createArkadeBatchHandler } from "../src/arkade/batch";
import { validateBatchRecipients } from "../src/wallet/validation";
import { validateVtxoTxGraph } from "../src/tree/validation";
import { Transaction } from "../src/utils/transaction";
import { networks } from "../src/networks";
import type { Recipient } from "../src/wallet";
import type { SignerSession } from "../src/tree/signingSession";
import type { ArkProvider, BatchStartedEvent, TreeSigningStartedEvent } from "../src/providers/ark";
import type { EmulatorProvider } from "../src/providers/emulator";
import type { Identity } from "../src/identity";
import type { Intent } from "../src/intent";
import type { TxTree } from "../src/tree/txTree";

const SIGNER_XONLY = "11".repeat(32);
const INTENT_ID = "intent-123";

function makeSession() {
    return {
        getPublicKey: vi.fn(async () => hex.decode("02" + SIGNER_XONLY)),
        init: vi.fn(async () => {}),
        getNonces: vi.fn(async () => ({}) as never),
        aggregatedNonces: vi.fn(),
        sign: vi.fn(),
    } as unknown as SignerSession;
}

function makeArkProvider() {
    return {
        confirmRegistration: vi.fn(async () => {}),
        getInfo: vi.fn(async () => ({ forfeitPubkey: "02" + "22".repeat(32) })),
        submitTreeNonces: vi.fn(async () => {}),
        submitTreeSignatures: vi.fn(async () => {}),
        submitSignedForfeitTxs: vi.fn(async () => {}),
    } as unknown as ArkProvider;
}

function makeEvents() {
    const commitmentTx = new Transaction({ allowUnknownOutputs: true });
    commitmentTx.addOutput({ script: new Uint8Array([0x51]), amount: 5000n });

    const batchStarted = {
        id: "batch-1",
        intentIdHashes: [hex.encode(sha256(new TextEncoder().encode(INTENT_ID)))],
        batchExpiry: 100n,
    } as unknown as BatchStartedEvent;

    const treeSigningStarted = {
        id: "batch-1",
        cosignersPublicKeys: ["02" + SIGNER_XONLY],
        unsignedCommitmentTx: base64.encode(commitmentTx.toPSBT()),
    } as unknown as TreeSigningStartedEvent;

    const vtxoTree = { leaves: () => [] } as unknown as TxTree;

    return { batchStarted, treeSigningStarted, vtxoTree };
}

function makeHandler(session: SignerSession, arkProvider: ArkProvider, recipients?: Recipient[]) {
    return createArkadeBatchHandler(
        INTENT_ID,
        [],
        {} as unknown as Identity,
        "signed-proof",
        {} as unknown as Intent.RegisterMessage,
        session,
        arkProvider,
        {} as unknown as EmulatorProvider,
        networks.regtest,
        recipients,
    );
}

describe("createArkadeBatchHandler recipient validation", () => {
    beforeEach(() => {
        vi.mocked(validateBatchRecipients).mockReset();
        vi.mocked(validateVtxoTxGraph).mockReset();
    });

    it("validates expected recipients against the vtxo tree before signing", async () => {
        const session = makeSession();
        const recipients: Recipient[] = [{ address: "ark1qexample", amount: 1000 }];
        const handler = makeHandler(session, makeArkProvider(), recipients);
        const { batchStarted, treeSigningStarted, vtxoTree } = makeEvents();

        await handler.onBatchStarted(batchStarted);
        const { skip } = await handler.onTreeSigningStarted(treeSigningStarted, vtxoTree);

        expect(skip).toBe(false);
        expect(validateVtxoTxGraph).toHaveBeenCalledTimes(1);
        expect(validateBatchRecipients).toHaveBeenCalledTimes(1);
        const [txArg, leavesArg, recipientsArg, networkArg] =
            vi.mocked(validateBatchRecipients).mock.calls[0];
        expect(txArg.getOutput(0)?.amount).toBe(5000n);
        expect(leavesArg).toEqual([]);
        expect(recipientsArg).toBe(recipients);
        expect(networkArg).toBe(networks.regtest);
    });

    it("aborts signing when a recipient is missing from the tree", async () => {
        const session = makeSession();
        vi.mocked(validateBatchRecipients).mockImplementation(() => {
            throw new Error("offchain send output not found: ark1qexample");
        });
        const handler = makeHandler(session, makeArkProvider(), [
            { address: "ark1qexample", amount: 1000 },
        ]);
        const { batchStarted, treeSigningStarted, vtxoTree } = makeEvents();

        await handler.onBatchStarted(batchStarted);
        await expect(handler.onTreeSigningStarted(treeSigningStarted, vtxoTree)).rejects.toThrow(
            /output not found/,
        );
        expect(session.init).not.toHaveBeenCalled();
    });

    it("skips recipient validation when none are provided (compat)", async () => {
        const session = makeSession();
        const handler = makeHandler(session, makeArkProvider());
        const { batchStarted, treeSigningStarted, vtxoTree } = makeEvents();

        await handler.onBatchStarted(batchStarted);
        const { skip } = await handler.onTreeSigningStarted(treeSigningStarted, vtxoTree);

        expect(skip).toBe(false);
        expect(validateBatchRecipients).not.toHaveBeenCalled();
    });
});
