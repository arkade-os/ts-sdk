import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { asset } from "@arkade-os/sdk";
import { requestArkadeSwap, SwapRefusal, type RfqTransport } from "../src/rfq";
import { deriveOffer } from "../src/offer";
import { ASSET_SWAP_COVENANT_VERSIONS, ASSET_SWAP_V2, ASSET_SWAP_V3 } from "../src/program";
import { acceptWallet } from "./client/fixtures";

const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const advertised = [ASSET_SWAP_V3, ASSET_SWAP_V2];

const setup = async (
    quotedGeneration: "current" | "previous",
    covenantVersion?: string,
    covenantVersions: readonly string[] | null = advertised,
) => {
    const f = await acceptWallet();
    const derive = (generation: "current" | "previous") =>
        deriveOffer(f.wallet, { wantAmount: 50_000n, wantAsset, emulatorPubkey, generation });
    const [current, previous] = await Promise.all([derive("current"), derive("previous")]);
    const quoted = quotedGeneration === "current" ? current : previous;
    const requestQuote = vi.fn(async (_payload: Record<string, unknown>) => ({
        v: 1 as const,
        type: "rfq_quote" as const,
        rfq_id: "11".repeat(32),
        pair: `arkade:BTC->arkade:${wantAsset}`,
        from_amount: "700",
        to_amount: "50000",
        solver_pubkey: "22".repeat(32),
        valid_until: 1_800_000_060,
        ...(covenantVersion !== undefined ? { covenant_version: covenantVersion } : {}),
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
            ...(covenantVersions !== null ? { covenantVersions } : {}),
            now: 1_800_000_000,
        });
    return { current, previous, request, requestQuote };
};

describe("requestArkadeSwap covenant negotiation", () => {
    it("derives the previous tree when the solver picks an advertised older covenant", async () => {
        const f = await setup("previous", ASSET_SWAP_V2);
        expect(f.previous.address).not.toBe(f.current.address);
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
        expect(result.offerHex).toBe(f.previous.offerHex);
    });

    it("refuses a covenant it did not advertise, naming the offered list", async () => {
        const f = await setup("previous", "asset-swap-v9");
        await expect(f.request()).rejects.toThrow(
            `solver chose covenant asset-swap-v9, not one of ${advertised.join(", ")}`,
        );
    });

    it("takes the baseline tree when the solver names no covenant", async () => {
        const f = await setup("previous");
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
    });

    it("refuses an unnamed covenant when the caller did not advertise the baseline", async () => {
        const f = await setup("previous", undefined, [ASSET_SWAP_V3]);
        await expect(f.request()).rejects.toThrow(
            `solver chose covenant ${ASSET_SWAP_V2}, not one of ${ASSET_SWAP_V3}`,
        );
    });

    it("advertises every covenant it derives when the caller names none", async () => {
        const f = await setup("current", ASSET_SWAP_V3, null);
        const result = await f.request();
        expect(result.address).toBe(f.current.address);
        expect(f.requestQuote).toHaveBeenCalledWith(
            expect.objectContaining({ covenant_versions: [...ASSET_SWAP_COVENANT_VERSIONS] }),
        );
    });

    it("asks a solver that refuses the list once more without it, taking the baseline", async () => {
        const f = await setup("previous", undefined, null);
        f.requestQuote.mockRejectedValueOnce(new SwapRefusal("unsupported_payload"));
        const result = await f.request();
        expect(result.address).toBe(f.previous.address);
        expect(f.requestQuote).toHaveBeenCalledTimes(2);
        expect(f.requestQuote.mock.calls[1]?.[0]).not.toHaveProperty("covenant_versions");
    });

    it("does not retry a solver that read the list and supports none of it", async () => {
        const f = await setup("previous", undefined, null);
        f.requestQuote.mockRejectedValueOnce(
            new SwapRefusal("unsupported_payload", undefined, {
                errorCode: "covenant_version_unsupported",
            }),
        );
        await expect(f.request()).rejects.toMatchObject({
            errorCode: "covenant_version_unsupported",
        });
        expect(f.requestQuote).toHaveBeenCalledTimes(1);
    });
});
