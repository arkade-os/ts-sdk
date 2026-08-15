import { Script } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils.js";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    RelativeTimelock,
} from "./tapscript";
import { hex } from "@scure/base";
import { TapLeafScript, VtxoScript } from "./base";
import { ArkadeScript } from "../arkade/script";
import { computeArkadeScriptPublicKey } from "../arkade/tweak";

/** Virtual Hash Time Lock Contract (VHTLC) namespace. */
export namespace VHTLC {
    export interface Options {
        sender: Bytes;
        receiver: Bytes;
        server: Bytes;
        preimageHash: Bytes;
        refundLocktime: bigint;
        unilateralClaimDelay: RelativeTimelock;
        unilateralRefundDelay: RelativeTimelock;
        unilateralRefundWithoutReceiverDelay: RelativeTimelock;
        /**
         * Optional non-interactive claim leaf: `server` plus a covenant-tweaked
         * emulator co-signer, pinned to `receiverPkScript`. Lets the receiver's
         * claim be pushed by the emulator without the receiver being online.
         */
        nonInteractiveClaim?: {
            receiverPkScript: Bytes;
            emulatorPubkey: Bytes;
        };
        /**
         * Optional non-interactive refund leaf: `server` + `receiver` + a
         * covenant-tweaked emulator co-signer, pinned to `senderPkScript`, no
         * timelock. Every OTHER refund-side leaf in this contract requires
         * the sender's own signature — if the sender permanently loses that
         * key, none of them are reachable. This leaf is the one exception:
         * it needs neither the sender's presence nor their key, so funds
         * remain recoverable to the sender's pre-committed address even
         * then. It still needs the receiver (unlike `nonInteractiveClaim`,
         * which needs only server + emulator) — deliberately: this is what
         * lets server + receiver release the refund immediately, the moment
         * they agree the swap has failed, rather than making the sender wait
         * out `refundLocktime` the way {@link Script.refundWithoutReceiver}
         * does.
         */
        nonInteractiveRefund?: {
            senderPkScript: Bytes;
            emulatorPubkey: Bytes;
        };
        /**
         * Optional: denominate this contract in an Arkade ASSET rather than in
         * sats alone.
         *
         * Only the two NON-INTERACTIVE leaves change. Every other leaf is a
         * signature path that asserts nothing about value, so an asset makes no
         * difference to them — which is why this option reaches exactly the
         * leaves whose covenant the emulator enforces.
         *
         * When set, those covenants additionally require the output to carry at
         * least the input's amount of THIS asset, and to carry exactly one
         * asset. The sat clause is RETAINED, not replaced: an asset-carrying
         * VTXO carries sats too, so dropping it would let a spend satisfy the
         * asset covenant while stripping the sats — exactly as the sat-only
         * covenant lets a spend strip the asset.
         *
         * The id is the pair the introspection opcodes take. A canonical Asset
         * ID is `(genesis txid, group index)`, never a single blob.
         */
        asset?: {
            /** The asset's genesis transaction id, 32 bytes. */
            txid: Bytes;
            /** The asset group index within that genesis transaction. */
            groupIndex: number;
        };
    }

    /**
     * Shared construction and accessors for every VHTLC script version. The
     * only thing that varies between versions is which preimage-condition
     * fragment `claim`/`unilateralClaim`/`nonInteractiveClaim` are built
     * from — everything else (the multisig/timelock leaves, the
     * non-interactive covenant leaves, the accessor methods) is identical,
     * so versions are expressed as thin subclasses over one builder rather
     * than as separate, independently-maintained copies of this class.
     */
    abstract class BaseScript extends VtxoScript {
        readonly options: Options;
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;
        readonly nonInteractiveClaimScript?: string;
        readonly nonInteractiveClaimArkadeScript?: Bytes;
        readonly nonInteractiveRefundScript?: string;
        readonly nonInteractiveRefundArkadeScript?: Bytes;

        protected constructor(options: Options, preimageCondition: (hash: Bytes) => Bytes) {
            validateOptions(options);

            const {
                sender,
                receiver,
                server,
                preimageHash,
                refundLocktime,
                unilateralClaimDelay,
                unilateralRefundDelay,
                unilateralRefundWithoutReceiverDelay,
            } = options;

            // The one leaf-condition fragment `claim`, `unilateralClaim`, and
            // (when present) `nonInteractiveClaim` all reuse below — computed
            // once so all three can never drift from one another within the
            // same script version.
            const conditionScript = preimageCondition(preimageHash);

            const claimScript = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [receiver, server],
            }).script;

