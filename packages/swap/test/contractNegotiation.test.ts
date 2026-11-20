import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { asset } from "@arkade-os/sdk";
import { requestArkadeSwap, requestVersionedQuote, SwapRefusal, type RfqQuote } from "../src/rfq";
import { createOffer, decodeOffer, deriveOffer, offerContract } from "../src/offer";
import { ASSET_SWAP_V2, ASSET_SWAP_V4, type AssetSwapContractVersion } from "../src/program";
import type { AttestingRfqTransport } from "../src/client/transport";
import { acceptWallet, SOLVER_DISCOVERY_KEY } from "./client/fixtures";

vi.mock("../src/offer", async (original) => {
    const actual = await original<typeof import("../src/offer")>();
    return { ...actual, createOffer: vi.fn(actual.createOffer) };
});

const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const TAKER = SOLVER_DISCOVERY_KEY;

const quoteOf = (
    offer: { address: string; swapPkScript: Uint8Array },
    contractVersion?: string,
): RfqQuote => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: "11".repeat(32),
    pair: `arkade:BTC->arkade:${wantAsset}`,
    from_amount: "700",
    to_amount: "50000",
    solver_pubkey: TAKER,
    valid_until: 1_800_000_060,
    ...(contractVersion !== undefined ? { contract_version: contractVersion } : {}),
    profile: { offer_address: offer.address, offer_pk_script: hex.encode(offer.swapPkScript) },
});

const setup = async (
    quotedVersion: AssetSwapContractVersion,
    contractVersion?: string,
    attestedResponder: string | null = TAKER,
) => {
    const f = await acceptWallet();
    const quoted = await deriveOffer(f.wallet, {
        wantAmount: 50_000n,
        wantAsset,
        emulatorPubkey,
        contractVersion: quotedVersion,
        ...(quotedVersion === ASSET_SWAP_V4 ? { taker: hex.decode(TAKER) } : {}),
    });
    const requestQuote = vi.fn(async (_payload: Record<string, unknown>) =>
        quoteOf(quoted, contractVersion),
    );
    const transport: AttestingRfqTransport = {
        ...(attestedResponder === null ? {} : { attestedResponder }),
        requestQuote,
        status: async () => null,
        close: async () => {},
    };
    vi.mocked(createOffer).mockClear();
    const request = () =>
        requestArkadeSwap(f.wallet, transport, {
            wantAsset,
            amount: 700n,
            emulatorPubkey,
            now: 1_800_000_000,
        });
    return { ...f, quoted, request, requestQuote };
};

describe("requestArkadeSwap contract version negotiation", () => {
    it("advertises asset-swap-v4 alone", async () => {
        const f = await setup(ASSET_SWAP_V4, ASSET_SWAP_V4);
        await f.request();
        expect(f.requestQuote.mock.calls[0]?.[0]).toMatchObject({
            contract_versions: [ASSET_SWAP_V4],
        });
    });

    it("binds the attested responder as the taker of the offer it registers", async () => {
        const f = await setup(ASSET_SWAP_V4, ASSET_SWAP_V4);
        const result = await f.request();
        expect(result.address).toBe(f.quoted.address);
        expect(decodeOffer(hex.decode(result.offerHex)).taker).toEqual(hex.decode(TAKER));
        expect(createOffer).toHaveBeenCalledWith(
            f.wallet,
            expect.objectContaining({ taker: hex.decode(TAKER) }),
        );
        expect(f.contracts.map((row) => row.script)).toEqual([hex.encode(result.swapPkScript)]);
    });

    it("refuses a v4 quote over a transport that attests nobody, before creating the offer", async () => {
        const f = await setup(ASSET_SWAP_V4, ASSET_SWAP_V4, null);
        await expect(f.request()).rejects.toMatchObject({
            name: "QuoteVerificationFailed",
            check: "responder",
        });
        expect(createOffer).not.toHaveBeenCalled();
        expect(f.contracts).toHaveLength(0);
    });

    it("refuses a quote that names no contract version, before creating the offer", async () => {
        const f = await setup(ASSET_SWAP_V2);
        await expect(f.request()).rejects.toThrow("solver negotiated no contract version");
        expect(createOffer).not.toHaveBeenCalled();
    });

    it.each(["asset-swap-v3", ASSET_SWAP_V2])("refuses a quote echoing %s", async (version) => {
        const f = await setup(ASSET_SWAP_V2, version);
        await expect(f.request()).rejects.toThrow(
            `solver chose contract version ${version}, not one of ${ASSET_SWAP_V4}`,
        );
        expect(createOffer).not.toHaveBeenCalled();
    });

    it("does not ask again without the list after a bare unsupported_payload", async () => {
        const f = await setup(ASSET_SWAP_V2);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        await expect(f.request()).rejects.toMatchObject({ reason: "unsupported_payload" });
        expect(f.requestQuote).toHaveBeenCalledTimes(1);
    });

    it("does not retry any other refusal", async () => {
        const f = await setup(ASSET_SWAP_V4, ASSET_SWAP_V4);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("no_liquidity"));
        await expect(f.request()).rejects.toMatchObject({ reason: "no_liquidity" });
        expect(f.requestQuote).toHaveBeenCalledTimes(1);
    });

    it("does not retry a solver that read the list and supports none of it", async () => {
        const f = await setup(ASSET_SWAP_V4, ASSET_SWAP_V4);
        f.requestQuote.mockRejectedValueOnce(
            new SwapRefusal("unsupported_payload", undefined, {
                errorCode: "contract_version_unsupported",
            }),
        );
        await expect(f.request()).rejects.toMatchObject({
            errorCode: "contract_version_unsupported",
        });
        expect(f.requestQuote).toHaveBeenCalledTimes(1);
    });
});

