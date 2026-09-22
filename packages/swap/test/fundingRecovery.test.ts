import { beforeEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, Extension, Transaction, UnknownPacket, type IWallet } from "@arkade-os/sdk";
import { encodeOffer, OFFER_PACKET_TYPE, offerVtxoScript, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { restoreAssetSwapRepository } from "../src/restoreRepository";
import type { RestoreIndexer, Tx } from "../src/restore";
import type { AssetSwap, FundingIntentInput } from "../src/store";

const mocks = vi.hoisted(() => ({ restoreOfferCoverage: vi.fn(async () => {}) }));

vi.mock("../src/offer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/offer")>()),
    restoreOfferCoverage: mocks.restoreOfferCoverage,
}));

const key = (byte: string) => schnorr.getPublicKey(hex.decode(byte.repeat(32)));
const SERVER_KEY = key("11");
const MAKER_KEY = key("22");
const EMULATOR_KEY = key("33");
const OUTPUT_KEY = key("44");
const OUTPUT_SCRIPT = new Uint8Array([0x51, 0x20, ...OUTPUT_KEY]);
const ASSET_ID = `${"aa".repeat(32)}0000`;

const binding: Omit<Offer, "swapPkScript"> = {
    wantAmount: 992n,
    wantAsset: asset.AssetId.fromString(ASSET_ID),
    makerPkScript: OUTPUT_SCRIPT,
    makerPublicKey: MAKER_KEY,
    emulatorPubkey: EMULATOR_KEY,
};
const OFFER = { ...binding, swapPkScript: offerVtxoScript(binding, SERVER_KEY).pkScript };
const OFFER_HEX = hex.encode(encodeOffer(OFFER));
const SCRIPT = hex.encode(OFFER.swapPkScript);

const source = (byte: string, vout = 0): FundingIntentInput => ({
    txid: byte.repeat(32),
    vout,
});

const prepared = (
    id: string,
    inputs: FundingIntentInput[],
    state: "prepared" | "submitted" = "submitted",
    assetDeposit = false,
): AssetSwap => ({
    id,
    fromAsset: assetDeposit ? ASSET_ID : "btc",
    toAsset: ASSET_ID,
    fromAmount: assetDeposit ? "500" : "10000",
    toAmount: "992",
    swapAddress: "tark1qprepared",
    swapPkScript: SCRIPT,
    offerHex: OFFER_HEX,
    fundingTxid: "",
    status: "pending",
    createdAt: 1,
    fundingIntent: {
        version: 1,
        state,
        inputs,
        serverPubkey: hex.encode(SERVER_KEY),
        arkServerUrl: "https://ark.example/",
        output: {
            script: SCRIPT,
            value: assetDeposit ? "330" : "10000",
            ...(assetDeposit ? { assetId: ASSET_ID, assetAmount: "500" } : {}),
        },
    },
    quote: { feeBps: 30 },
    carrier: { mode: "purchase", physicalSats: "330" },
});

const tx = (inputs: FundingIntentInput[], outputs: { script: Uint8Array; amount: bigint }[]) => {
    const value = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
    for (const input of inputs) value.addInput({ txid: hex.decode(input.txid), index: input.vout });
    for (const output of outputs) value.addOutput(output);
    return { value, psbt: base64.encode(value.toPSBT()), txid: value.id };
};

const checkpoint = (input: FundingIntentInput, extras: FundingIntentInput[] = []) =>
    tx([input, ...extras], [{ script: OUTPUT_SCRIPT, amount: 10_000n }]);

