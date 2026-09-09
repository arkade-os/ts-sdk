import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, asset, type IWallet } from "@arkade-os/sdk";
import {
    encodeOffer,
    offerVtxoScript,
    restoreOfferCoverage,
    OFFER_CONTRACT_KIND,
    OFFER_CONTRACT_LABEL,
    type Offer,
} from "../src/offer";
import { retireSettledOfferContracts } from "../src/coverage";
import type { AssetSwap, AssetSwapStatus } from "../src/store";

// real derivation and register(); its own file because `coverage.ts` keeps the
// issuance mark in module state, which a createOffer promotion would decide.
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
const SERVER_KEY = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const EMULATOR_KEY = hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
const FUNDING_TXID = "ab".repeat(32);

const state = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    watched: [] as [string, string][],
    getInfoCalls: 0,
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
                state.getInfoCalls++;
                return {
                    signerPubkey:
                        "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
                    checkpointTapscript,
                    network: "regtest",
                    unilateralExitDelay: BigInt(4096),
                };
            }
        },
        RestIndexerProvider: class {
            async getVtxos() {
                return { vtxos: [] };
            }
        },
    };
});

const contractManager = {
    createContract: async (params: Record<string, unknown>) => {
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
};

const wallet = {
    identity: { xOnlyPublicKey: async () => makerKey },
    getAddress: async () => makerAddress,
    getContractManager: async () => contractManager,
} as unknown as IWallet;

const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");

const makeOffer = (wantAmount = BigInt(50_000)): Offer => {
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount,
        wantAsset: testAsset,
        makerPkScript: ArkAddress.decode(makerAddress).pkScript,
        makerPublicKey: makerKey,
        emulatorPubkey: EMULATOR_KEY,
        exitDelay: { type: "seconds", value: BigInt(4096) },
    };
    return { ...binding, swapPkScript: offerVtxoScript(binding, SERVER_KEY).pkScript };
};

/** A record exactly as `restoreAssetSwaps` writes one: `swapAddress: ""`. */
const restored = (offer: Offer, overrides: Partial<AssetSwap> = {}): AssetSwap => ({
    id: FUNDING_TXID,
    fromAsset: "btc",
    toAsset: testAsset.toString(),
    fromAmount: "10000",
    toAmount: offer.wantAmount.toString(),
    swapAddress: "",
    swapPkScript: hex.encode(offer.swapPkScript),
    offerHex: hex.encode(encodeOffer(offer)),
    fundingTxid: FUNDING_TXID,
    status: "pending",
    createdAt: 1_700_000_000_000,
    ...overrides,
});

beforeEach(() => {
    state.created = [];
    state.watched = [];
    state.getInfoCalls = 0;
});

describe("restoreOfferCoverage", () => {
    it("registers the covenant behind a record the scan rebuilt", async () => {
        const offer = makeOffer();
        const record = restored(offer);

        await restoreOfferCoverage(wallet, "http://ark", [record]);

        expect(state.created).toHaveLength(1);
        const row = state.created[0];
        expect(row.type).toBe("arkade");
        expect(row.script).toBe(record.swapPkScript);
        expect(row.label).toBe(OFFER_CONTRACT_LABEL);
        expect(row.metadata).toEqual({ genericallySpendable: false, kind: OFFER_CONTRACT_KIND });
    });

    it("puts the restored script back in the watched set", async () => {
        const offer = makeOffer();
        await restoreOfferCoverage(wallet, "http://ark", [restored(offer)]);
        expect(state.watched).toEqual([[hex.encode(offer.swapPkScript), "watched"]]);
    });

    it("costs the same /v1/info whether it covers one script or many", async () => {
        const many = [50_000, 60_000, 70_000, 80_000].map((n, i) =>
            restored(makeOffer(BigInt(n)), {
                id: `0${i}`.repeat(32),
                fundingTxid: `0${i}`.repeat(32),
            }),
        );

        await restoreOfferCoverage(wallet, "http://ark", [many[0]]);
        const forOne = state.getInfoCalls;
        state.getInfoCalls = 0;
        await restoreOfferCoverage(wallet, "http://ark", many);

        expect(state.created).toHaveLength(5);
        expect(state.getInfoCalls).toBe(forOne);
    });

    it("leaves a script whose every record has settled alone", async () => {
        for (const status of ["fulfilled", "cancelled"] as AssetSwapStatus[]) {
            state.created = [];
            state.watched = [];
            await restoreOfferCoverage(wallet, "http://ark", [restored(makeOffer(), { status })]);
            expect(state.created).toEqual([]);
            expect(state.watched).toEqual([]);
        }
    });

    it("promotes a script a live record holds once, settled sibling or not", async () => {
        const offer = makeOffer();
        await restoreOfferCoverage(wallet, "http://ark", [
            restored(offer, { status: "fulfilled" }),
            restored(offer, { id: "ee".repeat(32), fundingTxid: "ee".repeat(32) }),
            restored(offer, { id: "ff".repeat(32), fundingTxid: "ff".repeat(32) }),
        ]);
        expect(state.watched).toEqual([[hex.encode(offer.swapPkScript), "watched"]]);
        expect(state.created).toHaveLength(1);
    });

    it("still lets the restored script retire once its record settles", async () => {
        // a mark dated later than every record at the script blocks the retire
        const offer = makeOffer();
        const script = hex.encode(offer.swapPkScript);
        const record = restored(offer);

        await restoreOfferCoverage(wallet, "http://ark", [record]);
        await retireSettledOfferContracts(contractManager, [{ ...record, status: "fulfilled" }]);

        expect(state.watched).toEqual([
            [script, "watched"],
            [script, "retained"],
        ]);
    });

    it("skips a record whose covenant no longer derives, and keeps going", async () => {
        // a server key rotated since funding: the rebuilt script is not this one
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const good = makeOffer();
        const stale = restored(makeOffer(BigInt(77)), { swapPkScript: "51" + "00".repeat(32) });

        await restoreOfferCoverage(wallet, "http://ark", [stale, restored(good)]);

        expect(state.watched).toEqual([[hex.encode(good.swapPkScript), "watched"]]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
