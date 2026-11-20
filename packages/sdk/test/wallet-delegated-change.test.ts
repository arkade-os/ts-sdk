import { describe, it, expect, vi, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultVtxo,
    ExecutorContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    SingleKey,
    TxType,
    Wallet,
    type ExecutorProvider,
    type ExtendedVirtualCoin,
} from "../src";
import { saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import { collectVtxos } from "../src/repositories/walletRepository";
import { DELEGATION_REGISTERED_KEY, DELEGATION_STATUS_KEY } from "../src/wallet/executor";
import { createMockExtendedVtxo } from "./contracts/helpers";
import vectors from "./fixtures/executor/vectors.json";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const SERVER_KEY_HEX = vectors.serverPubkey;
const DUST = 1000;
const MAX_FEE = 100;
const ARK_TXID = "ee".repeat(32);
const HOUR = 3_600_000;
const arkInfo = {
    signerPubkey: SERVER_KEY_HEX,
    forfeitPubkey: SERVER_KEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(DUST),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};
const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);
const serverXOnly = hex.decode(SERVER_KEY_HEX).subarray(1);
const bob = new DefaultVtxo.Script({
    pubKey: await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey(),
    serverPubKey: serverXOnly,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
    .address("tark", serverXOnly)
    .encode();

interface RowOptions {
    maxFee?: number;
    server?: string;
    metadata?: Record<string, unknown>;
    /** Compressed; the identity's by default. */
    owner?: Uint8Array;
}

/** The identity's live renewal watch; `maxFee` tells two watches apart. */
async function renewalRow({
    maxFee = MAX_FEE,
    server = SERVER_KEY_HEX,
    metadata = { [DELEGATION_STATUS_KEY]: "active" },
    owner,
}: RowOptions = {}) {
    const params = ExecutorContractHandler.serializeParams({
        template: "renewal",
        owner: owner ?? (await identity.compressedPublicKey()),
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee,
        cosignerPubKey: hex.decode(vectors.cosignerPubkey),
        serverPubKey: hex.decode(server),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = ExecutorContractHandler.createScript(params);
    return {
        script,
        contract: {
            type: "executor",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", serverXOnly).encode(),
            state: "active" as const,
            createdAt: Date.now(),
            metadata,
        },
    };
}
type Row = Awaited<ReturnType<typeof renewalRow>>;

/** A wallet with the given watches stored, whose operator submit succeeds as `ARK_TXID`. */
async function walletWith(...rows: Row[]) {
    mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/info")) return jsonResponse(arkInfo);
        if (url.includes("subscri")) return jsonResponse({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return jsonResponse({ vtxos: [] });
        return jsonResponse([]);
    });
    const contractRepository = new InMemoryContractRepository();
    for (const row of rows) await contractRepository.saveContract(row.contract);
    const walletRepository = new InMemoryWalletRepository();
    const wallet = await Wallet.create({
        identity,
        arkProvider: new RestArkProvider("http://localhost:7070"),
        storage: { walletRepository, contractRepository },
        settlementConfig: false,
        executorProvider: {} as ExecutorProvider,
    });
    const submit = vi
        .spyOn(wallet as any, "_buildAndSubmitOffchainTx")
        .mockResolvedValue({ arkTxid: ARK_TXID, signedCheckpointTxs: [] });
    return { wallet, walletRepository, submit };
}

/** A spendable coin at `script`, kept in `address`'s bucket. */
async function seed(
    walletRepository: InMemoryWalletRepository,
    bucket: { script: string; address: string },
    byte: string,
    value = 10_000,
) {
    const coin = createMockExtendedVtxo({
        script: bucket.script,
        txid: byte.repeat(32),
        value,
        isPreconfirmed: true,
        commitmentTxIds: ["cc".repeat(32)],
        expiresAt: new Date(Date.now() + 100 * HOUR),
    });
    await saveVtxosForContract(walletRepository, bucket, [coin]);
    return coin;
}

async function ownBucket(wallet: Wallet) {
    return { script: wallet.defaultContractScript, address: await wallet.getAddress() };
}

/** Sends `amount` to bob from `inputs`; what the operator was asked for and what was stored. */
async function sendTo(
    { wallet, walletRepository, submit }: Awaited<ReturnType<typeof walletWith>>,
    inputs: ExtendedVirtualCoin[],
    amount: number,
) {
    await wallet.send({ recipients: [{ address: bob, amount }], selectedVtxos: inputs });
    const [, outputs] = submit.mock.calls[0] as [unknown, { script: Uint8Array }[]];
    const changeOutput = hex.encode(outputs[1].script);
    const stored = async (address: string) =>
        (await collectVtxos(walletRepository, address)).filter((v) => v.txid === ARK_TXID);
    return { changeOutput, stored };
}

describe("a send's change from a delegated coin", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("goes to the renewal contract the coin sat at", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa");

        const { changeOutput, stored } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(row.contract.script);
        const [change] = await stored(row.contract.address);
        expect(change).toMatchObject({ vout: 1, value: 6_000, script: row.contract.script });
        expect(hex.encode(change.tapTree)).toBe(hex.encode(row.script.encode()));
        expect(await stored(await fx.wallet.getAddress())).toHaveLength(0);
        await fx.wallet.dispose();
    });

    it.each([
        // other not-live cases are delegatedContracts', covered in vtxo-manager-delegated
        ["is local", { metadata: { [DELEGATION_STATUS_KEY]: "local" } }],
        ["is under another signer", { server: vectors.cosignerPubkey }],
    ])("stays at the own address when the watch %s", async (_, options: RowOptions) => {
        const row = await renewalRow(options);
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa");

        const { changeOutput, stored } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(fx.wallet.defaultContractScript);
        expect(await stored(await fx.wallet.getAddress())).toHaveLength(1);
        expect(await stored(row.contract.address)).toHaveLength(0);
        await fx.wallet.dispose();
    });

    it("stays at the own address when no input is delegated", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, await ownBucket(fx.wallet), "aa");

        const { changeOutput } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(fx.wallet.defaultContractScript);
        await fx.wallet.dispose();
    });

    it("stays at the own address when the change is at most maxFee + dust", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa", 5_000);

        const { changeOutput } = await sendTo(fx, [input], 5_000 - (MAX_FEE + DUST));

        expect(changeOutput).toBe(fx.wallet.defaultContractScript);
        await fx.wallet.dispose();
    });

    it("stays at the own address, with a warning, when the watches cannot be read", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa");
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(fx.wallet as any, "delegatedExecutorContracts").mockRejectedValue(
            new Error("repository down"),
        );

        const { changeOutput } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(fx.wallet.defaultContractScript);
        expect(warn).toHaveBeenCalledWith(
            "Unable to inspect Executor renewal watches",
            expect.any(Error),
        );
        await fx.wallet.dispose();
    });

    it("goes to the first input's contract when the inputs sit at two", async () => {
        const first = await renewalRow({ maxFee: 100 });
        const second = await renewalRow({ maxFee: 200 });
        const fx = await walletWith(first, second);
        const a = await seed(fx.walletRepository, second.contract, "aa");
        const b = await seed(fx.walletRepository, first.contract, "bb");

        const { changeOutput } = await sendTo(fx, [a, b], 15_000);

        expect(changeOutput).toBe(second.contract.script);
        await fx.wallet.dispose();
    });

    it("goes to the contract when only one of the inputs is delegated", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const own = await seed(fx.walletRepository, await ownBucket(fx.wallet), "aa");
        const delegated = await seed(fx.walletRepository, row.contract, "bb");

        const { changeOutput } = await sendTo(fx, [own, delegated], 15_000);

        expect(changeOutput).toBe(row.contract.script);
        await fx.wallet.dispose();
    });

    it("shows the recipient's amount as sent, with no receive for the change", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa");

        await sendTo(fx, [input], 4_000);

        const history = await fx.wallet.getTransactionHistory();
        expect(history.filter((tx) => tx.type === TxType.TxSent)).toMatchObject([
            { key: { arkTxid: ARK_TXID }, amount: 4_000 },
        ]);
        expect(
            history.some((tx) => tx.key.arkTxid === ARK_TXID && tx.type === TxType.TxReceived),
        ).toBe(false);
        await fx.wallet.dispose();
    });
});

