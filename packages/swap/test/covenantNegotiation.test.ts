import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { asset } from "@arkade-os/sdk";
import { requestArkadeSwap, type RfqTransport } from "../src/rfq";
import { deriveOffer } from "../src/offer";
import { ASSET_SWAP_V2, ASSET_SWAP_V3 } from "../src/program";
import { acceptWallet } from "./client/fixtures";

const wantAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const emulatorPubkey = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const advertised = [ASSET_SWAP_V3, ASSET_SWAP_V2];

const setup = async (quotedGeneration: "current" | "previous", covenantVersion?: string) => {
    const f = await acceptWallet();
    const derive = (generation: "current" | "previous") =>
        deriveOffer(f.wallet, { wantAmount: 50_000n, wantAsset, emulatorPubkey, generation });
    const [current, previous] = await Promise.all([derive("current"), derive("previous")]);
    const quoted = quotedGeneration === "current" ? current : previous;
    const requestQuote = vi.fn(async () => ({
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
            covenantVersions: advertised,
            now: 1_800_000_000,
        });
    return { current, previous, request };
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

    it("keeps the current tree when the solver names no covenant", async () => {
        const f = await setup("current");
        const result = await f.request();
        expect(result.address).toBe(f.current.address);
    });
});
