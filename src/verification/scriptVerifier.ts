import * as bip68 from "bip68";
import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { hash160, sha256 } from "@scure/btc-signer/utils.js";
import {
    decodeTapscript,
    TapscriptType,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
} from "../script/tapscript";
import { scriptFromTapLeafScript, TapLeafScript } from "../script/base";
import type { Transaction } from "@scure/btc-signer/transaction.js";

export interface ScriptVerificationResult {
    txid: string;
    inputIndex: number;
    scriptType: TapscriptType;
    timelockSatisfied: boolean;
    signaturesSatisfied: boolean;
    hashPreimageSatisfied: boolean;
    errors: string[];
}

export interface TimelockCheck {
    type: "csv" | "cltv";
    required: bigint;
    actual: bigint;
    satisfied: boolean;
}

/**
 * Verifies that a transaction input's spending conditions are satisfiable
 * given the current chain state.
 *
 * Checks:
 * - CSV (CHECKSEQUENCEVERIFY): nSequence matches required relative timelock
 * - CLTV (CHECKLOCKTIMEVERIFY): nLockTime meets required absolute timelock
 * - Hash preimage: witness preimage hashes to expected value
 * - Signatures: tapScriptSig entries exist for required pubkeys
 *
 * @param tx - The transaction to verify
 * @param inputIndex - The input index to check
 * @param chainTip - Current chain tip height and time
 * @param parentConfirmationHeight - Block height at which the parent tx was confirmed (for CSV checks)
 */
export function verifyScriptSatisfaction(
    tx: Transaction,
    inputIndex: number,
    chainTip: { height: number; time: number },
    parentConfirmationHeight?: number
): ScriptVerificationResult {
    const errors: string[] = [];
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        return {
            txid: tx.id,
            inputIndex,
            scriptType: TapscriptType.Multisig,
            timelockSatisfied: false,
            signaturesSatisfied: false,
            hashPreimageSatisfied: false,
            errors: ["No tapLeafScript on input"],
        };
    }

    // Use the first tapLeafScript
    const tapLeaf = input.tapLeafScript[0];
    const rawScript = scriptFromTapLeafScript(tapLeaf);

    let decoded;
    try {
        decoded = decodeTapscript(rawScript);
    } catch (err) {
        return {
            txid: tx.id,
            inputIndex,
            scriptType: TapscriptType.Multisig,
            timelockSatisfied: false,
            signaturesSatisfied: false,
            hashPreimageSatisfied: false,
            errors: [
                `Failed to decode tapscript: ${err instanceof Error ? err.message : String(err)}`,
            ],
        };
    }

    let timelockSatisfied = true;
    let hashPreimageSatisfied = true;

    // Check CSV timelock
    if (
        CSVMultisigTapscript.is(decoded) ||
        ConditionCSVMultisigTapscript.is(decoded)
    ) {
        const timelock = CSVMultisigTapscript.is(decoded)
            ? decoded.params.timelock
            : (decoded as ConditionCSVMultisigTapscript.Type).params.timelock;

        const inputSequence = input.sequence ?? 0xffffffff;

        // BIP-68: sequence must signal relative timelock (bit 31 clear)
        if (inputSequence & 0x80000000) {
            timelockSatisfied = false;
            errors.push(
                `CSV: nSequence (0x${inputSequence.toString(16)}) has disable flag set`
            );
        } else {
            // Decode the sequence to get the actual relative lock
            try {
                const decodedSeq = bip68.decode(inputSequence);
                if (timelock.type === "blocks") {
                    const actualBlocks = BigInt(decodedSeq.blocks ?? 0);
                    if (actualBlocks < timelock.value) {
                        timelockSatisfied = false;
                        errors.push(
                            `CSV: sequence encodes ${actualBlocks} blocks, need ${timelock.value}`
                        );
                    }
                    // Also check against chain state if parent height is known
                    if (parentConfirmationHeight !== undefined) {
                        const elapsed = BigInt(
                            chainTip.height - parentConfirmationHeight
                        );
                        if (elapsed < timelock.value) {
                            timelockSatisfied = false;
                            errors.push(
                                `CSV: only ${elapsed} blocks elapsed since parent confirmation, need ${timelock.value}`
                            );
                        }
                    }
                } else {
                    const actualSeconds = BigInt(decodedSeq.seconds ?? 0);
                    if (actualSeconds < timelock.value) {
                        timelockSatisfied = false;
                        errors.push(
                            `CSV: sequence encodes ${actualSeconds}s, need ${timelock.value}s`
                        );
                    }
                }
            } catch {
                timelockSatisfied = false;
                errors.push(
                    `CSV: failed to decode nSequence (${inputSequence})`
                );
            }
        }
    }

    // Check CLTV timelock
    if (CLTVMultisigTapscript.is(decoded)) {
        const requiredLocktime = decoded.params.absoluteTimelock;
        const txLockTime = BigInt(tx.lockTime ?? 0);

        if (txLockTime < requiredLocktime) {
            timelockSatisfied = false;
            errors.push(
                `CLTV: nLockTime (${txLockTime}) < required (${requiredLocktime})`
            );
        }

        // Check against chain state
        const nLocktimeMinSeconds = 500_000_000n;
        if (requiredLocktime >= nLocktimeMinSeconds) {
            // Time-based: compare with chain tip time
            if (BigInt(chainTip.time) < requiredLocktime) {
                timelockSatisfied = false;
                errors.push(
                    `CLTV: chain tip time (${chainTip.time}) < required locktime (${requiredLocktime})`
                );
            }
        } else {
            // Height-based: compare with chain tip height
            if (BigInt(chainTip.height) < requiredLocktime) {
                timelockSatisfied = false;
                errors.push(
                    `CLTV: chain tip height (${chainTip.height}) < required locktime (${requiredLocktime})`
                );
            }
        }
    }

    // Check hash preimage conditions
    if (
        ConditionCSVMultisigTapscript.is(decoded) ||
        ConditionMultisigTapscript.is(decoded)
    ) {
        const conditionScript = decoded.params.conditionScript;
        const preimageCheck = verifyHashPreimage(conditionScript, input);
        if (!preimageCheck.satisfied) {
            hashPreimageSatisfied = false;
            if (preimageCheck.error) {
                errors.push(preimageCheck.error);
            }
        }
    }

    // Check signatures exist
    const hasSigs =
        input.tapScriptSig !== undefined && input.tapScriptSig.length > 0;
    const requiredPubkeys = decoded.params.pubkeys?.length ?? 0;
    const actualSigs = input.tapScriptSig?.length ?? 0;
    const signaturesSatisfied = hasSigs && actualSigs >= requiredPubkeys;

    if (!signaturesSatisfied) {
        errors.push(`Signatures: have ${actualSigs}, need ${requiredPubkeys}`);
    }

    return {
        txid: tx.id,
        inputIndex,
        scriptType: decoded.type,
        timelockSatisfied,
        signaturesSatisfied,
        hashPreimageSatisfied,
        errors,
    };
}

