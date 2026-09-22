import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, ReadonlySingleKey, type IWallet } from "@arkade-os/sdk";
import { createOffer, decodeOffer } from "../src/offer";
import { arkadeSwapRequest, requestArkadeSwap, type RfqQuote, type RfqTransport } from "../src/rfq";
import {
    encodeCarrierRequest,
    parseCarrierEcho,
    validateRecycleQuoteShape,
    type RecycleCarrierQuote,
} from "../src/receiveCarrier";

const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
const altServer = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const altKey = hex.decode("2a".repeat(32));
const altPkScript = hex.decode("5120" + hex.encode(altKey));
const altAddress = new ArkAddress(altServer, altPkScript.subarray(2), "tark").encode();

const state = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    watched: [] as [string, string][],
    unilateralExitDelay: BigInt(4096),
    dust: BigInt(330),
    onArkInfo: undefined as (() => void) | undefined,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    const { hex } = await import("@scure/base");
    const checkpointTapscript = hex.encode(
        mod.CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [
                hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa"),
            ],
        }).script,
    );
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                state.onArkInfo?.();
                return {
                    signerPubkey:
                        "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
                    checkpointTapscript,
                    network: "regtest",
                    unilateralExitDelay: state.unilateralExitDelay,
                    dust: state.dust,
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: [] };
            }
        },
        RestEmulatorProvider: class {
            async getInfo() {
                return {
                    signerPubkey:
                        "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
                };
            }
        },
    };
});

const identity = new ReadonlySingleKey(hex.decode("02" + hex.encode(makerKey)));
const realManager = {
    createContract: async (params: Record<string, unknown>) => {
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
    getContracts: async () => [],
};
const wallet = {
    identity,
    getAddress: async () => makerAddress,
    getContractManager: async () => realManager,
} as unknown as IWallet;
const fixtureManager = {
    createContract: async (params: Record<string, unknown>) => ({
        ...params,
        state: "active",
        createdAt: 0,
    }),
    setContractWatchState: async () => undefined,
    getContracts: async () => [],
};
const fixtureWallet = {
    identity,
    getAddress: async () => makerAddress,
    getContractManager: async () => fixtureManager,
} as unknown as IWallet;

const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const NOW = 1_800_000_000;
const VALID_UNTIL = NOW + 60;
const EXPIRES_AT = NOW + 300;
const RFQ_ID = "11".repeat(32);
const QUOTE_ID = "taxi-quote-1";
const MAX_BITCOIN_SATS = 2_100_000_000_000_000n;

const makerPublicKeyHex = async (): Promise<string> => hex.encode(await identity.xOnlyPublicKey());

const purchaseEcho = (physical: string, expiresAt = EXPIRES_AT) => ({
    mode: "purchase",
    physical_sats: physical,
    loan_sats: "0",
    receipt_sats: "0",
    service_fare_sats: "0",
    priced_sats: physical,
    expires_at: expiresAt,
});

const recycleEcho = (over: Record<string, unknown> = {}) => ({
    mode: "recycle",
    quote_id: QUOTE_ID,
    physical_sats: "330",
    loan_sats: "329",
    receipt_sats: "1",
    service_fare_sats: "0",
    priced_sats: "1",
    expires_at: EXPIRES_AT,
    ...over,
});

const derivedOffer = async (receiveAddress?: string) =>
    createOffer(fixtureWallet, "http://ark", {
        wantAmount: 50_000n,
        wantAsset: testAsset,
        emulatorPubkey,
        ...(receiveAddress !== undefined ? { receiveAddress } : {}),
    });

const recycleQuote = async (
    over: Partial<RecycleCarrierQuote> = {},
): Promise<RecycleCarrierQuote> => ({
    quoteId: QUOTE_ID,
    receiveAddress: (await derivedOffer()).address,
    makerPublicKey: await makerPublicKeyHex(),
    assetId: testAsset.toString(),
    physicalSats: 330n,
    loanSats: 329n,
    receiptSats: 1n,
    serviceFareSats: 0n,
    expiresAt: EXPIRES_AT,
    ...over,
});

const quoteFor = async (
    derived: { address: string; swapPkScript: Uint8Array },
    over: Record<string, unknown> = {},
): Promise<RfqQuote> => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: RFQ_ID,
    pair: "arkade:BTC->arkade:" + testAsset.toString(),
    from_amount: "1000",
    to_amount: "50000",
    carrier_sats: "330",
    solver_pubkey: "22".repeat(32),
    valid_until: VALID_UNTIL,
    profile: {
        offer_address: derived.address,
        offer_pk_script: hex.encode(derived.swapPkScript),
    },
    ...over,
});

