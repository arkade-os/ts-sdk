/**
 * The RFQ maker module. The test that matters most is the golden one: the
 * lightning-send program compiled here must be byte-identical — every leaf and
 * the final scriptPubKey — to the reference solver's script, or a trader
 * would derive an address the solver never quoted and refuse every swap.
 * The pinned bytes were produced by the reference implementation.
 */
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

import {
    AddressMismatch,
    ARKADE_ASSET,
    ARKADE_BTC,
    LIGHTNING_SEND_PAIR,
    SwapRefusal,
    arkadeSwapRequest,
    assertFundable,
    httpTransport,
    lightningSendRequest,
    lightningSendVtxoScript,
    newRfqId,
    offerTermsFromQuote,
    relayTransport,
    unilateralClaimDelay,
    verifyLockupAddress,
    type RelaySocket,
    type RfqQuote,
} from "../src/rfq";
import { USD_ID } from "./fixtures";
import { asset } from "@arkade-os/sdk";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

const RFQ_ID = "a1".repeat(32);

const quoteFixture = (over: Partial<RfqQuote> = {}): RfqQuote => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: RFQ_ID,
    pair: LIGHTNING_SEND_PAIR,
    from_amount: 2100,
    to_amount: 2100,
    solver_pubkey: hex.encode(key(1)),
    valid_until: 1_800_000_900,
    refund_locktime: 1_800_277_200,
    profile: {
        payment_hash: "da".repeat(32),
        lockup_address: "ark1qexample",
        receiver_pk_script: hex.encode(p2tr(key(1))),
    },
    ...over,
});

