/**
 * The three verbs, through the real client.
 *
 * They add no capability, so what is worth pinning is exactly what they decide:
 * which `QuoteInput` each destination compiles to, that the ceiling is checked
 * between `quote` and `accept` and therefore before anything is funded, that a
 * plain Arkade address never becomes a swap, and that `receive` cannot return
 * before its artifact is durable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { createSwapClient, type SwapClient } from "../../src/client/client";
import { MaxFeeExceeded } from "../../src/client/errors";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../../src/repository";
import type { FeeCeiling } from "../../src/client/verbs";
import type { SwapPolicy } from "../../src/client/policy";
import {
    EMULATOR_PUBKEY_HEX,
    NETWORK,
    OPERATOR_PUBKEY,
    PAYMENT_HASH,
    USD_ASSET_ID,
    acceptWallet,
    clockAt,
    feedServing,
    invoiceFor,
    key,
    lightningCard,
    onchainCard,
    solverFor,
    solverTransport,
    spotCard,
    type AcceptWallet,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const BCRT1 = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const ARK_ADDRESS = new ArkAddress(OPERATOR_PUBKEY, key(21), NETWORK.hrp).encode();
const INVOICE = invoiceFor(PAYMENT_HASH, CLOCK);

/** BTC on the leg every corridor quote denominates its fee on. */
const ARKADE_BTC = "arkade:regtest/slip44:0" as const;
const USD = `arkade:regtest/asset:${USD_ASSET_ID}` as const;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface Harness {
    readonly client: SwapClient;
    readonly repository: AssetSwapRepository;
    readonly wallet: AcceptWallet;
}