            const refundScript = MultisigTapscript.encode({
                pubkeys: [sender, receiver, server],
            }).script;

            const refundWithoutReceiverScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: refundLocktime,
                pubkeys: [sender, server],
            }).script;

            const unilateralClaimScript = ConditionCSVMultisigTapscript.encode({
                conditionScript,
                timelock: unilateralClaimDelay,
                pubkeys: [receiver],
            }).script;

            const unilateralRefundScript = CSVMultisigTapscript.encode({
                timelock: unilateralRefundDelay,
                pubkeys: [sender, receiver],
            }).script;

            const unilateralRefundWithoutReceiverScript = CSVMultisigTapscript.encode({
                timelock: unilateralRefundWithoutReceiverDelay,
                pubkeys: [sender],
            }).script;

            const scripts = [
                claimScript,
                refundScript,
                refundWithoutReceiverScript,
                unilateralClaimScript,
                unilateralRefundScript,
                unilateralRefundWithoutReceiverScript,
            ];

            let arkadeScriptNic: Bytes | undefined;
            let nonInteractiveClaimScript: Bytes | undefined;
            if (options.nonInteractiveClaim) {
                arkadeScriptNic = enforcePayToMaybeAsset(
                    options.nonInteractiveClaim.receiverPkScript,
                    options.asset,
                );
                nonInteractiveClaimScript = ConditionMultisigTapscript.encode({
                    conditionScript,
                    pubkeys: [
                        server,
                        computeArkadeScriptPublicKey(
                            options.nonInteractiveClaim.emulatorPubkey,
                            arkadeScriptNic,
                        ),
                    ],
                }).script;
                scripts.push(nonInteractiveClaimScript);
            }

            let arkadeScriptNir: Bytes | undefined;
            let nonInteractiveRefundScript: Bytes | undefined;
            if (options.nonInteractiveRefund) {
                arkadeScriptNir = enforcePayToMaybeAsset(
                    options.nonInteractiveRefund.senderPkScript,
                    options.asset,
                );
                // No timelock: server + receiver together can release this
                // immediately, same as `refund` above, just without needing
                // the sender's own signature — the covenant is what still
                // guarantees the payout can only reach the sender.
                nonInteractiveRefundScript = MultisigTapscript.encode({
                    pubkeys: [
                        server,
                        receiver,
                        computeArkadeScriptPublicKey(
                            options.nonInteractiveRefund.emulatorPubkey,
                            arkadeScriptNir,
                        ),
                    ],
                }).script;
                scripts.push(nonInteractiveRefundScript);
            }

            super(scripts);

            this.options = options;
            this.claimScript = hex.encode(claimScript);
            this.refundScript = hex.encode(refundScript);
            this.refundWithoutReceiverScript = hex.encode(refundWithoutReceiverScript);
            this.unilateralClaimScript = hex.encode(unilateralClaimScript);
            this.unilateralRefundScript = hex.encode(unilateralRefundScript);
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                unilateralRefundWithoutReceiverScript,
            );
            if (nonInteractiveClaimScript) {
                this.nonInteractiveClaimScript = hex.encode(nonInteractiveClaimScript);
                this.nonInteractiveClaimArkadeScript = arkadeScriptNic;
            }
            if (nonInteractiveRefundScript) {
                this.nonInteractiveRefundScript = hex.encode(nonInteractiveRefundScript);
                this.nonInteractiveRefundArkadeScript = arkadeScriptNir;
            }
        }

        /** Return the collaborative claim tapleaf script. */
        claim(): TapLeafScript {
            return this.findLeaf(this.claimScript);
        }

        /** Return the collaborative refund tapleaf script. */
        refund(): TapLeafScript {
            return this.findLeaf(this.refundScript);
        }

        /** Return the refund-without-receiver tapleaf script. */
        refundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.refundWithoutReceiverScript);
        }

        /** Return the unilateral claim tapleaf script. */
        unilateralClaim(): TapLeafScript {
            return this.findLeaf(this.unilateralClaimScript);
        }

        /** Return the unilateral refund tapleaf script. */
        unilateralRefund(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundScript);
        }

        /** Return the unilateral refund-without-receiver tapleaf script. */
        unilateralRefundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundWithoutReceiverScript);
        }

        /** Return the non-interactive claim tapleaf script as well as the ArkadeScript. */
        nonInteractiveClaim(): [TapLeafScript, Bytes] {
            if (!this.nonInteractiveClaimScript || !this.nonInteractiveClaimArkadeScript) {
                throw new Error("VHTLC has no non-interactive claim leaf");
            }
            return [
                this.findLeaf(this.nonInteractiveClaimScript),
                this.nonInteractiveClaimArkadeScript,
            ];
        }

        /** Return the non-interactive refund tapleaf script as well as the ArkadeScript. */
        nonInteractiveRefund(): [TapLeafScript, Bytes] {
            if (!this.nonInteractiveRefundScript || !this.nonInteractiveRefundArkadeScript) {
                throw new Error("VHTLC has no non-interactive refund leaf");
            }
            return [
                this.findLeaf(this.nonInteractiveRefundScript),
                this.nonInteractiveRefundArkadeScript,
            ];
        }
    }

    /**
     * Virtual Hash Time Lock Contract (VHTLC) script implementation.
     *
     * VHTLC enables atomic swaps and conditional payments in the Arkade protocol.
     * It provides multiple spending paths:
     *
     * - **claim**: Receiver can claim funds by revealing the preimage
     * - **refund**: Sender and receiver can collaboratively refund
     * - **refundWithoutReceiver**: Sender can refund after locktime expires
     * - **unilateralClaim**: Receiver can claim unilaterally after delay
     * - **unilateralRefund**: Sender and receiver can refund unilaterally after delay
     * - **unilateralRefundWithoutReceiver**: Sender can refund unilaterally after delay
     * - **nonInteractiveClaim** (optional): server + emulator can push the
     *   receiver's claim, pinned to a pre-committed destination
     * - **nonInteractiveRefund** (optional): server + receiver + emulator
     *   can push the sender's refund immediately, no timelock, pinned to a
     *   pre-committed destination — recoverable even if the sender's own key
     *   is lost
     *
     * See {@link ScriptV2} for the current recommended construction — same
     * leaf ladder, same options shape, an added length check on the claim
     * preimage. This class is unchanged and stays available as-is.
     *
     * @example
     * ```typescript
     * const vhtlc = new VHTLC.Script({
     *   sender: alicePubKey,
     *   receiver: bobPubKey,
     *   server: serverPubKey,
     *   preimageHash: hash160(secret),
     *   refundLocktime: BigInt(chainTip + 10),
     *   unilateralClaimDelay: { type: 'blocks', value: 100n },
     *   unilateralRefundDelay: { type: 'blocks', value: 102n },
     *   unilateralRefundWithoutReceiverDelay: { type: 'blocks', value: 103n }
     * });
     * ```
     */
    export class Script extends BaseScript {
        constructor(options: Options) {
            super(options, preimageConditionScript);
        }
    }

    /**
     * Same leaf ladder as {@link Script}, built with {@link
     * preimageConditionScriptV2} instead of {@link preimageConditionScript}
     * for every leaf that gates on the preimage (`claim`, `unilateralClaim`,
     * and, when present, `nonInteractiveClaim`) — see that function's doc
     * comment for what differs and why. A distinct class rather than a flag
     * on {@link Script}: the two produce different script bytes (and so
     * different addresses) for the same participant keys, and keeping them
     * as separate types makes that a compile-time-visible choice at every
     * call site instead of a runtime option that's easy to get wrong.
     */
    export class ScriptV2 extends BaseScript {
        constructor(options: Options) {
            super(options, preimageConditionScriptV2);
        }
    }

    function validateOptions(options: Options): void {
        const {
            sender,
            receiver,
            server,
            preimageHash,
            refundLocktime,
            unilateralClaimDelay,
            unilateralRefundDelay,
            unilateralRefundWithoutReceiverDelay,
        } = options;

        if (!preimageHash || preimageHash.length !== 20) {
            throw new Error("preimage hash must be 20 bytes");
        }
        if (options.nonInteractiveClaim) {
            const { emulatorPubkey, receiverPkScript } = options.nonInteractiveClaim;
            if (!emulatorPubkey || (emulatorPubkey.length !== 32 && emulatorPubkey.length !== 33)) {
                throw new Error("Invalid public key length (emulator)");
            }
            if (!receiverPkScript || !isP2trPkScript(receiverPkScript)) {
                throw new Error("Invalid P2TR script");
            }
        }
        if (options.nonInteractiveRefund) {
            const { emulatorPubkey, senderPkScript } = options.nonInteractiveRefund;
            if (!emulatorPubkey || (emulatorPubkey.length !== 32 && emulatorPubkey.length !== 33)) {
                throw new Error("Invalid public key length (emulator)");
            }
            if (!senderPkScript || !isP2trPkScript(senderPkScript)) {
                throw new Error("Invalid P2TR script");
            }
        }
        if (!receiver || receiver.length !== 32) {
            throw new Error("Invalid public key length (receiver)");
        }
        if (!sender || sender.length !== 32) {
            throw new Error("Invalid public key length (sender)");
        }
        if (!server || server.length !== 32) {
            throw new Error("Invalid public key length (server)");
        }
        if (typeof refundLocktime !== "bigint" || refundLocktime <= 0n) {
            throw new Error("refund locktime must be greater than 0");
        }
        if (
            !unilateralClaimDelay ||
            typeof unilateralClaimDelay.value !== "bigint" ||
            unilateralClaimDelay.value <= 0n
        ) {
            throw new Error("unilateral claim delay must greater than 0");
        }
        if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value % 512n !== 0n) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value < 512n) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundDelay ||
            typeof unilateralRefundDelay.value !== "bigint" ||
            unilateralRefundDelay.value <= 0n
        ) {
            throw new Error("unilateral refund delay must greater than 0");
        }
        if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value % 512n !== 0n) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value < 512n) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundWithoutReceiverDelay ||
            typeof unilateralRefundWithoutReceiverDelay.value !== "bigint" ||
            unilateralRefundWithoutReceiverDelay.value <= 0n
        ) {
            throw new Error("unilateral refund without receiver delay must greater than 0");
        }
        if (
            unilateralRefundWithoutReceiverDelay.type === "seconds" &&
            unilateralRefundWithoutReceiverDelay.value % 512n !== 0n
        ) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (
            unilateralRefundWithoutReceiverDelay.type === "seconds" &&
            unilateralRefundWithoutReceiverDelay.value < 512n
        ) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
    }
}

