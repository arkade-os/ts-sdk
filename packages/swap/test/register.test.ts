import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { asset, type IWallet } from "@arkade-os/sdk";
import { createOffer, OFFER_CONTRACT_KIND, OFFER_CONTRACT_LABEL } from "../src/offer";

// the covenant derivation, Arkade.connect, ArkadeContract and register() are
// all real here — only the network seam (the three Rest* providers) and the
// contract manager are stubbed, so a writer that omits or misspells the escrow
// marker fails this test rather than passing on a hand-built fixture
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";

const state = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    createContract: undefined as ((params: Record<string, unknown>) => unknown) | undefined,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    // the factory is hoisted above this file's imports, so re-import inside it
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
                return {
                    signerPubkey:
                        "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
                    checkpointTapscript,
                    network: "regtest",
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

const contractManager = {
    createContract: async (params: Record<string, unknown>) => {
        if (state.createContract) return state.createContract(params);
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
};

const wallet = {
    identity: { xOnlyPublicKey: async () => makerKey },
    getAddress: async () => makerAddress,
    getContractManager: async () => contractManager,
} as unknown as IWallet;

const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const create = () =>
    createOffer(wallet, "http://ark", "http://emu", {
        wantAmount: BigInt(50_000),
        wantAsset: testAsset,
    });

describe("offer contract registration", () => {
    beforeEach(() => {
        state.created = [];
        state.createContract = undefined;
    });

    it("registers the funded covenant as an escrowed arkade contract", async () => {
        const offer = await create();

        expect(state.created).toHaveLength(1);
        const row = state.created[0];
        expect(row.type).toBe("arkade");
        // the row must key on the script the maker is about to fund; a row at
        // any other script leaves the real deposit unwatched and unmarked
        expect(row.script).toBe(hex.encode(offer.swapPkScript));
        // and carry the address the caller was handed — a row derived against
        // the SDK's default network instead of the server's would disagree here
        expect(row.address).toBe(offer.address);
        expect(row.label).toBe(OFFER_CONTRACT_LABEL);
        expect(row.metadata).toEqual({
            genericallySpendable: false,
            kind: OFFER_CONTRACT_KIND,
        });
    });

    it("stores only script-level facts, so a shared row cannot go stale", async () => {
        // identical offers derive one address and createContract is
        // first-writer-wins, so the second deposit inherits the first row: any
        // per-offer value written here would silently describe the wrong offer
        const [a, b] = [await create(), await create()];
        expect(b.swapPkScript).toEqual(a.swapPkScript);
        expect(state.created[1]).toEqual(state.created[0]);

        const serialized = JSON.stringify(state.created[0]);
        for (const perOffer of [a.offerHex, "fundingTxid", "swapId"]) {
            expect(serialized).not.toContain(perOffer);
        }
    });

    it("fails the offer rather than returning an address it never registered", async () => {
        // registration runs before funding precisely so this can throw: the
        // same failure after wallet.send would strand an unwatched deposit
        state.createContract = () => {
            throw new Error("repository unavailable");
        };
        await expect(create()).rejects.toThrow("repository unavailable");
    });
});
