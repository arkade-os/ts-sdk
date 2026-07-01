/**
 * Swap transaction utilities ported from boltz-core.
 * Builds on @scure/btc-signer and @noble/curves directly.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { Script, ScriptNum, Transaction } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { compareBytes, equalBytes } from "@scure/btc-signer/utils.js";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import type { MusigKeyAgg } from "./musig";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TapLeaf = { output: Uint8Array; version: number };
export type TapTree = [TapTree | TapLeaf, TapTree | TapLeaf] | TapLeaf;
export type SwapTree = {
    tree: TapTree;
    claimLeaf: TapLeaf;
    refundLeaf: TapLeaf;
};

type SerializedLeaf = { version: number; output: string };
type SerializedTree = {
    claimLeaf: SerializedLeaf;
    refundLeaf: SerializedLeaf;
};

export type DetectedSwapOutput = TransactionOutput & { vout: number };

// ---------------------------------------------------------------------------
// Swap tree serialization
// ---------------------------------------------------------------------------

const deserializeLeaf = (leaf: SerializedLeaf): TapLeaf => ({
    version: leaf.version,
    output: hex.decode(leaf.output),
});

type WeightedNode = { probability: number; value: TapLeaf };

const sortTree = (nodes: WeightedNode[]): TapTree => {
    const sorted = [...nodes].sort((a, b) => b.probability - a.probability);
    const sub = (items: WeightedNode[]): TapTree => {
        if (items.length === 1) return items[0].value;
        if (items.length === 2) return [items[0].value, items[1].value];
        const sum = items.reduce((s, n) => s + n.probability, 0);
        let mid = 0;
        let midSum = 0;
        while (midSum < sum / 2) {
            midSum += items[mid].probability;
            mid++;
        }
        return [sub(items.slice(0, mid)), sub(items.slice(mid))];
    };
    return sub(sorted);
};

export const deserializeSwapTree = (tree: string | SerializedTree): SwapTree => {
    const parsed: SerializedTree = typeof tree === "string" ? JSON.parse(tree) : tree;
    const claimLeaf = deserializeLeaf(parsed.claimLeaf);
    const refundLeaf = deserializeLeaf(parsed.refundLeaf);
    return {
        claimLeaf,
        refundLeaf,
        tree: sortTree([
            { probability: 51, value: claimLeaf },
            { probability: 49, value: refundLeaf },
        ]),
    };
};

// ---------------------------------------------------------------------------
// BTC chain HTLC leaf assertions
// ---------------------------------------------------------------------------

// Boltz uses tapscript v1 leaves only; see NArk BtcHtlcScripts.
const TAPLEAF_V1 = 0xc0;
const PUSH_32 = Uint8Array.of(0x20);

// CLTV timeout is a canonical ScriptNum: at most 5 bytes (BIP65) and minimally
// encoded. Enforce both so only the exact Boltz refund-leaf shape is accepted.
const decodeScriptNum = (data: unknown): number | undefined =>
    data instanceof Uint8Array && data.length > 0
        ? Number(ScriptNum(5, true).decode(data))
        : undefined;

/**
 * Asserts a BTC chain-swap HTLC's leaves match the canonical Boltz shape and
 * carry the agreed preimage hash, keys, and CLTV. Throws on any deviation.
 *
 * claim:  OP_SIZE 32 OP_EQUALVERIFY OP_HASH160 <h160> OP_EQUALVERIFY <claim> OP_CHECKSIG
 * refund: <refund> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY
 */
export const assertChainHtlcLeaves = (
    tree: SwapTree,
    expected: {
        preimageHash160: Uint8Array;
        claimXOnly: Uint8Array;
        refundXOnly: Uint8Array;
        timeoutBlockHeight: number;
    },
): void => {
    if (tree.claimLeaf.version !== TAPLEAF_V1 || tree.refundLeaf.version !== TAPLEAF_V1)
        throw new Error("unexpected leaf version");

    const claim = Script.decode(tree.claimLeaf.output);
    if (
        claim.length !== 8 ||
        claim[0] !== "SIZE" ||
        !(claim[1] instanceof Uint8Array) ||
        !equalBytes(claim[1], PUSH_32) ||
        claim[2] !== "EQUALVERIFY" ||
        claim[3] !== "HASH160" ||
        !(claim[4] instanceof Uint8Array) ||
        !equalBytes(claim[4], expected.preimageHash160) ||
        claim[5] !== "EQUALVERIFY" ||
        !(claim[6] instanceof Uint8Array) ||
        !equalBytes(claim[6], expected.claimXOnly) ||
        claim[7] !== "CHECKSIG"
    )
        throw new Error("unexpected claim leaf");

    const refund = Script.decode(tree.refundLeaf.output);
    if (
        refund.length !== 4 ||
        !(refund[0] instanceof Uint8Array) ||
        !equalBytes(refund[0], expected.refundXOnly) ||
        refund[1] !== "CHECKSIGVERIFY" ||
        decodeScriptNum(refund[2]) !== expected.timeoutBlockHeight ||
        refund[3] !== "CHECKLOCKTIMEVERIFY"
    )
        throw new Error("unexpected refund leaf");
};

