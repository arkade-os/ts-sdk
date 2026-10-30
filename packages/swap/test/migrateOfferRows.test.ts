import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    asset,
    type Contract,
    type IndexerProvider,
    type IWallet,
    type RelativeTimelock,
} from "@arkade-os/sdk";
import { migrateV0OfferRows } from "../src/migrateOfferRows";
import { encodeOffer, offerContract, restoreOfferCoverage, type Offer } from "../src/offer";
import type { AssetSwap } from "../src/store";
import wantAssetV0 from "../src/legacy/swap-want-asset.program.v0.json";
import wantBtcV0 from "../src/legacy/swap-want-btc.program.v0.json";
import wantAssetV1 from "../src/swap-want-asset.program.json";
import wantBtcV1 from "../src/swap-want-btc.program.json";
import v0Wallet from "./fixtures/program-v0-offer.json";

const makerKey = hex.decode("3c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1");
const makerAddress =
    "tark1qp8n2k7uklxq4aegau7vawtptkgxsja4kt99lpv6krctwpq8tpc65wq0wnmwgr4nglzx999xqx7xahllp4gfh6638wkrjt5tl3k7c8vy6frzj2";
const SERVER_KEY = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const EMULATOR_KEY = hex.decode("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");

vi.mock("@arkade-os/sdk", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@arkade-os/sdk")>();
    const { hex } = await import("@scure/base");
    const server = "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
    const checkpointTapscript = hex.encode(
        mod.CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [hex.decode(server)],
        }).script,
    );
    return {
        ...mod,
        RestArkProvider: class {
            async getInfo() {
                return {
                    signerPubkey: "02" + server,
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

const indexer = {
    getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
    subscribeForScripts: vi.fn().mockResolvedValue("sub"),
    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
    getSubscription: vi.fn(() => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    })),
} as unknown as IndexerProvider;

const managed = async (rows: Contract[] = []) => {
    const repository = new InMemoryContractRepository();
    for (const row of rows) await repository.saveContract(row);
    const manager = await ContractManager.create({
        indexerProvider: indexer,
        contractRepository: repository,
        walletRepository: new InMemoryWalletRepository(),
    });
    const { RestArkProvider } = await import("@arkade-os/sdk");
    const wallet = {
        identity: { xOnlyPublicKey: async () => makerKey },
        getAddress: async () => makerAddress,
        getContractManager: async () => manager,
        getArkadeInfo: async () => new RestArkProvider("http://ark").getInfo(),
    } as unknown as IWallet;
    return { manager, wallet };
};

const makeOffer = (wantAsset: boolean, exitDelay?: RelativeTimelock): Offer => {
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount: BigInt(50_000),
        ...(wantAsset
            ? { wantAsset: asset.AssetId.fromString("aa".repeat(32) + "0000") }
            : { offerAsset: asset.AssetId.fromString("bb".repeat(32) + "0000") }),
        makerPkScript: ArkAddress.decode(makerAddress).pkScript,
        makerPublicKey: makerKey,
        emulatorPubkey: EMULATOR_KEY,
        ...(exitDelay && { exitDelay }),
    };
    return { ...binding, swapPkScript: offerContract(binding, hex.decode(SERVER_KEY)).pkScript };
};

const record = (offer: Offer): AssetSwap => ({
    id: "ab".repeat(32),
    fromAsset: "btc",
    toAsset: "x",
    fromAmount: "10000",
    toAmount: offer.wantAmount.toString(),
    swapAddress: "",
    swapPkScript: hex.encode(offer.swapPkScript),
    offerHex: hex.encode(encodeOffer(offer)),
    fundingTxid: "ab".repeat(32),
    status: "pending",
    createdAt: 1_700_000_000_000,
});

/** The row the record path writes for `offer`. */
const v1Row = async (offer: Offer): Promise<Contract> => {
    const { manager, wallet } = await managed();
    await restoreOfferCoverage(wallet, [record(offer)]);
    const [row] = await manager.getContracts({ script: hex.encode(offer.swapPkScript) });
    await manager.dispose();
    return row;
};

type ProgramJson = { params: unknown[]; functions: Record<string, unknown> };

/** The program string a pre-v1 release stored. */
const v0Program = (offer: Offer): ProgramJson => {
    const program: ProgramJson = offer.wantAsset ? wantAssetV0 : wantBtcV0;
    if (!offer.exitDelay) return program;
    return {
        ...program,
        params: [...program.params, { name: "exitDelay", type: "int" }],
        functions: {
            ...program.functions,
            exit: {
                tapscript: {
                    signers: ["$user"],
                    csv: { type: offer.exitDelay.type, value: "$exitDelay" },
                },
            },
        },
    };
};

const downgrade = (row: Contract, program: unknown): Contract => ({
    ...row,
    params: { ...row.params, program: JSON.stringify(program) },
    createdAt: 1,
    state: "inactive",
    watch: "retained",
});

const SHAPES: [string, boolean, RelativeTimelock | undefined][] = [
    ["want-btc", false, undefined],
    ["want-btc + blocks exit", false, { type: "blocks", value: BigInt(144) }],
    ["want-btc + seconds exit", false, { type: "seconds", value: BigInt(4096) }],
    ["want-asset", true, undefined],
    ["want-asset + blocks exit", true, { type: "blocks", value: BigInt(144) }],
    ["want-asset + seconds exit", true, { type: "seconds", value: BigInt(4096) }],
];

describe("migrateV0OfferRows", () => {
    it.each(SHAPES)("rewrites a %s row to v1 in place", async (_, wantAsset, exit) => {
        const offer = makeOffer(wantAsset, exit);
        const v1 = await v1Row(offer);
        const v0 = downgrade(v1, v0Program(offer));
        const { manager } = await managed([v0]);
        expect(await manager.getUnsupportedContracts()).toEqual([v0]);

        expect(await migrateV0OfferRows(manager)).toEqual({ migrated: [v1.script], skipped: [] });

        expect(await manager.getContracts({ script: v1.script })).toEqual([
            { ...v1, createdAt: 1, state: "inactive", watch: "retained" },
        ]);
        expect(await manager.getUnsupportedContracts()).toEqual([]);
        await manager.dispose();
    });

    it("writes the program string the record path writes", async () => {
        const offer = makeOffer(true, { type: "seconds", value: BigInt(4096) });
        const v1 = await v1Row(offer);
        const { manager, wallet } = await managed([downgrade(v1, v0Program(offer))]);

        await migrateV0OfferRows(manager);
        const [migrated] = await manager.getContracts({ script: v1.script });
        await restoreOfferCoverage(wallet, [record(offer)]);
        const [rebuilt] = await manager.getContracts({ script: v1.script });

        expect(migrated.params.program).toBe(v1.params.program);
        expect(rebuilt.params).toEqual(migrated.params);
        await manager.dispose();
    });

    it("migrates a cancelled offer exported from a pre-v1 wallet, with no swap record", async () => {
        // its IndexedDB index column, not part of the contract
        const { watchState: _, ...stored } = v0Wallet.contract;
        const row = stored as Contract;
        const { manager } = await managed([row]);

        expect(await migrateV0OfferRows(manager)).toEqual({ migrated: [row.script], skipped: [] });

        const [migrated] = await manager.getContracts({ script: row.script });
        expect(migrated).toEqual({ ...row, params: migrated.params });
        expect(JSON.parse(migrated.params.program).version).toBe(1);
        expect(migrated.params.serverKey).toBe(row.params.serverKey);
        expect(await manager.getUnsupportedContracts()).toEqual([]);
        await manager.dispose();
    });

    const offer = makeOffer(false, { type: "seconds", value: BigInt(4096) });
    const tweak = (edit: (program: any) => void) => {
        const program = structuredClone(v0Program(offer));
        edit(program);
        return program;
    };
    it.each([
        ["a changed asm token", tweak((p) => (p.functions.fulfill.arkadeScript.asm[1] = "SHA256"))],
        ["an extra param", tweak((p) => p.params.push({ name: "extra", type: "int" }))],
        ["exit without exitDelay", tweak((p) => p.params.pop())],
        ["exitDelay without exit", tweak((p) => delete p.functions.exit)],
        [
            "exit with other signers",
            tweak((p) => p.functions.exit.tapscript.signers.push("$server")),
        ],
        [
            "reordered functions",
            tweak((p) => {
                const { fulfill, ...rest } = p.functions;
                p.functions = { ...rest, fulfill };
            }),
        ],
        ["an unknown program name", tweak((p) => (p.name = "other"))],
    ])("leaves a row with %s untouched", async (_, program) => {
        const v0 = downgrade(await v1Row(offer), program);
        const { manager } = await managed([v0]);

        expect(await migrateV0OfferRows(manager)).toEqual({
            migrated: [],
            skipped: [{ script: v0.script, reason: "not a bundled Program v0 offer" }],
        });
        expect(await manager.getContracts({ script: v0.script })).toEqual([v0]);
        await manager.dispose();
    });

    it("leaves a row whose args no longer derive its script untouched", async () => {
        const v1 = await v1Row(offer);
        const args = { ...JSON.parse(v1.params.args), wantAmount: "1" };
        const v0 = downgrade(
            { ...v1, params: { ...v1.params, args: JSON.stringify(args) } },
            v0Program(offer),
        );
        const { manager } = await managed([v0]);

        const { migrated, skipped } = await migrateV0OfferRows(manager);

        expect(migrated).toEqual([]);
        expect(skipped).toEqual([
            { script: v0.script, reason: expect.stringContaining("Script mismatch") },
        ]);
        expect(await manager.getContracts({ script: v0.script })).toEqual([v0]);
        await manager.dispose();
    });

    it("ignores a v0 row that is not an offer", async () => {
        const v1 = await v1Row(offer);
        const { kind: _, ...metadata } = v1.metadata ?? {};
        const v0 = { ...downgrade(v1, v0Program(offer)), metadata };
        const { manager } = await managed([v0]);

        expect(await migrateV0OfferRows(manager)).toEqual({ migrated: [], skipped: [] });
        expect(await manager.getContracts({ script: v0.script })).toEqual([v0]);
        await manager.dispose();
    });

    it("migrates each row independently, and only once", async () => {
        const good = makeOffer(true);
        const goodV1 = await v1Row(good);
        const bad = await v1Row(offer);
        const tampered = downgrade(
            { ...bad, params: { ...bad.params, args: bad.params.args.replace("50000", "1") } },
            v0Program(offer),
        );
        const { manager } = await managed([tampered, downgrade(goodV1, v0Program(good))]);

        const first = await migrateV0OfferRows(manager);
        expect(first.migrated).toEqual([goodV1.script]);
        expect(first.skipped.map((skip) => skip.script)).toEqual([tampered.script]);

        const second = await migrateV0OfferRows(manager);
        expect(second.migrated).toEqual([]);
        expect(second.skipped.map((skip) => skip.script)).toEqual([tampered.script]);
        await manager.dispose();
    });

    // A failure here means a v1 program file changed: the migration's target needs reconsidering.
    it("targets the current program files", () => {
        const patch = (v0: typeof wantAssetV0) => ({
            ...v0,
            version: 1,
            params: v0.params.map((param) =>
                param.type === "hash" ? { ...param, type: "bytes32" } : param,
            ),
        });
        expect(patch(wantBtcV0)).toEqual(wantBtcV1);
        expect(patch(wantAssetV0)).toEqual(wantAssetV1);
    });
});