const transportFor = (quote: RfqQuote, log?: Record<string, unknown>[]): RfqTransport => ({
    requestQuote: vi.fn(async (request: Record<string, unknown>) => {
        log?.push(request);
        return quote;
    }),
    status: vi.fn(async () => null),
    close: vi.fn(async () => undefined),
});

beforeEach(() => {
    state.created = [];
    state.watched = [];
    state.dust = 330n;
    state.onArkInfo = undefined;
});

describe("carrier wire validation", () => {
    it("refuses malformed runtime carrier requests predictably", () => {
        const cases: Array<{ value: unknown; error: RegExp }> = [
            { value: null, error: /object/ },
            { value: { mode: "other" }, error: /mode/ },
            { value: { mode: "recycle" }, error: /quoteId/ },
            { value: { mode: "recycle", quoteId: 7 }, error: /quoteId/ },
            { value: { mode: "recycle", quoteId: "" }, error: /quoteId/ },
            { value: { mode: "recycle", quoteId: "x".repeat(129) }, error: /quoteId/ },
            { value: { mode: "purchase", quoteId: QUOTE_ID }, error: /unknown field/ },
            { value: { mode: "recycle", quoteId: QUOTE_ID, extra: true }, error: /unknown field/ },
        ];
        for (const c of cases) {
            expect(() => encodeCarrierRequest(c.value as never)).toThrow(c.error);
        }
    });

    it("refuses every omitted carrier echo field and unknown keys", () => {
        const purchase = purchaseEcho("330") as Record<string, unknown>;
        for (const key of Object.keys(purchase)) {
            const missing = { ...purchase };
            delete missing[key];
            expect(() => parseCarrierEcho(missing, { mode: "purchase" }), key).toThrow(
                new RegExp(key),
            );
        }
        const recycle = recycleEcho();
        delete (recycle as { quote_id?: string }).quote_id;
        expect(() => parseCarrierEcho(recycle, { mode: "recycle", quoteId: QUOTE_ID })).toThrow(
            /quote_id/,
        );
        expect(() => parseCarrierEcho({ ...purchase, extra: "1" }, { mode: "purchase" })).toThrow(
            /unknown field extra/,
        );
    });

    it("refuses invalid echo quote ids and expiry values", () => {
        for (const quoteId of ["", "x".repeat(129), 7]) {
            expect(() =>
                parseCarrierEcho(
                    { ...recycleEcho(), quote_id: quoteId },
                    { mode: "recycle", quoteId: QUOTE_ID },
                ),
            ).toThrow(/quote_id/);
        }
        for (const expiresAt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1800000300"]) {
            expect(() =>
                parseCarrierEcho(
                    { ...purchaseEcho("330"), expires_at: expiresAt },
                    { mode: "purchase" },
                ),
            ).toThrow(/safe positive unix time/);
        }
    });

    it("refuses noncanonical and over-supply wire amounts", () => {
        const fields = [
            "physical_sats",
            "loan_sats",
            "receipt_sats",
            "service_fare_sats",
            "priced_sats",
        ] as const;
        for (const field of fields) {
            for (const value of ["", "00", "+1", "-1", "1.0", "1e3"]) {
                expect(() =>
                    parseCarrierEcho(
                        { ...purchaseEcho("330"), [field]: value },
                        { mode: "purchase" },
                    ),
                ).toThrow(/canonical decimal/);
            }
            expect(() =>
                parseCarrierEcho(
                    {
                        ...purchaseEcho("330"),
                        [field]: (MAX_BITCOIN_SATS + 1n).toString(),
                    },
                    { mode: "purchase" },
                ),
            ).toThrow(/Bitcoin supply/);
        }
        expect(() =>
            parseCarrierEcho(
                { ...purchaseEcho("330"), physical_sats: "9".repeat(100_000) },
                { mode: "purchase" },
            ),
        ).toThrow(/Bitcoin supply/);
    });

    it("bounds every local recycle term and its priced sum", async () => {
        const quote = await recycleQuote();
        const fields = ["physicalSats", "loanSats", "receiptSats", "serviceFareSats"] as const;
        for (const field of fields) {
            expect(() =>
                validateRecycleQuoteShape({
                    ...quote,
                    [field]: MAX_BITCOIN_SATS + 1n,
                }),
            ).toThrow(/Bitcoin supply/);
        }
        expect(() =>
            validateRecycleQuoteShape({
                ...quote,
                physicalSats: MAX_BITCOIN_SATS,
                loanSats: 1n,
                receiptSats: MAX_BITCOIN_SATS - 1n,
                serviceFareSats: 2n,
            }),
        ).toThrow(/priced/);
    });
});

