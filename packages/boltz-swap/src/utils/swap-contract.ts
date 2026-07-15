/**
 * Pure mapper: converts a persisted BoltzSwap into the CreateContractParams
 * shape that ContractManager.createContract() accepts.
 *
 * This module is intentionally dependency-free from ArkadeSwaps — it takes
 * only the swap object and ArkInfo (both already available at call sites) and
 * produces a value object, making it straightforwardly testable.
 *
 * The resolver loop mirrors the private `ArkadeSwaps.resolveVHTLCForLockup`
 * method, extracted here as a shared free function (`resolveSwapVhtlc`) so
 * the mapper and the class can stay in sync without duplicating the logic.
 */
import { hex } from "@scure/base";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { ArkInfo, CreateContractParams, VHTLCContractHandler, VHTLC } from "@arkade-os/sdk";
import type { VHTLCContractParams, IContractManager, Contract } from "@arkade-os/sdk";
import { BoltzSwap } from "../types";
import { candidateServerPubkeys, createVHTLCScript } from "./vhtlc";
import { normalizeToXOnlyKey } from "./signatures";

/**
 * Per-swap-type field extraction result.
 *
 * These are the inputs that vary between swap types before the common VHTLC
 * construction step.
 */
interface SwapVhtlcInputs {
    /** SHA256 preimage hash bytes (the raw 32-byte digest, NOT yet RIPEMD160'd). */
    preimageHashBytes: Uint8Array;
    /** X-only or compressed receiver public key hex (normalised internally). */
    receiverPubkey: string;
    /** X-only or compressed sender public key hex (normalised internally). */
    senderPubkey: string;
    timeoutBlockHeights: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
    };
    lockupAddress: string;
}

/**
 * Extracts the VHTLC construction inputs for each swap type.
 *
 * Role assignments mirror the private `ArkadeSwaps.resolveVHTLCForLockup`
 * call sites:
 *
 * | Swap type        | receiver              | sender                             | lockupAddress                      |
 * |------------------|-----------------------|------------------------------------|------------------------------------|
 * | reverse          | wallet (claimPubkey)  | Boltz (response.refundPublicKey)   | response.lockupAddress             |
 * | submarine        | Boltz (claimPubkey)   | wallet (request.refundPublicKey)   | response.address                   |
 * | chain (BTC→ARK)  | wallet (claimPubkey)  | Boltz (claimDetails.serverPubkey)  | claimDetails.lockupAddress         |
 * | chain (ARK→BTC)  | Boltz (claimDetails.serverPubkey) | wallet (refundPublicKey) | lockupDetails.lockupAddress    |
 */
