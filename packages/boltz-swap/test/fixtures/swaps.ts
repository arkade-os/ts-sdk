/**
 * Test fixtures for swap-contract mapper tests.
 *
 * The fixture keys are all set to the same x-only key (`signerPubkey`) so
 * that `createVHTLCScript` can derive the lockup address without a real wallet
 * identity.  Real production swaps use distinct keys — the mapper logic under
 * test is the same regardless of which keys occupy each role.
 */
import { ArkInfo } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { BoltzReverseSwap, BoltzSubmarineSwap, BoltzChainSwap } from "../../src/types";
import {
    CreateReverseSwapRequest,
    CreateSubmarineSwapResponse,
} from "../../src/boltz-swap-provider";
import { createVHTLCScript } from "../../src/utils/vhtlc";

// Deterministic test key (32-byte x-only)
const FIXTURE_SECKEY = new Uint8Array(32).fill(0x42);
const FIXTURE_XONLY_HEX = hex.encode(schnorr.getPublicKey(FIXTURE_SECKEY));
// Compressed (33-byte) form of the same key
const FIXTURE_COMPRESSED_HEX = hex.encode(pubECDSA(FIXTURE_SECKEY, true));

const FIXTURE_PREIMAGE = new Uint8Array(32).fill(0xab);
const FIXTURE_PREIMAGE_HASH = sha256(FIXTURE_PREIMAGE);

const FIXTURE_TIMEOUTS = {
    refund: 1700000000,
    unilateralClaim: 266752,
    unilateralRefund: 432128,
    unilateralRefundWithoutReceiver: 518656,
};

export const makeArkInfoFixture = (): ArkInfo =>
    ({
        signerPubkey: FIXTURE_XONLY_HEX,
        deprecatedSigners: [],
        network: "regtest",
    }) as unknown as ArkInfo;

/**
 * Reverse swap fixture (Lightning → Ark).
 *
 * Roles (mirroring ArkadeSwaps.claimVHTLC):
 *   receiver = wallet key  (= signerPubkey in fixture)
 *   sender   = Boltz key   (= signerPubkey in fixture — same for test simplicity)
 */
export const makeReverseSwapFixture = (arkInfo: ArkInfo): BoltzReverseSwap => {
    // Derive the real lockup address so the mapper can reconstruct it.
    const { vhtlcAddress } = createVHTLCScript({
        network: arkInfo.network,
        preimageHash: FIXTURE_PREIMAGE_HASH,
        receiverPubkey: FIXTURE_XONLY_HEX, // wallet key
        senderPubkey: FIXTURE_XONLY_HEX, // Boltz refund key
        serverPubkey: FIXTURE_XONLY_HEX, // ark server
        timeoutBlockHeights: FIXTURE_TIMEOUTS,
    });

    const request: CreateReverseSwapRequest = {
        claimPublicKey: FIXTURE_COMPRESSED_HEX,
        invoiceAmount: 50000,
        preimageHash: hex.encode(FIXTURE_PREIMAGE_HASH),
    };

    return {
        id: "fixture-reverse-swap-id",
        type: "reverse",
        createdAt: 1700000000,
        preimage: hex.encode(FIXTURE_PREIMAGE),
        status: "swap.created",
        request,
        response: {
            id: "fixture-reverse-swap-id",
            invoice: "lntb...",
            onchainAmount: 50000,
            lockupAddress: vhtlcAddress,
            refundPublicKey: FIXTURE_COMPRESSED_HEX,
            timeoutBlockHeights: FIXTURE_TIMEOUTS,
        },
    };
};

/**
 * Submarine swap fixture (Ark → Lightning).
 *
 * Roles (mirroring ArkadeSwaps.buildSubmarineVHTLCContext):
 *   receiver = Boltz claim key  (= signerPubkey in fixture)
 *   sender   = wallet key       (= signerPubkey in fixture — same for test simplicity)
 */
export const makeSubmarineSwapFixture = (arkInfo: ArkInfo): BoltzSubmarineSwap => {
    const { vhtlcAddress } = createVHTLCScript({
        network: arkInfo.network,
        preimageHash: FIXTURE_PREIMAGE_HASH,
        receiverPubkey: FIXTURE_XONLY_HEX, // Boltz claim key
        senderPubkey: FIXTURE_XONLY_HEX, // wallet refund key
        serverPubkey: FIXTURE_XONLY_HEX, // ark server
        timeoutBlockHeights: FIXTURE_TIMEOUTS,
    });

    const response: CreateSubmarineSwapResponse = {
        id: "fixture-submarine-swap-id",
        expectedAmount: 50000,
        address: vhtlcAddress,
        claimPublicKey: FIXTURE_COMPRESSED_HEX,
        acceptZeroConf: true,
        timeoutBlockHeights: FIXTURE_TIMEOUTS,
    };

    return {
        id: "fixture-submarine-swap-id",
        type: "submarine",
        createdAt: 1700000000,
        preimageHash: hex.encode(FIXTURE_PREIMAGE_HASH),
        status: "swap.created",
        request: {
            invoice: "lntb...",
            refundPublicKey: FIXTURE_COMPRESSED_HEX,
        },
        response,
    };
};