describe("lightningSendVtxoScript", () => {
    // The reference solver's fixture, and its exact output bytes: sender =
    // key(13) (the trader's own VHTLC-sender key), receiver = key(1)
    // (solver), server = key(3), emulator = key(9), refund destination =
    // p2tr(key(5)) (also nonInteractiveRefund's covenant target), receiver
    // payout = p2tr(key(1)) (nonInteractiveClaim's covenant target, same key
    // as solverPubkey — the solver's own claim identity), preimage hash =
    // ripemd160(sha256(0x07 * 32)), locktime 1_800_000_000, CSV 4096s /
    // 4608s / 5120s (claimDelay, +512 per unilateralRefundDelay, +1024 per
    // unilateralRefundWithoutReceiverDelay).
    const PREIMAGE = new Uint8Array(32).fill(7);
    const PAYMENT_HASH = hex.encode(sha256(PREIMAGE));
    const REFUND_PK_SCRIPT = p2tr(key(5));
    const RECEIVER_PK_SCRIPT = p2tr(key(1));
    const SENDER_PUBKEY = key(13);

    const script = () =>
        lightningSendVtxoScript({
            solverPubkey: key(1),
            serverPubkey: key(3),
            paymentHash: PAYMENT_HASH,
            refundLocktime: 1_800_000_000,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            refundPkScript: REFUND_PK_SCRIPT,
            senderPubkey: SENDER_PUBKEY,
            receiverPkScript: RECEIVER_PK_SCRIPT,
        });

    it("is byte-identical to the reference solver's script — golden scriptPubKey", () => {
        expect(hex.encode(script().pkScript)).toBe(
            "51200370b2a6bf43aad67d7908c402beb7b6f079688a5e1d5380f3ed8ab9031ac982",
        );
    });

    it("compiles VHTLC's six base leaves plus the two non-interactive ones, leaf for leaf", () => {
        const compiled = script();
        const hash160 = hex.encode(ripemd160(sha256(PREIMAGE)));

        // claim: preimage (length-checked) + receiver + server
        expect(compiled.claimScript).toBe(
            `82012088a914${hash160}876920${hex.encode(key(1))}ad20${hex.encode(key(3))}ac`,
        );
        // refund: sender + receiver + server, immediate — no condition, no CSV/CLTV
        expect(compiled.refundScript).toBe(
            `20${hex.encode(SENDER_PUBKEY)}ad20${hex.encode(key(1))}ad20${hex.encode(key(3))}ac`,
        );
        // refundWithoutReceiver: sender + server, CLTV(refundLocktime)
        expect(compiled.refundWithoutReceiverScript.includes("b175")).toBe(true);
        expect(
            compiled.refundWithoutReceiverScript.endsWith(
                `20${hex.encode(SENDER_PUBKEY)}ad20${hex.encode(key(3))}ac`,
            ),
        ).toBe(true);
        // unilateralClaim: preimage (length-checked) + receiver alone, CSV(4096s)
        expect(compiled.unilateralClaimScript).toBe(
            `82012088a914${hash160}876903080040b275${"20"}${hex.encode(key(1))}ac`,
        );
        // unilateralRefund: sender + receiver, CSV(4608s), no server
        expect(compiled.unilateralRefundScript.includes(hex.encode(key(3)))).toBe(false);
        expect(
            compiled.unilateralRefundScript.endsWith(
                `20${hex.encode(SENDER_PUBKEY)}ad20${hex.encode(key(1))}ac`,
            ),
        ).toBe(true);
        // unilateralRefundWithoutReceiver: sender alone, CSV(5120s)
        expect(compiled.unilateralRefundWithoutReceiverScript.includes(hex.encode(key(1)))).toBe(
            false,
        );
        expect(compiled.unilateralRefundWithoutReceiverScript.includes(hex.encode(key(3)))).toBe(
            false,
        );
        expect(
            compiled.unilateralRefundWithoutReceiverScript.endsWith(
                `20${hex.encode(SENDER_PUBKEY)}ac`,
            ),
        ).toBe(true);
        // nonInteractiveClaim: preimage (length-checked) + server + covenant-tweaked emulator, pinned to receiverPkScript
        expect(compiled.nonInteractiveClaimScript).toBeDefined();
        expect(compiled.nonInteractiveClaimScript!.startsWith(`82012088a914${hash160}8769`)).toBe(
            true,
        );
        expect(compiled.nonInteractiveClaimScript!.includes(hex.encode(key(1)))).toBe(false);
        // nonInteractiveRefund: server + receiver + covenant-tweaked emulator, no
        // timelock, pinned to refundPkScript (the trader's OWN pkScript) — the
        // sender's OWN identity key is never needed, only server + receiver + emulator.
        expect(compiled.nonInteractiveRefundScript).toBeDefined();
        expect(compiled.nonInteractiveRefundScript!.includes("b175")).toBe(false);
        expect(
            compiled.nonInteractiveRefundScript!.startsWith(
                `20${hex.encode(key(3))}ad20${hex.encode(key(1))}ad`,
            ),
        ).toBe(true);
        expect(compiled.nonInteractiveRefundScript!.includes(hex.encode(SENDER_PUBKEY))).toBe(
            false,
        );
    });

    it("derives the HASH160 commitment from the payment hash — the trader never sees P", () => {
        // Same script from the payment hash alone; a different hash, different tree.
        const other = lightningSendVtxoScript({
            solverPubkey: key(1),
            serverPubkey: key(3),
            paymentHash: hex.encode(sha256(new Uint8Array(32).fill(8))),
            refundLocktime: 1_800_000_000,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            refundPkScript: REFUND_PK_SCRIPT,
            senderPubkey: SENDER_PUBKEY,
            receiverPkScript: RECEIVER_PK_SCRIPT,
        });
        expect(hex.encode(other.pkScript)).not.toBe(hex.encode(script().pkScript));
    });

    it("produces a different address when the sender key changes", () => {
        const other = lightningSendVtxoScript({
            solverPubkey: key(1),
            serverPubkey: key(3),
            paymentHash: PAYMENT_HASH,
            refundLocktime: 1_800_000_000,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            refundPkScript: REFUND_PK_SCRIPT,
            senderPubkey: key(14),
            receiverPkScript: RECEIVER_PK_SCRIPT,
        });
        expect(hex.encode(other.pkScript)).not.toBe(hex.encode(script().pkScript));
    });

    it("produces a different address when the receiver payout script changes", () => {
        const other = lightningSendVtxoScript({
            solverPubkey: key(1),
            serverPubkey: key(3),
            paymentHash: PAYMENT_HASH,
            refundLocktime: 1_800_000_000,
            claimDelay: 4096,
            emulatorPubkey: key(9),
            refundPkScript: REFUND_PK_SCRIPT,
            senderPubkey: SENDER_PUBKEY,
            receiverPkScript: p2tr(key(15)),
        });
        expect(hex.encode(other.pkScript)).not.toBe(hex.encode(script().pkScript));
    });
});

