/**
 * The three maker-flow entrypoints that need the emulator's key —
 * `requestLightningSend`, `requestOnchainSend` (rfq.ts) and `createOffer`
 * (offer.ts) — must never reach the emulator over the network: per policy,
 * clients have no network path to it, only the solver and covclaimd do. The
 * emulator's x-only key is instead a caller-supplied parameter, sourced out
 * of band from the solver's signed registry/corridor card.
 *
 * This file makes `RestEmulatorProvider`'s constructor throw, so if any of
 * these three ever regain a live emulator fetch, the test fails loudly
 * instead of a mock silently absorbing it — and it confirms the supplied key
 * actually reaches the covenant, not just that nothing crashes.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, SingleKey, asset, type IWallet } from "@arkade-os/sdk";

// cancel.test.ts's pattern: spread the real module, override only the
// network seam these functions must never touch (RestEmulatorProvider) plus
// the one they legitimately still call (RestArkProvider), stubbed.
const state = vi.hoisted(() => ({
    operatorInfo: { signerPubkey: "", unilateralExitDelay: 4096, network: "regtest" },
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    // the factory is hoisted above this file's imports, so re-import inside it
    const { hex: hexCodec } = await import("@scure/base");
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                // `createOffer` registers the covenant with the contract
                // manager, and `Arkade.connect` decodes this — derived from
                // whatever signer key the test set, so the two cannot drift.
                return {
                    ...state.operatorInfo,
                    checkpointTapscript: hexCodec.encode(
                        mod.CSVMultisigTapscript.encode({
                            timelock: { type: "blocks", value: 10n },
                            pubkeys: [hexCodec.decode(state.operatorInfo.signerPubkey)],
                        }).script,
                    ),
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: [] };
            }
        },
        RestEmulatorProvider: class {
            constructor() {
                throw new Error(
                    "RestEmulatorProvider must never be constructed by a maker-flow " +
                        "entrypoint — the emulator pubkey is caller-supplied now, never " +
                        "fetched live by this package",
                );
            }
        },
    };
});

import {
    AddressMismatch,
    LIGHTNING_SEND_PAIR,
    ONCHAIN_SEND_PAIR,
    lightningSendContract,
    requestLightningSend,
    requestOnchainSend,
    type RfqQuote,
    type RfqTransport,
} from "../src/rfq";
import { onchainHtlcScript, paymentHashOf } from "../src/onchainHtlc";
import { createOffer, decodeOffer } from "../src/offer";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const OPERATOR_PUBKEY = key(3);
const SOLVER = key(1);
const RECEIVER_PK_SCRIPT = p2tr(key(1));
const EMULATOR_PUBKEY = key(9);
const EMULATOR_PUBKEY_HEX = "02" + hex.encode(EMULATOR_PUBKEY);
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = paymentHashOf(PREIMAGE);
const REFUND_ADDRESS = new ArkAddress(OPERATOR_PUBKEY, key(21), "tark").encode();

state.operatorInfo.signerPubkey = hex.encode(OPERATOR_PUBKEY);

const NOW = Math.floor(Date.now() / 1000);
const VALID_UNTIL = NOW + 3600;
// Days out, comfortably past every headroom / claim-window / timelock-order
// gate (all bounded in hours) — the fixture never needs tuning against those
// margins.
const REFUND_LOCKTIME = NOW + 60 * 24 * 3600;
const HTLC_LOCKTIME = NOW + 30 * 24 * 3600;

const wallet = {
    // a complete signing identity: provisioning now refuses a wallet that
    // cannot sign, since it could never refund the leg it funds
    identity: SingleKey.fromRandomBytes(),
    getAddress: async () => REFUND_ADDRESS,
    // Every maker entrypoint here registers its covenant with the contract
    // manager before handing back an address — `createOffer` via
    // `registerOfferContract`, the two request* paths via
    // `registerLockupContract` — so the fake has to serve one.
    getContractManager: async () => ({
        createContract: async (params: Record<string, unknown>) => ({
            ...params,
            state: "active",
            createdAt: 0,
        }),
        setContractWatchState: async () => {},
    }),
} as unknown as IWallet;

/** A `requestQuote` stub playing the solver: reads the sender key the
 * caller generated internally (there is no way to inject it) off the
 * request's own `client_refund_pubkey`, and quotes a `lockup_address` built
 * with `forEmulatorPubkey` — standing in for "whatever emulator key the
 * solver's covenant actually used". */
const lightningTransport = (forEmulatorPubkey: Uint8Array): RfqTransport => ({
    async requestQuote(payload) {
        const profile = (payload as { profile: Record<string, unknown> }).profile;
        const senderPubkey = hex.decode(profile.client_refund_pubkey as string);
        const contract = lightningSendContract({
            solverPubkey: SOLVER,
            refundLocktime: REFUND_LOCKTIME,
            operatorPubkey: OPERATOR_PUBKEY,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: forEmulatorPubkey,
            senderPubkey,
            receiverPkScript: RECEIVER_PK_SCRIPT,
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
        });
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: payload.rfq_id as string,
            pair: LIGHTNING_SEND_PAIR,
            from_amount: 1000,
            to_amount: 1000,
            solver_pubkey: hex.encode(SOLVER),
            valid_until: VALID_UNTIL,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                lockup_address: contract.address("tark", OPERATOR_PUBKEY).encode(),
            },
        } satisfies RfqQuote;
    },
    async status() {
        return null;
    },
    async close() {},
});

