import { base64, hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { SigHash } from "@scure/btc-signer";
import * as musig from "@scure/btc-signer/musig2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vitest";
import { ChainTx, ChainTxType } from "../../src/providers/indexer";
import { aggregateKeys } from "../../src/musig2";
import { CSVMultisigTapscript } from "../../src/script/tapscript";
import { Transaction } from "../../src/utils/transaction";
import { CosignerPublicKey, setArkPsbtField, VtxoTreeExpiry } from "../../src/utils/unknownFields";
import type { VirtualCoin } from "../../src/wallet";
import {
    verifyVtxo,
    VtxoChainSource,
    VtxoProofSource,
    VtxoVerificationServerInfo,
} from "../../src/verification";

const SECRET_KEY = new Uint8Array(32).fill(7);
const COSIGNER_KEY = secp256k1.getPublicKey(SECRET_KEY);
const SERVER: VtxoVerificationServerInfo = {
    forfeitPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(8)),
};
const SWEEP_INTERVAL = { type: "blocks" as const, value: 144n };
const SWEEP_SCRIPT = CSVMultisigTapscript.encode({
    timelock: SWEEP_INTERVAL,
    pubkeys: [SERVER.forfeitPubkey],
}).script;
const SWEEP_ROOT = tapLeafHash(SWEEP_SCRIPT);
const OUTPUT_KEY = aggregateKeys([COSIGNER_KEY], true, {
    taprootTweak: SWEEP_ROOT,
}).finalKey.subarray(1);
const SCRIPT = Uint8Array.from([0x51, 0x20, ...OUTPUT_KEY]);

function fixture(tipHeight = 105) {
    const commitment = new Transaction({
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
    });
    commitment.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
    commitment.addOutput({ amount: 10_000n, script: SCRIPT });

    const tree = new Transaction({ allowLegacyWitnessUtxo: true });
    tree.addInput({
        txid: hex.decode(commitment.id),
        index: 0,
    });
    setArkPsbtField(tree, 0, CosignerPublicKey, {
        index: 0,
        key: COSIGNER_KEY,
    });
    setArkPsbtField(tree, 0, VtxoTreeExpiry, SWEEP_INTERVAL);
    tree.addOutput({ amount: 10_000n, script: SCRIPT });
    const message = tree.preimageWitnessV1(0, [SCRIPT], SigHash.DEFAULT, [10_000n]);
    const preTweakedKey = aggregateKeys([COSIGNER_KEY], true).preTweakedKey;
    const tweak = schnorr.utils.taggedHash("TapTweak", preTweakedKey.subarray(1), SWEEP_ROOT);
    const nonces = musig.nonceGen(COSIGNER_KEY);
    const session = new musig.Session(
        musig.nonceAggregate([nonces.public]),
        [COSIGNER_KEY],
        message,
        [tweak],
        [true],
    );
    const partialSignature = session.sign(nonces.secret, SECRET_KEY);
    tree.updateInput(0, { tapKeySig: session.partialSigAgg([partialSignature]) });

    const chain: ChainTx[] = [
        {
            txid: commitment.id,
            expiresAt: "0",
            type: ChainTxType.COMMITMENT,
            spends: [],
        },
        {
            txid: tree.id,
            expiresAt: "0",
            type: ChainTxType.TREE,
            spends: [commitment.id],
        },
    ];
    const proofSource: VtxoProofSource = {
        getVtxoChain: async () => chain,
        getVirtualTxs: async () => [base64.encode(tree.toPSBT())],
    };
    const chainSource: VtxoChainSource = {
        getTxHex: async () => commitment.hex,
        getTxStatus: async () => ({ confirmed: true, blockHeight: 100, blockTime: 1 }),
        getChainTip: async () => ({ height: tipHeight, time: 2, hash: "00".repeat(32) }),
        getTxOutspends: async () => [{ spent: false }],
    };
    const vtxo: VirtualCoin = {
        txid: tree.id,
        vout: 0,
        value: 10_000,
        script: hex.encode(SCRIPT),
        createdAt: new Date(0),
        isUnrolled: false,
        isPreconfirmed: false,
        status: { confirmed: false },
    };
    return { vtxo, proofSource, chainSource, commitment };
}

describe("verifyVtxo", () => {
    it("returns confirmed only after every phase passes", async () => {
        const { vtxo, proofSource, chainSource, commitment } = fixture();
        const result = await verifyVtxo(vtxo, proofSource, chainSource, SERVER);

        expect(result).toMatchObject({
            status: "confirmed",
            confirmationDepth: 6,
            commitmentTxids: [commitment.id],
            issues: [],
        });
    });

    it("returns preconfirmed without claiming an onchain anchor", async () => {
        const { vtxo, proofSource, chainSource } = fixture();
        const result = await verifyVtxo(
            { ...vtxo, isPreconfirmed: true },
            proofSource,
            chainSource,
            SERVER,
        );

        expect(result.status).toBe("preconfirmed");
    });

    it("returns invalid for a forged claimed amount", async () => {
        const { vtxo, proofSource, chainSource } = fixture();
        const result = await verifyVtxo(
            { ...vtxo, value: 10_001 },
            proofSource,
            chainSource,
            SERVER,
        );

        expect(result.status).toBe("invalid");
        expect(result.issues[0].code).toBe("leaf_amount_mismatch");
    });

    it("returns unavailable when the proof source withholds ancestry", async () => {
        const { vtxo, proofSource, chainSource } = fixture();
        proofSource.getVtxoChain = async () => {
            throw new Error("offline");
        };
        const result = await verifyVtxo(vtxo, proofSource, chainSource, SERVER);

        expect(result.status).toBe("unavailable");
        expect(result.issues[0].code).toBe("proof_chain_unavailable");
    });

    it("defaults to six confirmations and permits an explicit lower threshold", async () => {
        const { vtxo, proofSource, chainSource } = fixture(104);
        expect((await verifyVtxo(vtxo, proofSource, chainSource, SERVER)).status).toBe("invalid");
        expect(
            (
                await verifyVtxo(vtxo, proofSource, chainSource, SERVER, {
                    minConfirmationDepth: 5,
                })
            ).status,
        ).toBe("confirmed");
    });
});
