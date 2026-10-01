import { Bytes } from "@scure/btc-signer/utils.js";
import { RelativeTimelock } from "./tapscript";
import { hex } from "@scure/base";
import { TapLeafScript } from "./base";
import { ArkadeProgramScript } from "../arkade/program";
import { vhtlcBinding, type VhtlcVersion } from "./vhtlcProgram";

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
         * The emulator covenant leaves, ALL OR NOTHING. Present, this adds the
         * three non-interactive leaves the emulator co-signs under a covenant
         * pinning the payout to a pre-committed destination:
         *
         *  - `nonInteractiveClaim`: `server` + a covenant-tweaked emulator
         *    co-signer, paying `receiverPkScript` — the receiver's claim can
         *    be pushed without the receiver being online.
         *  - `nonInteractiveRefund`: `server` + `receiver` + a covenant-tweaked
         *    emulator co-signer, paying `senderPkScript`, no timelock — lets
         *    server and receiver release the refund the moment they agree the
         *    swap has failed, and recoverable even if the sender's own key is
         *    lost, since no OTHER refund-side leaf survives that.
         *  - `nonInteractiveRefundWithoutReceiver`: `server` + the SAME
         *    covenant-tweaked co-signer as `nonInteractiveRefund`, paying
         *    `senderPkScript` after `refundLocktime` — the only refund tier
         *    needing no participant signature at all, so a sender who funded
         *    a lockup and vanished is refundable through it alone.
         *
         * WHY ONE FLAG AND NOT A SWITCH PER LEAF. The three are one mechanism
         * — the same emulator key, the same `enforcePayTo` covenant pointed
         * at a per-role destination — and they protect opposite directions of
         * the same swap, so no real configuration wants a subset. A subset
         * would cost, not buy: every optional leaf multiplies the tree shapes
         * a counterparty must derive to verify an address (nothing on the
         * wire says which leaves a quote carries), so per-leaf toggling turns
         * one address comparison into a combinatorial guess. All-or-nothing
         * keeps the shape count at two: suite, or no suite.
         *
         * Leaf order fixes the taproot merkle root, so the suite is appended
         * after the six signature leaves in a fixed order (claim, refund,
         * timelocked refund) and a script built with this option NEVER
         * collides with one built without it — which is what makes "did this
         * quote opt in" a question an address comparison answers.
         *
         * STABLE PER RELEASE: what this option builds does not change within
         * a published SDK version. A future covenant leaf joins the suite
         * only behind a NEW option, so re-deriving a lockup with the SDK
         * that quoted it reproduces its address byte-for-byte.
         */
        nonInteractiveParameters?: {
            /**
             * The emulator service's public key, 32-byte x-only or 33-byte
             * compressed. ONE key, tweaked per covenant destination, becomes
             * the co-signer of every leaf in the suite — the leaves share it
             * structurally, and BIP-341 tapscript sighashes committing to the
             * tapleaf hash are what keep a signature for one leaf from
             * replaying against another.
             */
            emulatorPubkey: Bytes;
            /**
             * Where the claim covenant pays: the receiver's own P2TR
             * pkScript, 34 bytes.
             */
            receiverPkScript: Bytes;
            /**
             * Where BOTH refund covenants pay: the sender's own P2TR
             * pkScript, 34 bytes. One destination shared by both refund
             * leaves, so they cannot diverge on where a refund goes.
             */
            senderPkScript: Bytes;
            /**
             * LEGACY REBUILD ONLY — never for a new lockup.
             *
             * `"preTimelockedRefund"` builds the suite WITHOUT its timelocked
             * refund leaf: the shape every emulator-covenant lockup funded
             * before that leaf shipped carries. Lockups already funded in that
             * shape keep it permanently — a leaf cannot be retrofitted onto an
             * address already committed — so re-deriving such a lockup (to
             * spend it, or to verify an old quote's address) needs this. A new
             * lockup that omits the leaf gives up the one refund tier needing
             * nobody, for nothing.
             */
            legacy?: "preTimelockedRefund";
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

    /** Compile options to a Program binding — what {@link Script} / {@link ScriptV2} compile. */
    export const binding = vhtlcBinding;

    /**
     * Shared construction and accessors for every VHTLC script version.
     *
     * Compiles through {@link ArkadeProgramScript} from {@link vhtlcBinding} —
     * V1/V2 is which Program the binding builds, not a parallel encoder.
     */
    abstract class BaseScript extends ArkadeProgramScript {
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

        protected constructor(options: Options, version: VhtlcVersion) {
            validateOptions(options);
            const { program, args, keys } = vhtlcBinding(options, version);
            super(program, args, keys);

            this.options = options;
            this.claimScript = hex.encode(this.functionByName("claim")!.leafScript);
            this.refundScript = hex.encode(this.functionByName("refund")!.leafScript);
            this.refundWithoutReceiverScript = hex.encode(
                this.functionByName("refundWithoutReceiver")!.leafScript,
            );
            this.unilateralClaimScript = hex.encode(
                this.functionByName("unilateralClaim")!.leafScript,
            );
            this.unilateralRefundScript = hex.encode(
                this.functionByName("unilateralRefund")!.leafScript,
            );
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                this.functionByName("unilateralRefundWithoutReceiver")!.leafScript,
            );

            const nic = this.functionByName("nonInteractiveClaim");
            if (nic?.arkadeScript) {
                this.nonInteractiveClaimScript = hex.encode(nic.leafScript);
                this.nonInteractiveClaimArkadeScript = nic.arkadeScript;
            }
            const nir = this.functionByName("nonInteractiveRefund");
            if (nir?.arkadeScript) {
                this.nonInteractiveRefundScript = hex.encode(nir.leafScript);
                this.nonInteractiveRefundArkadeScript = nir.arkadeScript;
            }
            const nirwor = this.functionByName("nonInteractiveRefundWithoutReceiver");
            if (nirwor?.arkadeScript) {
                this.nonInteractiveRefundWithoutReceiverScript = hex.encode(nirwor.leafScript);
                this.nonInteractiveRefundWithoutReceiverArkadeScript = nirwor.arkadeScript;
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
         * SPENDING THIS LEAF, CONCRETELY — confirmed from this SDK's own
         * emulator client and covenant-spend builder ({@link
         * EmulatorProvider} in `src/providers/emulator.ts`, and {@link
         * ArkadeTransactionBuilder} in `src/arkade/contract.ts`), which is
         * the general machinery every covenant leaf in this file goes
         * through:
         *
         *  1. Build the ark tx spending this leaf (this method's {@link
         *     TapLeafScript} as `tapLeafScript`, this script's {@link
         *     VtxoScript.encode} as `tapTree`), plus its checkpoint tx.
         *  2. Attach the ArkadeScript this method returns to the spent
         *     input via an `EmulatorPacket` (type 1) — `{ vin, script:
         *     <this ArkadeScript>, witness: <empty> }`, empty because the
         *     script pushes its own input/output index with
         *     `PUSHCURRENTINPUTINDEX` rather than reading one from the
         *     witness — wrapped in an `Extension` OP_RETURN output on the
         *     ark tx.
         *  3. Attach the spent input's OWN creating ark tx as `PrevArkTx` on
         *     input 0 — required so the emulator can resolve that input's
         *     prevout pkScript/value; it does not otherwise have them.
         *  4. POST the (base64-PSBT) ark tx and checkpoint(s) as `{ arkTx,
         *     checkpointTxs }` to the emulator's `POST /v1/tx`.
         *
         * THE COVENANT CHECK the emulator runs against that ArkadeScript —
         * `enforcePayTo(senderPkScript)`, see that function above — is: the
         * output at this SAME input's index is a v1 P2TR output paying
         * `senderPkScript`, with a value at least the input's. Only on that
         * check passing does the emulator sign for `nirCosigner` (the
         * `emulatorPubkey` tweaked by this ArkadeScript's hash); the
         * response carries the fully co-signed `signedArkTx` and
         * `signedCheckpointTxs` — `ArkadeTransactionBuilder.send()`'s own
         * comment on this path: "the emulator executes the arkade script
         * and finalizes with arkd" — no separate call to arkd is made by
         * this SDK for a covenant spend.
         * Neither `server` nor `receiver` play any part in that check: this
         * leaf's tapscript still requires `server`'s own signature
         * alongside `nirCosigner`'s (see the class doc above), but that is
         * consensus-level multisig, not something the covenant enforces.
         *
         * NOT SPENDABLE UNTIL `refundLocktime` MATURES — the tapscript's
         * `OP_CHECKLOCKTIMEVERIFY` is arkd's concern, not the emulator's;
         * the emulator will happily co-sign an immature spend and arkd will
         * then refuse it. A block-height-typed `refundLocktime` (below the
         * standard height/timestamp boundary this SDK names
         * `CLTV_HEIGHT_THRESHOLD`, 500,000,000, in
         * `src/contracts/handlers/helpers.ts`) is refused by arkd for a
         * forfeit-eligible leaf independent of maturity — use a
         * seconds-typed (absolute Unix timestamp) value.
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
     * - **nonInteractiveClaim** (with `nonInteractiveParameters`): server + emulator
     *   can push the receiver's claim, pinned to a pre-committed destination
     * - **nonInteractiveRefund** (with `nonInteractiveParameters`): server + receiver
     *   + emulator can push the sender's refund immediately, no timelock,
     *   pinned to a pre-committed destination — recoverable even if the
     *   sender's own key is lost
     * - **nonInteractiveRefundWithoutReceiver** (with `nonInteractiveParameters`):
     *   server + emulator can push the sender's refund after `refundLocktime`,
     *   pinned to a pre-committed destination — the only refund tier needing
     *   no participant signature at all
     *
     * See {@link ScriptV2} for the current recommended construction — same
     * leaf ladder, same options shape, an added length check on the claim
     * preimage. This class is unchanged and stays available as-is.
     *
     * **Pre-existing limitation: the `vhtlc` contract handler registers none
     * of the covenant leaves.** `nonInteractiveParameters` builds on this class
     * exactly as it does on {@link ScriptV2} — both extend the same
     * `BaseScript` where those leaves are constructed. But the `vhtlc`
     * contract handler (`src/contracts/handlers/vhtlc.ts`) round-trips none
     * of them: its params type carries no covenant fields, and
     * `createScript` only ever builds the six signature-only leaves. A V1
     * script built with the covenant suite therefore compiles and can
     * be funded, but cannot be registered as a `vhtlc` contract — the
     * handler would derive a different (six-leaf) script for the same
     * params and `ContractManager` refuses the mismatch. Register through
     * the `vhtlc-v2` handler instead, which round-trips the suite.
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
            super(options, "v1");
        }
    }

    /**
     * Same leaf ladder as {@link Script}, with a BOLT3-style `OP_SIZE 32
     * OP_EQUALVERIFY` prefix on every preimage-gated leaf (`claim`,
     * `unilateralClaim`, and `nonInteractiveClaim`). A distinct class rather
     * than a flag on {@link Script}: the two produce different script bytes
     * (and so different addresses) for the same participant keys.
     */
    export class ScriptV2 extends BaseScript {
        constructor(options: Options) {
            super(options, "v2");
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
        // The non-interactive leaves are the ONLY ones carrying a covenant
        // — the signature leaves assert nothing about value — so they are the
        // only place an asset can be bound. Accepting `asset` without the
        // covenant suite would emit a sat-only contract and say nothing about
        // it: the caller funds it believing the asset is protected, and any
        // spend that satisfies the sat covenant walks off with the asset. The
        // one outward difference is a pkScript matching a non-asset address,
        // which is not something a caller thinks to check. Refuse instead of
        // dropping it.
        if (options.asset !== undefined && !options.nonInteractiveParameters) {
            throw new Error("asset has no effect without nonInteractiveParameters");
        }
        if (options.asset !== undefined) {
            if (options.asset.txid.length !== 32) {
                throw new Error(`asset txid must be 32 bytes, got ${options.asset.txid.length}`);
            }
            if (
                !Number.isInteger(options.asset.groupIndex) ||
                options.asset.groupIndex < 0 ||
                options.asset.groupIndex > 0xffff
            ) {
                throw new Error(
                    `asset group index must be an integer in [0, 65535], got ${options.asset.groupIndex}`,
                );
            }
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
            // One literal is the whole point of the field (see its doc
            // comment); anything else is a caller inventing a shape that does
            // not exist, and TS types are no check at all from JS.
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

function isP2trPkScript(pkScript: Bytes): boolean {
    return pkScript.length === 34 && pkScript[0] === 0x51 && pkScript[1] === 0x20;
}

export { vhtlcBinding, type VhtlcBinding, type VhtlcVersion } from "./vhtlcProgram";
