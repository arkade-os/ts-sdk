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
import { ArkadeScript, type ArkadeScriptType } from "../arkade/script";
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
            /**
             * OPT-IN: also require the claim to pay at least these amounts.
             *
             * The covenant's default bound is conservation (`out >= in`) — see
             * {@link enforcePayTo} for why a quote is normally not the
             * covenant's business. This is the escape hatch for a consumer that
             * wants the quote enforced in script rather than at its own
             * admission layer.
             *
             * ADDITIVE, NEVER A REPLACEMENT. The conservation bound stays. On
             * its own, `out >= quoted` leaves everything ABOVE the quote
             * unconstrained, so an overfunded lockup's surplus could be routed
             * anywhere by whoever assembles the spend — trading an underfunding
             * hole for a skimming one. Both bounds together admit neither.
             *
             * WHAT IT COSTS, and it is not only opcodes:
             *
             *  - THE ADDRESS BECOMES A FUNCTION OF THE QUOTE. These amounts
             *    compile into the leaf, hence the emulator key, hence the
             *    pkScript. A re-quote is a different address, and cannot be
             *    applied to a lockup already funded.
             *  - AN UNDERFUNDED LOCKUP BECOMES UNCLAIMABLE. Its only exit is the
             *    refund path, which waits out the CLTV. That is the intended
             *    incentive and it lands on whoever misfunded — but it converts
             *    "claim the short amount now and settle up" into "wait for the
             *    timelock".
             *
             * Omit for the default. Omitting leaves every script byte unchanged,
             * so contracts already funded keep their addresses.
             */
            strict?: {
                /** Sats the claim must pay. Positive. */
                amount: bigint;
                /**
                 * Asset base units the claim must pay.
                 *
                 * Required iff {@link VHTLC.Options.asset} is set, and refused
                 * otherwise. Strict-on-sats-only against an asset-denominated
                 * contract would pin the sat CARRIER and say nothing about the
                 * asset that is the actual amount — half-enforcement that reads
                 * like enforcement, which is the failure this option exists to
                 * avoid rather than introduce.
                 */
                assetAmount?: bigint;
            };
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
            /**
             * Also emit the timelocked twin: `server` plus the SAME
             * covenant-tweaked co-signer, spendable after `refundLocktime`
             * with no receiver signature and no sender signature.
             *
             * This is the only refund tier that needs nobody: `refund` and
             * `refundWithoutReceiver` need the sender's key,
             * `nonInteractiveRefund` needs the receiver's. A sender who
             * funded a lockup and vanished is refundable through this leaf
             * alone, by anyone, to their pre-committed address.
             *
             * Off by default: it is a ninth leaf, so enabling it changes the
             * taproot merkle root and therefore the address.
             */
            withoutReceiver?: boolean;
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
         * ONE ASSET IS BOUND, AND ONLY THAT ONE IS PROTECTED. If a VTXO funded to
         * this contract carries ADDITIONAL assets alongside the bound one, those
         * are not covered: whoever assembles a covenant spend chooses where they
         * go, and can send them anywhere.
         *
         * `INSPECTOUTASSETCOUNT == 1` does not close that. It constrains the
         * covenant's OUTPUT to exactly one asset — so the extras cannot ride
         * along with the bound asset — but arkd's conservation rule is satisfied
         * by routing them to a different output, which the covenant says nothing
         * about. The bound asset arrives; the rest is the spender's to direct.
         *
         * So fund an asset contract with the asset it names and nothing else. A
         * multi-asset VTXO behind this covenant is a loss waiting for whoever
         * pushes the spend.
         *
         * The id is the pair the introspection opcodes take. A canonical Asset
         * ID is `(genesis txid, group index)`, never a single blob.
         */
        asset?: {
            /**
             * The asset's genesis transaction id, 32 bytes, in CANONICAL order
             * — exactly the leading 32 bytes of a serialized Asset ID, no flip.
             *
             * The covenant reverses it internally because the introspection
             * opcodes match wire order; callers never do that themselves, and a
             * caller who pre-reverses gets a contract that is unspendable on its
             * covenant leaves with nothing in the error naming why.
             */
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
        readonly nonInteractiveRefundWithoutReceiverScript?: string;
        readonly nonInteractiveRefundWithoutReceiverArkadeScript?: Bytes;

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
                    options.nonInteractiveClaim.strict,
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
            let nonInteractiveRefundWithoutReceiverScript: Bytes | undefined;
            if (options.nonInteractiveRefund) {
                arkadeScriptNir = enforcePayToMaybeAsset(
                    options.nonInteractiveRefund.senderPkScript,
                    options.asset,
                );
                // Derived ONCE and shared by both refund covenant leaves. They
                // pin the same destination, so they must commit to the same
                // key; computing it twice would make that a coincidence rather
                // than a guarantee.
                const nirCosigner = computeArkadeScriptPublicKey(
                    options.nonInteractiveRefund.emulatorPubkey,
                    arkadeScriptNir,
                );
                // No timelock: server + receiver together can release this
                // immediately, same as `refund` above, just without needing
                // the sender's own signature — the covenant is what still
                // guarantees the payout can only reach the sender.
                nonInteractiveRefundScript = MultisigTapscript.encode({
                    pubkeys: [server, receiver, nirCosigner],
                }).script;
                scripts.push(nonInteractiveRefundScript);

                if (options.nonInteractiveRefund.withoutReceiver) {
                    // The same tier `refundWithoutReceiver` reaches, reached
                    // without the sender: their signature is replaced by the
                    // covenant, exactly as `nonInteractiveRefund` replaces it
                    // in `refund`. Last in `scripts`, because leaf order fixes
                    // the merkle root and every earlier leaf must keep its
                    // position.
                    nonInteractiveRefundWithoutReceiverScript = CLTVMultisigTapscript.encode({
                        absoluteTimelock: refundLocktime,
                        pubkeys: [server, nirCosigner],
                    }).script;
                    scripts.push(nonInteractiveRefundWithoutReceiverScript);
                }
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
            if (nonInteractiveRefundWithoutReceiverScript) {
                this.nonInteractiveRefundWithoutReceiverScript = hex.encode(
                    nonInteractiveRefundWithoutReceiverScript,
                );
                this.nonInteractiveRefundWithoutReceiverArkadeScript = arkadeScriptNir;
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

        /** Return the timelocked non-interactive refund tapleaf and its ArkadeScript. */
        nonInteractiveRefundWithoutReceiver(): [TapLeafScript, Bytes] {
            if (
                !this.nonInteractiveRefundWithoutReceiverScript ||
                !this.nonInteractiveRefundWithoutReceiverArkadeScript
            ) {
                throw new Error("VHTLC has no non-interactive refund-without-receiver leaf");
            }
            return [
                this.findLeaf(this.nonInteractiveRefundWithoutReceiverScript),
                this.nonInteractiveRefundWithoutReceiverArkadeScript,
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
     * - **nonInteractiveRefundWithoutReceiver** (optional): server + emulator
     *   can push the sender's refund after `refundLocktime`, pinned to a
     *   pre-committed destination — the only refund tier needing no
     *   participant signature at all
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
        // The two non-interactive leaves are the ONLY ones carrying a covenant
        // — the signature leaves assert nothing about value — so they are the
        // only place an asset can be bound. Accepting `asset` without either of
        // them would emit a sat-only contract and say nothing about it: the
        // caller funds it believing the asset is protected, and any spend that
        // satisfies the sat covenant walks off with the asset. The one outward
        // difference is a pkScript matching a non-asset address, which is not
        // something a caller thinks to check. Refuse instead of dropping it.
        if (
            options.asset !== undefined &&
            !options.nonInteractiveClaim &&
            !options.nonInteractiveRefund
        ) {
            throw new Error(
                "asset has no effect without nonInteractiveClaim or nonInteractiveRefund",
            );
        }

        // The opt-in quoted bound, and every way of asking for half of it.
        const strict = options.nonInteractiveClaim?.strict;
        if (strict !== undefined) {
            // `out >= 0` is satisfied by every output, so a zero would compile a
            // bound that reads like enforcement and enforces nothing.
            if (strict.amount <= 0n) {
                throw new Error(`strict claim amount must be positive, got ${strict.amount}`);
            }
            // Strict on the sat carrier while the ASSET — the actual amount —
            // goes unbounded. The most dangerous shape here, because the caller
            // has explicitly asked for enforcement and would get it on the wrong
            // quantity.
            if (options.asset !== undefined && strict.assetAmount === undefined) {
                throw new Error(
                    "strict claim needs assetAmount when the contract is denominated in an asset: " +
                        "bounding only the sats would leave the asset amount unenforced",
                );
            }
            if (options.asset === undefined && strict.assetAmount !== undefined) {
                throw new Error("strict claim assetAmount has no effect without asset");
            }
            if (strict.assetAmount !== undefined && strict.assetAmount <= 0n) {
                throw new Error(
                    `strict claim assetAmount must be positive, got ${strict.assetAmount}`,
                );
            }
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
 *
 * WHY `>= input` AND NOT `>= the quoted amount`. This bound is CONSERVATION,
 * not agreement: it says the spend may not skim, and says nothing about what
 * any quote promised. That is deliberate, on both leaves, and it is a question
 * worth answering here because the covenant reads like the natural place to
 * pin a quote and is not.
 *
 *  - A QUOTE IS NOT THE COVENANT'S TO KNOW. Pinning one compiles it into the
 *    leaf, hence into the emulator key, hence into the ADDRESS. Re-quoting
 *    would move the address of a contract that may already be funded.
 *  - MISFUNDING IS THE SENDER'S EXPOSURE. They chose the amount. A lockup that
 *    over- or underpays the quote is theirs to have created, and the
 *    counterparty's protection is to decline it — refuse the swap and let it
 *    refund — which is an application-layer decision, taken where a quote
 *    actually lives, and revisable without moving anyone's address.
 *  - NOTHING IS CLAIMED WITHOUT THE PREIMAGE. Both covenant leaves sit behind
 *    the hash condition, so an underfunded lockup cannot be claimed out from
 *    under the counterparty on the covenant's say-so. The covenant's job is to
 *    stop a spend that satisfies the condition from redirecting the value; it
 *    is not to adjudicate whether the trade was fair.
 *
 * So a funding gate that compares a lockup against its quote belongs in the
 * consumer, not here. `lightning-swap-service`'s `lockupIsFunded` is that gate.
 */
/**
 * The sat half of both covenants: the output at this input's index is P2TR,
 * pays `destinationPkScript`, and carries at least the input's value.
 *
 * ONE COPY, shared by {@link enforcePayTo} and {@link enforcePayToAsset}. The
 * asset covenant used to restate these tokens inline under a comment promising
 * they matched "byte-for-byte" — a promise nothing enforced, and one that an
 * option added to one and forgotten on the other would have broken silently.
 *
 * `quotedSats` is the opt-in bound from
 * {@link VHTLC.Options.nonInteractiveClaim.strict}. It is ADDED to the
 * conservation comparison, never substituted for it: alone, `out >= quoted`
 * leaves everything above the quote unconstrained, so an overfunded lockup's
 * surplus could be routed anywhere by whoever assembles the spend.
 */
function satClause(destinationPkScript: Bytes, quotedSats?: bigint): ArkadeScriptType {
    return [
        "PUSHCURRENTINPUTINDEX",
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        destinationPkScript.subarray(2),
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        // `DUP` because the output value is needed twice: once against the
        // quote, once against the input.
        ...(quotedSats === undefined
            ? []
            : (["DUP", quotedSats, "GREATERTHANOREQUAL", "VERIFY"] as ArkadeScriptType)),
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "GREATERTHANOREQUAL",
    ];
}

function enforcePayTo(destinationPkScript: Bytes, quotedSats?: bigint): Bytes {
    // validateOptions already checked this for both current call sites — kept
    // here too, since this covenant is the one place a wrong destination
    // becomes irreversible (a mis-typed leaf, unlike a rejected constructor
    // call, only surfaces once someone tries to spend it).
    if (!isP2trPkScript(destinationPkScript)) {
        throw new Error("invalid P2TR script");
    }
    return ArkadeScript.encode(satClause(destinationPkScript, quotedSats));
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
    /** @see VHTLC.Options.nonInteractiveClaim.strict */
    strict?: { amount: bigint; assetAmount?: bigint },
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
    // REVERSED, once, here. `asset.txid` is the id in CANONICAL order -- the
    // leading 32 bytes of the serialized Asset ID, which arkd's `serializeTxHash`
    // already reversed "to match the canonical txid format". The introspection
    // opcodes match against WIRE order, which is those bytes reversed back. Push
    // the canonical bytes unflipped and the lookup reports the asset ABSENT
    // (`0 0`), so the covenant fails and the contract it guards is unspendable. Nothing in the failure says so: the emulator returns only
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
        // The quoted bound, when the caller opted in — added to the input
        // comparison below, not substituted for it. `DUP` because the output's
        // asset amount is needed twice.
        ...(strict?.assetAmount === undefined
            ? []
            : (["DUP", strict.assetAmount, "GREATERTHANOREQUAL", "VERIFY"] as ArkadeScriptType)),
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
        // ...then the sat covenant, the same tokens `enforcePayTo` emits.
        ...satClause(destinationPkScript, strict?.amount),
    ]);
}

/** Pick the covenant this contract's denomination calls for. */
function enforcePayToMaybeAsset(
    destinationPkScript: Bytes,
    asset: { txid: Bytes; groupIndex: number } | undefined,
    /**
     * Present only for the CLAIM leaf, and only when the caller opted in. The
     * refund leaf never receives one: a refund returns what arrived, so a quote
     * has no place in it — see {@link enforcePayTo}.
     */
    strict?: { amount: bigint; assetAmount?: bigint },
): Bytes {
    return asset === undefined
        ? enforcePayTo(destinationPkScript, strict?.amount)
        : enforcePayToAsset(destinationPkScript, asset, strict);
}