function preimageConditionScript(preimageHash: Bytes): Bytes {
    return Script.encode(["HASH160", preimageHash, "EQUAL"]);
}

/**
 * Same as {@link preimageConditionScript}, plus an explicit length check on
 * the witness item before it's hashed: `OP_SIZE 32 OP_EQUALVERIFY` ahead of
 * the `OP_HASH160` check, the same prefix real-world HTLC scripts (e.g.
 * BOLT3's) carry for the same reason — the claim leaf otherwise accepts any
 * witness value whose HASH160 matches, regardless of length, and this
 * contract's preimage is always exactly 32 bytes by construction. Used by
 * {@link VHTLC.ScriptV2} for every leaf gated on the preimage.
 */
function preimageConditionScriptV2(preimageHash: Bytes): Bytes {
    return Script.encode(["SIZE", 32, "EQUALVERIFY", "HASH160", preimageHash, "EQUAL"]);
}

/**
 * A v1 P2TR pkScript is exactly `OP_1 <32-byte-program>` (0x51 0x20 ...) — 34
 * bytes total. Length alone isn't enough: any other 34-byte value (e.g.
 * {@link ArkAddress.subdustPkScript}'s `OP_RETURN <32 bytes>`, or a P2WSH
 * script) has the same length but a different witness version, and
 * `enforcePayTo` below trusts byte 2 onward as the taproot program
 * unconditionally.
 */