const harness = async (policy?: SwapPolicy): Promise<Harness> => {
    const wallet = await acceptWallet();
    const repository = new InMemoryAssetSwapRepository();
    const client = createSwapClient({
        wallet: wallet.wallet,
        repository,
        discovery: { snapshot: [lightningCard, onchainCard, spotCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => solverTransport(solverFor(CLOCK)),
        fetchImpl: feedServing().fetch,
        ...(policy === undefined ? {} : { policy }),
    });
    return { client, repository, wallet };
};

const ceiling = (amount: bigint, asset: string = ARKADE_BTC): FeeCeiling =>
    ({ amount, asset }) as FeeCeiling;

describe("pay", () => {
    it("compiles a bolt11 to the lightning send, taking the invoice's own amount", async () => {
        const { client, repository } = await harness();
        const result = await client.pay(INVOICE);

        expect(result.kind).toBe("swap");
        if (result.kind !== "swap") return;
        expect(result.swap.route.give.corridor).toBe("arkade");
        expect(result.swap.route.take.corridor).toBe("lightning");
        expect(result.swap.take.amount).toBe(5_000n);
        expect(result.swap.fee).toEqual({ asset: ARKADE_BTC, amount: 50n });
        expect(await repository.getSwapRecord(result.swap.id.slice(4))).toBeDefined();
    });

    it("compiles a bitcoin address to the onchain send, pinning what the recipient gets", async () => {
        const { client } = await harness();
        const result = await client.pay(BCRT1, { amount: 99_000n });

        expect(result.kind).toBe("swap");
        if (result.kind !== "swap") return;
        expect(result.swap.route.take.corridor).toBe("onchain");
        // `amountOn: "take"`: the number beside a destination is what lands there.
        expect(result.swap.take.amount).toBe(99_000n);
        expect(result.swap.give.amount).toBe(100_000n);
    });

    it("refuses an amount beside an invoice that already pins one", async () => {
        const { client } = await harness();
        await expect(client.pay(INVOICE, { amount: 5_000n })).rejects.toThrow(
            /exactly one amount may be pinned/,
        );
    });

    describe("to a plain Arkade address", () => {
        it("sends through the wallet and manufactures no swap", async () => {
            const { client, repository, wallet } = await harness();
            const result = await client.pay(ARK_ADDRESS, { amount: 1_000n });

            expect(result).toEqual({ kind: "payment", txid: expect.any(String) });
            expect(wallet.sent).toEqual([{ address: ARK_ADDRESS, amount: 1_000 }]);
            // Same asset, same rail, rate 1: there is nothing to record.
            expect(await repository.getAllSwapRecords()).toEqual([]);
        });

        it("reads the address out of a unified BIP21 URI too", async () => {
            const { client, wallet } = await harness();
            const uri = `bitcoin:${BCRT1}?ark=${ARK_ADDRESS}&amount=0.00001`;
            const result = await client.pay(uri);

            expect(result.kind).toBe("payment");
            // Core's own amount law: the URI's `amount=` is what it resolves to.
            expect(wallet.sent).toEqual([{ address: ARK_ADDRESS, amount: 1_000 }]);
        });

        it("refuses an amountless send in core's own words", async () => {
            const { client } = await harness();
            await expect(client.pay(ARK_ADDRESS)).rejects.toThrow(/an amount is required/);
        });
    });
});

describe("receive", () => {
    it("returns the artifact, durable, with nothing left in memory to lose", async () => {
        const { client, repository } = await harness();
        const request = await client.receive({ amount: 4_950n, via: "lightning" });

        expect(request.artifact.kind).toBe("invoice");
        expect(request.route.give.corridor).toBe("lightning");
        expect(request.route.take.corridor).toBe("arkade");
        // `amountOn: "take"`: "credit me this much", the trader's own leg.
        expect(request.take.amount).toBe(4_950n);
        expect(request.give.amount).toBe(5_000n);

        // The ordering M4 bought, stated in a signature: the record and its
        // claim secret are at rest before the invoice can reach a payer.
        const record = await repository.getSwapRecord(request.id.slice(4));
        expect(record?.artifact).toMatchObject({ kind: "invoice" });
    });

    it("funds nothing — the payer paying the invoice is the acceptance", async () => {
        const { client, wallet } = await harness();
        await client.receive({ amount: 4_950n, via: "lightning" });
        expect(wallet.sent).toEqual([]);
    });

    it("refuses a corridor no receive can arrive over", async () => {
        const { client } = await harness();
        await expect(client.receive({ amount: 1_000n, via: "arkade" })).rejects.toThrow(
            /not a corridor a receive can arrive over/,
        );
    });
});

describe("exchange", () => {
    it("swaps one Arkade asset for another, denominating the fee on the take leg", async () => {
        const { client } = await harness();
        const swap = await client.exchange({
            give: "BTC",
            take: "USD",
            amount: 100_000n,
            amountOn: "give",
        });

        expect(swap.family).toBe("offer");
        expect(swap.give).toEqual({ asset: ARKADE_BTC, amount: 100_000n });
        expect(swap.take.asset).toBe(USD);
        expect(swap.fee.asset).toBe(USD);
    });

    it("names the omission rather than the registry when one side is left out", async () => {
        const { client } = await harness();
        await expect(
            client.exchange({ give: "BTC", amount: 100_000n, amountOn: "give" }),
        ).rejects.toThrow(/name the other side/);
    });
});

describe("the fee ceiling", () => {
    it("throws MaxFeeExceeded with the terms, having funded nothing", async () => {
        const { client, repository, wallet } = await harness();
        const error = await client.pay(INVOICE, { maxFee: ceiling(49n) }).then(
            () => undefined,
            (e) => e,
        );

        expect(error).toBeInstanceOf(MaxFeeExceeded);
        expect(error).toMatchObject({
            asset: ARKADE_BTC,
            fee: 50n,
            maxFee: 49n,
            quoteId: expect.any(String),
        });
        // Between `quote` and `accept`: nothing persisted, nothing funded.
        expect(await repository.getAllSwapRecords()).toEqual([]);
        expect(wallet.sent).toEqual([]);
    });

    it("lets a quote at exactly the ceiling through", async () => {
        const { client } = await harness();
        await expect(client.pay(INVOICE, { maxFee: ceiling(50n) })).resolves.toMatchObject({
            kind: "swap",
        });
    });

    it("clamps to the policy ceiling a call tried to raise", async () => {
        // A policy ceiling a call can raise is decorative.
        const { client } = await harness({ maxFee: ceiling(10n) });
        await expect(client.pay(INVOICE, { maxFee: ceiling(1_000n) })).rejects.toMatchObject({
            name: "MaxFeeExceeded",
            maxFee: 10n,
        });
    });

    it("lets a call tighten the policy ceiling", async () => {
        const { client } = await harness({ maxFee: ceiling(1_000n) });
        await expect(client.pay(INVOICE, { maxFee: ceiling(10n) })).rejects.toMatchObject({
            name: "MaxFeeExceeded",
            maxFee: 10n,
        });
    });

    it("applies the policy ceiling to a call that names none", async () => {
        const { client } = await harness({ maxFee: ceiling(10n) });
        await expect(client.pay(INVOICE)).rejects.toBeInstanceOf(MaxFeeExceeded);
    });

    it("refuses a ceiling denominated in another asset rather than converting it", async () => {
        // The SDK holds no rate, and inventing one to compare two numbers is
        // how a ceiling silently stops being one.
        const { client, wallet } = await harness();
        await expect(client.pay(INVOICE, { maxFee: ceiling(10_000n, USD) })).rejects.toThrow(
            /no rate converts one ceiling into the other/,
        );
        expect(wallet.sent).toEqual([]);
    });

    it("accepts the same asset spelled on another rail, which needs no rate", async () => {
        // `bolt11:…/slip44:0` and `arkade:…/slip44:0` are one BTC, one sat.
        const { client } = await harness();
        await expect(
            client.pay(INVOICE, { maxFee: ceiling(50n, "bolt11:regtest/slip44:0") }),
        ).resolves.toMatchObject({ kind: "swap" });
    });

    it("guards receive and exchange the same way", async () => {
        const { client } = await harness();
        await expect(
            client.receive({ amount: 4_950n, via: "lightning", maxFee: ceiling(1n) }),
        ).rejects.toBeInstanceOf(MaxFeeExceeded);
        await expect(
            client.exchange({
                give: "BTC",
                take: "USD",
                amount: 100_000n,
                amountOn: "give",
                maxFee: ceiling(1n, USD),
            }),
        ).rejects.toBeInstanceOf(MaxFeeExceeded);
    });
});

describe("the disposal gate", () => {
    it("covers the three verbs like every other new act", async () => {
        const { client } = await harness();
        await client[Symbol.asyncDispose]();
        for (const call of [
            () => client.pay(INVOICE),
            () => client.receive({ amount: 4_950n, via: "lightning" }),
            () => client.exchange({ give: "BTC", take: "USD", amount: 1n, amountOn: "give" }),
        ]) {
            await expect(call()).rejects.toMatchObject({ name: "ClientDisposed" });
        }
    });
});