// ---------------------------------------------------------------------------
// Taproot tree hashing
// ---------------------------------------------------------------------------

interface HashedLeaf {
    type: "leaf";
    version: number;
    script: Uint8Array;
    hash: Uint8Array;
}

interface HashedBranch {
    type: "branch";
    left: HashedTree;
    right: HashedTree;
    hash: Uint8Array;
}

type HashedTree = HashedLeaf | HashedBranch;

export const taprootHashTree = (tree: TapTree): HashedTree => {
    if (!Array.isArray(tree)) {
        return {
            type: "leaf",
            version: tree.version,
            script: tree.output,
            hash: tapLeafHash(tree.output, tree.version),
        };
    }
    const left = taprootHashTree(tree[0]);
    const right = taprootHashTree(tree[1]);
    let [lH, rH] = [left.hash, right.hash];
    if (compareBytes(rH, lH) === -1) [lH, rH] = [rH, lH];
    return {
        type: "branch",
        left,
        right,
        hash: schnorr.utils.taggedHash("TapBranch", lH, rH),
    };
};

// ---------------------------------------------------------------------------
// Taproot MuSig tweak
// ---------------------------------------------------------------------------

export const tweakMusig = (musig: MusigKeyAgg, tree: TapTree): MusigKeyAgg => {
    const tweak = taprootHashTree(tree).hash;
    return musig.xonlyTweakAdd(schnorr.utils.taggedHash("TapTweak", musig.aggPubkey, tweak));
};

// ---------------------------------------------------------------------------
// Swap output detection
// ---------------------------------------------------------------------------

export const toXOnly = (pubKey: Uint8Array): Uint8Array => {
    if (pubKey.length === 32) return pubKey;
    if (pubKey.length === 33) {
        if (pubKey[0] !== 0x02 && pubKey[0] !== 0x03) {
            throw new Error(
                `Invalid compressed public key prefix: 0x${pubKey[0].toString(16).padStart(2, "0")}`,
            );
        }
        return pubKey.subarray(1, 33);
    }
    throw new Error(`Invalid public key length: expected 32 or 33 bytes, got ${pubKey.length}`);
};

export const p2trScript = (publicKey: Uint8Array): Uint8Array =>
    Script.encode(["OP_1", toXOnly(publicKey)]);

export const detectSwapOutput = (
    tweakedKey: Uint8Array,
    transaction: Transaction,
): DetectedSwapOutput => {
    const target = p2trScript(tweakedKey);
    for (let vout = 0; vout < transaction.outputsLength; vout++) {
        const output = transaction.getOutput(vout);
        if (
            output.script !== undefined &&
            output.amount !== undefined &&
            equalBytes(target, output.script)
        ) {
            return { ...output, vout };
        }
    }
    throw new Error("Swap output not found in transaction");
};

// ---------------------------------------------------------------------------
// Claim transaction construction (Taproot cooperative only)
// ---------------------------------------------------------------------------

const DUMMY_TAPROOT_SIGNATURE = new Uint8Array(64);

export const constructClaimTransaction = (
    utxo: {
        transactionId: string;
        vout: number;
        amount: bigint;
        script: Uint8Array;
    },
    destinationScript: Uint8Array,
    fee: bigint,
): Transaction => {
    if (fee < BigInt(0) || fee >= utxo.amount) throw new Error("fee exceeds utxo amount");

    const tx = new Transaction({ version: 2 });

    tx.addOutput({
        amount: utxo.amount - fee,
        script: destinationScript,
    });

    tx.addInput({
        txid: utxo.transactionId,
        index: utxo.vout,
        sequence: 0xfffffffd, // RBF enabled
    });

    // Cooperative (key-path) spend: dummy signature placeholder
    // The caller will replace this with the real aggregated MuSig2 signature
    tx.updateInput(0, {
        finalScriptWitness: [DUMMY_TAPROOT_SIGNATURE],
    });

    return tx;
};

// ---------------------------------------------------------------------------
// Fee targeting
// ---------------------------------------------------------------------------

export const targetFee = (
    satPerVbyte: number,
    constructTx: (fee: bigint) => Transaction,
): Transaction => {
    // Size the fee from the exact virtual size. The tx is finalized with a
    // real-length 64-byte Taproot key-path signature placeholder, so `vsize`
    // already matches the broadcast size — no per-input pad. The old
    // `+ inputsLength` overpaid ~1 sat/input, which claimBtc subtracts from the
    // recipient output, so the claim under-delivered by 1 sat/input. Sizing to the
    // true vsize keeps targetFee <= Boltz's grossed-up `minerFees.user.claim`, so
    // claimBtc's max() picks the reserved estimate and delivers the exact amount.
    const probe = constructTx(BigInt(1));
    return constructTx(BigInt(Math.ceil(probe.vsize * satPerVbyte)));
};
