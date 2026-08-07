import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import {
    buildOffchainTx,
    CSVMultisigTapscript,
    SingleKey,
    Transaction,
    type ArkInfo,
    type ArkProvider,
    type ArkTxInput,
} from "@arkade-os/sdk";
import { claimVHTLCwithOffchainTx, createVHTLCScript } from "../src/utils/vhtlc";

// The claim path co-signs a checkpoint arkd returns. The signature check
// confirms who signed it; the txid match confirms it is the checkpoint that was
// submitted, which is what the ark tx signed alongside it spends.

const ourKey = SingleKey.fromHex("11".repeat(32));
const boltzKey = SingleKey.fromHex("22".repeat(32));
const serverKey = SingleKey.fromHex("33".repeat(32));
const foreignKey = SingleKey.fromHex("44".repeat(32));

const P2TR = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)]);
const VALUE = 10_000;

async function unrollScript(key: SingleKey) {
    return CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 10n },
        pubkeys: [await key.xOnlyPublicKey()],
    });
}

async function fixture() {
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

    const input: ArkTxInput = {
        txid: "11".repeat(32),
        vout: 0,
        value: VALUE,
        tapLeafScript: vhtlcScript.claim(),
        tapTree: vhtlcScript.encode(),
    };
    const output = { script: P2TR, amount: BigInt(VALUE) };
    const arkInfo = {
        checkpointTapscript: hex.encode((await unrollScript(serverKey)).script),
        forfeitPubkey: hex.encode(server),
        network: "regtest",
    } as ArkInfo;

    return { vhtlcScript, server, input, output, arkInfo };
}

/**
 * A well-formed, correctly signed checkpoint for the same VTXO that is not the
 * one submitted — it is locked to a different server key, so it has a different
 * txid. Signed on the same claim leaf, so it satisfies the signature check and
 * only the txid tells it apart.
 */
async function divergentCheckpoint(input: ArkTxInput): Promise<string> {
    const { checkpoints } = buildOffchainTx(
        [input],
        [{ script: P2TR, amount: BigInt(VALUE) }],
        await unrollScript(foreignKey),
    );
    const signed = await serverKey.sign(checkpoints[0], [0]);
    return base64.encode(signed.toPSBT());
}

/**
 * arkd as the claim path expects it: co-signs the ark tx (so the pre-checkpoint
 * signature check passes), echoes the submitted tx's id as `arkTxid` unless
 * `overrideArkTxid` fakes a misrouted response, and answers with
 * `checkpointResponse`.
 */
function arkProviderStub(
    checkpointResponse: (submitted: string[]) => Promise<string[]>,
    overrideArkTxid?: string,
) {
    return {
        submitTx: vi.fn(async (arkTxB64: string, checkpointsB64: string[]) => {
            const submitted = Transaction.fromPSBT(base64.decode(arkTxB64));
            const signedArk = await serverKey.sign(submitted);
            return {
                arkTxid: overrideArkTxid ?? submitted.id,
                finalArkTx: base64.encode(signedArk.toPSBT()),
                signedCheckpointTxs: await checkpointResponse(checkpointsB64),
            };
        }),
        finalizeTx: vi.fn(async () => {}),
    } as unknown as ArkProvider & {
        submitTx: ReturnType<typeof vi.fn>;
        finalizeTx: ReturnType<typeof vi.fn>;
    };
}

const serverSigned = async (checkpointsB64: string[]) =>
    Promise.all(
        checkpointsB64.map(async (c) =>
            base64.encode(
                (await serverKey.sign(Transaction.fromPSBT(base64.decode(c)), [0])).toPSBT(),
            ),
        ),
    );

describe("claimVHTLCwithOffchainTx checkpoint reconciliation", () => {
    it("claims when arkd returns the checkpoint that was submitted", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const arkProvider = arkProviderStub(serverSigned);

        const arkTxid = await claimVHTLCwithOffchainTx(
            ourKey,
            vhtlcScript,
            server,
            [input],
            output,
            arkInfo,
            arkProvider,
        );

        const submittedId = Transaction.fromPSBT(
            base64.decode(arkProvider.submitTx.mock.calls[0][0] as string),
        ).id;
        expect(arkTxid).toBe(submittedId);
        expect(arkProvider.finalizeTx).toHaveBeenCalledTimes(1);
    });

    it("claims two VTXOs at the script in one offchain tx", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const input2: ArkTxInput = { ...input, txid: "22".repeat(32), vout: 1 };
        const arkProvider = arkProviderStub(serverSigned);

        const arkTxid = await claimVHTLCwithOffchainTx(
            ourKey,
            vhtlcScript,
            server,
            [input, input2],
            { ...output, amount: BigInt(VALUE * 2) },
            arkInfo,
            arkProvider,
        );

        const [submittedArkB64, submittedCheckpoints] = arkProvider.submitTx.mock.calls[0] as [
            string,
            string[],
        ];
        expect(submittedCheckpoints).toHaveLength(2);
        expect(arkTxid).toBe(Transaction.fromPSBT(base64.decode(submittedArkB64)).id);
        const finalized = arkProvider.finalizeTx.mock.calls[0][1] as string[];
        expect(finalized).toHaveLength(2);
    });

    it("rejects a response whose arkTxid is not the submitted tx", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const arkProvider = arkProviderStub(serverSigned, "cd".repeat(32));

        await expect(
            claimVHTLCwithOffchainTx(
                ourKey,
                vhtlcScript,
                server,
                [input],
                output,
                arkInfo,
                arkProvider,
            ),
        ).rejects.toThrow(/submitTx returned ark txid/);
        expect(arkProvider.finalizeTx).not.toHaveBeenCalled();
    });

    it("does not co-sign a checkpoint it did not submit", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const arkProvider = arkProviderStub(async () => [await divergentCheckpoint(input)]);

        await expect(
            claimVHTLCwithOffchainTx(
                ourKey,
                vhtlcScript,
                server,
                [input],
                output,
                arkInfo,
                arkProvider,
            ),
        ).rejects.toThrow(/does not match any submitted checkpoint/);
        expect(arkProvider.finalizeTx).not.toHaveBeenCalled();
    });
});

describe("claimVHTLCwithOffchainTx checkpoint exit delay validation [P720-2]", () => {
    it("rejects a sub-floor checkpointTapscript before submitting anything", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const arkProvider = arkProviderStub(serverSigned);
        const oneBlockCheckpoint = hex.encode(
            CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 1n },
                pubkeys: [server],
            }).script,
        );

        await expect(
            claimVHTLCwithOffchainTx(
                ourKey,
                vhtlcScript,
                server,
                [input],
                output,
                { ...arkInfo, checkpointTapscript: oneBlockCheckpoint },
                arkProvider,
            ),
        ).rejects.toThrow(/checkpoint exit delay rejected/);
        expect(arkProvider.submitTx).not.toHaveBeenCalled();
    });

    it("rejects a checkpointTapscript pinned to a pubkey other than forfeitPubkey", async () => {
        const { vhtlcScript, server, input, output, arkInfo } = await fixture();
        const arkProvider = arkProviderStub(serverSigned);
        const wrongPubkeyCheckpoint = hex.encode((await unrollScript(foreignKey)).script);

        await expect(
            claimVHTLCwithOffchainTx(
                ourKey,
                vhtlcScript,
                server,
                [input],
                output,
                { ...arkInfo, checkpointTapscript: wrongPubkeyCheckpoint },
                arkProvider,
            ),
        ).rejects.toThrow(/do not match the advertised forfeitPubkey/);
        expect(arkProvider.submitTx).not.toHaveBeenCalled();
    });
});
