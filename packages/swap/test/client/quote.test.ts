/**
 * `quote()` end to end: the four implemented routes, both backends, and one
 * verification failure per check.
 *
 * The solver doubles derive the covenants the client will derive, from the
 * request the client actually sent, so a passing `lockup_address` check means
 * the two derivations agreed rather than that neither ran. Every failure case
 * is a tamper on that agreement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress, contractSigner } from "@arkade-os/sdk";
import { ScriptNum } from "@scure/btc-signer";
import {
    claimPacketShape,
    EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
    EXECUTOR_RECEIVE_TEMPLATE_ID,
} from "../../src/claimPacket";
import { openClaimPacket } from "../helpers/claimPacket";
import { createSwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import { AmountMismatch, QuoteExpired, QuoteVerificationFailed } from "../../src/client/errors";
import { AmountEncodingUnsupported } from "../../src/client/errors";
import { MIN_HEADROOM_SECONDS, SwapRefusal } from "../../src/rfq";
import { MissingCorridorDep } from "../../src/client/errors";
import { DEFAULT_MAX_REFUND_WINDOW_SECONDS } from "../../src/client/policy";
import type { QuoteInput } from "../../src/client/quote";
import { l1ScriptForAddress } from "../../src/onchainHtlc";
import {
    BOARDING_ADDRESS,
    EMULATOR_PUBKEY_HEX,
    PAYMENT_HASH,
    SOLVER_DISCOVERY_KEY,
    SOLVER_PUBKEY,
    clockAt,
    compressed,
    feedServing,
    hdWallet,
    invoiceFor,
    lightningCard,
    lightningReceiveAnswer,
    lightningSendAnswer,
    onchainCard,
    onchainReceiveAnswer,
    onchainSendAnswer,
    solverTransport,
    solverFor,
    spotCard,
    type SolverAnswer,
    type SolverTransport,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

const setup = async (
    over: {
        answer?: SolverAnswer;
        attestedResponder?: string | undefined;
        snapshot?: (typeof lightningCard)[];
        policy?: Parameters<typeof createSwapClient>[0]["policy"];
        corridors?: Parameters<typeof createSwapClient>[0]["corridors"];
        price?: number;
    } = {},
) => {
    const wallet = await hdWallet();
    const transport: SolverTransport = solverTransport(
        over.answer ?? solverFor(CLOCK),
        "attestedResponder" in over ? { attestedResponder: over.attestedResponder } : {},
    );
    const feed = feedServing(over.price);
    const client = createSwapClient({
        wallet,
        discovery: { snapshot: over.snapshot ?? [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => transport,
        fetchImpl: feed.fetch,
        ...(over.policy === undefined ? {} : { policy: over.policy }),
        ...(over.corridors === undefined ? {} : { corridors: over.corridors }),
    });
    return { client, transport, feed, wallet };
};

const sendInput = (): QuoteInput => ({ to: invoiceFor(PAYMENT_HASH, CLOCK) });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});

it("refuses payouts below the default template admission minimum before sending an RFQ", async () => {
    const executor = { encryptionPubkey: compressed(7) };
    for (const via of ["lightning", "onchain"] as const) {
        const corridors =
            via === "lightning" ? { lightning: { executor } } : { onchain: { executor } };
        const snapshot = [lightningCard, onchainCard].map((card) => ({
            ...card,
            min_base_amount: "1",
            min_quote_amount: "1",
        }));
        const { client, transport } = await setup({ corridors, snapshot });
        await expect(client.quote({ via, amount: 999n, amountOn: "take" })).rejects.toThrow(
            /1,000/,
        );
        expect(transport.sent).toHaveLength(0);
    }
});

afterEach(() => {
    vi.useRealTimers();
});

describe.each(["lightning", "onchain"] as const)("%s receive predicates", (via) => {
    const predicate = Uint8Array.of(0x51);
    const configured = (program = predicate, templateId?: string) => ({
        [via]: { executor: { encryptionPubkey: compressed(7), predicate: program, templateId } },
    });

    it("seals the public program hash and fixed payout before sending the RFQ", async () => {
        const { client, transport, wallet } = await setup({ corridors: configured() });
        const quote = await client.quote({ via, amount: 4_950n, amountOn: "take" });
        const packet = (transport.sent[0] as { profile: { claim_packet: string } }).profile
            .claim_packet;
        const plaintext = await openClaimPacket(
            packet,
            new Uint8Array(32).fill(7),
            EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
        );
        expect(plaintext.subarray(32, 64)).toEqual(
            ArkAddress.decode(await wallet.getAddress()).pkScript.subarray(2),
        );
        expect(plaintext.subarray(64, 96)).toEqual(sha256(predicate));
        expect(ScriptNum(8, true).decode(plaintext.subarray(96))).toBe(4_950n);
        expect(base64.decode(packet).slice(-4)).toEqual(Uint8Array.of(4, 0, 1, 0x51));
        expect(client.preparationOf(quote.id)).toMatchObject({ executorClaims: true });
        expect(transport.sent).toHaveLength(1);
    });

    it("requires a fixed take amount before sending an RFQ", async () => {
        const { client, transport } = await setup({ corridors: configured() });
        await expect(client.quote({ via, amount: 5_000n, amountOn: "give" })).rejects.toThrow(
            /amountOn.*take/,
        );
        expect(transport.sent).toHaveLength(0);
    });

    it("retains the admission floor for either default template", async () => {
        for (const templateId of [
            undefined,
            EXECUTOR_RECEIVE_TEMPLATE_ID,
            EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID,
        ]) {
            const snapshot = [lightningCard, onchainCard].map((card) => ({
                ...card,
                min_base_amount: "1",
                min_quote_amount: "1",
            }));
            const { client, transport } = await setup({
                corridors: configured(predicate, templateId),
                snapshot,
            });
            await expect(client.quote({ via, amount: 999n, amountOn: "take" })).rejects.toThrow(
                /1,000/,
            );
            expect(transport.sent).toHaveLength(0);
        }
    });

    it("refuses invalid program lengths before sending an RFQ", async () => {
        for (const length of [0, 521]) {
            const { client, transport } = await setup({
                corridors: configured(new Uint8Array(length)),
            });
            await expect(client.quote({ via, amount: 5_000n, amountOn: "take" })).rejects.toThrow(
                /predicate.*1.*520/,
            );
            expect(transport.sent).toHaveLength(0);
        }
    });
});

it("keeps the custom predicate template's admission policy", async () => {
    const templateId = "compatible-custom-predicate-template";
    const { client, transport } = await setup({
        corridors: {
            onchain: {
                executor: {
                    encryptionPubkey: compressed(7),
                    predicate: Uint8Array.of(0x51),
                    templateId,
                },
            },
        },
        snapshot: [{ ...onchainCard, min_base_amount: "1", min_quote_amount: "1" }],
    });
    await client.quote({ via: "onchain", amount: 999n, amountOn: "take" });
    const packet = (transport.sent[0] as { profile: { claim_packet: string } }).profile
        .claim_packet;
    const plaintext = await openClaimPacket(packet, new Uint8Array(32).fill(7), templateId);
    expect(ScriptNum(8, true).decode(plaintext.subarray(96))).toBe(999n);
});

describe("quote() on arkade -> lightning", () => {
    it("pins the amount from the invoice and returns the order, fee included", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(sendInput());

        expect(quote.give).toEqual({ asset: "arkade:regtest/slip44:1", amount: 5_050n });
        expect(quote.take).toEqual({ asset: "bolt11:regtest/slip44:1", amount: 5_000n });
        expect(quote.fee).toEqual({ amount: 50n, asset: "arkade:regtest/slip44:1" });
        expect(quote.lock).toEqual({ hash: PAYMENT_HASH });
        expect(quote.refundLocktime).toBe(CLOCK.refundLocktime);
        expect(quote.expiresAt).toBe(CLOCK.validUntil);
        expect(quote.solver).toBe(hex.encode(SOLVER_PUBKEY));
        // The give leg is the wallet's, the take leg is the invoice the caller
        // handed in: the supply law, as a value.
        expect(quote.route.give.instrument).toEqual({ kind: "wallet" });
        expect(quote.route.take.instrument).toMatchObject({ kind: "invoice" });
        // Nothing to show a counterparty: the solver already has the invoice.
        expect(quote.artifact).toBeUndefined();
        expect(transport.sent).toHaveLength(1);
    });

    it("carries the card's provenance and closes the rendezvous behind it", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(sendInput());

        expect(quote.market).toMatchObject({
            kind: "card",
            backend: "rfq",
            key: "arkade:btc/lightning:btc",
            source: lightningCard.source,
            sourceType: "registry",
            solver: "frenchman",
            discoveryPubkey: SOLVER_DISCOVERY_KEY,
        });
        expect(quote.market.kind === "card" && quote.market.snapshot.source).toBe("injected");
        expect(transport.closed()).toBe(true);
    });

    it("hands the accept path the covenant it verified, and persists nothing", async () => {
        const { client } = await setup();
        const quote = await client.quote(sendInput());
        const preparation = client.preparationOf(quote.id);

        expect(preparation).toMatchObject({ backend: "rfq", route: "arkade->lightning" });
        // The wallet double throws from `getContractManager`, so reaching here
        // is the assertion that nothing was registered.
        expect(preparation && "lockup" in preparation && preparation.lockup.address).toMatch(
            /^tark1/,
        );
    });

    it("populates no auction: published RFQ is reserved and inert", async () => {
        const { client } = await setup();
        expect((await client.quote(sendInput())).auction).toBeUndefined();
    });
});

describe("quote() on lightning -> arkade", () => {
    const receive = (): QuoteInput => ({ via: "lightning", amount: 5_000n, amountOn: "give" });

    it("returns the solver's hold invoice as the artifact, verified against this swap", async () => {
        const { client, transport } = await setup();
        const quote = await client.quote(receive());

        expect(quote.artifact?.kind).toBe("invoice");
        // The artifact and the give leg's instrument are one fact, not two.
        expect(quote.artifact).toEqual({
            kind: "invoice",
            bolt11: (quote.route.give.instrument as { bolt11: string }).bolt11,
        });
        expect(transport.sent).toHaveLength(1);
        expect(quote.give.asset).toBe("bolt11:regtest/slip44:1");
        expect(quote.take).toEqual({ asset: "arkade:regtest/slip44:1", amount: 4_950n });
        // The give leg's instrument IS the artifact — the quote supplies the
        // non-wallet give instrument, which is what the artifact is.
        expect(quote.route.give.instrument).toMatchObject({ kind: "invoice", amount: 5_000n });
        expect(quote.route.take.instrument).toEqual({ kind: "wallet" });
    });

    it("sends the amount as a canonical decimal string on the side it pins", async () => {
        const { client, transport } = await setup();
        await client.quote(receive());
        expect(transport.sent[0]).toMatchObject({ amount: "5000", amount_side: "from" });
    });

    it("expires with the hold invoice rather than with the quote", async () => {
        const { client } = await setup();
        const quote = await client.quote(receive());
        // The invoice's own window is an hour from a minute ago; the quote's is
        // an hour from now. The earlier of the two binds.
        expect(quote.expiresAt).toBe(NOW + 3_540);
        expect(quote.expiresAt).toBeLessThan(CLOCK.validUntil);
    });

    describe("the claim packet", () => {
        it("is omitted when no Executor key is configured", async () => {
            const { client, transport } = await setup();
            await client.quote(receive());

            const { profile } = transport.sent[0] as { profile: Record<string, unknown> };
            expect(Object.keys(profile)).not.toContain("claim_packet");
        });

        const withExecutor = { lightning: { executor: { encryptionPubkey: compressed(7) } } };
        const packetOf = (transport: SolverTransport): string =>
            (transport.sent[0] as { profile: Record<string, unknown> }).profile
                .claim_packet as string;

        it("seals the caller's fixed payout and receiver before the quote", async () => {
            const { client, transport, wallet } = await setup({ corridors: withExecutor });
            await client.quote({ via: "lightning", amount: 4_950n, amountOn: "take" });
            const plaintext = await openClaimPacket(
                packetOf(transport),
                new Uint8Array(32).fill(7),
                EXECUTOR_RECEIVE_TEMPLATE_ID,
            );
            expect(plaintext.subarray(32, 64)).toEqual(
                ArkAddress.decode(await wallet.getAddress()).pkScript.subarray(2),
            );
            expect(ScriptNum(8, true).decode(plaintext.subarray(64))).toBe(4_950n);
            expect(claimPacketShape(packetOf(transport))).toMatchObject({
                kind: "packet",
                needsArkadeScript: true,
                encryptionPubkey: hex.decode(compressed(7)),
            });
        });

        it("refuses a delegated quote without a caller-fixed received amount", async () => {
            const { client, transport } = await setup({ corridors: withExecutor });
            await expect(client.quote(receive())).rejects.toThrow(/amountOn.*take/);
            expect(transport.sent).toHaveLength(0);
        });

        it("refuses a key that is not 33-byte compressed hex", async () => {
            for (const key of ["11".repeat(32), "not hex"]) {
                const { client } = await setup({
                    corridors: { lightning: { executor: { encryptionPubkey: key as never } } },
                });
                await expect(client.quote(receive())).rejects.toThrow();
            }
        });
    });
});

describe("quote() on arkade -> onchain", () => {
    const send = (): QuoteInput => ({ to: BCRT1, amount: 100_000n, amountOn: "give" });

    it("quotes both contracts and reports the covenant's refund deadline", async () => {
        const { client } = await setup();
        const quote = await client.quote(send());

        expect(quote.give).toEqual({ asset: "arkade:regtest/slip44:1", amount: 100_000n });
        expect(quote.take).toEqual({ asset: "bitcoin:regtest/slip44:1", amount: 99_000n });
        expect(quote.route.take.instrument).toEqual({ kind: "address", address: BCRT1 });
        expect(quote.refundLocktime).toBe(CLOCK.refundLocktime);
        const preparation = client.preparationOf(quote.id);
        expect(preparation).toMatchObject({
            route: "arkade->onchain",
            minConfirmations: 2,
            l1Network: "regtest",
        });
    });
});

describe("quote() on arkade -> arkade", () => {
    const exchange = (): QuoteInput => ({
        give: "BTC",
        take: "USD",
        amount: 10_000n,
        amountOn: "give",
    });

    it("prices from the card's feed, with no round trip to anybody", async () => {
        const { client, transport, feed } = await setup();
        const quote = await client.quote(exchange());

        // 10_000 sats at 0.1 cents/sat, less the card's 30bps and no cushion.
        expect(quote.give.amount).toBe(10_000n);
        expect(quote.take).toEqual({
            asset: `arkade:regtest/asset:${spotCard.quote_asset.id}`,
            amount: 997n,
        });
        expect(quote.fee).toEqual({
            amount: 3n,
            asset: `arkade:regtest/asset:${spotCard.quote_asset.id}`,
        });
        expect(quote.market.backend).toBe("feed");
        expect(transport.sent).toHaveLength(0);
        expect(feed.calls()).toBe(1);
    });

    it("mints an expiry from the feed's own freshness, since the plan carries none", async () => {
        const { client } = await setup();
        const quote = await client.quote(exchange());
        expect(quote.expiresAt).toBe(NOW + 30);
        expect(quote.solver).toBeUndefined();
        expect(quote.lock).toBeUndefined();
        expect(quote.refundLocktime).toBeUndefined();
    });

    it("resolves a ticker against the cards themselves", async () => {
        const { client } = await setup();
        const resolution = await client.resolve(exchange());
        expect(resolution.give.asset).toBe("arkade:regtest/slip44:1");
        expect(resolution.take.asset).toBe(`arkade:regtest/asset:${spotCard.quote_asset.id}`);
    });
});

describe("a dependency overridden to nothing", () => {
    const withoutChainSource = async () => {
        const wallet = await hdWallet();
        const transport = solverTransport(solverFor(CLOCK));
        const feed = feedServing();
        return {
            transport,
            client: createSwapClient({
                wallet,
                discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
                corridors: { onchain: { chain: null } },
                emulatorPubkey: EMULATOR_PUBKEY_HEX,
                transportFor: () => transport,
                fetchImpl: feed.fetch,
            }),
        };
    };

    it("refuses the route that touches it, before anything is disclosed", async () => {
        const { client, transport } = await withoutChainSource();
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(MissingCorridorDep);
        expect(error.corridor).toBe("onchain");
        expect(transport.sent).toHaveLength(0);
    });

    it("is no error at all for a route that never touches that corridor", async () => {
        const { client } = await withoutChainSource();
        await expect(client.quote(sendInput())).resolves.toMatchObject({
            take: { amount: 5_000n },
        });
    });
});

describe("the boundary quote() stops at", () => {
    /** Every repository call this quote made, by name. */
    const recording = (): { repository: AssetSwapRepository; calls: string[] } => {
        const calls: string[] = [];
        const backing = new InMemoryAssetSwapRepository();
        const repository = new Proxy(backing, {
            get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (typeof value !== "function") return value;
                return (...args: unknown[]) => {
                    calls.push(String(property));
                    return (value as (...a: unknown[]) => unknown).apply(target, args);
                };
            },
        }) as unknown as AssetSwapRepository;
        return { repository, calls };
    };

    it("writes no record on either backend, and reaches no contract manager", async () => {
        const { repository, calls } = recording();
        const wallet = await hdWallet();
        const transport = solverTransport(solverFor(CLOCK));
        const feed = feedServing();
        const client = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feed.fetch,
        });

        await client.quote(sendInput());
        await client.quote({ give: "BTC", take: "USD", amount: 10_000n, amountOn: "give" });

        // The wallet double throws from `getContractManager`, so arriving here
        // is the proof that no lockup was registered — and the repository saw
        // no write at all, because the markets came from an injected snapshot.
        expect(calls.filter((call) => call.startsWith("save"))).toEqual([]);
        expect(calls.filter((call) => call.includes("Swap"))).toEqual([]);
    });
});

