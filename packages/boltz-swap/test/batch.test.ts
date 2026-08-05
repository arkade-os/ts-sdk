import { describe, it, expect, vi, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

// Graph validation is delegated to the shared validators; mock both so the
// tests drive the handler's wiring. Recipient validation and the
// commitment-equality assertion stay real: they are under test below.
vi.mock("@arkade-os/sdk", async (importActual) => ({
    ...(await importActual<typeof import("@arkade-os/sdk")>()),
    validateVtxoTxGraph: vi.fn(),
    validateConnectorsTxGraph: vi.fn(),
}));

import {
    ArkAddress,
    SingleKey,
    Transaction,
    networks,
    validateVtxoTxGraph,
    type ArkProvider,
    type ArkTxInput,
    type BatchStartedEvent,
    type Identity,
    type Recipient,
    type SignerSession,
    type TreeSigningStartedEvent,
    type TxTree,
} from "@arkade-os/sdk";
import { createVHTLCBatchHandler } from "../src/batch";
import { createVHTLCScript } from "../src/utils/vhtlc";

const INTENT_ID = "intent-123";
const SIGNER_XONLY = "11".repeat(32);
const P2TR = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)]);

const ourKey = SingleKey.fromHex("11".repeat(32));
const boltzKey = SingleKey.fromHex("22".repeat(32));
const serverKey = SingleKey.fromHex("33".repeat(32));

async function makeVhtlcInput(): Promise<ArkTxInput> {
    const [ours, boltz, server] = await Promise.all([
        ourKey.xOnlyPublicKey(),
        boltzKey.xOnlyPublicKey(),
        serverKey.xOnlyPublicKey(),
    ]);
    const { vhtlcScript } = createVHTLCScript({
        network: "regtest",
        preimageHash: sha256(new Uint8Array(32).fill(7)),
        receiverPubkey: hex.encode(ours),
        senderPubkey: hex.encode(boltz),
        serverPubkey: hex.encode(server),
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 10,
            unilateralRefund: 20,
            unilateralRefundWithoutReceiver: 30,
        },
    });
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 10_000,
        tapLeafScript: vhtlcScript.claim(),
        tapTree: vhtlcScript.encode(),
    };
}

const RECIPIENT_ADDRESS = new ArkAddress(
    hex.decode("33".repeat(32)),
    hex.decode("aa".repeat(32)),
    "tark",
).encode();
const RECIPIENT: Recipient = { address: RECIPIENT_ADDRESS, amount: 10_000 };

function makeSession(): SignerSession {
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
        submitTreeNonces: vi.fn(async () => {}),
        submitTreeSignatures: vi.fn(async () => {}),
        submitSignedForfeitTxs: vi.fn(async () => {}),
    } as unknown as ArkProvider;
}

const identityStub = { sign: vi.fn(async (tx: Transaction) => tx) } as unknown as Identity;

/** A commitment tx PSBT; `amount` makes distinct fixtures distinguishable. */
function commitment(amount: bigint): string {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addOutput({ script: new Uint8Array([0x51]), amount });
    return base64.encode(tx.toPSBT());
}

/** A vtxo tree whose single leaf pays `amount` to the recipient address. */
function treeWithLeafPaying(amount: bigint): TxTree {
    const leaf = new Transaction({ allowUnknownOutputs: true });
    leaf.addOutput({ script: ArkAddress.decode(RECIPIENT_ADDRESS).pkScript, amount });
    return { leaves: () => [leaf] } as unknown as TxTree;
}

function connectorTreeWithLeaf(): TxTree {
    const connector = new Transaction({ allowUnknownOutputs: true });
    connector.addOutput({ script: P2TR, amount: 1000n });
    return { leaves: () => [connector] } as unknown as TxTree;
}

const batchStarted = {
    id: "batch-1",
    intentIdHashes: [hex.encode(sha256(new TextEncoder().encode(INTENT_ID)))],
    batchExpiry: 100n,
} as unknown as BatchStartedEvent;