interface PreimageCheckResult {
    satisfied: boolean;
    error?: string;
}

/**
 * Verifies a hash preimage condition from the condition script.
 *
 * Supports:
 * - OP_HASH160 <hash> OP_EQUAL (HTLC-style, 20-byte hash)
 * - OP_SHA256 <hash> OP_EQUAL (32-byte hash)
 */
function verifyHashPreimage(
    conditionScript: Uint8Array,
    input: ReturnType<Transaction["getInput"]>
): PreimageCheckResult {
    let asm;
    try {
        asm = Script.decode(conditionScript);
    } catch {
        return {
            satisfied: false,
            error: "Hash preimage: failed to decode condition script",
        };
    }

    // Look for HASH160 <hash> EQUAL or SHA256 <hash> EQUAL
    let hashOp: "HASH160" | "SHA256" | null = null;
    let expectedHash: Uint8Array | null = null;

    for (let i = 0; i < asm.length - 2; i++) {
        if (
            (asm[i] === "HASH160" || asm[i] === "SHA256") &&
            typeof asm[i + 1] !== "string" &&
            typeof asm[i + 1] !== "number" &&
            asm[i + 2] === "EQUAL"
        ) {
            hashOp = asm[i] as "HASH160" | "SHA256";
            expectedHash = asm[i + 1] as Uint8Array;
            break;
        }
    }

    if (!hashOp || !expectedHash) {
        // No hash condition found in script, that's OK (condition might be something else)
        return { satisfied: true };
    }

    // Look for the preimage in the condition witness
    // The preimage should be in the input's conditionWitness or tapScriptSig witness stack
    const witness = extractConditionWitness(input);
    if (!witness || witness.length === 0) {
        return {
            satisfied: false,
            error: `Hash preimage: no witness data found for ${hashOp} condition`,
        };
    }

    // The preimage is typically the first witness element
    const preimage = witness[0];
    if (!preimage || preimage.length === 0) {
        return {
            satisfied: false,
            error: `Hash preimage: empty preimage in witness`,
        };
    }

    // Hash the preimage and compare
    let computedHash: Uint8Array;
    if (hashOp === "HASH160") {
        computedHash = hash160(preimage);
    } else {
        computedHash = sha256(preimage);
    }

    if (hex.encode(computedHash) !== hex.encode(expectedHash)) {
        return {
            satisfied: false,
            error: `Hash preimage: ${hashOp}(preimage) = ${hex.encode(computedHash).slice(0, 16)}... does not match expected ${hex.encode(expectedHash).slice(0, 16)}...`,
        };
    }

    return { satisfied: true };
}

/**
 * Extracts condition witness data from a transaction input.
 * Looks for Ark PSBT condition witness field or falls back to finalScriptWitness.
 */
function extractConditionWitness(
    input: ReturnType<Transaction["getInput"]>
): Uint8Array[] | null {
    // Check for Ark-specific condition witness in unknown fields
    if (input.unknown) {
        for (const [key, value] of input.unknown) {
            // ArkPsbtFieldKeyType = 222, ArkPsbtFieldKey.ConditionWitness = "condition"
            if (key.type === 222) {
                try {
                    return [value];
                } catch {
                    continue;
                }
            }
        }
    }

    // Fall back to finalScriptWitness
    if (input.finalScriptWitness && input.finalScriptWitness.length > 0) {
        return Array.from(input.finalScriptWitness);
    }

    return null;
}