function isP2trPkScript(pkScript: Bytes): boolean {
    return pkScript.length === 34 && pkScript[0] === 0x51 && pkScript[1] === 0x20;
}

/**
 * The covenant: "this input's output pays the given P2TR script, value >=
 * input". Shared by {@link VHTLC.Options.nonInteractiveClaim} and {@link
 * VHTLC.Options.nonInteractiveRefund} — only the destination and the tier it
 * gates differ.
 *
 * `PUSHCURRENTINPUTINDEX` as the output index is not an assumption about how
 * the Ark round pairs inputs with outputs — the covenant imposes the pairing
 * on the spender. Whatever index a spending tx places this input at, the
 * output at that same index must pay the destination at least the input's
 * value, or the ArkadeScript fails and the server never co-signs. A tx with no
 * output at that index fails the same way: the leaf is unsatisfiable, not
 * fooled. Index alignment is therefore a *liveness* obligation on whoever
 * assembles the spend (the solver, for both leaves — this SDK never builds
 * them; its own aggregate refund uses the interactive leaf precisely because
 * it lacks this per-index constraint, see `refund.ts`), never a safety
 * assumption.
 */
function enforcePayTo(destinationPkScript: Bytes): Bytes {
    // validateOptions already checked this for both current call sites — kept
    // here too, since this covenant is the one place a wrong destination
    // becomes irreversible (a mis-typed leaf, unlike a rejected constructor
    // call, only surfaces once someone tries to spend it).
    if (!isP2trPkScript(destinationPkScript)) {
        throw new Error("invalid P2TR script");
    }
    return ArkadeScript.encode([
        "PUSHCURRENTINPUTINDEX",
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        destinationPkScript.subarray(2),
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "GREATERTHANOREQUAL",
    ]);
}

