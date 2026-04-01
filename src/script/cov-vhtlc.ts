import { Script } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import {
    ConditionMultisigTapscript,
    MultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    CSVMultisigTapscript,
    TapscriptType,
    RelativeTimelock,
} from "./tapscript";
import { TapLeafScript } from "./base";
import { VHTLC } from "./vhtlc";
import { ArkadeVtxoScript, ArkadeLeaf } from "../arkade/vtxoScript";
import { ArkadeScript, type ArkadeScriptType } from "../arkade/script";
import { computeArkadeScriptPublicKey } from "../arkade/tweak";

/**
 * Covenant VHTLC — extends VHTLC with a 7th covenant claim leaf.
 *
 * The covenant claim path lets anyone who knows the preimage claim the VTXO,
 * with the script enforcing (via Arkade introspection opcodes) that funds go
 * to a specific address with a specific amount. No user signature required —
 * only the introspector co-signs after validating the output constraints.
 *
 * This is the Arkade equivalent of Boltz's covenant claim on Liquid, using
 * the introspector service instead of Elements consensus-enforced opcodes.
 */
export namespace CovVHTLC {
    export interface ClaimAddress {
        /** Witness version (0 for p2wpkh/p2wsh, 1 for p2tr) */
        version: number;
        /** Witness program bytes */
        program: Uint8Array;
    }

    export interface Options extends VHTLC.Options {
        claimAddress: ClaimAddress;
        /** Satoshi amount the covenant enforces on output 0 */
        expectedAmount: bigint;
    }

    export class Script extends ArkadeVtxoScript {
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;
        readonly covenantClaimScript: string;

        constructor(
            readonly options: Options,
            opts: { introspectorPubkey: Uint8Array }
        ) {
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
                claimAddress,
                expectedAmount,
            } = options;

            const conditionScript = preimageConditionScript(preimageHash);

            // 6 standard VHTLC leaves (identical to VHTLC.Script)
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

            const unilateralRefundWithoutReceiverScript =
                CSVMultisigTapscript.encode({
                    timelock: unilateralRefundWithoutReceiverDelay,
                    pubkeys: [sender],
                }).script;

            // 7th leaf: covenant claim (Arkade-enhanced)
            // Condition: SIZE 32 EQUALVERIFY + HASH160 preimage check
            const covenantCondition = covenantPreimageCondition(preimageHash);

            // Arkade script: output introspection (enforces destination + amount)
            const arkadeScriptBytes = buildCovenantArkadeScript(
                claimAddress,
                expectedAmount
            );

            // ConditionMultisig with empty pubkeys — the introspector's tweaked
            // key is appended by ArkadeVtxoScript during tree construction.
            const covenantLeaf: ArkadeLeaf = {
                arkadeScript: arkadeScriptBytes,
                tapscript: {
                    type: TapscriptType.ConditionMultisig,
                    params: {
                        conditionScript: covenantCondition,
                        pubkeys: [],
                    },
                    script: new Uint8Array(0),
                },
            };

            super(
                [
                    claimScript,
                    refundScript,
                    refundWithoutReceiverScript,
                    unilateralClaimScript,
                    unilateralRefundScript,
                    unilateralRefundWithoutReceiverScript,
                    covenantLeaf,
                ],
                opts
            );

            // Compute the expected processed covenant leaf script for findLeaf.
            // processScripts appends the tweaked introspector key to the pubkeys,
            // so we replicate that to know the final script hex.
            const tweakedKey = computeArkadeScriptPublicKey(
                opts.introspectorPubkey,
                arkadeScriptBytes
            );
            const processedCovenantScript = ConditionMultisigTapscript.encode({
                conditionScript: covenantCondition,
                pubkeys: [tweakedKey],
            }).script;

            this.claimScript = hex.encode(claimScript);
            this.refundScript = hex.encode(refundScript);
            this.refundWithoutReceiverScript = hex.encode(
                refundWithoutReceiverScript
            );
            this.unilateralClaimScript = hex.encode(unilateralClaimScript);
            this.unilateralRefundScript = hex.encode(unilateralRefundScript);
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                unilateralRefundWithoutReceiverScript
            );
            this.covenantClaimScript = hex.encode(processedCovenantScript);
        }

        claim(): TapLeafScript {
            return this.findLeaf(this.claimScript);
        }

        refund(): TapLeafScript {
            return this.findLeaf(this.refundScript);
        }

        refundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.refundWithoutReceiverScript);
        }

        unilateralClaim(): TapLeafScript {
            return this.findLeaf(this.unilateralClaimScript);
        }

        unilateralRefund(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundScript);
        }

        unilateralRefundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundWithoutReceiverScript);
        }

        covenantClaim(): TapLeafScript {
            return this.findLeaf(this.covenantClaimScript);
        }
    }
}

