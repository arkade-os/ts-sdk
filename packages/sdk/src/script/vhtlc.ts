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
         * The emulator covenant leaves, ALL OR NOTHING. Adds three leaves the emulator co-signs
         * under a covenant pinning the payout to a pre-committed destination:
         *
         *  - `nonInteractiveClaim`: `server` + covenant-tweaked emulator, paying
         *    `receiverPkScript`; the claim can be pushed without the receiver online.
         *  - `nonInteractiveRefund`: `server` + `receiver` + covenant-tweaked emulator, paying
         *    `senderPkScript`, no timelock; recoverable even if the sender's key is lost.
         *  - `nonInteractiveRefundWithoutReceiver`: `server` + the SAME co-signer as
         *    `nonInteractiveRefund`, paying `senderPkScript` after `refundLocktime`; the only
         *    refund tier needing no participant signature.
         *
         * One flag, not one per leaf: nothing on the wire says which leaves a quote carries, so
         * each optional leaf multiplies the tree shapes a counterparty must derive to verify an
         * address. All-or-nothing keeps it at two.
         *
         * Leaf order fixes the merkle root: the suite is appended after the six signature leaves
         * (claim, refund, timelocked refund), so a script with it NEVER collides with one without.
         *
         * STABLE PER RELEASE: a future covenant leaf joins only behind a NEW option, so
         * re-deriving a lockup with the SDK that quoted it reproduces its address byte-for-byte.
         */
        nonInteractiveParameters?: {
            /**
             * Emulator public key, 32-byte x-only or 33-byte compressed. ONE key, tweaked per
             * covenant destination, co-signs every suite leaf; BIP-341 sighashes committing to
             * the tapleaf hash keep a signature for one leaf from replaying against another.
             */
            emulatorPubkey: Bytes;
            /** Where the claim covenant pays: the receiver's P2TR pkScript, 34 bytes. */
            receiverPkScript: Bytes;
            /**
             * Where BOTH refund covenants pay: the sender's P2TR pkScript, 34 bytes. Shared, so
             * the two refund leaves cannot diverge.
             */
            senderPkScript: Bytes;
            /**
             * LEGACY REBUILD ONLY, never for a new lockup. Builds the suite WITHOUT the
             * timelocked refund leaf, the shape of lockups funded before it shipped; a leaf can't
             * be retrofitted onto a committed address, so re-deriving those needs this.
             */
            legacy?: "preTimelockedRefund";
        };
        /**
         * Denominate this contract in an Arkade ASSET. Only the covenant (non-interactive)
         * leaves change; the signature leaves assert nothing about value.
         *
         * The covenants then also require the output to carry at least the input's amount of
         * THIS asset and exactly one asset. The sat clause is RETAINED: dropping it would let a
         * spend strip the sats, as the sat-only covenant lets a spend strip the asset.
         *
         * ONLY THE BOUND ASSET IS PROTECTED. `INSPECTOUTASSETCOUNT == 1` constrains only the
         * covenant's output; arkd's conservation rule lets extra assets on the funding VTXO be
         * routed to another output the spender chooses. Fund it with the named asset only.
         *
         * A canonical Asset ID is the pair `(genesis txid, group index)`, never a single blob.
         */
        asset?: {
            /**
             * Genesis txid, 32 bytes, in CANONICAL order (the leading 32 bytes of a serialized
             * Asset ID). Do not pre-reverse: the covenant reverses internally for the wire-order
             * opcodes, and a pre-reversed id silently makes the covenant leaves unspendable.
             */
            txid: Bytes;
            /** The asset group index within that genesis transaction. */
            groupIndex: number;
        };
    }

    /**
     * Shared construction for every VHTLC script version; versions differ only in the
     * preimage-condition fragment `claim`/`unilateralClaim`/`nonInteractiveClaim` are built from.
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

            // Computed once for every preimage-gated leaf so they can't drift within a version.
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
            let arkadeScriptNir: Bytes | undefined;
            let nonInteractiveRefundScript: Bytes | undefined;
            let nonInteractiveRefundWithoutReceiverScript: Bytes | undefined;
            const covenants = options.nonInteractiveParameters;
            if (covenants) {
                arkadeScriptNic = enforcePayToMaybeAsset(covenants.receiverPkScript, options.asset);
                nonInteractiveClaimScript = ConditionMultisigTapscript.encode({
                    conditionScript,
                    pubkeys: [
                        server,
                        computeArkadeScriptPublicKey(covenants.emulatorPubkey, arkadeScriptNic),
                    ],
                }).script;
                scripts.push(nonInteractiveClaimScript);

                arkadeScriptNir = enforcePayToMaybeAsset(covenants.senderPkScript, options.asset);
                // Derived ONCE for both refund covenant leaves: same destination, same key.
                const nirCosigner = computeArkadeScriptPublicKey(
                    covenants.emulatorPubkey,
                    arkadeScriptNir,
                );
                // No timelock, like `refund`: the covenant replaces the sender's signature and
                // still guarantees the payout can only reach the sender.
                nonInteractiveRefundScript = MultisigTapscript.encode({
                    pubkeys: [server, receiver, nirCosigner],
                }).script;
                scripts.push(nonInteractiveRefundScript);

                if (covenants.legacy !== "preTimelockedRefund") {
                    // `refundWithoutReceiver` with the covenant replacing the sender's signature.
                    // Last, because leaf order fixes the merkle root.
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

        /**
         * Return the timelocked non-interactive refund tapleaf and its ArkadeScript.
         *
         * Spent through the generic covenant path ({@link EmulatorProvider},
         * {@link ArkadeTransactionBuilder}): build the ark tx on this leaf plus its checkpoint;
         * attach this ArkadeScript to the input in an `EmulatorPacket` (type 1, empty witness:
         * the script pushes its own index with `PUSHCURRENTINPUTINDEX`) inside an `Extension`
         * OP_RETURN; attach the input's creating ark tx as `PrevArkTx` (the emulator can't
         * otherwise resolve its prevout); POST to the emulator's `/v1/tx`. The emulator co-signs
         * for `nirCosigner` only if `enforcePayTo(senderPkScript)` holds, and finalizes with arkd.
         * `server`'s signature is still required at consensus level, outside the covenant.
         *
         * The emulator does not check `refundLocktime`: it co-signs an immature spend and arkd's
         * CLTV refuses it. arkd also refuses a block-height `refundLocktime`
         * (< `CLTV_HEIGHT_THRESHOLD`, 500,000,000) on a forfeit-eligible leaf regardless of
         * maturity: use a seconds-typed (Unix timestamp) value.
         */
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
     * - **nonInteractive\*** (with `nonInteractiveParameters`): emulator covenant leaves; see
     *   {@link VHTLC.Options.nonInteractiveParameters}
     *
     * Prefer {@link ScriptV2} (same leaves and options, plus a claim-preimage length check).
     *
     * **The `vhtlc` contract handler registers none of the covenant leaves**: its params carry
     * no covenant fields, so a V1 script built with `nonInteractiveParameters` can be funded but
     * not registered (`ContractManager` refuses the six-leaf script mismatch). Use the
     * `vhtlc-v2` handler, which round-trips the suite.
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
     * {@link Script} built with {@link preimageConditionScriptV2} for every preimage-gated leaf.
     * A separate class rather than a flag: the two give different script bytes (so addresses)
     * for the same keys, which should be a compile-time-visible choice.
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
        // Only the covenant leaves can bind an asset. Without them `asset` would silently yield a
        // sat-only contract the caller funds believing the asset is protected.
        if (options.asset !== undefined && !options.nonInteractiveParameters) {
            throw new Error("asset has no effect without nonInteractiveParameters");
        }

        if (options.nonInteractiveParameters) {
            const { emulatorPubkey, receiverPkScript, senderPkScript, legacy } =
                options.nonInteractiveParameters;
            if (!emulatorPubkey || (emulatorPubkey.length !== 32 && emulatorPubkey.length !== 33)) {
                throw new Error("Invalid public key length (emulator)");
            }
            if (!receiverPkScript || !isP2trPkScript(receiverPkScript)) {
                throw new Error("Invalid P2TR script");
            }
            if (!senderPkScript || !isP2trPkScript(senderPkScript)) {
                throw new Error("Invalid P2TR script");
            }
            // TS types are no check from JS.
            if (legacy !== undefined && legacy !== "preTimelockedRefund") {
                throw new Error(
                    `nonInteractiveParameters.legacy must be "preTimelockedRefund" when set, got ${JSON.stringify(legacy)}`,
                );
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
 * {@link preimageConditionScript} plus `OP_SIZE 32 OP_EQUALVERIFY` before `OP_HASH160`, as BOLT3
 * HTLCs do: otherwise the claim leaf accepts any witness whose HASH160 matches regardless of
 * length, while this contract's preimage is always 32 bytes. Used by {@link VHTLC.ScriptV2}.
 */
function preimageConditionScriptV2(preimageHash: Bytes): Bytes {
    return Script.encode(["SIZE", 32, "EQUALVERIFY", "HASH160", preimageHash, "EQUAL"]);
}

/**
 * A v1 P2TR pkScript is exactly `OP_1 <32-byte-program>` (0x51 0x20 ...), 34 bytes. Length alone
 * isn't enough (subdust `OP_RETURN <32 bytes>` and P2WSH match it), and `enforcePayTo` trusts
 * byte 2 onward as the taproot program.
 */
function isP2trPkScript(pkScript: Bytes): boolean {
    return pkScript.length === 34 && pkScript[0] === 0x51 && pkScript[1] === 0x20;
}

/**
 * The covenant: "the output at this input's index pays the given P2TR script, value >= input",
 * shared by every {@link VHTLC.Options.nonInteractiveParameters} leaf.
 *
 * `PUSHCURRENTINPUTINDEX` imposes the input/output pairing on the spender: a tx without the
 * matching output is unsatisfiable, not fooled. Index alignment is a *liveness* obligation on
 * whoever assembles the spend (this SDK's aggregate refund uses the interactive leaf for that
 * reason, see `refund.ts`), never a safety assumption.
 *
 * `>= input`, not `>= the quoted amount`: conservation, not agreement. Pinning a quote would
 * compile it into the emulator key and so the ADDRESS, moving it on re-quote; misfunding is the
 * sender's exposure, which the counterparty answers by declining the swap; and nothing is
 * claimed without the preimage. A funding-vs-quote gate belongs in the consumer
 * (`lightning-swap-service`'s `lockupIsFunded`).
 */
/**
 * The sat half of both covenants: the output at this input's index is P2TR, pays
 * `destinationPkScript`, and carries at least the input's value. The ONE copy shared by
 * {@link enforcePayTo} and {@link enforcePayToAsset}, so they cannot drift.
 */
function satClause(destinationPkScript: Bytes): ArkadeScriptType {
    return [
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
    ];
}

function enforcePayTo(destinationPkScript: Bytes): Bytes {
    // Re-checked though validateOptions did: a wrong destination here is irreversible and only
    // surfaces at spend time.
    if (!isP2trPkScript(destinationPkScript)) {
        throw new Error("invalid P2TR script");
    }
    return ArkadeScript.encode(satClause(destinationPkScript));
}

/**
 * {@link enforcePayTo} for an asset-denominated contract: the sat covenant as its tail, plus
 * "carries at least the input's amount of exactly this one asset", so an asset contract never
 * enforces less than a sat one.
 *
 * Two opcode traps:
 *  - A canonical Asset ID is TWO stack items, `asset_txid` then `asset_gidx`; one 32-byte blob
 *    encodes fine and fails only at spend time, once funded.
 *  - `INSPECTOUTASSETLOOKUP` pushes `amount 1`, or `0 0` when ABSENT. The `VERIFY` after each
 *    lookup is load-bearing: without it an output with NONE of the asset passes `0 >= 0`. The
 *    input lookup gets one too.
 *
 * `INSPECTOUTASSETCOUNT == 1` is deliberately strict: a too-permissive covenant can't be
 * tightened once funded; a strict one can be relaxed in a later contract version.
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
    // REVERSED, once, here: `asset.txid` is canonical order (arkd's `serializeTxHash` reversed
    // it), but the introspection opcodes match WIRE order. Unflipped, the lookup reports ABSENT
    // and the emulator says only `OP_VERIFY failed` (established on regtest against a BTC-only
    // control). A copy, not in place: the caller's id is theirs.
    const inspectionTxid = Uint8Array.from(asset.txid).reverse();
    return ArkadeScript.encode([
        // The output at the input's index carries at least the input's amount of the asset.
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
        // ...then the sat covenant, the same tokens `enforcePayTo` emits.
        ...satClause(destinationPkScript),
    ]);
}

/** Pick the covenant this contract's denomination calls for. */
function enforcePayToMaybeAsset(
    destinationPkScript: Bytes,
    asset: { txid: Bytes; groupIndex: number } | undefined,
): Bytes {
    return asset === undefined
        ? enforcePayTo(destinationPkScript)
        : enforcePayToAsset(destinationPkScript, asset);
}
