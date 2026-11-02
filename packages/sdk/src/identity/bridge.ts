import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { Script, SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { getPrevOut } from "@scure/btc-signer/transaction.js";
import { equalBytes, taprootTweakPubkey } from "@scure/btc-signer/utils.js";
import type { BatchSignableIdentity, SignRequest } from ".";
import { TreeSignerSession } from "../tree/signingSession";
import { assertAllowedSighashTypes, Transaction } from "../utils/transaction";

export interface BridgeSigningRequest {
    psbt: Uint8Array;
    inputIndexes?: number[];
}

/** Bridges return unfinalized PSBTs, preserving every field and adding only requested signatures. */
export interface IdentityBridge {
    getPublicKey(): Promise<Uint8Array>;
    signPsbt(psbt: Uint8Array, inputIndexes?: number[]): Promise<Uint8Array>;
    /** Returns a 64-byte BIP340 or compact ECDSA signature over a 32-byte hash. */
    signMessage(hash: Uint8Array, type: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    signPsbts?(requests: BridgeSigningRequest[]): Promise<Uint8Array[]>;
}

type SignatureSlot = {
    index: number;
    publicKey: Uint8Array;
    digest: Uint8Array;
    sighash: number;
    leafHash?: Uint8Array;
    existing?: Uint8Array;
};
type PreparedRequest = {
    original: Transaction;
    psbt: Uint8Array;
    indexes?: number[];
    slots: SignatureSlot[];
};
const ALLOWED_SIGHASH = [SigHash.DEFAULT, SigHash.ALL, SigHash.ALL_ANYONECANPAY];

/**
 * A single-key Taproot identity that verifies every signature and PSBT returned by a bridge.
 * Owned script leaves take precedence over key-path signing.
 */
export class BridgeIdentity implements BatchSignableIdentity {
    private constructor(
        private readonly bridge: IdentityBridge,
        private readonly publicKey: Uint8Array,
    ) {}

    static async create(bridge: IdentityBridge): Promise<BridgeIdentity> {
        const publicKey = await bridge.getPublicKey();
        if (
            !(publicKey instanceof Uint8Array) ||
            publicKey.length !== 33 ||
            ![2, 3].includes(publicKey[0])
        ) {
            throw new Error("Bridge must return a compressed secp256k1 public key");
        }
        secp256k1.Point.fromBytes(publicKey).assertValidity();
        return new BridgeIdentity(bridge, publicKey.slice());
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return this.publicKey.slice();
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return this.publicKey.slice(1);
    }

    signerSession(): TreeSignerSession {
        return TreeSignerSession.random();
    }

    async signMessage(
        hash: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        if (hash.length !== 32) throw new Error("Expected a 32-byte message hash");
        if (type !== "schnorr" && type !== "ecdsa") throw new Error("Unsupported signature type");
        const digest = hash.slice();
        const returned = await this.bridge.signMessage(digest.slice(), type);
        if (!(returned instanceof Uint8Array) || returned.length !== 64) {
            throw new Error("Bridge returned an invalid signature length");
        }
        if (type === "schnorr") {
            if (!schnorr.verify(returned, digest, this.publicKey.subarray(1))) {
                throw new Error("Invalid bridge Schnorr signature");
            }
            return returned.slice();
        }
        let signature = secp256k1.Signature.fromBytes(returned);
        if (signature.hasHighS()) {
            signature = new secp256k1.Signature(
                signature.r,
                secp256k1.Point.Fn.ORDER - signature.s,
            );
        }
        const compact = signature.toBytes();
        if (!secp256k1.verify(compact, digest, this.publicKey, { prehash: false })) {
            throw new Error("Invalid bridge ECDSA signature");
        }
        return compact;
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        return this.execute(this.prepare(tx, inputIndexes));
    }

    async signMultiple(requests: SignRequest[]): Promise<Transaction[]> {
        const prepared = requests.map(({ tx, inputIndexes }) => this.prepare(tx, inputIndexes));
        if (!this.bridge.signPsbts || !prepared.some((request) => this.needsSignature(request))) {
            const signed: Transaction[] = [];
            for (const request of prepared) signed.push(await this.execute(request));
            return signed;
        }
        const returned = await this.bridge.signPsbts(
            prepared.map((request) => this.request(request)),
        );
        if (!Array.isArray(returned) || returned.length !== prepared.length) {
            throw new Error("Bridge must return one PSBT per signing request");
        }
        return prepared.map((request, index) => this.validate(request, returned[index]));
    }

    private request(prepared: PreparedRequest): BridgeSigningRequest {
        return {
            psbt: prepared.psbt.slice(),
            ...(prepared.indexes === undefined ? {} : { inputIndexes: prepared.indexes.slice() }),
        };
    }

    private needsSignature(prepared: PreparedRequest): boolean {
        return prepared.slots.some((slot) => !slot.existing);
    }

    private async execute(prepared: PreparedRequest): Promise<Transaction> {
        if (!this.needsSignature(prepared)) return prepared.original;
        const { psbt, inputIndexes } = this.request(prepared);
        return this.validate(prepared, await this.bridge.signPsbt(psbt, inputIndexes));
    }

    private prepare(tx: Transaction, inputIndexes?: number[]): PreparedRequest {
        const original = Transaction.fromPSBT(tx.toPSBT().slice(), { disableScriptCheck: false });
        assertAllowedSighashTypes(original, ALLOWED_SIGHASH);
        const indexes = inputIndexes?.slice();
        const selected =
            indexes ?? Array.from({ length: original.inputsLength }, (_, index) => index);
        const slots: SignatureSlot[] = [];
        const publicKey = this.publicKey.slice(1);
        for (const index of new Set(selected)) {
            if (!Number.isInteger(index) || index < 0 || index >= original.inputsLength) {
                throw new Error(`Invalid input index: ${index}`);
            }
            const input = original.getInput(index);
            if (input.finalScriptWitness?.length || input.finalScriptSig?.length) {
                if (indexes) throw new Error(`Input ${index} is already finalized`);
                continue;
            }
            const leaves = (input.tapLeafScript ?? []).filter(([, script]) =>
                Script.decode(script.subarray(0, -1)).some(
                    (part) => part instanceof Uint8Array && equalBytes(part, publicKey),
                ),
            );
            const keyPath = input.tapInternalKey && equalBytes(input.tapInternalKey, publicKey);
            if (!leaves.length && !keyPath) {
                if (indexes) throw new Error(`Input ${index} is not signable by this bridge key`);
                continue;
            }
            const prevout = getPrevOut(input);
            if (
                prevout.script.length !== 34 ||
                prevout.script[0] !== 0x51 ||
                prevout.script[1] !== 32
            ) {
                throw new Error("BridgeIdentity only signs Taproot inputs");
            }
            const sighash = input.sighashType ?? SigHash.DEFAULT;
            const prevouts = Array.from({ length: original.inputsLength }, (_, other) =>
                other !== index && sighash === SigHash.ALL_ANYONECANPAY
                    ? { script: new Uint8Array(), amount: 0n }
                    : getPrevOut(original.getInput(other)),
            );
            const scripts = prevouts.map((output) => output.script);
            const amounts = prevouts.map((output) => output.amount);
            if (leaves.length) {
                for (const [, scriptWithVersion] of leaves) {
                    const version = scriptWithVersion[scriptWithVersion.length - 1];
                    const script = scriptWithVersion.subarray(0, -1);
                    if (version !== 0xc0 || Script.decode(script).includes("CODESEPARATOR")) {
                        throw new Error("Unsupported tapscript version or OP_CODESEPARATOR");
                    }
                    const leafHash = tapLeafHash(script, version);
                    slots.push({
                        index,
                        publicKey,
                        sighash,
                        leafHash,
                        digest: original.preimageWitnessV1(
                            index,
                            scripts,
                            sighash,
                            amounts,
                            undefined,
                            script,
                            version,
                        ),
                        existing: input.tapScriptSig?.find(
                            ([key]) =>
                                equalBytes(key.pubKey, publicKey) &&
                                equalBytes(key.leafHash, leafHash),
                        )?.[1],
                    });
                }
            } else {
                if (input.tapLeafScript?.length && !input.tapMerkleRoot) {
                    throw new Error("Key-path signing with a script tree requires tapMerkleRoot");
                }
                const [outputKey] = taprootTweakPubkey(
                    publicKey,
                    input.tapMerkleRoot ?? new Uint8Array(),
                );
                if (!equalBytes(outputKey, prevout.script.subarray(2))) {
                    throw new Error("Taproot output does not match the bridge key and tweak");
                }
                slots.push({
                    index,
                    publicKey: outputKey,
                    sighash,
                    digest: original.preimageWitnessV1(index, scripts, sighash, amounts),
                    existing: input.tapKeySig,
                });
            }
        }
        for (const slot of slots) if (slot.existing) this.verify(slot, slot.existing);
        return { original, psbt: original.toPSBT(), indexes, slots };
    }

    private verify(slot: SignatureSlot, signature: Uint8Array): void {
        const length = slot.sighash === SigHash.DEFAULT ? 64 : 65;
        if (
            signature.length !== length ||
            (length === 65 && signature[64] !== slot.sighash) ||
            !schnorr.verify(signature.subarray(0, 64), slot.digest, slot.publicKey)
        ) {
            throw new Error(`Invalid bridge signature for input ${slot.index}`);
        }
    }

    private validate(prepared: PreparedRequest, psbt: Uint8Array): Transaction {
        if (!(psbt instanceof Uint8Array)) throw new Error("Bridge must return PSBT bytes");
        const returned = Transaction.fromPSBT(psbt.slice(), { disableScriptCheck: false });
        const expected = Transaction.fromPSBT(prepared.psbt, { disableScriptCheck: false });
        for (const slot of prepared.slots) {
            if (slot.existing) continue;
            const input = returned.getInput(slot.index);
            const signature = slot.leafHash
                ? input.tapScriptSig?.find(
                      ([key]) =>
                          equalBytes(key.pubKey, slot.publicKey) &&
                          equalBytes(key.leafHash, slot.leafHash!),
                  )?.[1]
                : input.tapKeySig;
            if (!signature) throw new Error(`Bridge did not sign input ${slot.index}`);
            this.verify(slot, signature);
            expected.updateInput(
                slot.index,
                slot.leafHash
                    ? {
                          tapScriptSig: [
                              [{ pubKey: slot.publicKey, leafHash: slot.leafHash }, signature],
                          ],
                      }
                    : { tapKeySig: signature },
            );
        }
        if (!equalBytes(expected.toPSBT(), returned.toPSBT())) {
            throw new Error("Bridge changed PSBT fields beyond the requested signatures");
        }
        return expected;
    }
}
