import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { asset } from "@arkade-os/sdk";
import { requestArkadeSwap, SwapRefusal, type RfqTransport } from "../src/rfq";
import { createOffer, deriveOffer, offerContract } from "../src/offer";
import {
    ASSET_SWAP_CONTRACT_VERSIONS,
    ASSET_SWAP_V2,
    ASSET_SWAP_V3,
    type AssetSwapContractVersion,
} from "../src/program";
import { acceptWallet } from "./client/fixtures";

const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const advertised = [ASSET_SWAP_V3, ASSET_SWAP_V2];

const setup = async (
    quotedVersion: AssetSwapContractVersion,
    contractVersion?: string,
    contractVersions: readonly string[] | null = advertised,
) => {
    const f = await acceptWallet();
    const derive = (contractVersion: AssetSwapContractVersion) =>
        deriveOffer(f.wallet, { wantAmount: 50_000n, wantAsset, emulatorPubkey, contractVersion });
    const [current, previous] = await Promise.all([
        derive("asset-swap-v3"),
        derive("asset-swap-v2"),
    ]);
    const quoted = quotedVersion === "asset-swap-v3" ? current : previous;
    const requestQuote = vi.fn(async (_payload: Record<string, unknown>) => ({
        v: 1 as const,
        type: "rfq_quote" as const,
        rfq_id: "11".repeat(32),
        pair: `arkade:BTC->arkade:${wantAsset}`,
        from_amount: "700",
        to_amount: "50000",
        solver_pubkey: "22".repeat(32),
        valid_until: 1_800_000_060,
        ...(contractVersion !== undefined ? { contract_version: contractVersion } : {}),
        profile: {
            offer_address: quoted.address,
            offer_pk_script: hex.encode(quoted.swapPkScript),
        },
    }));
    const transport: RfqTransport = {
        requestQuote,
        status: async () => null,
        close: async () => {},
    };
    const request = () =>
        requestArkadeSwap(f.wallet, transport, {
            wantAsset,
            amount: 700n,
            emulatorPubkey,
            ...(contractVersions !== null ? { contractVersions } : {}),
            now: 1_800_000_000,
        });
    return { current, previous, request, requestQuote };
};

describe("requestArkadeSwap contract version negotiation", () => {
    it("rejects an empty contractVersions list before sending anything", async () => {
        const f = await setup("asset-swap-v2", undefined, []);
        await expect(f.request()).rejects.toThrow("contractVersions is empty");
        expect(f.requestQuote).not.toHaveBeenCalled();
    });

    it("derives the previous tree when the solver picks an advertised older contract version", async () => {
        const f = await setup("asset-swap-v2", ASSET_SWAP_V2);
        expect(f.previous.address).not.toBe(f.current.address);
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
        expect(result.offerHex).toBe(f.previous.offerHex);
    });

    it("refuses a contract version it did not advertise, naming the offered list", async () => {
        const f = await setup("asset-swap-v2", "asset-swap-v9");
        await expect(f.request()).rejects.toThrow(
            `solver chose contract version asset-swap-v9, not one of ${advertised.join(", ")}`,
        );
    });

    it("derives the previous tree when the solver names no contract version", async () => {
        const f = await setup("asset-swap-v2");
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
    });

    it("refuses an unnamed contract version when the caller did not advertise the baseline", async () => {
        const f = await setup("asset-swap-v2", undefined, [ASSET_SWAP_V3]);
        await expect(f.request()).rejects.toThrow(
            `solver chose contract version ${ASSET_SWAP_V2}, not one of ${ASSET_SWAP_V3}`,
        );
    });

    it("advertises [asset-swap-v3, asset-swap-v2] and takes the current tree on v3", async () => {
        const f = await setup("asset-swap-v3", ASSET_SWAP_V3, null);
        const result = await f.request();
        expect(result.address).toBe(f.current.address);
        expect(f.requestQuote).toHaveBeenCalledWith(
            expect.objectContaining({ contract_versions: [...ASSET_SWAP_CONTRACT_VERSIONS] }),
        );
    });

    it("asks a solver that refuses the list once more without it, taking the baseline", async () => {
        const f = await setup("asset-swap-v2", undefined, null);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
        expect(f.requestQuote).toHaveBeenCalledTimes(2);
        const [[first], [second]] = f.requestQuote.mock.calls as [Record<string, unknown>][];
        expect(second).not.toHaveProperty("contract_versions");
        expect(second?.rfq_id).not.toBe(first?.rfq_id);
        expect(result.rfqId).toBe(second?.rfq_id);
    });

    it("refuses a retried quote that names a contract version nobody advertised", async () => {
        const f = await setup("asset-swap-v3", ASSET_SWAP_V3, null);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        await expect(f.request()).rejects.toThrow("but none was advertised");
    });

    it("does not retry any other refusal", async () => {
        const f = await setup("asset-swap-v2", undefined, null);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("no_liquidity"));
        await expect(f.request()).rejects.toMatchObject({ reason: "no_liquidity" });
        expect(f.requestQuote).toHaveBeenCalledTimes(1);
    });

    it("does not retry a solver that read the list and supports none of it", async () => {
        const f = await setup("asset-swap-v2", undefined, null);
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
});