describe("requestLightningSend never touches the emulator", () => {
    it("funds using the caller-supplied emulatorPubkey, without constructing RestEmulatorProvider", async () => {
        const result = await requestLightningSend(
            wallet,
            "http://ark",
            lightningTransport(EMULATOR_PUBKEY),
            {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                invoice: {
                    raw: "lnbc1...",
                    paymentHash: PAYMENT_HASH,
                    amountSats: 1000,
                    expiresAt: NOW + 7200,
                },
            },
        );
        expect(result.address.startsWith("tark1")).toBe(true);
    });

    it("refuses to fund when the caller's emulatorPubkey does not match what the covenant was quoted with", async () => {
        // the transport quotes a lockup built with a DIFFERENT emulator key
        // than the caller passes in — proving emulatorPubkey is load-bearing
        // in the derivation, not a dead parameter
        await expect(
            requestLightningSend(wallet, "http://ark", lightningTransport(key(29)), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                invoice: {
                    raw: "lnbc1...",
                    paymentHash: PAYMENT_HASH,
                    amountSats: 1000,
                    expiresAt: NOW + 7200,
                },
            }),
        ).rejects.toThrow(AddressMismatch);
    });
});

describe("requestOnchainSend never touches the emulator", () => {
    const PAYOUT_PUBKEY = key(15);
    const HTLC_PUBKEY = key(11);

    const onchainTransport = (forEmulatorPubkey: Uint8Array): RfqTransport => ({
        async requestQuote(payload) {
            const profile = (payload as { profile: Record<string, unknown> }).profile;
            const senderPubkey = hex.decode(profile.client_refund_pubkey as string);
            const lockupScript = lightningSendContract({
                solverPubkey: SOLVER,
                refundLocktime: REFUND_LOCKTIME,
                operatorPubkey: OPERATOR_PUBKEY,
                paymentHash: PAYMENT_HASH,
                claimDelay: 4096,
                emulatorPubkey: forEmulatorPubkey,
                senderPubkey,
                receiverPkScript: RECEIVER_PK_SCRIPT,
                refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
            });
            const htlc = onchainHtlcScript(
                {
                    paymentHash: PAYMENT_HASH,
                    claimKey: PAYOUT_PUBKEY,
                    refundKey: HTLC_PUBKEY,
                    refundLocktime: HTLC_LOCKTIME,
                },
                "regtest",
            );
            return {
                v: 1,
                type: "rfq_quote",
                rfq_id: payload.rfq_id as string,
                pair: ONCHAIN_SEND_PAIR,
                from_amount: 100_000,
                to_amount: 99_000,
                solver_pubkey: hex.encode(SOLVER),
                valid_until: VALID_UNTIL,
                refund_locktime: REFUND_LOCKTIME,
                profile: {
                    lockup_address: lockupScript.address("tark", OPERATOR_PUBKEY).encode(),
                    htlc_pubkey: hex.encode(HTLC_PUBKEY),
                    htlc_locktime: HTLC_LOCKTIME,
                    htlc_address: htlc.address,
                    min_confirmations: 2,
                    receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
                },
            } satisfies RfqQuote;
        },
        async status() {
            return null;
        },
        async close() {},
    });

    it("funds using the caller-supplied emulatorPubkey, without constructing RestEmulatorProvider", async () => {
        const result = await requestOnchainSend(
            wallet,
            "http://ark",
            onchainTransport(EMULATOR_PUBKEY),
            {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
                preimage: PREIMAGE,
            },
        );
        expect(result.address.startsWith("tark1")).toBe(true);
        expect(result.htlc.address).toBeTruthy();
    });

    it("refuses to fund when the caller's emulatorPubkey does not match what the covenant was quoted with", async () => {
        // The onchain path derives its Arkade lockup through the same
        // `verifyLockupAddress` check the lightning one does, so the parameter
        // has to be load-bearing here too — without this, a dead
        // `emulatorPubkey` on this entrypoint would pass the success case above
        // and only be caught by whoever funded a lockup they cannot spend.
        await expect(
            requestOnchainSend(wallet, "http://ark", onchainTransport(key(29)), {
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                amount: 100_000,
                amountSide: "to",
                payoutPubkey: PAYOUT_PUBKEY,
                preimage: PREIMAGE,
            }),
        ).rejects.toThrow(AddressMismatch);
    });
});

describe("createOffer never touches the emulator", () => {
    it("embeds the caller-supplied emulatorPubkey, without constructing RestEmulatorProvider", async () => {
        const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
        const offer = await createOffer(wallet, "http://ark", {
            wantAmount: 1000n,
            wantAsset,
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
        });
        expect(decodeOffer(hex.decode(offer.offerHex)).emulatorPubkey).toEqual(EMULATOR_PUBKEY);
    });
});