const extractSwapVhtlcInputs = (swap: BoltzSwap): SwapVhtlcInputs => {
    switch (swap.type) {
        case "reverse": {
            const { refundPublicKey, lockupAddress, timeoutBlockHeights } = swap.response;
            if (!refundPublicKey || !lockupAddress || !timeoutBlockHeights) {
                throw new Error(
                    `Swap ${swap.id}: incomplete reverse swap response (missing refundPublicKey, lockupAddress, or timeoutBlockHeights)`,
                );
            }
            return {
                preimageHashBytes: hex.decode(swap.request.preimageHash),
                receiverPubkey: swap.request.claimPublicKey,
                senderPubkey: refundPublicKey,
                timeoutBlockHeights,
                lockupAddress,
            };
        }

        case "submarine": {
            const { claimPublicKey, address, timeoutBlockHeights } = swap.response;
            const preimageHash = swap.preimageHash;
            if (!claimPublicKey || !address || !timeoutBlockHeights) {
                throw new Error(
                    `Swap ${swap.id}: incomplete submarine swap response (missing claimPublicKey, address, or timeoutBlockHeights)`,
                );
            }
            if (!preimageHash) {
                throw new Error(
                    `Swap ${swap.id}: preimage hash is required for submarine swap contract registration`,
                );
            }
            return {
                preimageHashBytes: hex.decode(preimageHash),
                receiverPubkey: claimPublicKey,
                senderPubkey: swap.request.refundPublicKey,
                timeoutBlockHeights,
                lockupAddress: address,
            };
        }

        case "chain": {
            // Determine which side is ARK to identify the VHTLC lockup address.
            const isFromArk = swap.request.from === "ARK";
            if (isFromArk) {
                // ARK → BTC: user sends ARK, Boltz claims; user is sender, Boltz server is receiver.
                const { lockupDetails } = swap.response;
                if (!lockupDetails?.timeouts) {
                    throw new Error(
                        `Swap ${swap.id}: missing lockupDetails or timeouts for ARK→BTC chain swap`,
                    );
                }
                return {
                    preimageHashBytes: hex.decode(swap.request.preimageHash),
                    receiverPubkey: lockupDetails.serverPublicKey,
                    senderPubkey: swap.request.refundPublicKey,
                    timeoutBlockHeights: lockupDetails.timeouts,
                    lockupAddress: lockupDetails.lockupAddress,
                };
            } else {
                // BTC → ARK: Boltz locks on BTC side; user claims on ARK side (claimDetails).
                const { claimDetails } = swap.response;
                if (!claimDetails?.timeouts) {
                    throw new Error(
                        `Swap ${swap.id}: missing claimDetails or timeouts for BTC→ARK chain swap`,
                    );
                }
                return {
                    preimageHashBytes: hex.decode(swap.request.preimageHash),
                    receiverPubkey: swap.request.claimPublicKey,
                    senderPubkey: claimDetails.serverPublicKey,
                    timeoutBlockHeights: claimDetails.timeouts,
                    lockupAddress: claimDetails.lockupAddress,
                };
            }
        }
    }
};

/**
 * Reconstruct a swap's VHTLC by matching the stored lockup address across the
 * current and deprecated server signers in `arkInfo`.
 *
 * Extracted from the private `ArkadeSwaps.resolveVHTLCForLockup` method so
 * the mapper can use it without going through the class, keeping this module
 * pure (no `this` / provider calls).
 *
 * @returns The matched VHTLC script, its address, and the server x-only pubkey
 *   it was built under (which may be a deprecated signer).
 * @throws if no candidate matches the stored lockup address.
 */
export const resolveSwapVhtlc = (args: {
    arkInfo: ArkInfo;
    preimageHashBytes: Uint8Array;
    receiverPubkey: string;
    senderPubkey: string;
    timeoutBlockHeights: SwapVhtlcInputs["timeoutBlockHeights"];
    lockupAddress: string;
    swapId: string;
}): { vhtlcScript: VHTLC.Script; vhtlcAddress: string; serverXOnlyPublicKey: Uint8Array } => {
    const candidates = candidateServerPubkeys(args.arkInfo);
    for (const serverPubkey of candidates) {
        const { vhtlcScript, vhtlcAddress } = createVHTLCScript({
            network: args.arkInfo.network,
            preimageHash: args.preimageHashBytes,
            receiverPubkey: args.receiverPubkey,
            senderPubkey: args.senderPubkey,
            serverPubkey,
            timeoutBlockHeights: args.timeoutBlockHeights,
        });
        if (vhtlcAddress !== args.lockupAddress) continue;
        // Note: createVHTLCScript (vhtlc.ts:110) already throws if claimScript is
        // absent, so no redundant guard is needed here.
        return {
            vhtlcScript,
            vhtlcAddress,
            serverXOnlyPublicKey: normalizeToXOnlyKey(hex.decode(serverPubkey), "server"),
        };
    }
    throw new Error(
        `Swap ${args.swapId}: VHTLC address mismatch. Expected ${args.lockupAddress}; ` +
            `no current or deprecated server signer (${candidates.length} candidate(s) tried) ` +
            `reproduced it`,
    );
};