describe("arkadeSwapRequest carrier", () => {
    it("omits the carrier key for legacy requests", () => {
        const maker = hex.decode("03".repeat(32));
        const script = hex.decode("5120" + "04".repeat(32));
        const req = arkadeSwapRequest({
            rfqId: RFQ_ID,
            wantAsset: testAsset,
            amount: 1000n,
            makerPkScript: script,
            makerPublicKey: maker,
        }) as { profile: Record<string, unknown> };
        expect(JSON.stringify(req)).toBe(
            `{"v":1,"type":"rfq_request","rfq_id":"${RFQ_ID}","pair":"arkade:BTC->arkade:${testAsset.toString()}","amount_side":"from","amount":"1000","profile":{"maker_pk_script":"5120${"04".repeat(32)}","maker_public_key":"${"03".repeat(32)}"}}`,
        );
        expect("carrier" in req.profile).toBe(false);
    });

    it("encodes purchase and recycle carriers", () => {
        const maker = hex.decode("03".repeat(32));
        const script = hex.decode("5120" + "04".repeat(32));
        const base = {
            rfqId: RFQ_ID,
            wantAsset: testAsset,
            amount: 1000n,
            makerPkScript: script,
            makerPublicKey: maker,
        };
        const p = arkadeSwapRequest({ ...base, carrier: { mode: "purchase" } }) as {
            profile: { carrier: unknown };
        };
        expect(p.profile.carrier).toEqual({ mode: "purchase" });
        const r = arkadeSwapRequest({
            ...base,
            carrier: { mode: "recycle", quoteId: QUOTE_ID },
        }) as { profile: { carrier: unknown } };
        expect(r.profile.carrier).toEqual({ mode: "recycle", quote_id: QUOTE_ID });
        expect(encodeCarrierRequest({ mode: "recycle", quoteId: "x".repeat(128) })).toEqual({
            mode: "recycle",
            quote_id: "x".repeat(128),
        });
    });

    it("refuses an explicit carrier on an asset sale before transport", async () => {
        const offerAsset = asset.AssetId.fromString("bb".repeat(32) + "0000");
        const requestQuote = vi.fn(async () => {
            throw new Error("must not be called");
        });
        const transport: RfqTransport = {
            requestQuote,
            status: vi.fn(async () => null),
            close: vi.fn(async () => undefined),
        };
        await expect(
            requestArkadeSwap(wallet, "http://ark", transport, {
                offerAsset,
                amount: 700n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/BTC->asset/);
        await expect(
            requestArkadeSwap(wallet, "http://ark", transport, {
                offerAsset,
                wantAsset: testAsset,
                amount: 700n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/BTC->asset/);
        expect(requestQuote).not.toHaveBeenCalled();
        expect(state.created).toHaveLength(0);
    });
});

describe("requestArkadeSwap carrier purchase", () => {
    it("returns verified terms for a valid purchase echo", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            carrier_sats: "330",
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("330"),
            },
        });
        const log: Record<string, unknown>[] = [];
        const result = await requestArkadeSwap(wallet, "http://ark", transportFor(quote, log), {
            wantAsset: testAsset,
            amount: 1000n,
            rfqId: RFQ_ID,
            emulatorPubkey,
            now: NOW,
            carrier: { mode: "purchase" },
        });
        expect((log[0] as { profile: { carrier: unknown } }).profile.carrier).toEqual({
            mode: "purchase",
        });
        expect(result.carrier).toEqual({
            mode: "purchase",
            physicalSats: 330n,
            loanSats: 0n,
            receiptSats: 0n,
            serviceFareSats: 0n,
            pricedSats: 330n,
            expiresAt: EXPIRES_AT,
        });
        expect(state.created).toHaveLength(1);
    });

    it("uses the independently connected Ark dust", async () => {
        state.dust = 777n;
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            carrier_sats: "777",
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("777"),
            },
        });
        const result = await requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
            wantAsset: testAsset,
            amount: 1000n,
            rfqId: RFQ_ID,
            emulatorPubkey,
            now: NOW,
            carrier: { mode: "purchase" },
        });
        expect(result.carrier?.physicalSats).toBe(777n);
        expect(state.created).toHaveLength(1);
    });

    it("rechecks elapsed time after carrier validation before registering", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("330"),
            },
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
        let infoCalls = 0;
        state.onArkInfo = () => {
            infoCalls += 1;
            if (infoCalls === 1) {
                clock.mockReturnValue(VALID_UNTIL * 1000);
            }
        };
        try {
            await expect(
                requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                    wantAsset: testAsset,
                    amount: 1000n,
                    rfqId: RFQ_ID,
                    emulatorPubkey,
                    carrier: { mode: "purchase" },
                }),
            ).rejects.toThrow(/lapsed|expired/);
        } finally {
            clock.mockRestore();
        }
        expect(state.created).toHaveLength(0);
    });

    it("rechecks elapsed time after asynchronous offer derivation", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("330"),
            },
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
        let infoCalls = 0;
        state.onArkInfo = () => {
            infoCalls += 1;
            if (infoCalls === 2) clock.mockReturnValue(VALID_UNTIL * 1000);
        };
        try {
            await expect(
                requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                    wantAsset: testAsset,
                    amount: 1000n,
                    rfqId: RFQ_ID,
                    emulatorPubkey,
                    carrier: { mode: "purchase" },
                }),
            ).rejects.toThrow(/during derivation/);
        } finally {
            clock.mockRestore();
        }
        expect(state.created).toHaveLength(1);
    });

    it("refuses a legacy solver answer without echo and never falls back", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived);
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/did not return carrier terms/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses purchase physical above the server dust", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            carrier_sats: "500",
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("500"),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/server dust/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses an over-supply top-level carrier before registration", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            carrier_sats: "9".repeat(100_000),
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: purchaseEcho("330"),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/Bitcoin supply/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses substituted purchase terms and invalid expiry ordering", async () => {
        const derived = await derivedOffer();
        const cases: Array<{ name: string; echo: Record<string, unknown> }> = [
            { name: "loan", echo: purchaseEcho("330") },
            { name: "receipt", echo: purchaseEcho("330") },
            { name: "fare", echo: purchaseEcho("330") },
            { name: "priced", echo: purchaseEcho("330") },
            { name: "expiry", echo: purchaseEcho("330", VALID_UNTIL - 1) },
        ];
        cases[0].echo.loan_sats = "1";
        cases[1].echo.receipt_sats = "1";
        cases[2].echo.service_fare_sats = "1";
        cases[2].echo.priced_sats = "331";
        cases[3].echo.priced_sats = "329";
        for (const c of cases) {
            state.created = [];
            const quote = await quoteFor(derived, {
                profile: {
                    offer_address: derived.address,
                    offer_pk_script: hex.encode(derived.swapPkScript),
                    carrier: c.echo,
                },
            });
            await expect(
                requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                    wantAsset: testAsset,
                    amount: 1000n,
                    rfqId: RFQ_ID,
                    emulatorPubkey,
                    now: NOW,
                    carrier: { mode: "purchase" },
                }),
                c.name,
            ).rejects.toThrow();
            expect(state.created, c.name).toHaveLength(0);
        }
    });

    it("refuses a mode substitution in the echo", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho(),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "purchase" },
            }),
        ).rejects.toThrow(/mode/);
        expect(state.created).toHaveLength(0);
    });
});