describe("requestVersionedQuote", () => {
    const advertised = [ASSET_SWAP_V4, ASSET_SWAP_V2];
    const request = { rfq_id: "33".repeat(32), contract_versions: advertised };
    const answering = (contractVersion?: string) => ({
        requestQuote: vi.fn(async (_payload: Record<string, unknown>) =>
            quoteOf({ address: "tark1quoted", swapPkScript: new Uint8Array(34) }, contractVersion),
        ),
        status: async () => null,
        close: async () => {},
    });

    it("rejects an empty list before sending anything", async () => {
        const transport = answering(ASSET_SWAP_V4);
        await expect(requestVersionedQuote(transport, request, [])).rejects.toThrow(
            "contractVersions is empty",
        );
        expect(transport.requestQuote).not.toHaveBeenCalled();
    });

    it("refuses a contract version it did not advertise, naming the offered list", async () => {
        await expect(
            requestVersionedQuote(answering("asset-swap-v9"), request, advertised),
        ).rejects.toThrow(
            `solver chose contract version asset-swap-v9, not one of ${advertised.join(", ")}`,
        );
    });

    it("reads a quote naming none as the baseline when the baseline was advertised", async () => {
        await expect(
            requestVersionedQuote(answering(), request, advertised),
        ).resolves.toMatchObject({ contractVersion: ASSET_SWAP_V2 });
    });

    it("asks once more without the list when the baseline was advertised", async () => {
        const transport = answering();
        transport.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        const result = await requestVersionedQuote(transport, request, advertised);
        expect(result.contractVersion).toBe(ASSET_SWAP_V2);
        const [[first], [second]] = transport.requestQuote.mock.calls;
        expect(second).not.toHaveProperty("contract_versions");
        expect(second?.rfq_id).not.toBe(first?.rfq_id);
        expect(result.rfqId).toBe(second?.rfq_id);
    });

    it("refuses a retried quote that names a contract version nobody advertised", async () => {
        const transport = answering(ASSET_SWAP_V4);
        transport.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        await expect(requestVersionedQuote(transport, request, advertised)).rejects.toThrow(
            "but none was advertised",
        );
    });
});

describe("offer contract version default", () => {
    it("derives the legacy tree when createOffer is given no contract version", async () => {
        const f = await acceptWallet();
        const created = await createOffer(f.wallet, {
            wantAmount: 50_000n,
            wantAsset,
            emulatorPubkey,
        });
        const previous = await deriveOffer(f.wallet, {
            wantAmount: 50_000n,
            wantAsset,
            emulatorPubkey,
            contractVersion: "asset-swap-v2",
        });
        expect(created.address).toBe(previous.address);
        expect(hex.encode(offerContract(previous.binding, previous.operatorPubkey).pkScript)).toBe(
            hex.encode(previous.swapPkScript),
        );
    });

    it("refuses asset-swap-v3 as an unknown version, and registers nothing", async () => {
        const f = await acceptWallet();
        const params = {
            wantAmount: 50_000n,
            wantAsset,
            emulatorPubkey,
            contractVersion: "asset-swap-v3" as never,
        };
        await expect(deriveOffer(f.wallet, params)).rejects.toThrow(
            "unknown contract version asset-swap-v3",
        );
        await expect(createOffer(f.wallet, params)).rejects.toThrow(
            "unknown contract version asset-swap-v3",
        );
        expect(f.contracts).toHaveLength(0);
    });
});
