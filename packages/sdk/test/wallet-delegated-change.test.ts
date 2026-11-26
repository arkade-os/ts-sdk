import { describe, it, expect, vi, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    TxType,
    Wallet,
    type ExecutorProvider,
    type ExtendedVirtualCoin,
} from "../src";
import { collectVtxos } from "../src/repositories/walletRepository";
import { DELEGATION_REGISTERED_KEY, DELEGATION_STATUS_KEY } from "../src/wallet/executor";
import vectors from "./fixtures/executor/vectors.json";
import {
    ARK_TXID,
    DUST,
    MAX_FEE,
    arkInfo,
    bob,
    identity,
    renewalRow,
    seed,
    type Row,
    type RowOptions,
} from "./helpers/delegatedRows";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

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

async function ownBucket(wallet: Wallet) {
    return { script: wallet.defaultContractScript, address: wallet.arkAddress.encode() };
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
        expect(await stored(fx.wallet.arkAddress.encode())).toHaveLength(0);
        await fx.wallet.dispose();
    });

    it.each([
        // other not-live cases are delegatedContracts', covered in vtxo-manager-delegated
        ["is local", { metadata: { [DELEGATION_STATUS_KEY]: "local" } }],
        ["is under another signer", { operatorPubkey: vectors.batchCosignerPubkey }],
    ])("stays at the own address when the watch %s", async (_, options: RowOptions) => {
        const row = await renewalRow(options);
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, row.contract, "aa");

        const { changeOutput, stored } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(fx.wallet.defaultContractScript);
        expect(await stored(fx.wallet.arkAddress.encode())).toHaveLength(1);
        expect(await stored(row.contract.address)).toHaveLength(0);
        await fx.wallet.dispose();
    });

    it("goes to the receive key's twin when no input is delegated", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, await ownBucket(fx.wallet), "aa");

        const { changeOutput, stored } = await sendTo(fx, [input], 4_000);

        expect(changeOutput).toBe(row.contract.script);
        const [change] = await stored(row.contract.address);
        expect(hex.encode(change.tapTree)).toBe(hex.encode(row.script.encode()));
        await fx.wallet.dispose();
    });

    it("stays at the own address when no input is delegated and the change is at most maxFee + dust", async () => {
        const row = await renewalRow();
        const fx = await walletWith(row);
        const input = await seed(fx.walletRepository, await ownBucket(fx.wallet), "aa", 5_000);

        const { changeOutput } = await sendTo(fx, [input], 5_000 - (MAX_FEE + DUST));

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

        expect(await wallet.renewalAddress(10_000n)).toBe(wallet.arkAddress.encode());
        await wallet.dispose();
    });

    it("pay to the own address for maxFee + dust or less", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);
        const floor = BigInt(MAX_FEE + DUST);

        expect(await wallet.renewalAddress(floor)).toBe(wallet.arkAddress.encode());
        expect(await wallet.renewalAddress(floor + 1n)).toBe(row.contract.address);
        await wallet.dispose();
    });

    it("pay to the twin of the receive key, not the most recently registered watch", async () => {
        const rotatedKey = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";
        const twin = await renewalRow({ metadata: active(1) });
        const newer = await renewalRow({
            owner: hex.decode(`02${rotatedKey}`),
            metadata: { ...active(2), signingDescriptor: `tr(${rotatedKey})` },
        });
        const { wallet } = await walletWith(twin, newer);

        expect(await wallet.renewalAddress(10_000n)).toBe(twin.contract.address);
        await wallet.dispose();
    });

    it("pay to the own address when an input sits at a live renewal contract", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);

        expect(await wallet.renewalAddress(10_000n, [row.contract.script])).toBe(
            wallet.arkAddress.encode(),
        );
        await wallet.dispose();
    });

    it("pay to the twin when the inputs sit elsewhere", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);

        expect(await wallet.renewalAddress(10_000n, ["51" + "00".repeat(32)])).toBe(
            row.contract.address,
        );
        await wallet.dispose();
    });

    it("pay to the twin when an input sits at a contract that is not live", async () => {
        const local = await renewalRow({
            maxFee: 150,
            metadata: { [DELEGATION_STATUS_KEY]: "local" },
        });
        const live = await renewalRow();
        const { wallet } = await walletWith(local, live);

        expect(await wallet.renewalAddress(10_000n, [local.contract.script])).toBe(
            live.contract.address,
        );
        await wallet.dispose();
    });

    it("pay to the own address for an input at a rotated key's live contract", async () => {
        const rotatedKey = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";
        const displayed = await renewalRow({ metadata: active(2) });
        const rotated = await renewalRow({
            owner: hex.decode(`02${rotatedKey}`),
            metadata: { ...active(1), signingDescriptor: `tr(${rotatedKey})` },
        });
        const { wallet } = await walletWith(displayed, rotated);

        expect(await wallet.renewalAddress(10_000n, [rotated.contract.script])).toBe(
            wallet.arkAddress.encode(),
        );
        await wallet.dispose();
    });

    it("pay to the own address, with a warning, when the watches cannot be read", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith(row);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(wallet.contractRepository, "getContractsPage").mockRejectedValue(
            new Error("repository down"),
        );

        expect(await wallet.renewalAddress(10_000n)).toBe(wallet.arkAddress.encode());
        expect(warn).toHaveBeenCalledWith(
            "Unable to inspect Executor renewal watches",
            expect.any(Error),
        );
        await wallet.dispose();
    });
});
