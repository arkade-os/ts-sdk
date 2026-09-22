import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    asset,
    type IWallet,
    type NormalizedExtendedVirtualCoin,
} from "@arkade-os/sdk";
import { FundingOutcomeUnknownError, fundOffer, InMemoryAssetSwapRepository } from "../src";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";
import { encodeOffer, OFFER_PACKET_TYPE, offerVtxoScript, type Offer } from "../src/offer";

const SERVER_KEY_HEX = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const MAKER_KEY_HEX = "3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";
const EMULATOR_KEY_HEX = "466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const ASSET_ID = `${"aa".repeat(32)}0000`;
const OTHER_ASSET_ID = `${"bb".repeat(32)}0000`;
const FUNDING_TXID = "99".repeat(32);
const NOW = 1_800_000_000;

const state = vi.hoisted(() => ({
    providerCalls: 0,
    network: "regtest",
    signerPubkey: "024f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
    dust: 330n,
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
                state.providerCalls++;
                return {
                    signerPubkey: state.signerPubkey,
                    checkpointTapscript,
                    network: state.network,
                    unilateralExitDelay: 4096n,
                    dust: state.dust,
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

const SERVER_KEY = hex.decode(SERVER_KEY_HEX);
const MAKER_KEY = hex.decode(MAKER_KEY_HEX);
const EMULATOR_KEY = hex.decode(EMULATOR_KEY_HEX);
const MAKER_ADDRESS =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";

const contractManager = {
    createContract: vi.fn(async (params: Record<string, unknown>) => ({
        ...params,
        state: "active",
        createdAt: 0,
    })),
    setContractWatchState: vi.fn(async () => {}),
};

const offer = (side: "btc" | "asset" = "btc") => {
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount: side === "btc" ? 992n : 21_000n,
        ...(side === "btc"
            ? { wantAsset: asset.AssetId.fromString(ASSET_ID) }
            : { offerAsset: asset.AssetId.fromString(ASSET_ID) }),
        makerPkScript: ArkAddress.decode(MAKER_ADDRESS).pkScript,
        makerPublicKey: MAKER_KEY,
        emulatorPubkey: EMULATOR_KEY,
        exitDelay: { type: "seconds", value: 4096n },
    };
    const script = offerVtxoScript(binding, SERVER_KEY);
    const value = { ...binding, swapPkScript: script.pkScript };
    return {
        offer: value,
        offerHex: hex.encode(encodeOffer(value)),
        address: script.address("tark", SERVER_KEY).encode(),
    };
};

const coin = (
    txidByte: string,
    value: number,
    assets?: { assetId: string; amount: bigint }[],
    expiry: { kind: "height" | "time"; value: number } = {
        kind: "time",
        value: NOW + 7200,
    },
): NormalizedExtendedVirtualCoin =>
    ({
        txid: txidByte.repeat(32),
        vout: 0,
        value,
        assets,
        ...(expiry.kind === "height"
            ? { expiresAtHeight: expiry.value }
            : { expiresAt: new Date(expiry.value * 1000) }),
        virtualStatus: { state: "settled" },
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        spentBy: "",
        commitmentTxIds: [],
        isUnrolled: false,
        script: "51",
        createdAt: new Date((NOW - 1000) * 1000),
    }) as unknown as NormalizedExtendedVirtualCoin;

const walletFor = (
    vtxos: NormalizedExtendedVirtualCoin[],
    send = vi.fn(async () => FUNDING_TXID),
    address = MAKER_ADDRESS,
) =>
    ({
        identity: { xOnlyPublicKey: vi.fn(async () => MAKER_KEY) },
        getAddress: vi.fn(async () => address),
        getContractManager: vi.fn(async () => contractManager),
        getSpendableVtxos: vi.fn(async () => vtxos),
        send,
    }) as unknown as IWallet;

beforeEach(() => {
    state.providerCalls = 0;
    state.network = "regtest";
    state.signerPubkey = `02${SERVER_KEY_HEX}`;
    state.dust = 330n;
    contractManager.createContract.mockClear();
    contractManager.setContractWatchState.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("fundOffer", () => {
    it("rejects repositories without the complete v5 atomic funding contract before wallet work", async () => {
        const getAddress = vi.fn();
        const getSpendableVtxos = vi.fn();
        const send = vi.fn();
        const wallet = { getAddress, getSpendableVtxos, send } as unknown as IWallet;

        await expect(
            fundOffer(wallet, "https://ark.example/", {
                repository: { version: 4 } as never,
                offerHex: "not-hex",
                deposit: { amount: 10_000n },
            }),
        ).rejects.toThrow(/version 5.*atomic/i);
        expect(state.providerCalls).toBe(0);
        expect(getAddress).not.toHaveBeenCalled();
        expect(getSpendableVtxos).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it("rejects an asset-only carrier on a BTC deposit before provider work", async () => {
        const wallet = walletFor([coin("11", 20_000)]);
        const derived = offer();

        await expect(
            fundOffer(wallet, "https://ark.example/", {
                repository: new InMemoryAssetSwapRepository(),
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n, carrierSats: 330n },
            }),
        ).rejects.toThrow(/carrierSats.*asset/i);
        expect(state.providerCalls).toBe(0);
        expect(wallet.getSpendableVtxos).not.toHaveBeenCalled();
        expect(wallet.send).not.toHaveBeenCalled();
    });

    it("persists prepared then submitted before exact BTC send and binds one stable row", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const first = coin("11", 10_100, [{ assetId: OTHER_ASSET_ID, amount: 7n }]);
        const second = coin("22", 230);
        let atSend: Awaited<ReturnType<typeof repository.getSwap>>;
        const send = vi.fn(async () => {
            atSend = await repository.getSwap("operation-a");
            return FUNDING_TXID;
        });
        const wallet = walletFor([first, second], send);
        const derived = offer();

        const result = await fundOffer(wallet, "https://ark.example/", {
            repository,
            offerHex: derived.offerHex,
            deposit: { amount: 10_000n },
            id: "operation-a",
            validUntil: NOW + 60,
            inputExpiryFloor: { kind: "time", value: BigInt(NOW + 3600) },
            prepareNew: (draft) => ({
                ...draft,
                quote: { feeBps: 25 },
                carrier: { mode: "purchase", physicalSats: "330" },
            }),
        });

        expect(atSend!).toMatchObject({
            id: "operation-a",
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
        expect(send).toHaveBeenCalledWith({
            recipients: [
                {
                    address: derived.address,
                    amount: 10_000,
                    extensions: [
                        { type: OFFER_PACKET_TYPE, payload: hex.decode(derived.offerHex) },
                    ],
                },
            ],
            selectedVtxos: [first, second],
            validUntil: NOW + 60,
        });
        expect(result).toMatchObject({
            id: "operation-a",
            fromAsset: "btc",
            toAsset: ASSET_ID,
            fromAmount: "10000",
            toAmount: "992",
            swapAddress: derived.address,
            offerHex: derived.offerHex,
            fundingTxid: FUNDING_TXID,
            status: "pending",
            fundingIntent: {
                state: "bound",
                inputs: [
                    { txid: first.txid, vout: 0 },
                    { txid: second.txid, vout: 0 },
                ],
                output: { value: "10000" },
            },
            quote: { feeBps: 25 },
            carrier: { mode: "purchase", physicalSats: "330" },
        });
        expect(await repository.getAllSwaps()).toEqual([result]);
    });

    it("uses operator dust for an asset deposit and funds every selected asset change", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const first = coin("11", 400, [
            { assetId: ASSET_ID, amount: 600n },
            { assetId: OTHER_ASSET_ID, amount: 7n },
        ]);
        const second = coin("22", 260);
        const send = vi.fn(async () => FUNDING_TXID);
        const wallet = walletFor([first, second], send);
        const derived = offer("asset");

        const result = await fundOffer(wallet, "https://ark.example/", {
            repository,
            offerHex: derived.offerHex,
            deposit: { assetId: ASSET_ID, amount: 500n },
            id: "operation-asset",
        });

        expect(send).toHaveBeenCalledWith(
            expect.objectContaining({
                recipients: [
                    expect.objectContaining({
                        address: derived.address,
                        amount: 330,
                        assets: [{ assetId: ASSET_ID, amount: 500n }],
                    }),
                ],
                selectedVtxos: [first, second],
            }),
        );
        expect(result).toMatchObject({
            fromAsset: ASSET_ID,
            toAsset: "btc",
            fromAmount: "500",
            toAmount: "21000",
            fundingIntent: {
                output: {
                    value: "330",
                    assetId: ASSET_ID,
                    assetAmount: "500",
                },
            },
        });
    });

    it("rejects maker, operator, and wallet-network mismatches before selection or send", async () => {
        const derived = offer();
        const repository = new InMemoryAssetSwapRepository();
        const badMaker = walletFor([coin("11", 20_000)]);
        badMaker.identity.xOnlyPublicKey = vi.fn(async () => hex.decode("44".repeat(32)));
        await expect(
            fundOffer(badMaker, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
            }),
        ).rejects.toThrow(/maker.*wallet/i);

        state.signerPubkey = `02${EMULATOR_KEY_HEX}`;
        const walletOutputKey = ArkAddress.decode(MAKER_ADDRESS).vtxoTaprootKey;
        const rotatedAddress = new ArkAddress(EMULATOR_KEY, walletOutputKey, "tark").encode();
        const wrongOperator = walletFor(
            [coin("11", 20_000)],
            vi.fn(async () => FUNDING_TXID),
            rotatedAddress,
        );
        await expect(
            fundOffer(wrongOperator, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
            }),
        ).rejects.toThrow(/covenant.*operator/i);

        state.signerPubkey = `02${SERVER_KEY_HEX}`;
        const wrongNetwork = walletFor(
            [coin("11", 20_000)],
            vi.fn(async () => FUNDING_TXID),
            MAKER_ADDRESS.replace(/^tark/, "ark"),
        );
        await expect(
            fundOffer(wrongNetwork, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
            }),
        ).rejects.toThrow(/wallet.*network/i);
        expect(wrongNetwork.getSpendableVtxos).not.toHaveBeenCalled();
        expect(wrongNetwork.send).not.toHaveBeenCalled();
    });

    it("refuses unknown, mixed-domain, and too-short expiries under a floor", async () => {
        const derived = offer();
        const cases = [
            coin("11", 20_000, undefined, { kind: "time", value: 0 }),
            coin("22", 20_000, undefined, { kind: "height", value: 900_000 }),
            coin("33", 20_000, undefined, { kind: "time", value: NOW + 30 }),
        ];
        delete (cases[0] as { expiresAt?: Date }).expiresAt;

        for (const candidate of cases) {
            const wallet = walletFor([candidate]);
            await expect(
                fundOffer(wallet, "https://ark.example/", {
                    repository: new InMemoryAssetSwapRepository(),
                    offerHex: derived.offerHex,
                    deposit: { amount: 10_000n },
                    inputExpiryFloor: { kind: "time", value: BigInt(NOW + 60) },
                }),
            ).rejects.toThrow(/expiry floor/i);
            expect(wallet.send).not.toHaveBeenCalled();
        }
    });

    it("checks the deadline again after asynchronous decoration and inserts nothing", async () => {
        let clock = NOW;
        vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
        const repository = new InMemoryAssetSwapRepository();
        const wallet = walletFor([coin("11", 20_000)]);
        const derived = offer();

        await expect(
            fundOffer(wallet, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
                validUntil: NOW + 1,
                prepareNew: async (draft) => {
                    clock = NOW + 1;
                    return { ...draft, quote: { label: "kept only if inserted" } };
                },
            }),
        ).rejects.toThrow(/deadline/i);
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(wallet.send).not.toHaveBeenCalled();
    });

    it("rejects decoration that changes authority while allowing detached display extras", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const wallet = walletFor([coin("11", 20_000)]);
        const derived = offer();

        await expect(
            fundOffer(wallet, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
                prepareNew: (draft) => ({
                    ...draft,
                    fromAmount: "10001",
                    quote: { label: "display" },
                }),
            }),
        ).rejects.toThrow(/prepareNew.*fromAmount/i);
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(wallet.send).not.toHaveBeenCalled();
    });

    it("returns an existing same-id operation without selecting or sending again", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const derived = offer();
        const firstWallet = walletFor([coin("11", 20_000)]);
        const first = await fundOffer(firstWallet, "https://ark.example/", {
            repository,
            offerHex: derived.offerHex,
            deposit: { amount: 10_000n },
            id: "same-operation",
        });
        const retryWallet = walletFor([]);

        await expect(
            fundOffer(retryWallet, "https://ark.example/", {
                repository,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
                id: "same-operation",
            }),
        ).resolves.toEqual(first);
        expect(retryWallet.getSpendableVtxos).not.toHaveBeenCalled();
        expect(retryWallet.send).not.toHaveBeenCalled();
    });

    it("does not send when insertion or the prepared-to-submitted CAS fails", async () => {
        const derived = offer();
        for (const fail of ["insert", "cas"] as const) {
            const repository = new InMemoryAssetSwapRepository();
            const wallet = walletFor([coin("11", 20_000)]);
            if (fail === "insert") {
                vi.spyOn(repository, "insertPreparedSwap").mockResolvedValue(false);
            } else {
                vi.spyOn(repository, "advanceFundingState").mockResolvedValue(false);
            }
            await expect(
                fundOffer(wallet, "https://ark.example/", {
                    repository,
                    offerHex: derived.offerHex,
                    deposit: { amount: 10_000n },
                }),
            ).rejects.toThrow(/funding (reservation|state)/i);
            expect(wallet.send).not.toHaveBeenCalled();
        }
    });

    it("keeps submitted state and reports the operation id when send outcome is unknown", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const wallet = walletFor(
            [coin("11", 20_000)],
            vi.fn(async () => {
                throw new Error("response lost");
            }),
        );
        const derived = offer();

        const error = await fundOffer(wallet, "https://ark.example/", {
            repository,
            offerHex: derived.offerHex,
            deposit: { amount: 10_000n },
            id: "unknown-operation",
        }).catch((value) => value);

        expect(error).toBeInstanceOf(FundingOutcomeUnknownError);
        expect(error).toMatchObject({ operationId: "unknown-operation" });
        expect(await repository.getSwap("unknown-operation")).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
    });

    it("keeps submitted state and the canonical txid when durable bind fails", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const advance = repository.advanceFundingState.bind(repository);
        vi.spyOn(repository, "advanceFundingState").mockImplementation(
            async (id, expected, next) => {
                if (next.state === "bound") throw new Error("disk full");
                return advance(id, expected, next);
            },
        );
        const wallet = walletFor([coin("11", 20_000)]);
        const derived = offer();

        const error = await fundOffer(wallet, "https://ark.example/", {
            repository,
            offerHex: derived.offerHex,
            deposit: { amount: 10_000n },
            id: "bind-operation",
        }).catch((value) => value);

        expect(error).toBeInstanceOf(FundingOutcomeUnknownError);
        expect(error).toMatchObject({
            operationId: "bind-operation",
            fundingTxid: FUNDING_TXID,
        });
        expect(await repository.getSwap("bind-operation")).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
    });

    it("allows only one overlapping helper to send across repository connections", async () => {
        const name = `fund-offer-${Math.random()}`;
        await using first = new IndexedDbAssetSwapRepository(name);
        await using second = new IndexedDbAssetSwapRepository(name);
        const selected = coin("11", 20_000);
        const send = vi.fn(async () => FUNDING_TXID);
        const wallet = walletFor([selected], send);
        const derived = offer();

        const results = await Promise.allSettled([
            fundOffer(wallet, "https://ark.example/", {
                repository: first,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
                id: "race-a",
            }),
            fundOffer(wallet, "https://ark.example/", {
                repository: second,
                offerHex: derived.offerHex,
                deposit: { amount: 10_000n },
                id: "race-b",
            }),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(1);
    });
});