/**
 * Chain swap fixture (BTC → Ark).
 *
 * Roles (mirroring ArkadeSwaps.claimArk for BTC→ARK direction):
 *   receiver = wallet claim key           (= signerPubkey in fixture)
 *   sender   = Boltz claimDetails server  (= signerPubkey in fixture)
 *
 * The ARK-side VHTLC lives at claimDetails.lockupAddress.
 */
export const makeChainSwapFixture = (arkInfo: ArkInfo): BoltzChainSwap => {
    const { vhtlcAddress } = createVHTLCScript({
        network: arkInfo.network,
        preimageHash: FIXTURE_PREIMAGE_HASH,
        receiverPubkey: FIXTURE_XONLY_HEX, // wallet claim key
        senderPubkey: FIXTURE_XONLY_HEX, // Boltz server public key
        serverPubkey: FIXTURE_XONLY_HEX, // ark server
        timeoutBlockHeights: FIXTURE_TIMEOUTS,
    });

    return {
        id: "fixture-chain-swap-id",
        type: "chain",
        preimage: hex.encode(FIXTURE_PREIMAGE),
        createdAt: 1700000000,
        ephemeralKey: "ef".repeat(32),
        feeSatsPerByte: 1,
        status: "swap.created",
        amount: 50000,
        toAddress: "tark1q...",
        request: {
            to: "ARK",
            from: "BTC",
            preimageHash: hex.encode(FIXTURE_PREIMAGE_HASH),
            claimPublicKey: FIXTURE_COMPRESSED_HEX,
            refundPublicKey: FIXTURE_COMPRESSED_HEX,
            feeSatsPerByte: 1,
        },
        response: {
            id: "fixture-chain-swap-id",
            claimDetails: {
                lockupAddress: vhtlcAddress,
                amount: 50000,
                serverPublicKey: FIXTURE_COMPRESSED_HEX,
                timeoutBlockHeight: 100,
                timeouts: FIXTURE_TIMEOUTS,
            },
            lockupDetails: {
                lockupAddress: "bcrt1p...",
                amount: 50000,
                serverPublicKey: FIXTURE_COMPRESSED_HEX,
                timeoutBlockHeight: 100,
            },
        },
    };
};

/**
 * Chain swap fixture (Ark → BTC).
 *
 * Roles (mirroring the `isFromArk === true` branch in `extractSwapVhtlcInputs`):
 *   receiver = Boltz server key  (= lockupDetails.serverPublicKey in fixture)
 *   sender   = wallet refund key (= request.refundPublicKey in fixture)
 *
 * The ARK-side VHTLC lives at lockupDetails.lockupAddress (user locks ARK here,
 * Boltz claims it once it sees the BTC payment to the user's address).
 */
export const makeChainSwapFromArkFixture = (arkInfo: ArkInfo): BoltzChainSwap => {
    const { vhtlcAddress } = createVHTLCScript({
        network: arkInfo.network,
        preimageHash: FIXTURE_PREIMAGE_HASH,
        receiverPubkey: FIXTURE_XONLY_HEX, // Boltz server key (receiver on ARK side)
        senderPubkey: FIXTURE_XONLY_HEX, // wallet refund key (sender)
        serverPubkey: FIXTURE_XONLY_HEX, // ark server
        timeoutBlockHeights: FIXTURE_TIMEOUTS,
    });

    return {
        id: "fixture-chain-from-ark-swap-id",
        type: "chain",
        preimage: hex.encode(FIXTURE_PREIMAGE),
        createdAt: 1700000000,
        ephemeralKey: "ef".repeat(32),
        feeSatsPerByte: 1,
        status: "swap.created",
        amount: 50000,
        toAddress: "bcrt1q...",
        request: {
            to: "BTC",
            from: "ARK",
            preimageHash: hex.encode(FIXTURE_PREIMAGE_HASH),
            claimPublicKey: FIXTURE_COMPRESSED_HEX,
            refundPublicKey: FIXTURE_COMPRESSED_HEX,
            feeSatsPerByte: 1,
        },
        response: {
            id: "fixture-chain-from-ark-swap-id",
            claimDetails: {
                // BTC-side claim details — not the ARK VHTLC
                lockupAddress: "bcrt1p...",
                amount: 50000,
                serverPublicKey: FIXTURE_COMPRESSED_HEX,
                timeoutBlockHeight: 100,
            },
            lockupDetails: {
                // ARK-side lockup: user locks funds here, Boltz claims
                lockupAddress: vhtlcAddress,
                amount: 50000,
                serverPublicKey: FIXTURE_COMPRESSED_HEX,
                timeoutBlockHeight: 100,
                timeouts: FIXTURE_TIMEOUTS,
            },
        },
    };
};
