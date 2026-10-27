import { describe, expect, it, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    asset,
    type Contract,
    type IndexerProvider,
    type IWallet,
} from "@arkade-os/sdk";
import {
    encodeOffer,
    offerContract,
    restoreOfferCoverage,
    OFFER_CONTRACT_KIND,
    OFFER_CONTRACT_LABEL,
    type Offer,
} from "../src/offer";
import { retireSettledOfferContracts } from "../src/coverage";
import type { AssetSwap, AssetSwapStatus } from "../src/store";
import v0Wallet from "./fixtures/program-v0-offer.json";

// real derivation and register(); its own file because `coverage.ts` keeps the
// issuance mark in module state, which a createOffer promotion would decide.
const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
const SERVER_KEY = hex.decode("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
const EMULATOR_KEY = hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
const FUNDING_TXID = "ab".repeat(32);
const ROTATED_KEY = "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";

const state = vi.hoisted(() => ({
    signer: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
    rows: [] as { type: string; script: string; params: Record<string, string> }[],
    created: [] as Record<string, unknown>[],
    watched: [] as [string, string][],
    getInfoCalls: 0,
    managerCalls: 0,
    batchCalls: 0,
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
                    signerPubkey: "02" + state.signer,
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
    getContracts: async ({ script }: { script: string[] }) =>
        state.rows.filter((row) => script.includes(row.script)),
    createContract: async (params: Record<string, unknown>) => {
        state.created.push(params);
        return { ...params, state: "active", createdAt: 0 };
    },
    createContracts: async (list: Record<string, unknown>[]) => {
        state.batchCalls++;
        return list.map((params) => {
            state.created.push(params);
            return { ...params, state: "active", createdAt: 0 };
        });
    },
    setContractWatchState: async (script: string, watch: string) => {
        state.watched.push([script, watch]);
    },
};

const wallet = {
    identity: { xOnlyPublicKey: async () => makerKey },
    getAddress: async () => makerAddress,
    getContractManager: async () => {
        state.managerCalls++;
        return contractManager;
    },
    getArkadeInfo: async () => new RestArkProvider("http://ark").getInfo(),
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
    return { ...binding, swapPkScript: offerContract(binding, SERVER_KEY).pkScript };
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
    state.signer = hex.encode(SERVER_KEY);
    state.rows = [];
    state.created = [];
    state.watched = [];
    state.getInfoCalls = 0;
    state.managerCalls = 0;
    state.batchCalls = 0;
});

describe("restoreOfferCoverage", () => {
    it("registers the covenant behind a record the scan rebuilt", async () => {
        const offer = makeOffer();
        const record = restored(offer);

        await restoreOfferCoverage(wallet, [record]);

        expect(state.created).toHaveLength(1);
        const row = state.created[0];
        expect(row.type).toBe("arkade");
        expect(row.script).toBe(record.swapPkScript);
        expect(row.label).toBe(OFFER_CONTRACT_LABEL);
        expect(row.metadata).toEqual({ genericallySpendable: false, kind: OFFER_CONTRACT_KIND });
    });

    it("puts the restored script back in the watched set", async () => {
        const offer = makeOffer();
        await restoreOfferCoverage(wallet, [restored(offer)]);
        expect(state.watched).toEqual([[hex.encode(offer.swapPkScript), "watched"]]);
    });

    it("costs the same /v1/info whether it covers one script or many", async () => {
        const many = [50_000, 60_000, 70_000, 80_000].map((n, i) =>
            restored(makeOffer(BigInt(n)), {
                id: `0${i}`.repeat(32),
                fundingTxid: `0${i}`.repeat(32),
            }),
        );

        await restoreOfferCoverage(wallet, [many[0]]);
        const forOne = state.getInfoCalls;
        state.getInfoCalls = 0;
        state.managerCalls = 0;
        state.batchCalls = 0;
        await restoreOfferCoverage(wallet, many);

        // 5 = 1 from the single-script call above, 4 from the batch
        expect(state.created).toHaveLength(5);
        expect(state.getInfoCalls).toBe(forOne);
        // one manager for the whole batch, or a registration spans two
        expect(state.managerCalls).toBe(1);
        expect(state.batchCalls).toBe(1);
    });

    it("leaves a script whose every record has settled alone", async () => {
        for (const status of ["fulfilled", "cancelled"] as AssetSwapStatus[]) {
            state.created = [];
            state.watched = [];
            await restoreOfferCoverage(wallet, [restored(makeOffer(), { status })]);
            expect(state.created).toEqual([]);
            expect(state.watched).toEqual([]);
        }
    });

    it("promotes a script a live record holds once, settled sibling or not", async () => {
        const offer = makeOffer();
        await restoreOfferCoverage(wallet, [
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

        await restoreOfferCoverage(wallet, [record]);
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

        await restoreOfferCoverage(wallet, [stale, restored(good)]);

        expect(state.watched).toEqual([[hex.encode(good.swapPkScript), "watched"]]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("rebuilds with the operator key the stored row was funded under", async () => {
        const offer = makeOffer();
        const script = hex.encode(offer.swapPkScript);
        state.signer = ROTATED_KEY;
        // compressed on purpose: the stored key is normalized like the live one
        state.rows = [
            { type: "arkade", script, params: { serverKey: "02" + hex.encode(SERVER_KEY) } },
        ];

        await restoreOfferCoverage(wallet, [restored(offer)]);

        expect(state.created).toHaveLength(1);
        expect(state.created[0].script).toBe(script);
        expect((state.created[0].params as Record<string, string>).serverKey).toBe(
            hex.encode(SERVER_KEY),
        );
    });

    it("falls back to the current signer when the offer has no row", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        state.signer = ROTATED_KEY;

        await restoreOfferCoverage(wallet, [restored(makeOffer())]);

        // funded under the old key, so the current one cannot rebuild it
        expect(state.created).toEqual([]);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe("restoreOfferCoverage over a Program v0 row", () => {
    const indexer = {
        getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
        subscribeForScripts: vi.fn().mockResolvedValue("sub"),
        unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
        getSubscription: vi.fn(() => ({
            [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        })),
    } as unknown as IndexerProvider;

    const managed = async (repository: InMemoryContractRepository) => {
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: repository,
            walletRepository: new InMemoryWalletRepository(),
        });
        return {
            manager,
            wallet: { ...wallet, getContractManager: async () => manager } as unknown as IWallet,
        };
    };

    it("replaces the row in place from the swap record", async () => {
        const offer = makeOffer();
        const script = hex.encode(offer.swapPkScript);
        const scratch = await managed(new InMemoryContractRepository());
        await restoreOfferCoverage(scratch.wallet, [restored(offer)]);
        const [v1] = await scratch.manager.getContracts({ script });
        await scratch.manager.dispose();

        // the same row as an SDK that wrote Program v0 left it
        const program = JSON.parse(v1.params.program);
        const v0: Contract = {
            ...v1,
            params: { ...v1.params, program: JSON.stringify({ ...program, version: 0 }) },
            createdAt: 1,
        };
        const repository = new InMemoryContractRepository();
        await repository.saveContract(v0);
        const { manager, wallet: restoring } = await managed(repository);
        expect(await manager.getUnsupportedContracts()).toEqual([v0]);

        await restoreOfferCoverage(restoring, [restored(offer)]);

        expect(await manager.getContracts({ script })).toEqual([{ ...v1, createdAt: 1 }]);
        expect(await manager.getUnsupportedContracts()).toEqual([]);
        await manager.dispose();
    });

    it("leaves a v0 row whose every record has settled alone", async () => {
        const offer = makeOffer();
        const script = hex.encode(offer.swapPkScript);
        const v0: Contract = {
            type: "arkade",
            params: {
                program: JSON.stringify({ version: 0, functions: {} }),
                serverKey: hex.encode(SERVER_KEY),
            },
            script,
            address: "ark1v0",
            state: "active",
            createdAt: 1,
        };
        const repository = new InMemoryContractRepository();
        await repository.saveContract(v0);
        const { manager, wallet: restoring } = await managed(repository);

        await restoreOfferCoverage(restoring, [restored(offer, { status: "fulfilled" })]);

        expect(await manager.getContracts({ script })).toEqual([v0]);
        await manager.dispose();
    });

    describe("exported from a pre-v1 wallet", () => {
        // its IndexedDB index column, not part of the contract
        const { watchState: _, ...stored } = v0Wallet.contract;
        const row = stored as Contract;
        const swap = v0Wallet.swap as AssetSwap;

        const seeded = async () => {
            const repository = new InMemoryContractRepository();
            await repository.saveContract(row);
            return managed(repository);
        };

        it("leaves the row of its cancelled offer alone", async () => {
            const { manager, wallet: restoring } = await seeded();

            await restoreOfferCoverage(restoring, [swap]);

            expect(await manager.getContracts({ script: row.script })).toEqual([row]);
            expect(await manager.getUnsupportedContracts()).toEqual([row]);
            await manager.dispose();
        });

        it("rebuilds a live offer's row as v1 in place, under the key it was funded with", async () => {
            const { manager, wallet: restoring } = await seeded();

            await restoreOfferCoverage(restoring, [{ ...swap, status: "pending" }]);

            const [replaced] = await manager.getContracts({ script: row.script });
            // a live record promotes its retained script back to watched
            expect(replaced).toEqual({ ...row, params: replaced.params, watch: "watched" });
            expect(JSON.parse(replaced.params.program).version).toBe(1);
            expect(replaced.params.serverKey).toBe(row.params.serverKey);
            expect(await manager.getUnsupportedContracts()).toEqual([]);
            await manager.dispose();
        });
    });
});