/** HASH160 <preimageHash> EQUAL — same condition used by VHTLC */
function preimageConditionScript(preimageHash: Bytes): Bytes {
    return Script.encode(["HASH160", preimageHash, "EQUAL"]);
}

/**
 * SIZE 32 EQUALVERIFY HASH160 <preimageHash> EQUAL
 *
 * Matches Boltz's Liquid covenant claim design: enforce 32-byte preimage
 * before the hash check. Since the covenant path has no signature gate,
 * the SIZE check prevents grinding with non-standard preimage lengths.
 */
function covenantPreimageCondition(preimageHash: Bytes): Bytes {
    return Script.encode([
        "SIZE",
        new Uint8Array([32]),
        "EQUALVERIFY",
        "HASH160",
        preimageHash,
        "EQUAL",
    ]);
}

/**
 * Build the Arkade script that enforces output constraints via introspection.
 *
 * The introspector evaluates this script against the spending transaction:
 * - Output 0 scriptPubKey must match the expected witness version + program
 * - Output 0 value must match the expected amount
 *
 * Script (pseudo):
 *   0 INSPECTOUTPUTSCRIPTPUBKEY <version> EQUALVERIFY <program> EQUALVERIFY
 *   0 INSPECTOUTPUTVALUE DROP <amountLE64> EQUAL
 */
function buildCovenantArkadeScript(
    claimAddress: CovVHTLC.ClaimAddress,
    expectedAmount: bigint
): Uint8Array {
    const amountLE = bigintToLE64(expectedAmount);

    const ops: ArkadeScriptType = [
        // Enforce output 0 goes to the expected address
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        claimAddress.version,
        "EQUALVERIFY",
        claimAddress.program,
        "EQUALVERIFY",
        // Enforce output 0 has the expected value
        0,
        "INSPECTOUTPUTVALUE",
        "DROP", // drop prefix byte (explicit value marker)
        amountLE,
        "EQUAL",
    ];

    return ArkadeScript.encode(ops);
}

function bigintToLE64(value: bigint): Uint8Array {
    const buf = new Uint8Array(8);
    let v = value;
    for (let i = 0; i < 8; i++) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf;
}

function validateOptions(options: CovVHTLC.Options): void {
    const {
        sender,
        receiver,
        server,
        preimageHash,
        refundLocktime,
        unilateralClaimDelay,
        unilateralRefundDelay,
        unilateralRefundWithoutReceiverDelay,
        claimAddress,
        expectedAmount,
    } = options;

    // Base VHTLC validation
    if (!preimageHash || preimageHash.length !== 20) {
        throw new Error("preimage hash must be 20 bytes");
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
    validateTimelock(unilateralClaimDelay, "unilateral claim delay");
    validateTimelock(unilateralRefundDelay, "unilateral refund delay");
    validateTimelock(
        unilateralRefundWithoutReceiverDelay,
        "unilateral refund without receiver delay"
    );

    // Covenant-specific validation
    if (!claimAddress || !claimAddress.program) {
        throw new Error("claim address is required");
    }
    if (claimAddress.version !== 0 && claimAddress.version !== 1) {
        throw new Error("claim address version must be 0 or 1");
    }
    if (
        claimAddress.version === 0 &&
        claimAddress.program.length !== 20 &&
        claimAddress.program.length !== 32
    ) {
        throw new Error("witness v0 program must be 20 or 32 bytes");
    }
    if (claimAddress.version === 1 && claimAddress.program.length !== 32) {
        throw new Error("witness v1 program must be 32 bytes");
    }
    if (typeof expectedAmount !== "bigint" || expectedAmount <= 0n) {
        throw new Error("expected amount must be greater than 0");
    }
}

function validateTimelock(
    timelock: RelativeTimelock | undefined,
    name: string
): void {
    if (
        !timelock ||
        typeof timelock.value !== "bigint" ||
        timelock.value <= 0n
    ) {
        throw new Error(`${name} must greater than 0`);
    }
    if (timelock.type === "seconds" && timelock.value % 512n !== 0n) {
        throw new Error("seconds timelock must be multiple of 512");
    }
    if (timelock.type === "seconds" && timelock.value < 512n) {
        throw new Error("seconds timelock must be greater or equal to 512");
    }
}