/**
 * Maps a persisted BoltzSwap to a `CreateContractParams` for the SDK's
 * ContractManager.
 *
 * The returned value is a pure data object — no side effects, no network
 * calls.  Callers are responsible for passing it to
 * `contractManager.createContract()`.
 *
 * @param swap - The swap whose ARK-side VHTLC should be registered.
 * @param arkInfo - Current ArkInfo (with `deprecatedSigners`) so that swaps
 *   created under a now-rotated signer are still resolved correctly.
 * @returns A `CreateContractParams` with `type: "vhtlc"`, serialized params,
 *   script, address, state, and metadata.
 * @throws if the swap response is incomplete or no server signer matches the
 *   stored lockup address.
 */
export const swapToContractParams = (swap: BoltzSwap, arkInfo: ArkInfo): CreateContractParams => {
    const inputs = extractSwapVhtlcInputs(swap);

    const { vhtlcScript, vhtlcAddress, serverXOnlyPublicKey } = resolveSwapVhtlc({
        arkInfo,
        preimageHashBytes: inputs.preimageHashBytes,
        receiverPubkey: inputs.receiverPubkey,
        senderPubkey: inputs.senderPubkey,
        timeoutBlockHeights: inputs.timeoutBlockHeights,
        lockupAddress: inputs.lockupAddress,
        swapId: swap.id,
    });

    // Build the typed VHTLCContractParams.
    // createVHTLCScript applies ripemd160 internally, so `params.hash` must
    // be the RIPEMD160 digest of the SHA256 preimage hash — not the raw SHA256.
    const receiverXOnly = normalizeToXOnlyKey(hex.decode(inputs.receiverPubkey), "receiver");
    const senderXOnly = normalizeToXOnlyKey(hex.decode(inputs.senderPubkey), "sender");
    // serverXOnlyPublicKey is the key that matched the lockup address (may be deprecated).

    const { timeoutBlockHeights: t } = inputs;
    const typedParams: VHTLCContractParams = {
        sender: senderXOnly,
        receiver: receiverXOnly,
        server: serverXOnlyPublicKey,
        // CRITICAL: createVHTLCScript applies ripemd160 internally.
        // serializeParams stores this as `params.hash`, and deserializeParams
        // reads it back without re-hashing. So we must store the RIPEMD160
        // digest here, not the raw SHA256.
        preimageHash: ripemd160(inputs.preimageHashBytes),
        refundLocktime: BigInt(t.refund),
        unilateralClaimDelay: {
            type: t.unilateralClaim < 512 ? ("blocks" as const) : ("seconds" as const),
            value: BigInt(t.unilateralClaim),
        },
        unilateralRefundDelay: {
            type: t.unilateralRefund < 512 ? ("blocks" as const) : ("seconds" as const),
            value: BigInt(t.unilateralRefund),
        },
        unilateralRefundWithoutReceiverDelay: {
            type:
                t.unilateralRefundWithoutReceiver < 512
                    ? ("blocks" as const)
                    : ("seconds" as const),
            value: BigInt(t.unilateralRefundWithoutReceiver),
        },
    };

    const serializedParams = VHTLCContractHandler.serializeParams(typedParams);

    return {
        type: "vhtlc",
        params: serializedParams,
        script: hex.encode(vhtlcScript.pkScript),
        address: vhtlcAddress,
        state: "active",
        metadata: {
            swapId: swap.id,
            swapType: swap.type,
            source: `swap:${swap.id}`,
        },
    };
};

/**
 * Registers a swap's VHTLC as a tracked contract in the SDK's ContractManager.
 *
 * Idempotent: ContractManager.createContract deduplicates on script, so calling
 * this multiple times for the same swap is safe.
 *
 * @param contractManager - The SDK ContractManager that owns contract state.
 * @param swap - The swap whose ARK-side VHTLC should be registered.
 * @param arkInfo - Current ArkInfo (with `deprecatedSigners`) for signer resolution.
 * @returns The created (or existing) Contract.
 */
export const registerSwapContract = (
    contractManager: IContractManager,
    swap: BoltzSwap,
    arkInfo: ArkInfo,
): Promise<Contract> => contractManager.createContract(swapToContractParams(swap, arkInfo));
