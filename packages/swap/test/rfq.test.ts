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
    ARKADE_BTC,
    LIGHTNING_SEND_PAIR,
    MAX_PAIR_LENGTH,
    SOLO_REFUND_HEADROOM_SECONDS,
    SwapRefusal,
    arkadeAssetLeg,
    arkadeSwapRequest,
    assertFundable,
    assertPairLength,
    expectQuote,
    httpTransport,
    lightningSendRequest,
    lightningSendVtxoScript,
    newRfqId,
    offerTermsFromQuote,
    relayTransport,
    rfqPair,
    unilateralClaimDelay,
    unilateralRefundDelay,
    unilateralRefundWithoutReceiverDelay,
    verifyLockupAddress,
    type RelaySocket,
    type RfqQuote,
} from "../src/rfq";
import { CHF_ID, USD_ID } from "./fixtures";
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
    // Any change to these pinned bytes changes every lockup address and needs
    // coordinated trader/solver deployment — see "Breaking changes" in the
    // README. A version mismatch refuses quotes (verifyLockupAddress), it does
    // not lose funds.
    //
    // PROVENANCE — read before regenerating. "Byte-identical to the reference
    // solver" is only meaningful if the expected value came from the SOLVER.
    // Recomputing it from this package would assert that this code equals
    // itself: green, and blind to exactly the drift the pin exists to catch.
    //
    // The current bytes were produced by the solver's own `CovenantSwapScript`
    // (`src/arkade/covenant.ts`) at lightning-swap-service `b9fc3fe`, merged to
    // its main as `c904d44`, driven by that commit's `deriveUnilateralDelays`.
    // The generator was first run against the PRE-change ladder
    // (4096/4608/5120) as a negative control and reproduced the goldens then
    // pinned here — send `51200370b2a6…`, receive `5120f683cdac…` — which is
    // what establishes it speaks the reference's dialect rather than this one.
    //
    // Regenerate the same way: drive the solver, reproduce the CURRENT pin
    // first, and only then trust the new number.
    // The reference solver's fixture, and its exact output bytes: sender =
    // key(13) (the trader's own VHTLC-sender key), receiver = key(1)
    // (solver), server = key(3), emulator = key(9), refund destination =
    // p2tr(key(5)) (also the refund covenants' target), receiver
    // payout = p2tr(key(1)) (nonInteractiveClaim's covenant target, same key
    // as solverPubkey — the solver's own claim identity), preimage hash =
    // ripemd160(sha256(0x07 * 32)), locktime 1_800_000_000, CSV 4096s /
    // 4096s / 8192s (claimDelay, unilateralRefundDelay LEVEL with it, and
    // SOLO_REFUND_HEADROOM_SECONDS above it for
    // unilateralRefundWithoutReceiverDelay).
    //
    // `legacy: "preTimelockedRefund"` because the solver that produced the
    // pinned bytes predates the timelocked non-interactive refund leaf: its
    // `CovenantSwapScript` builds the covenant suite WITHOUT that leaf, the
    // shape this marker now reproduces byte for byte. The default full suite
    // is one leaf longer and derives a different address — which is exactly
    // why `matchQuotedLockup` tries both shapes against a quote.
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
            legacy: "preTimelockedRefund",
        });

    it("is byte-identical to the reference solver's script — golden scriptPubKey", () => {
        expect(hex.encode(script().pkScript)).toBe(
            "51209e4ec65c3dc94c8046e7ef50258b69a88d61720df5b87bd0069576859e22ab89",
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
        // unilateralRefund: sender + receiver, CSV(4096s) — LEVEL with the
        // claim, no server. The CSV bytes are pinned, not just described: the
        // two refund tiers' sequences were the one part of this tree nothing
        // asserted, which is how the ladder could drift silently.
        expect(compiled.unilateralRefundScript.startsWith("03080040b275")).toBe(true);
        expect(compiled.unilateralRefundScript.includes(hex.encode(key(3)))).toBe(false);
        expect(
            compiled.unilateralRefundScript.endsWith(
                `20${hex.encode(SENDER_PUBKEY)}ad20${hex.encode(key(1))}ac`,
            ),
        ).toBe(true);
        // unilateralRefundWithoutReceiver: sender alone, CSV(8192s) — the
        // headroom above the claim, the gap that stops a funder preempting a
        // claimant who holds the preimage.
        expect(compiled.unilateralRefundWithoutReceiverScript.startsWith("03100040b275")).toBe(
            true,
        );
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

    it("keeps all three tiers BIP68-encodable at the maximum server delay", () => {
        // the cap sits SOLO_REFUND_HEADROOM_SECONDS below BIP68's 0xffff * 512
        // ceiling so the solo refund stacked above claimDelay still encodes
        const max = 0xffff * 512 - SOLO_REFUND_HEADROOM_SECONDS;
        const claim = unilateralClaimDelay(max);
        expect(claim).toBe(max);
        expect(unilateralRefundDelay(claim)).toBe(max);
        expect(unilateralRefundWithoutReceiverDelay(claim)).toBe(0xffff * 512);
        // the proof that matters: the full contract compiles, so every CSV
        // leaf's sequence encoded — this threw from inside the tapscript
        // encoder before the cap accounted for the stacked tiers
        expect(() =>
            lightningSendVtxoScript({
                solverPubkey: key(1),
                serverPubkey: key(3),
                paymentHash: "da".repeat(32),
                refundLocktime: 1_800_000_000,
                claimDelay: claim,
                emulatorPubkey: key(9),
                senderPubkey: key(13),
                receiverPkScript: p2tr(key(1)),
                refundPkScript: p2tr(key(5)),
            }),
        ).not.toThrow();
    });

    it("rejects a server delay whose solo refund would overflow BIP68", () => {
        expect(() => unilateralClaimDelay(0xffff * 512 - SOLO_REFUND_HEADROOM_SECONDS + 1)).toThrow(
            /BIP68/,
        );
        expect(() => unilateralClaimDelay(0xffff * 512)).toThrow(/BIP68/);
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

    it("names the asset id in the pair, in both directions", () => {
        const usd = asset.AssetId.fromString(USD_ID);
        const wanting = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset: usd,
            amountSide: "from",
            amount: 5000,
        }) as Record<string, unknown>;
        expect(wanting.pair).toBe(`arkade:BTC->arkade:${USD_ID}`);
        expect(wanting.amount).toBe(5000);

        const offering = arkadeSwapRequest({
            rfqId: RFQ_ID,
            offerAsset: usd,
            amountSide: "to",
            amount: 5000,
        }) as Record<string, unknown>;
        expect(offering.pair).toBe(`arkade:${USD_ID}->arkade:BTC`);
    });

    /** Solvers compare pair strings byte for byte, so an uppercase id reaching
     * the wire is a silent unserved-pair miss. Taking an `AssetId` is the
     * normalisation. */
    it("emits a lowercase leg for an asset id built from uppercase hex", () => {
        const request = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset: asset.AssetId.fromString(USD_ID.toUpperCase()),
            amountSide: "from",
            amount: 1,
        }) as Record<string, unknown>;
        expect(request.pair).toBe(`arkade:BTC->arkade:${USD_ID}`);
    });

    /** ...and the rule that makes it work, pinned to the shared vector rather
     * than to a fixture id. `arkadeAssetLeg` is the eighth site implementing
     * the identity form, and the only one where a case slip is invisible: the
     * leg still builds, still routes, and is simply never served. */
    describe("arkadeAssetLeg, against the shared vector", () => {
        const V = asset.ASSET_ID_VECTORS;
        const drift = (label: string) =>
            `asset id encoding drifted from ASSET_ID_VECTORS (${label})`;

        V.valid.forEach((v) => {
            it(`carries the identity form verbatim -- ${v.label}`, () => {
                const leg = arkadeAssetLeg(asset.AssetId.create(V.txid_hex, v.group_index));
                expect(leg, drift(v.label)).toBe(`arkade:${v.asset_id_hex}`);
                expect(leg.slice("arkade:".length), drift(v.label)).toMatch(/^[0-9a-f]{68}$/);
            });
        });

        V.invalid_identity
            .filter((v) => v.normalizes_to !== undefined)
            .forEach((v) => {
                it(`normalises rather than propagating -- ${v.label}`, () => {
                    expect(arkadeAssetLeg(asset.AssetId.fromString(v.value)), drift(v.label)).toBe(
                        `arkade:${v.normalizes_to}`,
                    );
                });
            });
    });

    /** Each refusal names its own cause: neither set is degenerate, both set is
     * a real corridor with no counterparty. One shared message would tell the
     * BTC->BTC caller to wait for a solver that will never help it. */
    it("refuses neither asset and both, for the reason that applies", () => {
        const usd = asset.AssetId.fromString(USD_ID);
        const chf = asset.AssetId.fromString(CHF_ID);
        expect(() => arkadeSwapRequest({ rfqId: RFQ_ID, amountSide: "to", amount: 1 })).toThrow(
            /exactly one.*not a swap/s,
        );
        expect(() =>
            arkadeSwapRequest({
                rfqId: RFQ_ID,
                offerAsset: usd,
                wantAsset: chf,
                amountSide: "to",
                amount: 1,
            }),
        ).toThrow(/no solver quotes it yet/);
    });

    /** Load-bearing against the solver's `.strict()` profile schema: a key it
     * does not declare refuses the whole request. */
    it("sends an empty profile, with no asset keys left in it", () => {
        const request = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset: asset.AssetId.fromString(USD_ID),
            amountSide: "from",
            amount: 5000,
        }) as Record<string, unknown>;
        expect(Object.keys(request.profile as Record<string, unknown>)).toHaveLength(0);
    });

    it("mirrors the wire's pair-length cap, dormant until asset->asset lands", () => {
        expect(MAX_PAIR_LENGTH).toBe(158);
        const both = rfqPair(
            arkadeAssetLeg(asset.AssetId.fromString(USD_ID)),
            arkadeAssetLeg(asset.AssetId.fromString(CHF_ID)),
        );
        expect(both.length).toBe(152);
        expect(() => assertPairLength("x".repeat(MAX_PAIR_LENGTH + 1))).toThrow(/158/);
        // What the builder can actually emit today — the number that makes the
        // guard unreachable until the exactly-one-asset rule relaxes.
        const request = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset: asset.AssetId.fromString(USD_ID),
            amountSide: "from",
            amount: 1,
        }) as Record<string, unknown>;
        expect((request.pair as string).length).toBe(87);
    });
});

