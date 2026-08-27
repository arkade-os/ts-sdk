/**
 * The onchain corridor's RFQ layer: request shapes, the new funding gates, and
 * the double local derivation (Arkade lockup + L1 HTLC) with its compare-only
 * refusals — the maker never funds anything it did not derive itself.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { ArkAddress, VHTLCV2ContractHandler } from "@arkade-os/sdk";

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
    lightningSendContract,
    onchainReceiveRequest,
    onchainSendRequest,
    type RfqQuote,
} from "../src/rfq";
import { onchainHtlcScript, paymentHashOf, type OnchainHtlc } from "../src/onchainHtlc";
import { onchainSendProfile } from "../src/rfqCorridors";
import { createRfqSwapRecord, rebuildRfqSwap } from "../src/rfqRecord";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);
const PREIMAGE = new Uint8Array(32).fill(7);
const PAYMENT_HASH = paymentHashOf(PREIMAGE);
const NOW = 1_800_000_000;
const REFUND_LOCKTIME = NOW + 200 * 3600;
const HTLC_LOCKTIME = NOW + 24 * 3600;

// The onchain leg's Arkade lockup shares `lightningSendContract` with the
// Lightning leg directly (see `deriveOnchainSend` below) — one function, one
// golden test (`rfq.test.ts`). There is no separate onchain program object
// left to compare it against, so there is nothing to pin here any more.
describe("pairs", () => {
    it("names the onchain legs", () => {
        expect(ONCHAIN_BTC).toBe("onchain:BTC");
        expect(ONCHAIN_SEND_PAIR).toBe(`${ARKADE_BTC}->${ONCHAIN_BTC}`);
        expect(ONCHAIN_RECEIVE_PAIR).toBe(`${ONCHAIN_BTC}->${ARKADE_BTC}`);
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
                senderPubkey: key(13),
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
            payoutAddress: "ark1q...",
            payoutPubkey: key(9),
            refundPubkey: key(7),
            claimPacket: "abc=",
            amount: 100_000,
            amountSide: "from",
        });
        expect(request).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: "onchain:BTC->arkade:BTC",
            amount_side: "from",
            amount: 100_000,
            profile: {
                payment_hash: PAYMENT_HASH,
                claim_packet: "abc=",
                refund_pubkey: hex.encode(key(7)),
                payout_address: "ark1q...",
                payout_pubkey: hex.encode(key(9)),
            },
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
    // claim delay 4096, sender key(13) — and a real, decodable arkade refund
    // address.
    const OPERATOR_PUBKEY = key(3);
    const SENDER_PUBKEY = key(13);
    const RECEIVER_PK_SCRIPT = p2tr(key(1));
    const REFUND_ADDRESS = lightningSendContract({
        solverPubkey: key(1),
        refundLocktime: REFUND_LOCKTIME,
        operatorPubkey: OPERATOR_PUBKEY,
        paymentHash: PAYMENT_HASH,
        claimDelay: 4096,
        emulatorPubkey: key(9),
        refundPkScript: p2tr(key(5)),
        senderPubkey: SENDER_PUBKEY,
        receiverPkScript: RECEIVER_PK_SCRIPT,
    })
        .address("ark", OPERATOR_PUBKEY)
        .encode();

    const derivation = () => ({
        paymentHash: PAYMENT_HASH,
        payoutPubkey: key(5),
        operatorPubkey: OPERATOR_PUBKEY,
        emulatorPubkey: key(9),
        claimDelay: 4096,
        hrp: "ark",
        l1Network: "regtest" as const,
        refundAddress: REFUND_ADDRESS,
        senderPubkey: SENDER_PUBKEY,
    });

    /** A quote whose compare-only fields MATCH the maker's own derivations. */
    const consistentQuote = (): RfqQuote => {
        const input = derivation();
        const lockup = lightningSendContract({
            solverPubkey: key(1),
            refundLocktime: REFUND_LOCKTIME,
            operatorPubkey: OPERATOR_PUBKEY,
            paymentHash: PAYMENT_HASH,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            refundPkScript: ArkAddress.decode(REFUND_ADDRESS).pkScript,
            senderPubkey: SENDER_PUBKEY,
            receiverPkScript: RECEIVER_PK_SCRIPT,
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
                lockup_address: lockup.address("ark", OPERATOR_PUBKEY).encode(),
                htlc_pubkey: hex.encode(key(11)),
                htlc_locktime: HTLC_LOCKTIME,
                htlc_address: htlc.address,
                min_confirmations: 2,
                receiver_pk_script: hex.encode(RECEIVER_PK_SCRIPT),
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

    it("hands back the L1 network, which the ark network name does not give", () => {
        // The mapping from `info.network` is private and lossy — signet,
        // mutinynet and testnet4 all land on `"testnet"` — so a caller
        // reconstructing this from context is re-deriving something it cannot
        // see, for a field the profile needs verbatim.
        expect(deriveOnchainSend({ quote: consistentQuote(), ...derivation() }).l1Network).toBe(
            "regtest",
        );
    });

    it("maps the derivation onto the profile, renames and all", () => {
        // The three that are not a straight copy, in one place so the mapping
        // is auditable: the L1 locktime is `htlcLocktime` on the profile
        // (`refundLocktime` there is the arkade lockup's, another deadline
        // entirely), the keys go to hex, and `htlcAddress` is derived — no
        // input carries it, and it is what the rebuild checks against.
        const derived = deriveOnchainSend({ quote: consistentQuote(), ...derivation() });
        expect(onchainSendProfile(derived)).toEqual({
            claimKey: hex.encode(key(5)),
            refundKey: hex.encode(key(11)),
            htlcLocktime: HTLC_LOCKTIME,
            network: "regtest",
            htlcAddress: derived.htlc.address,
            minConfirmations: 2,
        });
    });

    it("round-trips the L1 half from a real derivation through a record", () => {
        // End to end over the seam the builder exists for: derive, persist,
        // rebuild, and land on the same contract. A field mapped wrong here
        // does not fail at the write — it fails at the restore, against an
        // HTLC nobody funded.
        const derived = deriveOnchainSend({ quote: consistentQuote(), ...derivation() });
        const record = createRfqSwapRecord(
            {
                kind: "onchain_send",
                lockupAddress: derived.address,
                profile: {
                    signer: { signingDescriptor: `tr(${hex.encode(SENDER_PUBKEY)})` },
                    hashlock: { paymentHash: PAYMENT_HASH },
                    ...onchainSendProfile(derived),
                },
            },
            {
                kind: "onchain_send",
                rfqId: RFQ_ID,
                state: "pending",
                lockupPkScript: derived.swapPkScript,
                paymentHash: PAYMENT_HASH,
                refundLocktime: derived.refundLocktime,
                htlc: derived.htlc,
                minConfirmations: derived.minConfirmations,
                createdAt: NOW,
                updatedAt: NOW,
            } as unknown as Parameters<typeof createRfqSwapRecord>[1],
        );

        const rebuilt = rebuildRfqSwap(
            record,
            VHTLCV2ContractHandler.serializeParams(derived.script.options),
        ) as { htlc: OnchainHtlc; minConfirmations: number };

        expect(rebuilt.htlc.address).toBe(derived.htlc.address);
        expect(hex.encode(rebuilt.htlc.pkScript)).toBe(hex.encode(derived.htlc.pkScript));
        expect(rebuilt.minConfirmations).toBe(2);
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
            signingDescriptor: `tr(${"ab".repeat(32)})`,
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
