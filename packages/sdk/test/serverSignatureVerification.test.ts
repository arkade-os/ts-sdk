/**
 * `submitOffchainTx`'s opt-in server-signature check, driven through
 * `signAndSubmitOffchainTx` with real keys and real signatures.
 *
 * What it proves and what it does not: the server co-signed THIS transaction,
 * on the leaf we are spending. It says nothing about condition values (a
 * preimage has already reached the server by then) — it turns a silent
 * "submitted, never landed" into an immediate failure.
 */
import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Transaction } from "../src/utils/transaction";
import { SingleKey } from "../src/identity/singleKey";
import { VtxoScript } from "../src/script/base";
import { CSVMultisigTapscript, MultisigTapscript } from "../src/script/tapscript";
import { signAndSubmitOffchainTx, type ArkTxInput } from "../src/utils/arkTransaction";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));

const USER = SingleKey.fromPrivateKey(priv(11));
const SERVER = SingleKey.fromPrivateKey(priv(3));
const SERVER_PUBKEY = key(3);
const P2TR = Uint8Array.from([0x51, 0x20, ...key(21)]);

/** Two collaborative leaves the server is on: the spend uses the first, and
 * the second is what a leaf-substituting server would sign instead. */
const spendLeaf = MultisigTapscript.encode({ pubkeys: [key(11), SERVER_PUBKEY] }).script;
const otherLeaf = MultisigTapscript.encode({ pubkeys: [key(12), SERVER_PUBKEY] }).script;
const vtxoScript = new VtxoScript([spendLeaf, otherLeaf]);

const SERVER_UNROLL = CSVMultisigTapscript.encode({
    timelock: { type: "blocks", value: 144n },
    pubkeys: [SERVER_PUBKEY],
});

const inputs = (): ArkTxInput[] => [
    {
        txid: "11".repeat(32),
        vout: 0,
        value: 10_000,
        tapLeafScript: vtxoScript.findLeaf(hex.encode(spendLeaf)),
        tapTree: vtxoScript.encode(),
    },
];

const cosign = async (psbt: string): Promise<string> =>
    base64.encode((await SERVER.sign(Transaction.fromPSBT(base64.decode(psbt)))).toPSBT());

/** Sign the checkpoint after swapping its spend leaf for the other one: same
 * txid (PSBT fields are not committed to), signature over the wrong leaf. */
const cosignOtherLeaf = async (psbt: string): Promise<string> => {
    const tx = Transaction.fromPSBT(base64.decode(psbt));
    tx.updateInput(0, { tapLeafScript: [vtxoScript.findLeaf(hex.encode(otherLeaf))] });
    return base64.encode((await SERVER.sign(tx)).toPSBT());
};

const provider = (
    over: {
        cosignArkTx?: (psbt: string) => Promise<string>;
        cosignCheckpoint?: (psbt: string) => Promise<string>;
        dropFinalArkTx?: boolean;
    } = {},
) => ({
    submitTx: vi.fn(async (arkTx: string, checkpoints: string[]) => ({
        arkTxid: Transaction.fromPSBT(base64.decode(arkTx)).id,
        finalArkTx: over.dropFinalArkTx ? undefined : await (over.cosignArkTx ?? cosign)(arkTx),
        signedCheckpointTxs: await Promise.all(checkpoints.map(over.cosignCheckpoint ?? cosign)),
    })),
    finalizeTx: vi.fn(async () => {}),
});

const submit = (
    p: ReturnType<typeof provider>,
    verifyServerSignatures?: { serverPubkey: Uint8Array },
) =>
    signAndSubmitOffchainTx({
        identity: USER,
        provider: p,
        inputs: inputs(),
        outputs: [{ script: P2TR, amount: 9_000n }],
        serverUnrollScript: SERVER_UNROLL,
        verifyServerSignatures,
    });

describe("signAndSubmitOffchainTx server-signature verification", () => {
    it("finalizes when the server signed the ark tx and every checkpoint", async () => {
        const p = provider();
        const arkTxid = await submit(p, { serverPubkey: SERVER_PUBKEY });
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
        const submittedArkTx = p.submitTx.mock.calls[0][0];
        expect(arkTxid).toBe(Transaction.fromPSBT(base64.decode(submittedArkTx)).id);
    });

    it("accepts a compressed server key, not only an x-only one", async () => {
        const p = provider();
        await submit(p, { serverPubkey: Uint8Array.from([0x02, ...SERVER_PUBKEY]) });
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
    });

    it("rejects a response the server never signed, before finalizing", async () => {
        const p = provider({ cosignArkTx: async (psbt) => psbt });
        await expect(submit(p, { serverPubkey: SERVER_PUBKEY })).rejects.toThrow(
            /ark tx: input 0 is not signed by the server/,
        );
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    // Same txid, signature over another leaf of the same contract: the expected
    // leaf comes from the LOCAL build, so the substitution has nothing to hide
    // behind.
    it("rejects a checkpoint signed on a leaf other than the one being spent", async () => {
        const p = provider({ cosignCheckpoint: cosignOtherLeaf });
        await expect(submit(p, { serverPubkey: SERVER_PUBKEY })).rejects.toThrow(
            /checkpoint 0: input 0 is not signed by the server on the leaf being spent/,
        );
        expect(p.finalizeTx).not.toHaveBeenCalled();
    });

    it("fails closed when the response carries no final ark tx — but only when asked to verify", async () => {
        await expect(
            submit(provider({ dropFinalArkTx: true }), { serverPubkey: SERVER_PUBKEY }),
        ).rejects.toThrow(/no final ark tx to verify/);

        // The same response with verification omitted is the pre-existing path.
        const p = provider({ dropFinalArkTx: true });
        await submit(p);
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
    });

    it("leaves an unsigned-by-the-server response untouched when verification is omitted", async () => {
        const p = provider({ cosignArkTx: async (psbt) => psbt, cosignCheckpoint: async (c) => c });
        await submit(p);
        expect(p.finalizeTx).toHaveBeenCalledTimes(1);
    });
});