const finalTx = (
    checkpoints: { txid: string }[],
    overrides: {
        extraInputs?: FundingIntentInput[];
        script?: Uint8Array;
        sats?: bigint;
        offerHex?: string;
        assetAmount?: bigint;
        assetId?: string;
    } = {},
) => {
    const packets = [];
    if (overrides.assetAmount !== undefined) {
        packets.push(
            asset.Packet.create([
                asset.AssetGroup.create(
                    asset.AssetId.fromString(overrides.assetId ?? ASSET_ID),
                    null,
                    [],
                    [asset.AssetOutput.create(0, overrides.assetAmount)],
                    [],
                ),
            ]),
        );
    }
    packets.push(new UnknownPacket(OFFER_PACKET_TYPE, hex.decode(overrides.offerHex ?? OFFER_HEX)));
    const extension = Extension.create(packets).txOut();
    return tx(
        [
            ...checkpoints.map((item) => ({ txid: item.txid, vout: 0 })),
            ...(overrides.extraInputs ?? []),
        ],
        [
            { script: overrides.script ?? OFFER.swapPkScript, amount: overrides.sats ?? 10_000n },
            extension,
        ],
    );
};

type Chain = {
    source: FundingIntentInput;
    checkpoint: ReturnType<typeof checkpoint>;
    final: ReturnType<typeof finalTx>;
};

const chain = (input: FundingIntentInput, finalOverrides = {}): Chain => {
    const checkpointTx = checkpoint(input);
    return {
        source: input,
        checkpoint: checkpointTx,
        final: finalTx([checkpointTx], finalOverrides),
    };
};

const sourceVtxo = (item: Chain, overrides = {}) => ({
    txid: item.source.txid,
    vout: item.source.vout,
    value: 20_000,
    script: "51",
    isSpent: true,
    spentBy: item.checkpoint.txid,
    arkTxId: item.final.txid,
    virtualStatus: { state: "spent" },
    ...overrides,
});

const depositVtxo = (final: { txid: string }, assetDeposit = false) => ({
    txid: final.txid,
    vout: 0,
    value: assetDeposit ? 330 : 10_000,
    script: SCRIPT,
    createdAt: new Date(1_800_000_000_000),
    isSpent: false,
    spentBy: "",
    virtualStatus: { state: "settled" },
    ...(assetDeposit ? { assets: [{ assetId: ASSET_ID, amount: 500n }] } : {}),
});

const indexerFor = (
    chains: Chain[],
    options: {
        sourceRows?: unknown[];
        deposits?: unknown[];
        responses?: Map<string, string>;
    } = {},
): RestoreIndexer => {
    const responses =
        options.responses ??
        new Map(
            chains.flatMap((item) => [
                [item.checkpoint.txid, item.checkpoint.psbt],
                [item.final.txid, item.final.psbt],
            ]),
        );
    return {
        getVirtualTxs: async (ids: string[]) => ({
            txs: ids.map((id) => responses.get(id)).filter((value): value is string => !!value),
        }),
        getVtxos: async (opts) => ({
            vtxos: (opts?.outpoints
                ? (options.sourceRows ?? chains.map((item) => sourceVtxo(item)))
                : (options.deposits ?? chains.map((item) => depositVtxo(item.final)))) as never,
        }),
    } as RestoreIndexer;
};

const wallet = { identity: {} } as IWallet;
const history = (txid: string): Tx => ({
    type: "sent",
    redeemTxid: txid,
    createdAt: 1_800_000_000,
});

const seed = async (repository: InMemoryAssetSwapRepository, swap: AssetSwap) => {
    const state = swap.fundingIntent!.state;
    await repository.insertPreparedSwap({
        ...swap,
        fundingIntent: { ...swap.fundingIntent!, state: "prepared" },
    });
    if (state === "submitted") {
        await repository.advanceFundingState(swap.id, "prepared", { state: "submitted" });
    }
};

const run = (repository: InMemoryAssetSwapRepository, indexer: RestoreIndexer, txs: Tx[] = []) =>
    restoreAssetSwapRepository({
        wallet,
        arkServerUrl: "https://ark.example/",
        indexer,
        repository,
        txs,
        serverPubkey: SERVER_KEY,
    });

beforeEach(() => mocks.restoreOfferCoverage.mockClear());

