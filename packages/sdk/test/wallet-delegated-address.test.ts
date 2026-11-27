import { describe, it, expect, vi, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    Wallet,
    type ExecutorProvider,
    type ExtendedVirtualCoin,
} from "../src";
import {
    DELEGATION_EXPIRES_KEY,
    DELEGATION_STATUS_KEY,
    ExecutorManagerImpl,
} from "../src/wallet/executor";
import vectors from "./fixtures/executor/vectors.json";
import {
    ARK_TXID,
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

const otherSigner = hex.decode(vectors.batchCosignerPubkey);
const rotatedKey = "2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4";

async function walletWith(rows: Row[], executorProvider: Partial<ExecutorProvider> = {}) {
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
        executorProvider: executorProvider as ExecutorProvider,
    });
    return { wallet, walletRepository, contractRepository };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("getAddress with an Executor watch", () => {
    it("is the twin of the receive key while its renewal watch is live", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith([row]);

        expect(await wallet.getAddress()).toBe(row.contract.address);
        expect(wallet.arkAddress.encode()).not.toBe(row.contract.address);
        await wallet.dispose();
    });

    it("keeps the own address at getOwnAddress() while a twin is live", async () => {
        const row = await renewalRow();
        const { wallet } = await walletWith([row]);

        expect(await wallet.getOwnAddress()).toBe(wallet.arkAddress.encode());
        expect(await wallet.getOwnAddress()).not.toBe(await wallet.getAddress());
        await wallet.dispose();
    });

    it.each<[string, RowOptions]>([
        [
            "expired",
            { metadata: { [DELEGATION_STATUS_KEY]: "active", [DELEGATION_EXPIRES_KEY]: 1 } },
        ],
        ["local", { metadata: { [DELEGATION_STATUS_KEY]: "local" } }],
        ["under another signer", { operatorPubkey: vectors.batchCosignerPubkey }],
        [
            "a boarding key's",
            {
                owner: hex.decode(`02${rotatedKey}`),
                metadata: {
                    [DELEGATION_STATUS_KEY]: "active",
                    signingDescriptor: `tr(${rotatedKey})`,
                },
            },
        ],
    ])("is the own address when the only watch is %s", async (_, options) => {
        const { wallet } = await walletWith([await renewalRow(options)]);

        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        await wallet.dispose();
    });

    it("is the own address, and warns once, for a watch restored without a status", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet } = await walletWith([await renewalRow({ metadata: {}, maxFee: 321 })]);

        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());

        const warned = warn.mock.calls.filter(([m]) => String(m).includes("no delegation status"));
        expect(warned).toHaveLength(1);
        await wallet.dispose();
    });

    it("is the own address without a watch, reading the repository once and nothing else", async () => {
        const { wallet, contractRepository } = await walletWith([]);
        const read = vi.spyOn(contractRepository, "getContractsPage");
        const operatorInfo = vi.spyOn(wallet, "getOperatorInfo");
        const xOnlyPublicKey = vi.spyOn(identity, "xOnlyPublicKey");
        read.mockClear();
        xOnlyPublicKey.mockClear();

        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());

        expect(read).toHaveBeenCalledOnce();
        expect(operatorInfo).not.toHaveBeenCalled();
        expect(xOnlyPublicKey).not.toHaveBeenCalled();
        await wallet.dispose();
    });

    it("reads the rows on every call, so a watch registered elsewhere is followed", async () => {
        const { wallet, contractRepository } = await walletWith([]);
        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());

        const row = await renewalRow();
        await contractRepository.saveContract(row.contract);

        expect(await wallet.getAddress()).toBe(row.contract.address);
        await wallet.dispose();
    });

    it("is the own address, with a warning, when the rows cannot be read", async () => {
        const { wallet, contractRepository } = await walletWith([await renewalRow()]);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(contractRepository, "getContractsPage").mockRejectedValue(new Error("down"));

        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        expect(warn).toHaveBeenCalledWith(
            "Unable to inspect executor renewal watches",
            expect.any(Error),
        );
        await wallet.dispose();
    });

    /** Rotates the operator signer once the wallet has read its Executor rows. */
    function rotateSignerAfterTheRead(wallet: Wallet, repository: InMemoryContractRepository) {
        const read = repository.getContractsPage.bind(repository);
        let rotated = false;
        vi.spyOn(repository, "getContractsPage").mockImplementation(async (...args) => {
            const page = await read(...args);
            if (!rotated && args[0]?.type?.includes("executor")) {
                rotated = true;
                await wallet.rotateServerSigner(otherSigner, arkInfo.checkpointTapscript);
            }
            return page;
        });
        return () => rotated;
    }

    it("never mixes two signers when the operator signer rotates during the read", async () => {
        const row = await renewalRow();
        const { wallet, contractRepository } = await walletWith([row]);
        const rotated = rotateSignerAfterTheRead(wallet, contractRepository);

        const address = await wallet.getAddress();

        // the epoch the call started in: its twin, under its own signer
        expect(rotated()).toBe(true);
        expect(address).toBe(row.contract.address);
        // the new epoch has no watch under its signer: the own address, under the new one
        expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());
        expect(hex.encode(ArkAddress.decode(await wallet.getAddress()).serverPubKey)).toBe(
            hex.encode(otherSigner.subarray(1)),
        );
        await wallet.dispose();
    });

    it("sends the change to the twin of the epoch the send started in when the signer rotates", async () => {
        const row = await renewalRow();
        const { wallet, walletRepository, contractRepository } = await walletWith([row]);
        const input = await seed(
            walletRepository,
            { script: wallet.defaultContractScript, address: wallet.arkAddress.encode() },
            "aa",
        );
        const submit = vi
            .spyOn(wallet as any, "_buildAndSubmitOffchainTx")
            .mockResolvedValue({ arkTxid: ARK_TXID, signedCheckpointTxs: [] });
        const rotated = rotateSignerAfterTheRead(wallet, contractRepository);

        await wallet.send({
            recipients: [{ address: bob, amount: 4_000 }],
            selectedVtxos: [input],
        });

        const [, outputs] = submit.mock.calls[0] as [unknown, { script: Uint8Array }[]];
        expect(rotated()).toBe(true);
        expect(hex.encode(outputs[1].script)).toBe(row.contract.script);
        await wallet.dispose();
    });
});

