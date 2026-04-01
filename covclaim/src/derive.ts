/**
 * Derives a CovVHTLC script from registration parameters.
 *
 * Reconstructs the full taproot script tree including the covenant claim leaf
 * so we can compute the taproot address and spending paths.
 */

import { hex } from "@scure/base";
import { Address, NETWORK } from "@scure/btc-signer";
import { hash160 } from "@scure/btc-signer/utils.js";
import { CovVHTLC, RestIntrospectorProvider } from "@arkade-os/sdk";
import type { CovenantRegistration, Config } from "./types.js";

export async function deriveCovVHTLC(
    reg: CovenantRegistration,
    config: Config
): Promise<{
    script: CovVHTLC.Script;
    introspectorPubkey: Uint8Array;
    taprootAddress: string;
}> {
    const introspector = new RestIntrospectorProvider(config.introspectorUrl);
    const info = await introspector.getInfo();
    const introspectorPubkey = hex.decode(info.signerPubkey);

    // Decode the claim address to extract witness version + program
    const network = networkFromConfig(config);
    const decoded = Address(network).decode(reg.claimAddress);
    if (decoded.type !== "tr" && decoded.type !== "wpkh" && decoded.type !== "wsh") {
        throw new Error(
            `Unsupported claim address type: ${decoded.type}. Must be p2wpkh, p2wsh, or p2tr.`
        );
    }

    let version: number;
    let program: Uint8Array;

    if (decoded.type === "tr") {
        version = 1;
        program = decoded.pubkey;
    } else if (decoded.type === "wpkh") {
        version = 0;
        program = decoded.hash;
    } else {
        // wsh
        version = 0;
        program = decoded.hash;
    }

    // Compute preimage hash (HASH160 = RIPEMD160(SHA256(x)))
    const preimageBytes = hex.decode(reg.preimage);
    const preimageHash = hash160(preimageBytes);

    const script = new CovVHTLC.Script(
        {
            sender: hex.decode(reg.sender),
            receiver: hex.decode(reg.receiver),
            server: hex.decode(reg.server),
            preimageHash,
            refundLocktime: BigInt(reg.refundLocktime),
            unilateralClaimDelay: {
                type: reg.unilateralClaimDelay.type,
                value: BigInt(reg.unilateralClaimDelay.value),
            },
            unilateralRefundDelay: {
                type: reg.unilateralRefundDelay.type,
                value: BigInt(reg.unilateralRefundDelay.value),
            },
            unilateralRefundWithoutReceiverDelay: {
                type: reg.unilateralRefundWithoutReceiverDelay.type,
                value: BigInt(
                    reg.unilateralRefundWithoutReceiverDelay.value
                ),
            },
            claimAddress: { version, program },
            expectedAmount: BigInt(reg.expectedAmount),
        },
        { introspectorPubkey }
    );

    const taprootAddress = script.onchainAddress(network);

    return { script, introspectorPubkey, taprootAddress };
}

function networkFromConfig(config: Config): typeof NETWORK {
    switch (config.network) {
        case "mainnet":
            return { bech32: "bc", pubKeyHash: 0x00, scriptHash: 0x05 };
        case "signet":
            return { bech32: "tb", pubKeyHash: 0x6f, scriptHash: 0xc4 };
        case "regtest":
            return { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4 };
    }
}