describe("prepared OFFER funding recovery", () => {
    it("binds identical offers to their distinct exact source chains and preserves extras", async () => {
        const first = chain(source("51"));
        const second = chain(source("52"));
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-a", [first.source], "prepared"));
        await seed(repository, prepared("operation-b", [second.source]));

        const result = await run(repository, indexerFor([first, second]), [
            history(first.final.txid),
            history(second.final.txid),
        ]);

        expect(result.swaps).toHaveLength(2);
        expect(await repository.getSwap("operation-a")).toMatchObject({
            id: "operation-a",
            fundingTxid: first.final.txid,
            fundingIntent: { state: "bound" },
            quote: { feeBps: 30 },
            carrier: { mode: "purchase", physicalSats: "330" },
        });
        expect(await repository.getSwap("operation-b")).toMatchObject({
            id: "operation-b",
            fundingTxid: second.final.txid,
            fundingIntent: { state: "bound" },
        });
        expect(result.changes).toHaveLength(2);
    });

    it("leaves an unrelated same-script deposit to the legacy restore path", async () => {
        const selected = source("61");
        const manualCheckpoint = checkpoint(source("62"));
        const manual = finalTx([manualCheckpoint]);
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-a", [selected]));
        const responses = new Map([
            [manual.txid, manual.psbt],
            [manualCheckpoint.txid, manualCheckpoint.psbt],
        ]);
        const indexer = indexerFor([], {
            sourceRows: [
                {
                    txid: selected.txid,
                    vout: 0,
                    isSpent: false,
                    spentBy: "",
                    virtualStatus: { state: "settled" },
                },
            ],
            deposits: [depositVtxo(manual)],
            responses,
        });

        const result = await run(repository, indexer, [history(manual.txid)]);

        expect(await repository.getSwap("operation-a")).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
        expect(result.swaps.map((swap) => swap.id).sort()).toEqual(
            ["operation-a", manual.txid].sort(),
        );
    });

    it("fails closed on forged, incomplete, additional, or wrong final evidence", async () => {
        const selected = source("71");
        const exact = chain(selected);
        const wrongSource = source("72");
        const cases: [string, Chain, Map<string, string> | undefined][] = [
            [
                "checkpoint spends another source",
                { ...exact, checkpoint: checkpoint(wrongSource) },
                undefined,
            ],
            [
                "checkpoint has an additional input",
                { ...exact, checkpoint: checkpoint(selected, [wrongSource]) },
                undefined,
            ],
            [
                "final has an additional checkpoint",
                chain(selected, { extraInputs: [wrongSource] }),
                undefined,
            ],
            ["final pays the wrong script", chain(selected, { script: OUTPUT_SCRIPT }), undefined],
            ["final pays the wrong sats", chain(selected, { sats: 9_999n }), undefined],
            ["final carries the wrong offer", chain(selected, { offerHex: "01" }), undefined],
            [
                "provider labels a different final transaction",
                exact,
                new Map([
                    [exact.checkpoint.txid, exact.checkpoint.psbt],
                    [exact.final.txid, finalTx([exact.checkpoint], { sats: 9_999n }).psbt],
                ]),
            ],
        ];

        for (const [, evidence, responses] of cases) {
            const repository = new InMemoryAssetSwapRepository();
            await seed(repository, prepared("operation-a", [selected]));
            await run(repository, indexerFor([evidence], { responses }));
            expect(await repository.getSwap("operation-a")).toMatchObject({
                fundingTxid: "",
                fundingIntent: { state: "submitted" },
            });
        }
    });

    it("requires the exact intended asset packet", async () => {
        const selected = source("81");
        const checkpointTx = checkpoint(selected);
        const wrong = finalTx([checkpointTx], { sats: 330n, assetAmount: 499n });
        const evidence = { source: selected, checkpoint: checkpointTx, final: wrong };
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-asset", [selected], "submitted", true));

        await run(repository, indexerFor([evidence], { deposits: [depositVtxo(wrong, true)] }));

        expect(await repository.getSwap("operation-asset")).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
    });

    it("leaves duplicate pending reservations for the same exact inputs ambiguous", async () => {
        const evidence = chain(source("89"));
        const repository = new InMemoryAssetSwapRepository();
        const first = prepared("operation-a", [evidence.source]);
        const duplicate = prepared("operation-b", [evidence.source]);
        await seed(repository, first);
        vi.spyOn(repository, "getAllSwaps").mockResolvedValue([first, duplicate]);

        await run(repository, indexerFor([evidence]));

        expect(await repository.getSwap("operation-a")).toMatchObject({
            fundingTxid: "",
            fundingIntent: { state: "submitted" },
        });
    });

    it("does not route a duplicated source response through legacy restore", async () => {
        const evidence = chain(source("8a"));
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-a", [evidence.source]));
        const row = sourceVtxo(evidence);

        const result = await run(repository, indexerFor([evidence], { sourceRows: [row, row] }), [
            history(evidence.final.txid),
        ]);

        expect((await repository.getSwap("operation-a"))?.fundingTxid).toBe("");
        expect(result.swaps.map((swap) => swap.id)).toEqual(["operation-a"]);
        expect(result.scannedTxids).toEqual([]);
    });

    it("surfaces an indexer read failure instead of reporting no candidates", async () => {
        for (const failing of ["getVtxos", "getVirtualTxs"] as const) {
            const evidence = chain(source("9b"));
            const repository = new InMemoryAssetSwapRepository();
            await seed(repository, prepared("operation-a", [evidence.source]));
            const unavailable = new Error(`${failing} unavailable`);
            const answers = indexerFor([evidence]);
            const indexer: RestoreIndexer = {
                getVirtualTxs: async (ids) => {
                    if (failing === "getVirtualTxs") throw unavailable;
                    return answers.getVirtualTxs(ids);
                },
                getVtxos: async (opts) => {
                    if (failing === "getVtxos" && opts?.outpoints) throw unavailable;
                    return answers.getVtxos(opts);
                },
            } as RestoreIndexer;

            await expect(run(repository, indexer, [history(evidence.final.txid)])).rejects.toBe(
                unavailable,
            );
            expect((await repository.getAllSwaps()).map((swap) => swap.id)).toEqual([
                "operation-a",
            ]);
        }
    });

    it("preserves both causes when coverage also fails after a failed recovery read", async () => {
        const evidence = chain(source("9c"));
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-a", [evidence.source]));
        const unavailable = new Error("getVtxos unavailable");
        const uncovered = new Error("coverage unavailable");
        mocks.restoreOfferCoverage.mockRejectedValueOnce(uncovered);
        const answers = indexerFor([evidence]);
        const indexer = {
            getVirtualTxs: answers.getVirtualTxs,
            getVtxos: async (opts: Parameters<RestoreIndexer["getVtxos"]>[0]) => {
                if (opts?.outpoints) throw unavailable;
                return answers.getVtxos(opts);
            },
        } as RestoreIndexer;

        const failure = await run(repository, indexer).catch((value) => value);

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([unavailable, uncovered]);
        expect(mocks.restoreOfferCoverage).toHaveBeenCalledOnce();
    });

    it("retries ambiguous evidence and makes repeated exact observations idempotent", async () => {
        const evidence = chain(source("91"));
        const repository = new InMemoryAssetSwapRepository();
        await seed(repository, prepared("operation-a", [evidence.source]));
        const responses = new Map([[evidence.checkpoint.txid, evidence.checkpoint.psbt]]);
        const indexer = indexerFor([evidence], { responses });

        await run(repository, indexer);
        expect((await repository.getSwap("operation-a"))?.fundingTxid).toBe("");

        responses.set(evidence.final.txid, evidence.final.psbt);
        await run(repository, indexer);
        const bound = await repository.getSwap("operation-a");
        expect(bound).toMatchObject({
            fundingTxid: evidence.final.txid,
            fundingIntent: { state: "bound" },
        });

        await expect(run(repository, indexer)).resolves.toMatchObject({ changes: [] });
        expect(await repository.getSwap("operation-a")).toEqual(bound);
    });
});