describe("guardrails", () => {
    it("verifyLockupAddress refuses on any mismatch", () => {
        const quote = quoteFixture();
        expect(verifyLockupAddress(quote, "ark1qexample")).toBe("ark1qexample");
        expect(() => verifyLockupAddress(quote, "ark1qmine")).toThrow(AddressMismatch);
    });

    it("verifyLockupAddress accepts the matching candidate of an array, and reports every candidate tried", () => {
        const quote = quoteFixture();
        // The derivation itself is ambiguous while solvers roll out the
        // timelocked non-interactive refund leaf, so callers derive BOTH
        // shapes and the quote's own lockup_address picks one. Newest first:
        // a full-suite match, not the legacy one, is what gets returned.
        expect(verifyLockupAddress(quote, ["ark1qother", "ark1qexample"])).toBe("ark1qexample");
        const mismatch = ((): unknown => {
            try {
                verifyLockupAddress(quote, ["ark1qmine", "ark1qother"]);
                return undefined;
            } catch (error) {
                return error;
            }
        })();
        expect(mismatch).toBeInstanceOf(AddressMismatch);
        // Never fund past this — the error must carry EVERY candidate tried,
        // so a caller can see both shapes were refused.
        expect((mismatch as AddressMismatch).derived).toEqual(["ark1qmine", "ark1qother"]);
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

describe("expectQuote", () => {
    it("refuses a quote for a pair other than the one requested, case included", () => {
        const requested = LIGHTNING_SEND_PAIR;
        expect(expectQuote(quoteFixture(), RFQ_ID, requested).to_amount).toBe(2100);
        expect(() =>
            expectQuote(quoteFixture({ pair: "onchain:BTC->arkade:BTC" }), RFQ_ID, requested),
        ).toThrow(/not the requested/);
        expect(() =>
            expectQuote(quoteFixture({ pair: requested.toUpperCase() }), RFQ_ID, requested),
        ).toThrow(/not the requested/);
    });

    it("accepts any pair when the request named none", () => {
        expect(expectQuote(quoteFixture({ pair: "anything" }), RFQ_ID).rfq_id).toBe(RFQ_ID);
    });

    it("still reports a refusal as a refusal, not as a pair mismatch", () => {
        expect(() =>
            expectQuote(
                { v: 1, type: "rfq_refusal", rfq_id: RFQ_ID, reason: "exposure_cap" },
                RFQ_ID,
                LIGHTNING_SEND_PAIR,
            ),
        ).toThrow(SwapRefusal);
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
            } as unknown as new (
                url: string,
            ) => RelaySocket,
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

/**
 * The max-fee gate: the client's own ceiling on what a quote may charge.
 *
 * A solver's fee is `from_amount - to_amount` and nothing in the quote breaks it
 * down. With dynamic pricing the flat component tracks the chain fee market, so
 * the registry card cannot bound it either — the card publishes the configured
 * fallback, not the live ceiling. This is the only place a client can hold a
 * line, and it needs nothing from the solver.
 */
describe("assertFundable — the max-fee gate", () => {
    const now = 1_800_000_000;
    const fundable = (over: Partial<RfqQuote>, maxFee?: { bps?: number; sats?: number }) =>
        assertFundable({
            quote: quoteFixture({ valid_until: now + 900, refund_locktime: now + 7200, ...over }),
            invoiceExpiresAt: now + 3600,
            now,
            maxFee,
        });

    it("does not gate at all when no ceiling is given", () => {
        // Backward compatibility is the point: every existing caller passes no
        // `maxFee` and must keep funding exactly what it funded before.
        expect(() => fundable({ from_amount: 10_000, to_amount: 1 })).not.toThrow();
    });

    /**
     * The guards on the CEILING itself, as opposed to on the quote.
     *
     * A ceiling only protects while it is a bound the comparison can hold, and
     * each of these is a way to write one that is not: `bps: 10_001` is looser
     * than any real quote and therefore no bound at all, a fractional `bps`
     * silently truncates through `Math.floor` into a different ceiling than the
     * caller wrote, and a negative bound refuses everything. All are mistakes at
     * the CALL SITE, so they fail there by name rather than being clamped into
     * something plausible — a clamped ceiling is a wallet believing it is
     * protected at a level it never asked for.
     *
     * Asserted on `reason` rather than on the message: the reason code is the
     * closed contract a caller branches on, and the sentence beside it is not.
     */
    const reasonOf = (run: () => unknown): string => {
        try {
            run();
        } catch (error) {
            return (error as { reason?: string }).reason ?? "<threw without a reason>";
        }
        return "<did not throw>";
    };

    it.each([
        ["bps past 100%", { bps: 10_001 }],
        ["negative bps", { bps: -1 }],
        ["fractional bps", { bps: 12.5 }],
        ["negative sats", { sats: -1 }],
        ["fractional sats", { sats: 0.5 }],
    ])("refuses a ceiling that is not a usable bound: %s", (_label, maxFee) => {
        expect(reasonOf(() => fundable({ from_amount: 100_000, to_amount: 99_999 }, maxFee))).toBe(
            "max_fee_out_of_range",
        );
    });

    it("allows the boundary values, so the guard does not become the bug", () => {
        // 10_000 bps is exactly 100% and 0 is a real choice — an absolute-only
        // ceiling is written `{ bps: 0, sats: n }`. Refusing either would make
        // this guard reject ceilings a caller is entitled to set.
        const quote = { from_amount: 100_000, to_amount: 99_999 };
        expect(() => fundable(quote, { bps: 10_000 })).not.toThrow();
        expect(() => fundable(quote, { bps: 0, sats: 1 })).not.toThrow();
        expect(() => fundable(quote, { sats: 0, bps: 1 })).not.toThrow();
    });

    it("refuses a fee above the proportional ceiling", () => {
        expect(() =>
            fundable({ from_amount: 100_000, to_amount: 99_000 }, { bps: 100 }),
        ).not.toThrow();
        expect(() => fundable({ from_amount: 100_000, to_amount: 98_999 }, { bps: 100 })).toThrow(
            /fee/i,
        );
    });

    /**
     * THE CASE THIS EXISTS FOR. A flat network component is a large percentage
     * of a small swap: 420 sats on 5_000 is 8.4%, and on 500_000 it is 0.084%.
     * A bare percentage therefore refuses every small swap the moment fees rise.
     * The ceiling is the GREATER of the two allowances, so an absolute floor
     * covers the flat component without weakening the proportional bound.
     */
    it("allows a flat network fee on a small swap that a bare percentage would refuse", () => {
        expect(() => fundable({ from_amount: 5_420, to_amount: 5_000 }, { bps: 100 })).toThrow(
            /fee/i,
        );
        expect(() =>
            fundable({ from_amount: 5_420, to_amount: 5_000 }, { bps: 100, sats: 1_000 }),
        ).not.toThrow();
    });

    it("keeps the proportional bound on a large swap, where the absolute one is slack", () => {
        // allowed = max(1_000, 1% of 500_000) = 5_000.
        expect(() =>
            fundable({ from_amount: 500_000, to_amount: 495_000 }, { bps: 100, sats: 1_000 }),
        ).not.toThrow();
        expect(() =>
            fundable({ from_amount: 500_000, to_amount: 494_999 }, { bps: 100, sats: 1_000 }),
        ).toThrow(/fee/i);
    });

    /**
     * LOUD, not silent. `from_amount - to_amount` is a fee only when both sides
     * name the same asset; on `arkade:BTC->ethereum:<token>` it subtracts tokens
     * from sats and means nothing. Skipping quietly would leave a wallet
     * believing a ceiling applied when it did not, which is worse than no gate.
     */
    it("refuses to pretend it can gate a cross-asset pair", () => {
        expect(() =>
            fundable(
                { pair: "arkade:BTC->ethereum:0xa0b86991", from_amount: 100_000, to_amount: 42 },
                { bps: 100 },
            ),
        ).toThrow(/cross-asset|different assets/i);
    });

    it("refuses a ceiling that names neither bound, rather than tolerating no fee", () => {
        // `{}` reads as "no fee at all" if taken literally, which no caller means.
        expect(() => fundable({ from_amount: 100_000, to_amount: 99_999 }, {})).toThrow(
            /bps|sats/i,
        );
    });
});

/**
 * The cross-asset half of the same ceiling.
 *
 * `from_amount - to_amount` is not a fee when the legs name different assets,
 * but the fee is not unknowable — it is the spread against a reference rate,
 * and the caller is the only party that can supply one honestly. Given `R` in
 * to-units per from-unit, the fee in FROM units is
 * `(from_amount * R - to_amount) / R`, and the same max(proportional, absolute)
 * rule applies unchanged.
 */
describe("assertFundable — the max-fee gate, cross-asset", () => {
    const now = 1_800_000_000;
    const CROSS = "arkade:BTC->ethereum:0xa0b86991";
    const gate = (
        over: Partial<RfqQuote>,
        maxFee?: { bps?: number; sats?: number; referenceRate?: number },
    ) =>
        assertFundable({
            quote: quoteFixture({
                pair: CROSS,
                from_amount: 100_000,
                valid_until: now + 900,
                refund_locktime: now + 7200,
                ...over,
            }),
            invoiceExpiresAt: now + 3600,
            now,
            maxFee,
        });

    // R = 0.5 token-units per sat, so 100_000 sats is fairly worth 50_000.
    it("gates on the spread against the caller's own rate", () => {
        // 49_500 received = 500 short = 1_000 sats of fee = exactly 1% of 100_000.
        expect(() => gate({ to_amount: 49_500 }, { bps: 100, referenceRate: 0.5 })).not.toThrow();
        expect(() => gate({ to_amount: 49_499 }, { bps: 100, referenceRate: 0.5 })).toThrow(/fee/i);
    });

    it("still refuses when no rate is supplied — unchanged from before", () => {
        expect(() => gate({ to_amount: 42 }, { bps: 100 })).toThrow(/different assets|rate/i);
    });

    it("refuses a rate that cannot price anything", () => {
        for (const referenceRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => gate({ to_amount: 49_500 }, { bps: 100, referenceRate })).toThrow(
                /referenceRate/i,
            );
        }
    });

    /**
     * Rounds the fee UP, and this is the only case that can tell. R = 3 with
     * 2_999 to-units short is 999.67 sats of fee: ceil refuses it against a
     * 999-sat ceiling, floor funds it. Erring toward refusing is the client's
     * side to err on, and without this the choice was untested — a floor
     * mutation passed every other case here.
     */
    it("rounds a fractional cross-asset fee up, not down", () => {
        expect(() => gate({ to_amount: 297_001 }, { sats: 999, referenceRate: 3 })).toThrow(/fee/i);
    });

    it("ignores a rate on a same-asset pair, where the exact fee is already known", () => {
        // A wallet setting one ceiling for every pair must not be punished for
        // carrying a rate the same-asset branch has no use for.
        expect(() =>
            assertFundable({
                quote: quoteFixture({
                    from_amount: 100_000,
                    to_amount: 99_500,
                    valid_until: now + 900,
                    refund_locktime: now + 7200,
                }),
                invoiceExpiresAt: now + 3600,
                now,
                maxFee: { bps: 100, referenceRate: 0.5 },
            }),
        ).not.toThrow();
    });
});
