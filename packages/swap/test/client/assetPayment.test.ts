import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArkAddress, SendDeadlineExceededError, type IWallet } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { assembleRoute } from "../../src/client/resolve";
import { createSwapClient } from "../../src/client/client";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import type { QuoteInput } from "../../src/client/quote";
import {
    ARK_INFO,
    OPERATOR_PUBKEY,
    NETWORK,
    key,
    USD_ASSET_ID,
    EMULATOR_PUBKEY_HEX,
    acceptWallet,
    arkadeAssetAnswer,
    assetCard,
    clockAt,
    feedServing,
    solverTransport,
    type SolverAnswer,
} from "./fixtures";

const NOW = 1_700_000_000;
const CLOCK = clockAt(NOW);
const external = new ArkAddress(OPERATOR_PUBKEY, key(29), NETWORK.hrp).encode();
const buy = (): QuoteInput => ({ give: "BTC", take: "USD", amount: 1000n, amountOn: "take" });
const setup = async (answer?: SolverAnswer) => {
    const fixture = await acceptWallet();
    const wallet = {
        ...fixture.wallet,
        getArkadeInfo: async () => ({ ...ARK_INFO, dust: 330n }),
    } as unknown as IWallet;
    const repository = new InMemoryAssetSwapRepository();
    const transport = solverTransport(
        answer ??
            ((payload) =>
                arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
                    toAmount: BigInt(payload.amount as string),
                })),
    );
    const client = createSwapClient({
        wallet,
        repository,
        discovery: { snapshot: [assetCard] },
        emulatorPubkey: EMULATOR_PUBKEY_HEX,
        transportFor: () => transport,
        fetchImpl: feedServing().fetch,
    });
    return { client, transport, repository, fixture, wallet };
};
const recycled = async (wallet: IWallet) => ({
    mode: "recycleReceiver" as const,
    quote: {
        quoteId: "taxi-quote",
        receiveAddress: external,
        senderKey: hex.encode(await wallet.identity.xOnlyPublicKey()),
        assetId: USD_ASSET_ID,
        physicalSats: 330n,
        loanSats: 330n,
        expiresAt: CLOCK.validUntil,
    },
    taxi: { url: "https://taxi.example", operatorKey: hex.encode(key(31)) },
    inputExpiryFloor: { kind: "time" as const, value: BigInt(CLOCK.validUntil + 500) },
});
const recycleAnswer: SolverAnswer = (payload) => {
    const request = (payload.profile as Record<string, unknown>).carrier as Record<string, unknown>;
    return arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
        toAmount: BigInt(payload.amount as string),
        profile: { carrier: { ...echo, ...request, loan_sats: "330", priced_sats: "0" } },
    });
};
const purchase = { mode: "purchase" as const };
const echo = {
    mode: "purchase",
    physical_sats: "330",
    loan_sats: "0",
    receipt_sats: "0",
    service_fare_sats: "0",
    priced_sats: "330",
    expires_at: CLOCK.validUntil,
};
const carrierAnswer: SolverAnswer = (payload) =>
    arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
        toAmount: BigInt(payload.amount as string),
        quote: { carrier_sats: "330" },
        profile: { carrier: echo },
    });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("native asset payment quote", () => {
    it("prices exact-out from the solver's give and retains feed spread", async () => {
        const { client, transport } = await setup((payload) =>
            arkadeAssetAnswer({ ...payload, amount: "11000" }, CLOCK, {
                toAmount: BigInt(payload.amount as string),
            }),
        );
        const quote = await client.quote(buy());
        expect(transport.sent[0].amount_side).toBe("to");
        expect(quote.give.amount).toBe(11000n);
        expect(quote.take.amount).toBe(1000n);
        expect(quote.fee.amount).toBe(100n);
    });
    it("binds the actual recipient without changing the buyer signing key", async () => {
        const { client, transport, wallet } = await setup();
        const own = hex.encode(await wallet.identity.xOnlyPublicKey());
        const quote = await client.quote({ ...buy(), assetPayment: { receiveAddress: external } });
        expect(quote.route.take.instrument).toEqual({ kind: "address", address: external });
        expect((transport.sent[0].profile as Record<string, unknown>).maker_pk_script).toBe(
            hex.encode(ArkAddress.decode(external).pkScript),
        );
        expect((transport.sent[0].profile as Record<string, unknown>).maker_public_key).toBe(own);
    });
    it("refuses a foreign server before disclosing a request", async () => {
        const { client, transport } = await setup();
        const receiveAddress = new ArkAddress(key(30), key(29), NETWORK.hrp).encode();
        await expect(client.quote({ ...buy(), assetPayment: { receiveAddress } })).rejects.toThrow(
            /server/,
        );
        expect(transport.sent).toHaveLength(0);
    });
    it("requests and verifies purchased carrier terms", async () => {
        const { client, transport } = await setup(carrierAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { receiveAddress: external, carrier: purchase },
        });
        expect((transport.sent[0].profile as Record<string, unknown>).carrier).toEqual({
            mode: "purchase",
        });
        expect(quote.assetPayment?.carrier?.physicalSats).toBe(330n);
        expect(quote.assetPayment?.validUntil).toBe(CLOCK.validUntil - 30);
    });
    it("refuses carrier echoes that differ from live dust", async () => {
        const { client } = await setup((payload) =>
            arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
                toAmount: 1000n,
                quote: { carrier_sats: "546" },
                profile: { carrier: { ...echo, physical_sats: "546", priced_sats: "546" } },
            }),
        );
        await expect(
            client.quote({ ...buy(), assetPayment: { carrier: purchase } }),
        ).rejects.toThrow(/dust/);
    });
    it("persists its deadline before funding and restores it after an ambiguous attempt", async () => {
        const { client, repository, wallet, transport } = await setup(carrierAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { receiveAddress: external, carrier: purchase },
        });
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("unknown submission"))
            .mockResolvedValue("b".repeat(64));
        await expect(client.accept(quote)).rejects.toThrow("unknown submission");
        const saved = await repository.getSwapRecord(quote.id);
        expect(saved?.assetPayment?.validUntil).toBe(CLOCK.validUntil - 30);
        expect(saved?.assetPayment?.carrier?.physicalSats).toBe("330");
        const restarted = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [assetCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feedServing().fetch,
        });
        await restarted.accept(quote);
        expect(send.mock.calls[1][0]).toMatchObject({
            validUntil: CLOCK.validUntil - 30,
            recipients: [{ amount: 10000 }],
        });
        expect(send).toHaveBeenCalledTimes(2);
    });
    it("caps and persists caller tightening across restart without relaxing the deadline", async () => {
        const { client, repository, wallet, transport } = await setup(carrierAnswer);
        const quote = await client.quote({ ...buy(), assetPayment: { carrier: purchase } });
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("ambiguous"))
            .mockResolvedValue("b".repeat(64));
        await expect(client.accept(quote, { validUntil: CLOCK.validUntil - 60 })).rejects.toThrow(
            "ambiguous",
        );
        expect((await repository.getSwapRecord(quote.id))?.assetPayment?.validUntil).toBe(
            CLOCK.validUntil - 60,
        );
        const restarted = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [assetCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feedServing().fetch,
        });
        await restarted.accept(quote, { validUntil: CLOCK.validUntil + 100 });
        expect(send.mock.calls[1][0]).toMatchObject({ validUntil: CLOCK.validUntil - 60 });
    });
    it("keeps a retry's tighter deadline local after an ambiguous first send", async () => {
        const { client, repository, wallet } = await setup(carrierAnswer);
        const quote = await client.quote({ ...buy(), assetPayment: { carrier: purchase } });
        const original = CLOCK.validUntil - 30;
        const tighter = original - 20;
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("ambiguous"))
            .mockRejectedValueOnce(new SendDeadlineExceededError(tighter))
            .mockResolvedValue("b".repeat(64));
        await expect(client.accept(quote)).rejects.toThrow("ambiguous");
        await expect(client.accept(quote, { validUntil: tighter })).rejects.toBeInstanceOf(
            SendDeadlineExceededError,
        );
        const saved = await repository.getSwapRecord(quote.id);
        expect(saved?.assetPayment?.validUntil).toBe(original);
        expect(saved?.fundingNotSubmitted).toBeUndefined();
        await client.accept(quote);
        expect(
            send.mock.calls.map(([request]) => (request as { validUntil: number }).validUntil),
        ).toEqual([original, tighter, original]);
    });

    it("snapshots receiver terms before awaits and durably forwards the floor after restart", async () => {
        const { client, repository, wallet, transport } = await setup(recycleAnswer);
        const choice = await recycled(wallet);
        const input = { ...buy(), assetPayment: { carrier: choice } };
        const result = client.quote(input);
        choice.quote.receiveAddress = "invalid";
        choice.quote.physicalSats = 546n;
        choice.taxi.url = "evil";
        choice.inputExpiryFloor.value = 1n;
        const quote = await result;
        expect(quote.route.take.instrument).toEqual({ kind: "address", address: external });
        expect(quote.assetPayment?.carrier).toMatchObject({
            mode: "recycle_receiver",
            physicalSats: 330n,
            loanSats: 330n,
            receiptSats: 0n,
        });
        const expected = { kind: "time", value: BigInt(CLOCK.validUntil + 500) };
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("ambiguous"))
            .mockResolvedValue("b".repeat(64));
        await expect(client.accept(quote)).rejects.toThrow("ambiguous");
        const saved = JSON.parse(JSON.stringify(await repository.getSwapRecord(quote.id)));
        expect(saved.assetPayment.inputExpiryFloor).toEqual({
            kind: "time",
            value: String(expected.value),
        });
        await repository.saveSwapRecord(saved);
        const restarted = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [assetCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feedServing().fetch,
        });
        await restarted.accept(quote);
        expect(send.mock.calls[0][0]).toMatchObject({ inputExpiryFloor: expected });
        expect(send.mock.calls[1][0]).toMatchObject({ inputExpiryFloor: expected });
    });
    it("reconciles observed funding before a stored carrier deadline expires", async () => {
        const { client, repository, wallet, fixture } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const send = vi.spyOn(wallet, "send").mockRejectedValue(new Error("ambiguous"));
        await expect(client.accept(quote)).rejects.toThrow("ambiguous");
        const saved = await repository.getSwapRecord(quote.id);
        if (saved?.family !== "offer") throw new Error("missing offer");
        fixture.deposits.set(saved.swapPkScript, [{ txid: "c".repeat(64), value: 10000 }]);
        vi.setSystemTime((CLOCK.validUntil + 10) * 1000);
        const swapped = await client.accept(quote);
        expect(swapped.fundingTxid).toBe("c".repeat(64));
        expect(send).toHaveBeenCalledTimes(1);
    });
    it("does not disclose a mismatched receiver quote", async () => {
        for (const mismatch of ["assetId", "senderKey", "receiveAddress"] as const) {
            const { client, transport, wallet } = await setup(recycleAnswer);
            const carrier = await recycled(wallet);
            if (mismatch === "assetId") carrier.quote.assetId = "a".repeat(64) + "0000";
            if (mismatch === "senderKey") carrier.quote.senderKey = hex.encode(key(32));
            const assetPayment =
                mismatch === "receiveAddress"
                    ? { carrier, receiveAddress: await wallet.getAddress() }
                    : { carrier };
            await expect(client.quote({ ...buy(), assetPayment })).rejects.toThrow();
            expect(transport.sent).toHaveLength(0);
        }
    });
    it("refuses a repriced take-side pin", async () => {
        const { client } = await setup((payload) =>
            arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, { toAmount: 999n }),
        );
        await expect(client.quote(buy())).rejects.toThrow(/pair check/);
    });
    it("refuses carrier choice on the reverse asset route before disclosure", async () => {
        const { client, transport } = await setup();
        await expect(
            client.quote({
                give: "USD",
                take: "BTC",
                amount: 1000n,
                amountOn: "give",
                assetPayment: { carrier: purchase },
            }),
        ).rejects.toThrow(/BTC-to-asset/);
        expect(transport.sent).toHaveLength(0);
    });
    it("refuses stale receiver quote before disclosure", async () => {
        const { client, transport, wallet } = await setup();
        const carrier = await recycled(wallet);
        carrier.quote.expiresAt = NOW + 30;
        await expect(client.quote({ ...buy(), assetPayment: { carrier } })).rejects.toThrow(
            /expired/,
        );
        expect(transport.sent).toHaveLength(0);
    });
    it.each([
        "physical_sats",
        "loan_sats",
        "receipt_sats",
        "service_fare_sats",
        "priced_sats",
        "quote_id",
        "taxi_url",
        "taxi_key",
        "expires_at",
        "extra",
        "top",
    ])("refuses malformed receiver carrier echo %s", async (field) => {
        const { client, wallet } = await setup(async (payload) => {
            const answer = await recycleAnswer(payload);
            const carrier = { ...(answer.profile?.carrier as Record<string, unknown>) };
            if (field !== "top")
                carrier[field] =
                    field === "expires_at"
                        ? CLOCK.validUntil + 1
                        : field === "physical_sats" || field === "loan_sats"
                          ? "546"
                          : field.endsWith("_sats")
                            ? "1"
                            : "wrong";
            return {
                ...answer,
                ...(field === "top" ? { carrier_sats: "330" } : {}),
                profile: { ...answer.profile, carrier },
            };
        });
        await expect(
            client.quote({ ...buy(), assetPayment: { carrier: await recycled(wallet) } }),
        ).rejects.toThrow();
    });

    it.each(["omit", "recipient", "carrier", "floor", "deadline"])(
        "refuses first accept with altered %s constraints before registration",
        async (field) => {
            const { client, wallet, fixture, repository } = await setup(recycleAnswer);
            const quote = await client.quote({
                ...buy(),
                assetPayment: { carrier: await recycled(wallet) },
            });
            const assetPayment = field === "omit" ? undefined : { ...quote.assetPayment! };
            if (assetPayment) {
                if (field === "recipient") assetPayment.receiveAddress = await wallet.getAddress();
                if (field === "carrier")
                    assetPayment.carrier = { ...assetPayment.carrier!, loanSats: 0n };
                if (field === "floor")
                    assetPayment.inputExpiryFloor = { kind: "height", value: 1n };
                if (field === "deadline") assetPayment.validUntil += 100;
            }
            await expect(client.accept({ ...quote, assetPayment })).rejects.toThrow(
                /verified quote/,
            );
            expect(fixture.contracts).toHaveLength(0);
            expect(fixture.sent).toHaveLength(0);
            expect(await repository.getSwapRecord(quote.id)).toBeUndefined();
        },
    );
    it("accepts equivalent asset terms and recipients with reordered object keys", async () => {
        const { client, wallet } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const terms = quote.assetPayment!;
        const reordered = {
            ...quote,
            assetPayment: {
                validUntil: terms.validUntil,
                inputExpiryFloor: {
                    value: terms.inputExpiryFloor!.value,
                    kind: terms.inputExpiryFloor!.kind,
                },
                carrier: Object.fromEntries(
                    Object.entries(terms.carrier!).reverse(),
                ) as typeof terms.carrier,
                receiveAddress: terms.receiveAddress,
            },
            route: {
                ...quote.route,
                take: {
                    ...quote.route.take,
                    instrument: { address: external, kind: "address" as const },
                },
            } as typeof quote.route,
        };
        vi.spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("ambiguous"))
            .mockResolvedValue("b".repeat(64));
        await expect(client.accept(reordered)).rejects.toThrow("ambiguous");
        await expect(client.accept(quote)).resolves.toBeDefined();
    });

    it("lists healthy swaps when another stored asset payment is malformed", async () => {
        const { client, repository } = await setup(carrierAnswer);
        const quote = await client.quote({ ...buy(), assetPayment: { carrier: purchase } });
        const swap = await client.accept(quote);
        const row = (await repository.getSwapRecord(quote.id))!;
        await repository.saveSwapRecord({
            ...row,
            id: "malformed",
            assetPayment: { ...row.assetPayment!, validUntil: 0 },
        });
        await expect(client.swaps()).resolves.toEqual([swap]);
    });

    it("refuses altered metadata on a stored ambiguous liability", async () => {
        const { client, wallet, repository } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const send = vi.spyOn(wallet, "send").mockRejectedValue(new Error("ambiguous"));
        await expect(client.accept(quote)).rejects.toThrow("ambiguous");
        await expect(client.accept({ ...quote, assetPayment: undefined })).rejects.toThrow(
            /conflict/,
        );
        expect(send).toHaveBeenCalledTimes(1);
        expect((await repository.getSwapRecord(quote.id))?.fundingNotSubmitted).toBeUndefined();
    });
    it("retains negotiated carrier fields in the public swap projection", async () => {
        const { client, wallet } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const swap = await client.accept(quote);
        expect(swap.assetPayment).toEqual(quote.assetPayment);
        expect(swap.assetPayment?.carrier?.receiptSats).toBe(0n);
    });
    it("uses the earliest echo expiry minus the funding safety margin", async () => {
        const { client } = await setup((payload) =>
            arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
                toAmount: 1000n,
                quote: { carrier_sats: "330" },
                profile: { carrier: { ...echo, expires_at: CLOCK.validUntil - 20 } },
            }),
        );
        const quote = await client.quote({ ...buy(), assetPayment: { carrier: purchase } });
        expect(quote.assetPayment?.validUntil).toBe(CLOCK.validUntil - 50);
    });
    it.each([0n, -1n])("refuses invalid floor %s before disclosure", async (value) => {
        const { client, transport, wallet } = await setup();
        const carrier = await recycled(wallet);
        carrier.inputExpiryFloor.value = value;
        await expect(client.quote({ ...buy(), assetPayment: { carrier } })).rejects.toThrow(
            /inputExpiryFloor/,
        );
        expect(transport.sent).toHaveLength(0);
    });

    it("refuses a receiver choice with the floor missing before RFQ", async () => {
        const { client, transport, wallet } = await setup();
        const carrier = await recycled(wallet);
        Reflect.deleteProperty(carrier, "inputExpiryFloor");
        await expect(client.quote({ ...buy(), assetPayment: { carrier } })).rejects.toThrow(
            /inputExpiryFloor/,
        );
        expect(transport.sent).toHaveLength(0);
    });
    it("keeps an earlier uncertain submission pending after a later unsent retry", async () => {
        const { client, repository, wallet, transport } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValueOnce(new Error("unknown earlier submission"))
            .mockRejectedValue(new SendDeadlineExceededError(quote.assetPayment!.validUntil));
        await expect(client.accept(quote)).rejects.toThrow("unknown earlier submission");
        const restarted = createSwapClient({
            wallet,
            repository,
            discovery: { snapshot: [assetCard] },
            emulatorPubkey: EMULATOR_PUBKEY_HEX,
            transportFor: () => transport,
            fetchImpl: feedServing().fetch,
        });
        await expect(restarted.accept(quote)).rejects.toThrow(SendDeadlineExceededError);
        const saved = await repository.getSwapRecord(quote.id);
        expect(saved?.fundingNotSubmitted).toBeUndefined();
        if (saved?.family !== "offer") throw new Error("missing offer");
        expect(saved.status).toBe("pending");
        expect(send).toHaveBeenCalledTimes(2);
    });
    it("abandonment proof applies only to a fresh first send", async () => {
        const { client, repository, wallet, fixture } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        const send = vi
            .spyOn(wallet, "send")
            .mockRejectedValue(new SendDeadlineExceededError(quote.assetPayment!.validUntil));
        await expect(client.accept(quote)).rejects.toThrow(SendDeadlineExceededError);
        const saved = await repository.getSwapRecord(quote.id);
        expect(saved?.fundingNotSubmitted).toEqual({
            reason: "send_deadline",
            validUntil: quote.assetPayment!.validUntil,
        });
        if (saved?.family !== "offer") throw new Error("missing offer");
        expect(saved.status).toBe("cancelled");
        expect(fixture.watched.at(-1)).toEqual([saved.swapPkScript, "retained"]);
        expect((await client.accept(quote)).outcome).toBe("cancelled");
        expect(send).toHaveBeenCalledTimes(1);
    });
    it("does not classify floor refusal as a proven unsent funding", async () => {
        const { client, repository, wallet } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        vi.spyOn(wallet, "send").mockRejectedValue(new Error("input expiry below floor"));
        await expect(client.accept(quote)).rejects.toThrow("input expiry below floor");
        expect((await repository.getSwapRecord(quote.id))?.fundingNotSubmitted).toBeUndefined();
    });
    it("refuses an echo extending the verified Taxi quote expiry", async () => {
        const { client, wallet } = await setup(recycleAnswer);
        const carrier = await recycled(wallet);
        carrier.quote.expiresAt -= 10;
        await expect(client.quote({ ...buy(), assetPayment: { carrier } })).rejects.toThrow(
            /expected expiry/,
        );
    });
    it("authenticates the responder before carrier disclosure", async () => {
        const { client, transport } = await setup(carrierAnswer);
        Object.assign(transport, { attestedResponder: hex.encode(key(32)) });
        await expect(
            client.quote({ ...buy(), assetPayment: { carrier: purchase } }),
        ).rejects.toThrow(/responder/);
        expect(transport.sent).toHaveLength(0);
    });
    it.each([330, "0330", "1e3", "-1", "0x14a"])(
        "refuses noncanonical carrier quantity %s",
        async (physical_sats) => {
            const { client } = await setup((payload) =>
                arkadeAssetAnswer({ ...payload, amount: "10000" }, CLOCK, {
                    toAmount: 1000n,
                    quote: { carrier_sats: "330" },
                    profile: { carrier: { ...echo, physical_sats } },
                }),
            );
            await expect(
                client.quote({ ...buy(), assetPayment: { carrier: purchase } }),
            ).rejects.toThrow(/canonical decimal/);
        },
    );
    it("refuses changed recipient history before first funding", async () => {
        const { client, wallet, fixture, repository } = await setup(recycleAnswer);
        const quote = await client.quote({
            ...buy(),
            assetPayment: { carrier: await recycled(wallet) },
        });
        await expect(
            client.accept({
                ...quote,
                route: assembleRoute(quote.route.give, {
                    ...quote.route.take,
                    instrument: { kind: "wallet" },
                }),
            }),
        ).rejects.toThrow(/recipient.*verified quote/);
        expect(fixture.contracts).toHaveLength(0);
        expect(fixture.sent).toHaveLength(0);
        expect(await repository.getSwapRecord(quote.id)).toBeUndefined();
    });
});

it("retires a negotiated native offer after an unsent fractional-millisecond registration", async () => {
    vi.setSystemTime(NOW * 1000 + 537);
    const h = await setup();
    const quote = await h.client.quote(buy());
    vi.spyOn(h.wallet, "send").mockRejectedValue(new SendDeadlineExceededError(NOW + 1));
    await expect(h.client.accept(quote, { validUntil: NOW + 1 })).rejects.toBeInstanceOf(
        SendDeadlineExceededError,
    );
    const row = await h.repository.getSwapRecord(quote.id);
    expect(row?.family).toBe("offer");
    expect(row?.fundingNotSubmitted).toEqual({ reason: "send_deadline", validUntil: NOW + 1 });
    expect(h.fixture.watched).toContainEqual([h.fixture.contracts[0]?.script, "retained"]);
    await h.client[Symbol.asyncDispose]();
});