function treeSigningStarted(commitmentTx: string): TreeSigningStartedEvent {
    return {
        id: "batch-1",
        cosignersPublicKeys: ["02" + SIGNER_XONLY],
        unsignedCommitmentTx: commitmentTx,
    } as unknown as TreeSigningStartedEvent;
}

async function makeHandler(opts?: { recipient?: Recipient; recoverable?: boolean }) {
    const arkProvider = makeArkProvider();
    const handler = createVHTLCBatchHandler(
        INTENT_ID,
        await makeVhtlcInput(),
        arkProvider,
        identityStub,
        makeSession(),
        hex.decode("44".repeat(32)),
        networks.regtest,
        opts?.recipient,
        opts?.recoverable ? undefined : P2TR,
    );
    return { handler, arkProvider };
}

beforeEach(() => {
    vi.mocked(validateVtxoTxGraph).mockReset();
});

describe("createVHTLCBatchHandler commitment tx pinning", () => {
    it("rejects a finalization commitment tx that differs from the validated one", async () => {
        const { handler, arkProvider } = await makeHandler();

        await handler.onBatchStarted(batchStarted);
        await handler.onTreeSigningStarted(
            treeSigningStarted(commitment(5000n)),
            treeWithLeafPaying(10_000n),
        );

        await expect(
            handler.onBatchFinalization(
                { commitmentTx: commitment(9999n) } as never,
                undefined,
                connectorTreeWithLeaf(),
            ),
        ).rejects.toThrow(/finalization commitment tx .* differs from the validated commitment tx/);
        expect(arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("rejects forfeit finalization when the tree signing step never ran", async () => {
        const { handler, arkProvider } = await makeHandler();

        await handler.onBatchStarted(batchStarted);

        await expect(
            handler.onBatchFinalization(
                { commitmentTx: commitment(5000n) } as never,
                undefined,
                connectorTreeWithLeaf(),
            ),
        ).rejects.toThrow(/commitment tx was not validated at tree signing/);
        expect(arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });

    it("submits the forfeit when the finalization commitment tx matches", async () => {
        const { handler, arkProvider } = await makeHandler();

        await handler.onBatchStarted(batchStarted);
        await handler.onTreeSigningStarted(
            treeSigningStarted(commitment(5000n)),
            treeWithLeafPaying(10_000n),
        );
        await handler.onBatchFinalization(
            { commitmentTx: commitment(5000n) } as never,
            undefined,
            connectorTreeWithLeaf(),
        );

        expect(arkProvider.submitSignedForfeitTxs).toHaveBeenCalledTimes(1);
    });

    it("still skips finalization for a recoverable input", async () => {
        const { handler, arkProvider } = await makeHandler({ recoverable: true });

        await handler.onBatchStarted(batchStarted);
        await handler.onBatchFinalization(
            { commitmentTx: commitment(5000n) } as never,
            undefined,
            connectorTreeWithLeaf(),
        );

        expect(arkProvider.submitSignedForfeitTxs).not.toHaveBeenCalled();
    });
});

describe("createVHTLCBatchHandler recipient validation", () => {
    it("validates the recipient against the vtxo tree leaves before submitting nonces", async () => {
        const { handler, arkProvider } = await makeHandler({ recipient: RECIPIENT });

        await handler.onBatchStarted(batchStarted);
        const { skip } = await handler.onTreeSigningStarted(
            treeSigningStarted(commitment(5000n)),
            treeWithLeafPaying(10_000n),
        );

        expect(skip).toBe(false);
        expect(validateVtxoTxGraph).toHaveBeenCalledTimes(1);
        expect(arkProvider.submitTreeNonces).toHaveBeenCalledTimes(1);
    });

    it("aborts tree signing when no leaf pays the recipient", async () => {
        const { handler, arkProvider } = await makeHandler({ recipient: RECIPIENT });

        await handler.onBatchStarted(batchStarted);
        await expect(
            handler.onTreeSigningStarted(
                treeSigningStarted(commitment(5000n)),
                treeWithLeafPaying(9000n),
            ),
        ).rejects.toThrow(/offchain send output not found/);
        expect(arkProvider.submitTreeNonces).not.toHaveBeenCalled();
    });
});
