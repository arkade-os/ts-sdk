import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";
import { cancelOffer, encodeOffer, offerVtxoScript, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap } from "../src/store";

// cancelOffer's guards fire before any signing: mock only the network seam
// (Arkade.connect for the current server key, ArkadeContract for the vtxo
// lookup) and keep the real covenant derivation underneath
const state = vi.hoisted(() => ({
    // bare Uint8Array, not the inferred Uint8Array<ArrayBuffer>: hex.decode
    // returns the ArrayBufferLike flavor and must be assignable here
    serverKey: new Uint8Array(0) as Uint8Array,
    utxos: [] as { txid: string; vout: number; value: number }[],
    connectOptions: undefined as { contractManager?: unknown } | undefined,
    sends: 0,
}));

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    return {
        ...mod,
        arkade: {
            ...mod.arkade,
            Arkade: {
                connect: async (opts: { contractManager?: unknown }) => {
                    state.connectOptions = opts;
                    return { serverKey: state.serverKey };
                },
            },
            ArkadeContract: class {
                getUtxos = async () => state.utxos;
                functions = {
                    cancel: () => {
                        const chain = {
                            from: () => chain,
                            to: () => chain,
                            withAsset: () => chain,
                            send: async () => {
                                state.sends += 1;
                                return { txid: "cc".repeat(32) };
                            },
                        };
                        return chain;
                    },
                };
            },
        },
    };
});

const fundedServerKey = hex.decode(
    "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
);
const rotatedServerKey = hex.decode(
    "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
);
const binding: Omit<Offer, "swapPkScript"> = {
    wantAmount: BigInt(50_000),
    wantAsset: asset.AssetId.fromString("aa".repeat(32) + "0000"),
    makerPkScript: hex.decode(
        "51203c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1",
    ),
    makerPublicKey: hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1"),
    emulatorPubkey: hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27"),
};
const script = offerVtxoScript(binding, fundedServerKey);
const offerHex = hex.encode(encodeOffer({ ...binding, swapPkScript: script.pkScript }));
const fundedAddress = new ArkAddress(fundedServerKey, script.tweakedPublicKey, "tark").encode();

const contractManager = { marker: "the wallet's manager" };
const wallet = {
    identity: {},
    getAddress: async () => "unused-before-a-vtxo-is-selected",
    getContractManager: async () => contractManager,
} as unknown as IWallet;

describe("cancelOffer guards", () => {
    it("diagnoses a rotated server key instead of reporting a missing VTXO", async () => {
        state.serverKey = rotatedServerKey;
        await expect(
            cancelOffer(wallet, "http://ark", offerHex, {
                repository: new InMemoryAssetSwapRepository(),
            }),
        ).rejects.toThrow("signing key has likely rotated");
    });

    it("proceeds past a rotation when swapAddress pins the funded server key", async () => {
        // the current (rotated) key is never consulted; reaching the vtxo
        // lookup — and its ordinary empty-address error — proves the pin held
        state.serverKey = rotatedServerKey;
        state.utxos = [];
        await expect(
            cancelOffer(wallet, "http://ark", offerHex, {
                repository: new InMemoryAssetSwapRepository(),
                swapAddress: fundedAddress,
            }),
        ).rejects.toThrow("no spendable VTXO");
    });

    it("refuses to guess between multiple deposits when fundingTxid is absent", async () => {
        state.serverKey = fundedServerKey;
        state.utxos = [
            { txid: "a".repeat(64), vout: 0, value: 10_000 },
            { txid: "b".repeat(64), vout: 0, value: 10_000 },
        ];
        await expect(
            cancelOffer(wallet, "http://ark", offerHex, {
                repository: new InMemoryAssetSwapRepository(),
            }),
        ).rejects.toThrow("pass fundingTxid");
    });

    it("does not broadcast when the in-flight marker cannot be written", async () => {
        // The `cancelling` marker is what keeps a crash between submit and
        // record from leaving a swap that still looks pending. It is written
        // before `send()`, so a lost write must stop the broadcast, not warn
        // past it.
        state.serverKey = fundedServerKey;
        state.utxos = [{ txid: "a".repeat(64), vout: 0, value: 10_000 }];
        state.sends = 0;

        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, {
            id: "a".repeat(64),
            fromAsset: "btc",
            toAsset: "aa".repeat(32) + "0000",
            fromAmount: "10000",
            toAmount: "50000",
            swapAddress: fundedAddress,
            swapPkScript: hex.encode(script.pkScript),
            offerHex,
            fundingTxid: "a".repeat(64),
            status: "pending",
            createdAt: 1_700_000_000_000,
        });
        vi.spyOn(repository, "saveSwap").mockRejectedValue(new Error("quota exceeded"));
        // this is the one test that gets past vtxo selection, so the maker
        // address has to decode
        const funded = { ...wallet, getAddress: async () => fundedAddress } as unknown as IWallet;

        await expect(
            cancelOffer(funded, "http://ark", offerHex, {
                repository,
                fundingTxid: "a".repeat(64),
            }),
        ).rejects.toThrow(/quota exceeded/);
        expect(state.sends).toBe(0);
        vi.restoreAllMocks();
    });

    // without this the contract takes the direct-indexer fallback and a
    // registered offer's repository-backed VTXOs are never consulted
    it("hands the wallet's contract manager to the arkade client", async () => {
        state.serverKey = fundedServerKey;
        state.utxos = [];
        state.connectOptions = undefined;
        await expect(
            cancelOffer(wallet, "http://ark", offerHex, {
                repository: new InMemoryAssetSwapRepository(),
            }),
        ).rejects.toThrow("no spendable VTXO");
        expect(state.connectOptions?.contractManager).toBe(contractManager);
    });
});