describe("the wallet's own renewals", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const active = (registeredAt: number) => ({
        [DELEGATION_STATUS_KEY]: "active",
        [DELEGATION_REGISTERED_KEY]: registeredAt,
    });

    it("pay into the live renewal contract", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);

        expect(await wallet.renewalAddress(10_000n)).toBe(row.contract.address);
        await wallet.dispose();
    });

    it("pay to the own address when no renewal watch is live", async () => {
        const local = await renewalRow({ metadata: { [DELEGATION_STATUS_KEY]: "local" } });
        const { wallet } = await walletWith(local);

        expect(await wallet.renewalAddress(10_000n)).toBe(await wallet.getAddress());
        await wallet.dispose();
    });

    it("pay to the own address for maxFee + dust or less", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);
        const floor = BigInt(MAX_FEE + DUST);

        expect(await wallet.renewalAddress(floor)).toBe(await wallet.getAddress());
        expect(await wallet.renewalAddress(floor + 1n)).toBe(row.contract.address);
        await wallet.dispose();
    });

    it("pay into the most recently registered watch", async () => {
        const older = await renewalRow({ metadata: active(1) });
        const newer = await renewalRow({ maxFee: 200, metadata: active(2) });
        const { wallet } = await walletWith(older, newer);

        expect(await wallet.renewalAddress(10_000n)).toBe(newer.contract.address);
        await wallet.dispose();
    });

    it("prefer a contract the displayed boarding key does not own, which would rotate it", async () => {
        const rotatedKey = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";
        const displayed = await renewalRow({ metadata: active(2) });
        const rotated = await renewalRow({
            owner: hex.decode(`02${rotatedKey}`),
            metadata: { ...active(1), signingDescriptor: `tr(${rotatedKey})` },
        });
        const { wallet } = await walletWith(displayed, rotated);

        expect(await wallet.renewalAddress(10_000n)).toBe(rotated.contract.address);
        await wallet.dispose();
    });

    it("pay to the own address, with a warning, when the watches cannot be read", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(wallet as any, "delegatedExecutorContracts").mockRejectedValue(
            new Error("repository down"),
        );

        expect(await wallet.renewalAddress(10_000n)).toBe(await wallet.getAddress());
        expect(warn).toHaveBeenCalledWith(
            "Unable to inspect Executor renewal watches",
            expect.any(Error),
        );
        await wallet.dispose();
    });
});
