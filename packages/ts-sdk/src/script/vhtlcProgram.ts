/**
 * VHTLC as a {@link Program}.
 *
 * The class in `vhtlc.ts` is a typed facade: every {@link VHTLC.Script} /
 * {@link VHTLC.ScriptV2} compiles through {@link ArkadeProgramScript} from the
 * binding this module builds. Leaf order, csv type, the optional covenant
 * suite and the asset denomination are all Program-level choices — the same
 * kind of optional-leaf append standing offers already do with `withExitClosure`.
 *
 * A static JSON artifact cannot cover the tree: csv blocks-vs-seconds is a
 * literal in the artifact format, V1/V2 differ by one condition prefix, and
 * the covenant/asset/legacy flags drop or rewrite whole functions. The binding
 * is the artifact.
 *
 * Covenant asm is conservation, not a quote: output value >= input, paying a
 * pre-committed P2TR program. Pinning a quoted amount would bake it into the
 * address.
 */
import type { VHTLC } from "./vhtlc";
import type {
    ArkadeFunction,
    ArkadeParamValue,
    AsmToken,
    InputDef,
    Program,
    ProgramKeys,
} from "../arkade/program";

/** Which preimage condition the claim-side leaves commit to. */
export type VhtlcVersion = "v1" | "v2";

/** HASH160 + EQUAL — leaves a bool for the ConditionMultisig VERIFY wrapper. */
const PREIMAGE_V1: AsmToken[] = ["HASH160", "$preimageHash", "EQUAL"];
/** BOLT3-style length gate, then the same HASH160 + EQUAL. */
const PREIMAGE_V2: AsmToken[] = ["SIZE", 32, "EQUALVERIFY", "HASH160", "$preimageHash", "EQUAL"];

/** `enforcePayTo` tokens, destination as a `$param` (32-byte x-only taproot program). */
function payToAsm(wpParam: "$receiverWP" | "$senderWP"): AsmToken[] {
    return [
        "PUSHCURRENTINPUTINDEX",
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        wpParam,
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "GREATERTHANOREQUAL",
    ];
}

/**
 * `enforcePayToAsset` tokens. `$assetTxid` is WIRE order — the binding reverses
 * the canonical Asset ID txid once, here, matching the class.
 */
function payToAssetAsm(wpParam: "$receiverWP" | "$senderWP"): AsmToken[] {
    return [
        "PUSHCURRENTINPUTINDEX",
        "$assetTxid",
        "$assetGroupIndex",
        "INSPECTOUTASSETLOOKUP",
        "VERIFY",
        "PUSHCURRENTINPUTINDEX",
        "$assetTxid",
        "$assetGroupIndex",
        "INSPECTINASSETLOOKUP",
        "VERIFY",
        "GREATERTHANOREQUAL",
        "VERIFY",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTOUTASSETCOUNT",
        1,
        "EQUALVERIFY",
        ...payToAsm(wpParam),
    ];
}

export interface VhtlcBinding {
    program: Program;
    args: Record<string, ArkadeParamValue>;
    keys: ProgramKeys;
}

/**
 * Program + args + keys for a VHTLC. {@link VHTLC.Script} / {@link VHTLC.ScriptV2}
 * compile this; callers that want the artifact (persist, inspect, round-trip)
 * can take it without constructing the class.
 *
 * Function insertion order is the leaf order, which is the merkle root.
 */
export function vhtlcBinding(options: VHTLC.Options, version: VhtlcVersion): VhtlcBinding {
    const preimageAsm = version === "v2" ? PREIMAGE_V2 : PREIMAGE_V1;
    const covenants = options.nonInteractiveParameters;
    const denomAsm = options.asset ? payToAssetAsm : payToAsm;

    const functions: Record<string, ArkadeFunction> = {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }],
            tapscript: {
                signers: ["$receiver", "$server"],
                asm: preimageAsm,
                witness: ["preimage"],
            },
        },
        refund: {
            tapscript: { signers: ["$sender", "$receiver", "$server"] },
        },
        refundWithoutReceiver: {
            tapscript: { signers: ["$sender", "$server"], cltv: "$refundLocktime" },
        },
        unilateralClaim: {
            inputs: [{ name: "preimage", type: "bytes" }],
            tapscript: {
                signers: ["$receiver"],
                asm: preimageAsm,
                csv: {
                    type: options.unilateralClaimDelay.type,
                    value: "$unilateralClaimDelay",
                },
                witness: ["preimage"],
            },
        },
        unilateralRefund: {
            tapscript: {
                signers: ["$sender", "$receiver"],
                csv: {
                    type: options.unilateralRefundDelay.type,
                    value: "$unilateralRefundDelay",
                },
            },
        },
        unilateralRefundWithoutReceiver: {
            tapscript: {
                signers: ["$sender"],
                csv: {
                    type: options.unilateralRefundWithoutReceiverDelay.type,
                    value: "$unilateralRefundWithoutReceiverDelay",
                },
            },
        },
    };

    if (covenants) {
        functions.nonInteractiveClaim = {
            inputs: [{ name: "preimage", type: "bytes" }],
            tapscript: {
                signers: ["$server"],
                asm: preimageAsm,
                witness: ["preimage"],
            },
            arkadeScript: { asm: denomAsm("$receiverWP") },
        };
        functions.nonInteractiveRefund = {
            tapscript: { signers: ["$server", "$receiver"] },
            arkadeScript: { asm: denomAsm("$senderWP") },
        };
        if (covenants.legacy !== "preTimelockedRefund") {
            functions.nonInteractiveRefundWithoutReceiver = {
                tapscript: { signers: ["$server"], cltv: "$refundLocktime" },
                arkadeScript: { asm: denomAsm("$senderWP") },
            };
        }
    }

    const params: InputDef[] = [
        { name: "sender", type: "pubkey" },
        { name: "receiver", type: "pubkey" },
        { name: "server", type: "pubkey" },
        { name: "preimageHash", type: "hash" },
        { name: "refundLocktime", type: "int" },
        { name: "unilateralClaimDelay", type: "int" },
        { name: "unilateralRefundDelay", type: "int" },
        { name: "unilateralRefundWithoutReceiverDelay", type: "int" },
    ];
    const args: Record<string, ArkadeParamValue> = {
        sender: options.sender,
        receiver: options.receiver,
        server: options.server,
        preimageHash: options.preimageHash,
        refundLocktime: options.refundLocktime,
        unilateralClaimDelay: options.unilateralClaimDelay.value,
        unilateralRefundDelay: options.unilateralRefundDelay.value,
        unilateralRefundWithoutReceiverDelay: options.unilateralRefundWithoutReceiverDelay.value,
    };

    if (covenants) {
        params.push({ name: "receiverWP", type: "pubkey" }, { name: "senderWP", type: "pubkey" });
        args.receiverWP = covenants.receiverPkScript.subarray(2);
        args.senderWP = covenants.senderPkScript.subarray(2);
        if (options.asset) {
            params.push(
                { name: "assetTxid", type: "bytes" },
                { name: "assetGroupIndex", type: "int" },
            );
            // Wire order — introspection opcodes match the serialized tx hash, not the canonical id.
            args.assetTxid = Uint8Array.from(options.asset.txid).reverse();
            args.assetGroupIndex = options.asset.groupIndex;
        }
    }

    return {
        program: {
            version: 0,
            name: version === "v2" ? "vhtlc-v2" : "vhtlc",
            params,
            functions,
        },
        args,
        keys: {
            serverKey: options.server,
            emulatorKey: covenants?.emulatorPubkey,
        },
    };
}