describe("quote() on onchain -> arkade", () => {
    const receive = (): QuoteInput => ({ via: "onchain", amount: 100_000n, amountOn: "give" });

    it("seals the onchain receive terms and marks the executor claim", async () => {
        const { client, transport, wallet } = await setup({
            corridors: { onchain: { executor: { encryptionPubkey: compressed(7) } } },
        });
        const quote = await client.quote({ via: "onchain", amount: 99_000n, amountOn: "take" });
        const packet = (transport.sent[0] as { profile: { claim_packet: string } }).profile
            .claim_packet;
        const plaintext = await openClaimPacket(
            packet,
            new Uint8Array(32).fill(7),
            EXECUTOR_RECEIVE_TEMPLATE_ID,
        );
        expect(plaintext.subarray(32, 64)).toEqual(
            ArkAddress.decode(await wallet.getAddress()).pkScript.subarray(2),
        );
        expect(ScriptNum(8, true).decode(plaintext.subarray(64))).toBe(99_000n);
        expect(client.preparationOf(quote.id)).toMatchObject({ executorClaims: true });
    });

    it("refuses an onchain delegated receive that only fixes the amount given", async () => {
        const { client, transport } = await setup({
            corridors: { onchain: { executor: { encryptionPubkey: compressed(7) } } },
        });
        await expect(client.quote(receive())).rejects.toThrow(/amountOn.*take/);
        expect(transport.sent).toHaveLength(0);
    });

    it("hands back the L1 HTLC to fund as the give leg's instrument and artifact", async () => {
        const { client } = await setup();
        const quote = await client.quote(receive());

        expect(quote.give).toEqual({ asset: "bitcoin:regtest/slip44:1", amount: 100_000n });
        expect(quote.take).toEqual({ asset: "arkade:regtest/slip44:1", amount: 99_000n });
        const preparation = client.preparationOf(quote.id);
        if (preparation?.backend !== "rfq" || preparation.route !== "onchain->arkade") {
            throw new Error("expected an onchain->arkade preparation");
        }
        const htlcAddress = preparation.htlc.address;
        expect(quote.route.give.instrument).toEqual({
            kind: "address",
            address: htlcAddress,
            amount: 100_000n,
        });
        expect(quote.route.take.instrument).toEqual({ kind: "wallet" });
        expect(quote.artifact).toMatchObject({
            kind: "deposit",
            corridor: "onchain",
            address: htlcAddress,
            amount: 100_000n,
        });
        expect(quote.refundLocktime).toBe(CLOCK.refundLocktime);
        expect(preparation).toMatchObject({
            minConfirmations: 2,
            l1Network: "regtest",
            expectedAmount: 99_000n,
        });
    });

    it("binds the HTLC's refund leaf to a wallet key and refunds to a boarding address", async () => {
        const { client, transport, wallet } = await setup();
        const quote = await client.quote(receive());
        const preparation = client.preparationOf(quote.id);
        if (preparation?.backend !== "rfq" || preparation.route !== "onchain->arkade") {
            throw new Error("expected an onchain->arkade preparation");
        }

        const { profile } = transport.sent[0] as { profile: Record<string, unknown> };
        expect(profile.refund_pubkey).toBe(hex.encode(preparation.refundKey.pubkey));
        expect(preparation.htlcParams.refundKey).toEqual(preparation.refundKey.pubkey);
        const signer = await contractSigner(wallet, preparation.refundKey.descriptor);
        expect(await signer.xOnlyPublicKey()).toEqual(preparation.refundKey.pubkey);
        expect(preparation.refundPkScript).toEqual(l1ScriptForAddress(BOARDING_ADDRESS, "regtest"));
    });

    it("refuses an HTLC address it did not derive", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainReceiveAnswer(payload, CLOCK, { profile: { htlc_address: BCRT1 } }),
        });
        await expect(client.quote(receive())).rejects.toThrow(QuoteVerificationFailed);
    });
});