describe("unilateralClaimDelay", () => {
    it("rounds the server's exit delay UP to BIP68 granularity, as the solver does", () => {
        expect(unilateralClaimDelay(4096)).toBe(4096);
        expect(unilateralClaimDelay(4000)).toBe(4096);
        expect(unilateralClaimDelay(604672)).toBe(604672);
    });

    it("rejects a value that is a block count, not seconds", () => {
        expect(() => unilateralClaimDelay(144)).toThrow(/512/);
    });
});

describe("requests", () => {
    it("builds the lightning-send request exact-out with the invoice in the profile", () => {
        expect(
            lightningSendRequest({
                rfqId: RFQ_ID,
                invoice: "lnbc...",
                refundAddress: "ark1q...",
                senderPubkey: key(13),
            }),
        ).toEqual({
            v: 1,
            type: "rfq_request",
            rfq_id: RFQ_ID,
            pair: "arkade:BTC->lightning:BTC",
            amount_side: "to",
            profile: {
                invoice: "lnbc...",
                refund_address: "ark1q...",
                client_refund_pubkey: hex.encode(key(13)),
            },
        });
    });

    it("builds an arkade swap request with asset ids riding the profile", () => {
        const wantAsset = asset.AssetId.fromBytes(hex.decode(USD_ID));
        const request = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset,
            amountSide: "from",
            amount: 5000,
        }) as Record<string, unknown>;
        expect(request.pair).toBe(`${ARKADE_BTC}->${ARKADE_ASSET}`);
        expect(request.amount).toBe(5000);
        expect((request.profile as Record<string, unknown>).want_asset).toBe(USD_ID);
        // Exactly one side names an asset.
        expect(() => arkadeSwapRequest({ rfqId: RFQ_ID, amountSide: "to", amount: 1 })).toThrow(
            /exactly one/,
        );
    });
});

describe("guardrails", () => {
    it("verifyLockupAddress refuses on any mismatch", () => {
        const quote = quoteFixture();
        expect(verifyLockupAddress(quote, "ark1qexample")).toBe("ark1qexample");
        expect(() => verifyLockupAddress(quote, "ark1qmine")).toThrow(AddressMismatch);
    });

    it("assertFundable gates on invoice expiry, valid_until, and refund headroom", () => {
        const quote = quoteFixture();
        const now = 1_800_000_000;
        assertFundable({ quote, invoiceExpiresAt: now + 3600, now });
        expect(() => assertFundable({ quote, invoiceExpiresAt: now, now })).toThrow(/expired/);
        expect(() =>
            assertFundable({ quote, invoiceExpiresAt: now + 3600, now: quote.valid_until }),
        ).toThrow(/fresh/);
        const short = quoteFixture({ refund_locktime: now + 60 * 60 });
        expect(() => assertFundable({ quote: short, invoiceExpiresAt: now + 7200, now })).toThrow(
            /headroom/,
        );
    });
});