describe("requestArkadeSwap carrier recycle", () => {
    it("returns verified terms for a valid 329+1 recycle echo", async () => {
        const expected = await recycleQuote();
        const derived = await derivedOffer(expected.receiveAddress);
        const quote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho(),
            },
        });
        const log: Record<string, unknown>[] = [];
        const result = await requestArkadeSwap(wallet, "http://ark", transportFor(quote, log), {
            wantAsset: testAsset,
            amount: 1000n,
            rfqId: RFQ_ID,
            emulatorPubkey,
            now: NOW,
            carrier: { mode: "recycle", quote: expected },
        });
        expect((log[0] as { profile: { carrier: unknown } }).profile.carrier).toEqual({
            mode: "recycle",
            quote_id: QUOTE_ID,
        });
        expect(result.carrier).toEqual({
            mode: "recycle",
            physicalSats: 330n,
            loanSats: 329n,
            receiptSats: 1n,
            serviceFareSats: 0n,
            pricedSats: 1n,
            expiresAt: EXPIRES_AT,
            quoteId: QUOTE_ID,
        });
        const decoded = decodeOffer(hex.decode(result.offerHex));
        expect(decoded.makerPkScript).toEqual(ArkAddress.decode(expected.receiveAddress).pkScript);
        expect(hex.encode(decoded.makerPublicKey)).toBe(await makerPublicKeyHex());
        expect(state.created).toHaveLength(1);
    });

    it("pins the expected recycle descriptor before asynchronous work", async () => {
        const expected = await recycleQuote();
        const replacement = {
            ...expected,
            physicalSats: 331n,
            loanSats: 330n,
            serviceFareSats: 2n,
        };
        const derived = await derivedOffer(expected.receiveAddress);
        const quote = await quoteFor(derived, {
            carrier_sats: "331",
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho({
                    physical_sats: "331",
                    loan_sats: "330",
                    service_fare_sats: "2",
                    priced_sats: "3",
                }),
            },
        });
        const carrier = { mode: "recycle" as const, quote: expected };
        const transport: RfqTransport = {
            requestQuote: vi.fn(async () => {
                carrier.quote = replacement;
                return quote;
            }),
            status: vi.fn(async () => null),
            close: vi.fn(async () => undefined),
        };
        await expect(
            requestArkadeSwap(wallet, "http://ark", transport, {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier,
            }),
        ).rejects.toThrow(/expected descriptor/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses a mismatched receiveAddress before transport", async () => {
        const requestQuote = vi.fn(async () => {
            throw new Error("must not be called");
        });
        const transport: RfqTransport = {
            requestQuote,
            status: vi.fn(async () => null),
            close: vi.fn(async () => undefined),
        };
        const q = await recycleQuote();
        await expect(
            requestArkadeSwap(wallet, "http://ark", transport, {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                receiveAddress: makerAddress,
                carrier: { mode: "recycle", quote: q },
            }),
        ).rejects.toThrow(/receiveAddress/);
        expect(requestQuote).not.toHaveBeenCalled();
        expect(state.created).toHaveLength(0);
    });

    it("refuses recycle addresses for the wrong network or Ark server", async () => {
        const expected = await recycleQuote();
        const decoded = ArkAddress.decode(expected.receiveAddress);
        const cases = [
            {
                name: "network",
                address: new ArkAddress(
                    decoded.serverPubKey,
                    decoded.pkScript.subarray(2),
                    "ark",
                ).encode(),
                error: /network/,
            },
            {
                name: "server",
                address: new ArkAddress(
                    hex.decode("99".repeat(32)),
                    decoded.pkScript.subarray(2),
                    "tark",
                ).encode(),
                error: /server/,
            },
        ];
        for (const c of cases) {
            const requestQuote = vi.fn(async () => {
                throw new Error("must not be called");
            });
            const transport: RfqTransport = {
                requestQuote,
                status: vi.fn(async () => null),
                close: vi.fn(async () => undefined),
            };
            await expect(
                requestArkadeSwap(wallet, "http://ark", transport, {
                    wantAsset: testAsset,
                    amount: 1000n,
                    rfqId: RFQ_ID,
                    emulatorPubkey,
                    now: NOW,
                    carrier: {
                        mode: "recycle",
                        quote: { ...expected, receiveAddress: c.address },
                    },
                }),
                c.name,
            ).rejects.toThrow(c.error);
            expect(requestQuote, c.name).not.toHaveBeenCalled();
            expect(state.created, c.name).toHaveLength(0);
        }
    });

    it("refuses substituted descriptor amounts", async () => {
        const cases: Array<{ name: string; echoOver: Record<string, unknown> }> = [
            { name: "physical", echoOver: { physical_sats: "331" } },
            { name: "loan", echoOver: { loan_sats: "328" } },
            { name: "receipt", echoOver: { receipt_sats: "2" } },
            { name: "fare", echoOver: { service_fare_sats: "1", priced_sats: "2" } },
            { name: "quoteId", echoOver: { quote_id: "other-quote" } },
            { name: "priced", echoOver: { priced_sats: "2" } },
            { name: "unknown", echoOver: { extra: "1" } },
            { name: "leading-zero", echoOver: { physical_sats: "0330" } },
        ];
        for (const c of cases) {
            state.created = [];
            const expected = await recycleQuote();
            const derived = await derivedOffer(expected.receiveAddress);
            const quote = await quoteFor(derived, {
                profile: {
                    offer_address: derived.address,
                    offer_pk_script: hex.encode(derived.swapPkScript),
                    carrier: recycleEcho(c.echoOver),
                },
            });
            await expect(
                requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                    wantAsset: testAsset,
                    amount: 1000n,
                    rfqId: RFQ_ID,
                    emulatorPubkey,
                    now: NOW,
                    carrier: { mode: "recycle", quote: expected },
                }),
                c.name,
            ).rejects.toThrow();
            expect(state.created, c.name).toHaveLength(0);
        }
    });

    it("refuses full-vs-priced carrier confusion", async () => {
        const expected = await recycleQuote();
        const derived = await derivedOffer(expected.receiveAddress);
        const quote = await quoteFor(derived, {
            carrier_sats: "1",
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho(),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "recycle", quote: expected },
            }),
        ).rejects.toThrow(/carrier_sats/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses an echo that extends the expected expiry", async () => {
        const expected = await recycleQuote();
        const derived = await derivedOffer(expected.receiveAddress);
        const quote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho({ expires_at: EXPIRES_AT + 600 }),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "recycle", quote: expected },
            }),
        ).rejects.toThrow(/expir/);
        expect(state.created).toHaveLength(0);
    });

    it("refuses wrong asset, signer and expired terms", async () => {
        const wrongAsset = asset.AssetId.fromString("cc".repeat(32) + "0000");
        const expected = await recycleQuote();
        const derived = await derivedOffer(expected.receiveAddress);
        const badAssetQuote = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho(),
            },
        });
        const badAsset = { ...expected, assetId: wrongAsset.toString() };
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(badAssetQuote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "recycle", quote: badAsset },
            }),
        ).rejects.toThrow(/assetId/);
        const badSigner = { ...expected, makerPublicKey: "34".repeat(32) };
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(badAssetQuote), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: NOW,
                carrier: { mode: "recycle", quote: badSigner },
            }),
        ).rejects.toThrow(/makerPublicKey/);
        const expired = await quoteFor(derived, {
            profile: {
                offer_address: derived.address,
                offer_pk_script: hex.encode(derived.swapPkScript),
                carrier: recycleEcho(),
            },
        });
        await expect(
            requestArkadeSwap(wallet, "http://ark", transportFor(expired), {
                wantAsset: testAsset,
                amount: 1000n,
                rfqId: RFQ_ID,
                emulatorPubkey,
                now: VALID_UNTIL + 1,
                carrier: { mode: "recycle", quote: expected },
            }),
        ).rejects.toThrow(/expir|lapsed/);
        expect(state.created).toHaveLength(0);
    });

    it("keeps legacy results without carrier terms", async () => {
        const derived = await derivedOffer();
        const quote = await quoteFor(derived);
        const result = await requestArkadeSwap(wallet, "http://ark", transportFor(quote), {
            wantAsset: testAsset,
            amount: 1000n,
            rfqId: RFQ_ID,
            emulatorPubkey,
            now: NOW,
        });
        expect(Object.keys(result)).toEqual([
            "rfqId",
            "quote",
            "pair",
            "address",
            "fundAmount",
            "carrierSats",
            "swapPkScript",
            "offerHex",
            "extension",
        ]);
        expect(result.rfqId).toBe(RFQ_ID);
        expect(result.quote).toBe(quote);
        expect(result.address).toBe(derived.address);
        expect("carrier" in result).toBe(false);
    });
});
