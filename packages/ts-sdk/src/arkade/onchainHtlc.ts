/**
 * The Bitcoin-L1 HTLC as a {@link Program}.
 *
 * Two pure-tapscript leaves, no Arkade co-signer, NUMS internal key (via
 * {@link ArkadeProgramScript} / {@link VtxoScript}). Same tree VHTLC and
 * standing offers already compile — the corridor in `@arkade-os/swap` still
 * owns L1 spend builders, chain access and locktime policy.
 *
 * Claim condition ends in EQUALVERIFY (BOLT3). `tapscript.verify: false` skips
 * the arkd ConditionMultisig VERIFY wrap so this leaf stays byte-identical to
 * the historical `onchainHtlcScript` encoding.
 */
import {
    ArkadeProgramScript,
    SUPPORTED_PROGRAM_VERSION,
    type Program,
    type ProgramKeys,
} from "./program";

/** Fixed-shape L1 HTLC — claim (hash + key) and refund (CLTV + key). */
export const ONCHAIN_HTLC_PROGRAM: Program = {
    version: SUPPORTED_PROGRAM_VERSION,
    name: "onchain-htlc",
    params: [
        { name: "preimageHash", type: "hash" },
        { name: "claimKey", type: "pubkey" },
        { name: "refundKey", type: "pubkey" },
        { name: "refundLocktime", type: "int" },
    ],
    functions: {
        claim: {
            inputs: [{ name: "preimage", type: "bytes" }],
            tapscript: {
                signers: ["$claimKey"],
                asm: ["SIZE", 32, "EQUALVERIFY", "HASH160", "$preimageHash", "EQUALVERIFY"],
                verify: false,
                witness: ["preimage"],
            },
        },
        refund: {
            tapscript: {
                signers: ["$refundKey"],
                cltv: "$refundLocktime",
            },
        },
    },
};

export interface OnchainHtlcProgramParams {
    /** HASH160 commitment — `ripemd160(sha256(P))`, 20 bytes. */
    preimageHash: Uint8Array;
    /** x-only key that claims with the preimage. */
    claimKey: Uint8Array;
    /** x-only key that refunds after the locktime. */
    refundKey: Uint8Array;
    /** Absolute locktime (height or unix seconds — BIP65). */
    refundLocktime: bigint | number;
}

/** L1-only: no Arkade Service signer, no emulator co-signer. */
const ONCHAIN_HTLC_KEYS: ProgramKeys = {};

/**
 * Compile the L1 HTLC Program. Address encoding stays with the caller
 * (`script.onchainAddress(network)`) so this module does not pick an HRP.
 */
export function compileOnchainHtlc(params: OnchainHtlcProgramParams): ArkadeProgramScript {
    if (params.preimageHash.length !== 20) {
        throw new Error(`preimageHash must be 20 bytes, got ${params.preimageHash.length}`);
    }
    if (params.claimKey.length !== 32 || params.refundKey.length !== 32) {
        throw new Error("claimKey and refundKey must be 32-byte x-only keys");
    }
    return new ArkadeProgramScript(
        ONCHAIN_HTLC_PROGRAM,
        {
            preimageHash: params.preimageHash,
            claimKey: params.claimKey,
            refundKey: params.refundKey,
            refundLocktime: params.refundLocktime,
        },
        ONCHAIN_HTLC_KEYS,
    );
}