describe("httpTransport", () => {
    const jsonResponse = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status });

    it("returns the quote and correlates by rfq_id", async () => {
        const transport = httpTransport("http://solver", {
            fetchImpl: async () => jsonResponse(201, quoteFixture()),
        });
        const quote = await transport.requestQuote(
            lightningSendRequest({
                rfqId: RFQ_ID,
                invoice: "ln",
                refundAddress: "a",
                senderPubkey: key(13),
            }),
        );
        expect(quote.to_amount).toBe(2100);
    });

    it("throws SwapRefusal with the closed reason on a refusal", async () => {
        const transport = httpTransport("http://solver", {
            fetchImpl: async () =>
                jsonResponse(422, {
                    v: 1,
                    type: "rfq_refusal",
                    rfq_id: RFQ_ID,
                    reason: "exposure_cap",
                }),
        });
        await expect(
            transport.requestQuote(
                lightningSendRequest({
                    rfqId: RFQ_ID,
                    invoice: "ln",
                    refundAddress: "a",
                    senderPubkey: key(13),
                }),
            ),
        ).rejects.toMatchObject({ name: "SwapRefusal", reason: "exposure_cap" });
    });

    it("resolves status, and null on 404", async () => {
        const status = {
            v: 1,
            type: "rfq_status",
            rfq_id: RFQ_ID,
            state: "settled",
            updated_at: 1,
            profile: {},
        };
        const transport = httpTransport("http://solver", {
            fetchImpl: async (url) =>
                String(url).endsWith(`/v1/rfq/${RFQ_ID}`)
                    ? jsonResponse(200, status)
                    : jsonResponse(404, { v: 1, type: "not_found" }),
        });
        expect((await transport.status(RFQ_ID))?.state).toBe("settled");
        expect(await transport.status("ff".repeat(32))).toBeNull();
    });
});

describe("relayTransport", () => {
    /** A scripted solver on the other side of a fake socket: subscribes are
     * acknowledged silently; each published rfq_request gets the scripted
     * reply, addressed back like a relay would deliver it. */
    class FakeSocket implements RelaySocket {
        private listeners = new Map<string, ((event: any) => void)[]>();
        constructor(private readonly reply: (payload: any) => unknown) {
            queueMicrotask(() => this.emit("open", {}));
        }
        addEventListener(type: string, listener: (event: any) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        send(data: string): void {
            const frame = JSON.parse(data);
            if (frame.op !== "event") return;
            const payload = this.reply(frame.event.payload);
            queueMicrotask(() =>
                this.emit("message", {
                    data: JSON.stringify({ op: "event", event: { payload } }),
                }),
            );
        }
        close(): void {}
        private emit(type: string, event: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) listener(event);
        }
    }

    const transportWith = (reply: (payload: any) => unknown) =>
        relayTransport("ws://relay", {
            solverPubkey: "ab".repeat(32),
            clientPubkey: "cd".repeat(32),
            WebSocketCtor: class extends FakeSocket {
                constructor() {
                    super(reply);
                }
            } as unknown as new (url: string) => RelaySocket,
            timeoutMs: 1000,
        });

    it("round-trips a quote over the relay framing, correlated by rfq_id", async () => {
        const transport = transportWith((request) => ({
            ...quoteFixture(),
            rfq_id: request.rfq_id,
        }));
        const quote = await transport.requestQuote(
            lightningSendRequest({
                rfqId: newRfqId(),
                invoice: "ln",
                refundAddress: "a",
                senderPubkey: key(13),
            }),
        );
        expect(quote.type).toBe("rfq_quote");
        await transport.close();
    });

    it("delivers refusals as SwapRefusal and answers status requests", async () => {
        const transport = transportWith((request) =>
            request.type === "rfq_status_request"
                ? {
                      v: 1,
                      type: "rfq_status",
                      rfq_id: request.rfq_id,
                      state: "quoted",
                      updated_at: 1,
                      profile: {},
                  }
                : { v: 1, type: "rfq_refusal", rfq_id: request.rfq_id, reason: "unsupported_pair" },
        );
        await expect(
            transport.requestQuote(
                lightningSendRequest({
                    rfqId: newRfqId(),
                    invoice: "ln",
                    refundAddress: "a",
                    senderPubkey: key(13),
                }),
            ),
        ).rejects.toThrow(SwapRefusal);
        expect((await transport.status(newRfqId()))?.state).toBe("quoted");
        await transport.close();
    });
});

describe("offerTermsFromQuote", () => {
    it("binds the quoted to_amount as the offer's wantAmount", () => {
        const wantAsset = asset.AssetId.fromBytes(hex.decode(USD_ID));
        const terms = offerTermsFromQuote(quoteFixture({ to_amount: 12_345 }), { wantAsset });
        expect(terms.wantAmount).toBe(12_345n);
        expect(terms.wantAsset).toBe(wantAsset);
        expect(() => offerTermsFromQuote(quoteFixture(), {})).toThrow(/exactly one/);
    });
});