describe("where the wallet's own outputs go", () => {
    /** Registers an intent for `settle`, stopping there with what it would have asked for. */
    async function registeredOutputs(wallet: Wallet, settle: () => Promise<unknown>) {
        const stop = new Error("stop");
        const register = vi
            .spyOn(wallet as any, "makeRegisterIntentSignature")
            .mockRejectedValue(stop);
        await expect(settle()).rejects.toBe(stop);
        return register.mock.calls[0][1] as { script: Uint8Array; amount: bigint }[];
    }

    it("settle() with no params pays the twin", async () => {
        const row = await renewalRow();
        const { wallet, walletRepository } = await walletWith([row]);
        await seed(
            walletRepository,
            { script: wallet.defaultContractScript, address: wallet.arkAddress.encode() },
            "aa",
        );

        const outputs = await registeredOutputs(wallet, () => wallet.settle());

        expect(hex.encode(outputs[0].script)).toBe(row.contract.script);
        await wallet.dispose();
    });

    it("settle() carries an input's assets to the twin", async () => {
        const row = await renewalRow();
        const { wallet, walletRepository } = await walletWith([row]);
        const input = await seed(
            walletRepository,
            { script: wallet.defaultContractScript, address: wallet.arkAddress.encode() },
            "aa",
        );
        const assets = [{ assetId: "ab".repeat(32) + "0000", amount: 5n }];

        const outputs = await registeredOutputs(wallet, async () =>
            wallet.settle({
                inputs: [{ ...input, assets } as ExtendedVirtualCoin],
                outputs: [{ address: await wallet.getAddress(), amount: BigInt(input.value) }],
            }),
        );

        // the twin's output, then the asset packet that names it
        expect(hex.encode(outputs[0].script)).toBe(row.contract.script);
        expect(outputs).toHaveLength(2);
        await wallet.dispose();
    });

    it("keeps the Executor manager reading the own address while a twin is live", async () => {
        const row = await renewalRow();
        const getInfo = vi.fn(async () => ({
            version: "test",
            network: "mutinynet",
            batchCosignerPubkey: vectors.batchCosignerPubkey,
            operatorPubkey: vectors.operatorPubkey,
            emulatorPubkey: vectors.emulatorPubkey,
        }));
        const { wallet } = await walletWith([row], { getInfo });
        const getAddress = vi.spyOn(wallet, "getAddress");
        const manager = (await wallet.getExecutorManager()) as ExecutorManagerImpl;

        const registration = await manager.registerRenewal(
            { renewalWindow: 1000, maxFee: 100, exitDelay: 144 },
            { emulatorPubkey: vectors.emulatorPubkey },
        );

        expect(registration.address).toBe(row.contract.address);
        expect(getAddress).not.toHaveBeenCalled();
        await wallet.dispose();
    });

    it("leaves a coin stored at a twin spendable and watched once its delegation has ended", async () => {
        const row = await renewalRow({ metadata: { [DELEGATION_STATUS_KEY]: "expired" } });
        const { wallet, walletRepository } = await walletWith([row]);
        const input = await seed(walletRepository, row.contract, "aa");
        const manager = await wallet.getContractManager();

        const watched = await manager.getContracts({ state: "active" });
        const spendable = await wallet.getSpendableVtxos();

        expect(watched.map((c) => c.script)).toContain(row.contract.script);
        expect(spendable.map((v) => `${v.txid}:${v.vout}`)).toContain(
            `${input.txid}:${input.vout}`,
        );
        await wallet.dispose();
    });
});