describe("verification, one failure per check", () => {
    it("refuses a quote for another pair", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, { quote: { pair: "arkade:BTC->onchain:BTC" } }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("pair");
    });

    it("refuses a lockup address it did not derive", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, {
                    profile: { lockup_address: "tark1qsomebodyelses" },
                }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("lockup_address");
        // v1's AddressMismatch, folded in rather than admitted as a
        // seventeenth member.
        expect(error.cause).toMatchObject({ name: "AddressMismatch" });
    });

    it("refuses a send quote that reprices the invoice", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, { quote: { to_amount: 4_000 } }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("invoice");
    });

    it("refuses a hold invoice on another payment hash", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningReceiveAnswer(payload, CLOCK, {
                    invoice: invoiceFor("ab".repeat(32), CLOCK),
                }),
        });
        const error = await client
            .quote({ via: "lightning", amount: 5_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("invoice");
    });

    it("refuses a refund window inside the funding headroom", async () => {
        const tight = { ...CLOCK, refundLocktime: NOW + MIN_HEADROOM_SECONDS - 60 };
        const { client } = await setup({
            answer: (payload) => lightningSendAnswer(payload, tight),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
    });

    it("refuses a valid_until that would delete the expiry gate rather than fail it", async () => {
        const { client } = await setup({
            answer: (payload) => ({
                ...lightningSendAnswer(payload, CLOCK),
                valid_until: Number.NaN,
            }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
    });

    it("refuses a transport that attests nobody, before disclosing anything", async () => {
        const { client, transport } = await setup({ attestedResponder: undefined });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("responder");
        // The whole point of running it before the request.
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a transport attesting somebody other than the card's key", async () => {
        const { client } = await setup({ attestedResponder: "cd".repeat(32) });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error.check).toBe("responder");
        expect(error.expected).toBe(SOLVER_DISCOVERY_KEY);
    });

    it("keeps a solver's decline a refusal, not a verification failure", async () => {
        const { client } = await setup({
            answer: () => {
                throw new SwapRefusal("amount_out_of_range");
            },
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(SwapRefusal);
        expect(error).not.toBeInstanceOf(QuoteVerificationFailed);
        expect(error.reason).toBe("amount_out_of_range");
    });

    it("refuses a refund locktime past the policy's refund window", async () => {
        const long = { ...CLOCK, refundLocktime: NOW + DEFAULT_MAX_REFUND_WINDOW_SECONDS + 3600 };
        const { client } = await setup({
            answer: (payload) => lightningSendAnswer(payload, long),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
        expect(error.expected).toMatch(/at most/);
    });

    it("refuses a solo-refund delay past the policy's refund window", async () => {
        const { client } = await setup({
            answer: (payload) =>
                lightningSendAnswer(payload, CLOCK, { refundWithoutReceiverDelay: 0xffff * 512 }),
        });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
        expect(error.expected).toMatch(/at most/);
    });

    it("refuses an onchain send's refund locktime past the refund window", async () => {
        const long = { ...CLOCK, refundLocktime: NOW + DEFAULT_MAX_REFUND_WINDOW_SECONDS + 3600 };
        const { client } = await setup({
            answer: (payload) => onchainSendAnswer(payload, long),
        });
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
        expect(error.expected).toMatch(/at most/);
    });

    it("refuses an onchain send's solo-refund delay past the refund window", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainSendAnswer(payload, CLOCK, { refundWithoutReceiverDelay: 0xffff * 512 }),
        });
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(QuoteVerificationFailed);
        expect(error.check).toBe("refund_window");
        expect(error.expected).toMatch(/solo-refund delay/);
    });

    it("takes a longer refund window when the policy allows it", async () => {
        const long = { ...CLOCK, refundLocktime: NOW + DEFAULT_MAX_REFUND_WINDOW_SECONDS + 3600 };
        const { client } = await setup({
            answer: (payload) => lightningSendAnswer(payload, long),
            policy: { maxRefundWindowSeconds: 2 * DEFAULT_MAX_REFUND_WINDOW_SECONDS },
        });
        const quote = await client.quote(sendInput());
        expect(quote.refundLocktime).toBe(long.refundLocktime);
    });

    it("refuses a quote already inside the policy's TTL floor", async () => {
        const { client } = await setup({ policy: { quoteTtlFloorSeconds: 7_200 } });
        const error = await client.quote(sendInput()).catch((e) => e);
        expect(error).toBeInstanceOf(QuoteExpired);
    });
});

describe("the amount encoding, both ways", () => {
    it("refuses a quote amount a JSON number cannot carry", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainSendAnswer(payload, CLOCK, {
                    quote: { from_amount: Number.MAX_SAFE_INTEGER + 2 },
                }),
        });
        const error = await client
            .quote({ to: BCRT1, amount: 100_000n, amountOn: "give" })
            .catch((e) => e);
        expect(error).toBeInstanceOf(AmountEncodingUnsupported);
        expect(error.field).toBe("from_amount");
    });

    it("reads a canonical decimal string quote amount", async () => {
        const { client } = await setup({
            answer: (payload) =>
                onchainSendAnswer(payload, CLOCK, {
                    quote: {
                        from_amount: "100000" as unknown as number,
                        to_amount: "99000" as unknown as number,
                    },
                }),
        });
        const quote = await client.quote({ to: BCRT1, amount: 100_000n, amountOn: "give" });
        expect(quote.give.amount).toBe(100_000n);
        expect(quote.take.amount).toBe(99_000n);
    });

    it("refuses a second pinned amount before any round trip", async () => {
        const { client, transport } = await setup();
        await expect(
            client.quote({ ...sendInput(), amount: 5_000n, amountOn: "take" }),
        ).rejects.toThrow(AmountMismatch);
        expect(transport.sent).toHaveLength(0);
    });
});
