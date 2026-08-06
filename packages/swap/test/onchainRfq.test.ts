/**
 * The onchain corridor's RFQ layer: request shapes, the new funding gates, and
 * the double local derivation (Arkade lockup + L1 HTLC) with its compare-only
 * refusals — the maker never funds anything it did not derive itself.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress } from "@arkade-os/sdk";

import {
    ARKADE_BTC,
    AddressMismatch,
    MAX_MIN_CONFIRMATIONS,
    ONCHAIN_BTC,
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    ONCHAIN_ORDER_MARGIN_SECONDS,
    ONCHAIN_RECEIVE_PAIR,
    ONCHAIN_SEND_PAIR,
    assertFundable,
    deriveOnchainSend,
    htlcSendProgram,
    lightningSendProgram,
    lightningSendVtxoScript,
    onchainReceiveRequest,
    onchainSendRequest,
    unilateralRefundWithoutReceiverDelay,
    type RfqQuote,
} from "../src/rfq";
import { onchainHtlcScript, paymentHashOf } from "../src/onchainHtlc";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const RFQ_ID = "a1".repeat(32);
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = paymentHashOf(PREIMAGE);
const NOW = 1_800_000_000;
const REFUND_LOCKTIME = NOW + 200 * 3600;
const HTLC_LOCKTIME = NOW + 24 * 3600;

describe("pairs and the shared program", () => {
    it("names the onchain legs", () => {
        expect(ONCHAIN_BTC).toBe("onchain:BTC");
        expect(ONCHAIN_SEND_PAIR).toBe(`${ARKADE_BTC}->${ONCHAIN_BTC}`);
        expect(ONCHAIN_RECEIVE_PAIR).toBe(`${ONCHAIN_BTC}->${ARKADE_BTC}`);
    });

    it("aliases the Arkade lockup to the lightning-send artifact — one program, one golden test", () => {
        expect(htlcSendProgram).toBe(lightningSendProgram);
    });
});

describe("request builders", () => {
    it("builds the off-board request", () => {
        expect(
            onchainSendRequest({
                rfqId: RFQ_ID,
                paymentHash: PAYMENT_HASH,
                payoutPubkey: key(5),
                refundAddress: "ark1q...",
                clientRefundPubkey: key(13),
                amount: 100_000,
                amountSide: "to",
            }),
        ).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: "arkade:BTC->onchain:BTC",
            amount_side: "to",
            amount: 100_000,
            profile: {
                payment_hash: PAYMENT_HASH,
                payout_pubkey: hex.encode(key(5)),
                refund_address: "ark1q...",
                client_refund_pubkey: hex.encode(key(13)),
            },
        });
    });

    it("builds the on-board request with the sealed packet riding the profile", () => {
        const request = onchainReceiveRequest({
            rfqId: RFQ_ID,
            paymentHash: PAYMENT_HASH,
            destinationAddress: "ark1q...",
            refundPubkey: key(7),
            claimPacket: { ciphertext: "abc=", arkade_script: "zXY=" },
            amount: 100_000,
            amountSide: "from",
        }) as Record<string, unknown>;
        expect(request.pair).toBe("onchain:BTC->arkade:BTC");
        expect((request.profile as Record<string, unknown>).claim_packet).toEqual({
            ciphertext: "abc=",
            arkade_script: "zXY=",
        });
    });
});

describe("assertFundable — onchain gates", () => {
    const quote = (over: Partial<RfqQuote> = {}): RfqQuote => ({
        v: 1,
        type: "rfq_quote",
        rfq_id: RFQ_ID,
        pair: ONCHAIN_SEND_PAIR,
        from_amount: 100_000,
        to_amount: 99_000,
        solver_pubkey: hex.encode(key(1)),
        valid_until: NOW + 900,
        refund_locktime: REFUND_LOCKTIME,
        profile: {},
        ...over,
    });
    const onchain = {
        htlcLocktime: HTLC_LOCKTIME,
        minConfirmations: 2,
        direction: "send" as const,
    };

    it("passes a well-ordered quote, without requiring an invoice expiry", () => {
        assertFundable({ quote: quote(), now: NOW, onchain });
    });

    it("bounds min_confirmations", () => {
        for (const bad of [0, MAX_MIN_CONFIRMATIONS + 1]) {
            expect(() =>
                assertFundable({
                    quote: quote(),
                    now: NOW,
                    onchain: { ...onchain, minConfirmations: bad },
                }),
            ).toThrow(expect.objectContaining({ reason: "confirmations_out_of_range" }));
        }
    });

    it("requires a safe claim window before the L1 refund leaf opens", () => {
        const tight = NOW + 2 * 600 + ONCHAIN_CLAIM_MARGIN_SECONDS; // exactly the bound
        expect(() =>
            assertFundable({
                quote: quote(),
                now: NOW,
                onchain: { ...onchain, htlcLocktime: tight },
            }),
        ).toThrow(expect.objectContaining({ reason: "claim_window_too_short" }));
    });

    it("enforces timelock order for the send direction: L1 + margin before the Arkade refund", () => {
        const late = REFUND_LOCKTIME - ONCHAIN_ORDER_MARGIN_SECONDS + 1;
        expect(() =>
            assertFundable({
                quote: quote(),
                now: NOW,
                onchain: { ...onchain, htlcLocktime: late },
            }),
        ).toThrow(expect.objectContaining({ reason: "timelock_order" }));
        // The receive direction leaves ordering to the solver's own safety check.
        assertFundable({
            quote: quote({ refund_locktime: undefined }),
            now: NOW,
            onchain: { ...onchain, htlcLocktime: late, direction: "receive" },
        });
    });
});

describe("deriveOnchainSend", () => {
    // The maker's own view of its stack: server key(3), emulator key(9),
    // client-unilateral-refund key(13), claim delay 4096 — and a real,
    // decodable arkade refund address.
    const SERVER = key(3);
    const CLAIM_DELAY = 4096;
    const CLIENT_REFUND_DELAY = unilateralRefundWithoutReceiverDelay(CLAIM_DELAY);
    const REFUND_ADDRESS = lightningSendVtxoScript({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        serverPubkey: SERVER,
        paymentHash: PAYMENT_HASH,
        claimDelay: CLAIM_DELAY,
        emulatorPubkey: key(9),
        refundPkScript: Uint8Array.from([0x51, 0x20, ...key(5)]),
        clientRefundPubkey: key(13),
        clientRefundDelay: CLIENT_REFUND_DELAY,
    })
        .address("ark", SERVER)
        .encode();

    const derivation = () => ({
        paymentHash: PAYMENT_HASH,
        payoutPubkey: key(5),
        serverPubkey: SERVER,
        emulatorPubkey: key(9),
        claimDelay: CLAIM_DELAY,
        hrp: "ark",
        l1Network: "regtest" as const,
        refundAddress: REFUND_ADDRESS,
        clientRefundPubkey: key(13),
        clientRefundDelay: CLIENT_REFUND_DELAY,
    });

    /** A quote whose compare-only fields MATCH the maker's own derivations. */
    const consistentQuote = (): RfqQuote => {
        const input = derivation();
        const lockup = lightningSendVtxoScript({
            solverPubkey: key(1),
            refundLocktime: REFUND_LOCKTIME,
            serverPubkey: SERVER,
            paymentHash: PAYMENT_HASH,
            claimDelay: CLAIM_DELAY,
            emulatorPubkey: key(9),
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
            clientRefundPubkey: key(13),
            clientRefundDelay: CLIENT_REFUND_DELAY,
        });
        const htlc = onchainHtlcScript(
            {
                paymentHash: PAYMENT_HASH,
                claimKey: input.payoutPubkey,
                refundKey: key(11),
                refundLocktime: HTLC_LOCKTIME,
            },
            "regtest",
        );
        return {
            v: 1,
            type: "rfq_quote",
            rfq_id: RFQ_ID,
            pair: ONCHAIN_SEND_PAIR,
            from_amount: 100_000,
            to_amount: 99_000,
            solver_pubkey: hex.encode(key(1)),
            valid_until: NOW + 900,
            refund_locktime: REFUND_LOCKTIME,
            profile: {
                lockup_address: lockup.address("ark", SERVER).encode(),
                htlc_pubkey: hex.encode(key(11)),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
            },
        };
    };

    it("derives both contracts and accepts a consistent quote", () => {
        const derived = deriveOnchainSend({ quote: consistentQuote(), ...derivation() });
        expect(derived.htlcLocktime).toBe(HTLC_LOCKTIME);
        expect(derived.minConfirmations).toBe(2);
        expect(derived.htlc.paymentHash).toBe(PAYMENT_HASH);
        expect(derived.address.startsWith("ark1")).toBe(true);
    });

    it("refuses to fund on an L1 address the maker did not derive", () => {
        const quote = consistentQuote();
        quote.profile.htlc_address = "bcrt1ptampered";
        expect(() => deriveOnchainSend({ quote, ...derivation() })).toThrow(AddressMismatch);
    });

    it("refuses to fund on an Arkade lockup the maker did not derive", () => {
        const quote = consistentQuote();
        quote.profile.lockup_address = "ark1qtampered";
        expect(() => deriveOnchainSend({ quote, ...derivation() })).toThrow(AddressMismatch);
    });

    it("refuses a quote missing a binding field", () => {
        const quote = consistentQuote();
        delete quote.profile.htlc_locktime;
        expect(() => deriveOnchainSend({ quote, ...derivation() })).toThrow(/binding field/);
    });
});

describe("store — onchain records", () => {
    it("admits a record that carries a payment hash instead of an offer TLV", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const record = {
            id: "l1-swap",
            fromAsset: "btc",
            toAsset: "btc",
            fromAmount: "100000",
            toAmount: "99000",
            swapAddress: "ark1q...",
            swapPkScript: "5120aa",
            fundingTxid: "ff".repeat(32),
            status: "awaiting_fill",
            createdAt: 1,
            pair: ONCHAIN_SEND_PAIR,
            paymentHash: PAYMENT_HASH,
            preimageHex: hex.encode(PREIMAGE),
            htlcPkScriptHex: "5120bb",
            htlcLocktime: HTLC_LOCKTIME,
        } as unknown as AssetSwap;
        await addAssetSwap(repository, record);
        const swaps = await getAssetSwaps(repository);
        expect(swaps).toHaveLength(1);
        expect(swaps[0]!.paymentHash).toBe(PAYMENT_HASH);
        expect(swaps[0]!.status).toBe("awaiting_fill");
    });
});