/**
 * {@link enforcePayTo} for a contract denominated in an Arkade ASSET: the same
 * covenant, plus "carries at least the input's amount of exactly this one
 * asset".
 *
 * The sat covenant is this one's TAIL, restated inline below, so an asset
 * contract enforces everything a sat contract does and never less.  That
 * matters because an asset-carrying VTXO carries sats too: a covenant
 * constraining only the asset would let a spend strip the sats, and the
 * sat-only covenant lets a spend strip the ASSET -- the loss this exists to
 * prevent.
 *
 * Two opcode details decide whether it is safe, and the intuitive reading gets
 * both wrong:
 *
 *  - A canonical Asset ID is TWO stack items, `asset_txid` then `asset_gidx`.
 *    Pushing it as one 32-byte blob encodes cleanly and fails only at spend
 *    time, once the contract is already funded.
 *  - `INSPECTOUTASSETLOOKUP` pushes `amount 1`, or `0 0` when the asset is
 *    ABSENT.  The `VERIFY` after each lookup pops that success flag and is
 *    load-bearing, not defensive: without it an output carrying NONE of the
 *    asset reports amount 0, `0 >= 0` passes, and the stripping spend succeeds
 *    anyway.  Applied to the input lookup too, so an input whose asset is
 *    undeclared cannot compare `0 >= 0` either.
 *
 * `INSPECTOUTASSETCOUNT == 1` bounds the output to the single asset bound, so
 * nothing can be injected alongside it.  Deliberately strict: a covenant that
 * is too permissive cannot be tightened once funds are locked to it, while a
 * strict one can be relaxed in a later contract version.
 */
function enforcePayToAsset(
    destinationPkScript: Bytes,
    asset: { txid: Bytes; groupIndex: number },
): Bytes {
    if (!isP2trPkScript(destinationPkScript)) {
        throw new Error("invalid P2TR script");
    }
    if (asset.txid.length !== 32) {
        throw new Error(`asset txid must be 32 bytes, got ${asset.txid.length}`);
    }
    if (!Number.isInteger(asset.groupIndex) || asset.groupIndex < 0 || asset.groupIndex > 0xffff) {
        throw new Error(
            `asset group index must be an integer in [0, 65535], got ${asset.groupIndex}`,
        );
    }
    // REVERSED, once, here. `asset.txid` is the id in WIRE order -- the leading
    // 32 bytes of the serialized Asset ID -- but the introspection opcodes match
    // against those bytes reversed. Push wire order and the lookup reports the
    // asset ABSENT (`0 0`), so the covenant fails and the contract it guards is
    // unspendable. Nothing in the failure says so: the emulator returns only
    // `OP_VERIFY failed`, and returns it whatever the amount comparison says.
    // Established on regtest against a real minted asset, by elimination against
    // a passing BTC-only control.
    //
    // A copy rather than an in-place reverse: the caller's id is theirs.
    const inspectionTxid = Uint8Array.from(asset.txid).reverse();
    return ArkadeScript.encode([
        // The output carries at least as much of the asset as the input did.
        // Output index is the input's -- the same index alignment the sat
        // covenant relies on, and the same liveness obligation on whoever
        // assembles the spend.
        "PUSHCURRENTINPUTINDEX",
        inspectionTxid,
        asset.groupIndex,
        "INSPECTOUTASSETLOOKUP",
        "VERIFY", // PRESENT on the output, not merely "zero of it"
        "PUSHCURRENTINPUTINDEX",
        inspectionTxid,
        asset.groupIndex,
        "INSPECTINASSETLOOKUP",
        "VERIFY", // ...and on the input, so the comparison means something
        "GREATERTHANOREQUAL",
        "VERIFY",
        // Exactly one asset out: nothing injected alongside the one bound.
        "PUSHCURRENTINPUTINDEX",
        "INSPECTOUTASSETCOUNT",
        1,
        "EQUALVERIFY",
        // ...then the sat covenant, byte-for-byte enforcePayTo above.
        "PUSHCURRENTINPUTINDEX",
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        destinationPkScript.subarray(2),
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "GREATERTHANOREQUAL",
    ]);
}

/** Pick the covenant this contract's denomination calls for. */
function enforcePayToMaybeAsset(
    destinationPkScript: Bytes,
    asset?: { txid: Bytes; groupIndex: number },
): Bytes {
    return asset === undefined
        ? enforcePayTo(destinationPkScript)
        : enforcePayToAsset(destinationPkScript, asset);
}
