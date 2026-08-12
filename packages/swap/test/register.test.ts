import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    asset,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    ReadonlySingleKey,
    ReadonlyWallet,
    type ArkProvider,
    type IndexerProvider,
    type IWallet,
    type OnchainProvider,
} from "@arkade-os/sdk";
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
    watched: [] as [string, string][],
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
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
};

const wallet = {
    identity: { xOnlyPublicKey: async () => makerKey },
    getAddress: async () => makerAddress,
    getContractManager: async () => contractManager,
} as unknown as IWallet;

// Explicit override, not fetched: the key defaults to the SDK's per-network
// pin, and this suite overrides it so its golden expectations don't move with
// the pinned constants. Same value the RestEmulatorProvider stub above used
// to hand back, so this file's expectations are unchanged.
const emulatorPubkey = hex.decode(
    "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27",
);
const testAsset = asset.AssetId.fromString("aa".repeat(32) + "0000");
const create = (maker: IWallet = wallet) =>
    createOffer(maker, "http://ark", {
        wantAmount: BigInt(50_000),
        wantAsset: testAsset,
        emulatorPubkey,
    });

describe("offer contract registration", () => {
    beforeEach(() => {
        state.created = [];
        state.watched = [];
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

    it("states that the address it hands back is watched", async () => {
        const offer = await create();
        expect(state.watched).toEqual([[hex.encode(offer.swapPkScript), "watched"]]);
    });
});

// ── Re-offering a retired script, against a real contract manager ────────────

const SIGNER_PUBKEY = "02" + "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";

const arkInfo = () => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: SIGNER_PUBKEY,
    network: "regtest",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: SIGNER_PUBKEY,
    unilateralExitDelay: 4096n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

/** Offline: every indexer read fails retryably, so the row still persists. */
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as Partial<IndexerProvider> as IndexerProvider;

const realWallet = async () => {
    const contractRepository = new InMemoryContractRepository();
    const wallet = await ReadonlyWallet.create({
        arkServerUrl: "http://localhost:7070",
        arkProvider: { getInfo: async () => arkInfo() } as Partial<ArkProvider> as ArkProvider,
        indexerProvider: offlineIndexer(),
        onchainProvider: {
            getCoins: async () => [],
            getTransactions: async () => [],
            getTxOutspends: async () => [],
        } as Partial<OnchainProvider> as OnchainProvider,
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        identity: ReadonlySingleKey.fromPublicKey(
            hex.decode("02" + hex.encode(schnorr.getPublicKey(makerKey))),
        ),
    });
    return { wallet: wallet as unknown as IWallet, contractRepository };
};

describe("an offer at a script an earlier offer retired", () => {
    it("is watched again before the maker can fund it", async () => {
        const { wallet, contractRepository } = await realWallet();
        const offer = await create(wallet);
        const script = hex.encode(offer.swapPkScript);
        const manager = await wallet.getContractManager();
        // the state a settled offer leaves behind
        await manager.setContractWatchState(script, "retained");

        // identical offers derive one script, and createContract is
        // first-writer-wins: it never touches the existing row, so the
        // promotion is the only thing that can restore coverage here
        await create(wallet);

        const row = (await contractRepository.getContracts()).find((c) => c.script === script);
        expect(row?.watch).toBe("watched");
    });
});
