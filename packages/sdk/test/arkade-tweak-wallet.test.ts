import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    arkade,
    ArkadeContractHandler,
    ArkadeTweak,
    ContractManager,
    getArkPsbtFields,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    ProviderUnavailableError,
    SingleKey,
    Wallet,
    type Contract,
    type ExtendedVirtualCoin,
    type IndexerProvider,
} from "../src";
import { Transaction } from "../src/utils/transaction";
import { prepareOwnedInput } from "../src/contracts/onchainSpend";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { collectScriptVtxos } from "../src/repositories/walletRepository";
import { deriveContractTapscripts } from "../src/wallet/utils";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { jsonResponse } from "./helpers/response";
import { MockEventSource } from "./mocks/eventSource";
import { createMockExtendedVtxo, TEST_PUB_KEY, TEST_SERVER_PUB_KEY } from "./contracts/helpers";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const ARK_INFO = {
    signerPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    forfeitPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 144n,
    roundInterval: 144n,
    network: "mutinynet",
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};

const EMULATOR_KEY = hex.decode("f8352deebdf5658d95875d89656112b1dd150f176c702eea4f91a91527e48e26");
const RECEIVER = hex.decode("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
const AMOUNT = 9_000n;
const VALUE = 10_000;

const payTo = [
    "DUP",
    "INSPECTOUTPUTSCRIPTPUBKEY",
    1,
    "EQUALVERIFY",
    "$receiver",
    "EQUALVERIFY",
    "INSPECTOUTPUTVALUE",
    "$amount",
    "EQUAL",
] as arkade.AsmToken[];

const args = {
    receiver: RECEIVER,
    amount: AMOUNT,
    server: TEST_SERVER_PUB_KEY,
    user: TEST_PUB_KEY,
};
const PAY_HASH = arkade.arkadeScriptHash(arkade.resolveAsm(payTo, args));

const params = [
    { name: "receiver", type: "pubkey" },
    { name: "amount", type: "int" },
    { name: "server", type: "pubkey" },
    { name: "user", type: "pubkey" },
] as const;

/** `pay` names the server only tweaked by its own covenant, so a `collab` spend must reveal it. */
const tweakOnly = {
    version: 1,
    params,
    functions: {
        collab: { tapscript: { signers: ["$user", "$server"] } },
        pay: {
            tapscript: { signers: [{ tweak: "$server", fn: "pay" }], emulator: null },
            arkadeScript: { asm: payTo },
        },
    },
} as unknown as arkade.Program;

const plainServer = {
    version: 1,
    params,
    functions: {
        collab: { tapscript: { signers: ["$user", "$server"] } },
        pay: { tapscript: { signers: ["$server"] }, arkadeScript: { asm: payTo } },
    },
} as unknown as arkade.Program;

function contractFor(program: arkade.Program): Contract {
    const serialized = ArkadeContractHandler.serializeParams({
        program,
        args,
        serverKey: TEST_SERVER_PUB_KEY,
        userKey: TEST_PUB_KEY,
        emulatorKey: EMULATOR_KEY,
    });
    const script = ArkadeContractHandler.createScript(serialized);
    return {
        type: "arkade",
        params: serialized,
        script: hex.encode(script.pkScript),
        address: script.address(networks.mutinynet.hrp, TEST_SERVER_PUB_KEY).encode(),
        state: "active",
        createdAt: 1,
        metadata: { genericallySpendable: true },
    };
}

// Offline: the repository rows stand in for a sync, as in spendability-gate.test.ts.
const offlineIndexer = () =>
    ({
        getVtxos: async () => {
            throw new ProviderUnavailableError("operator down");
        },
        subscribeForScripts: async () => "sub-1",
        unsubscribeForScripts: async () => undefined,
        getSubscription: async function* () {},
    }) as unknown as IndexerProvider;

async function seededWallet(program: arkade.Program) {
    mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/info")) return jsonResponse(ARK_INFO);
        if (url.includes("subscri")) return jsonResponse({ subscriptionId: "sub-1" });
        return jsonResponse([]);
    });
    vi.stubGlobal("EventSource", MockEventSource);

    const contract = contractFor(program);
    const walletRepository = new InMemoryWalletRepository();
    const contractRepository = new InMemoryContractRepository();
    await contractRepository.saveContract(contract);
    const vtxoScript = ArkadeContractHandler.createScript(contract.params);
    await walletRepository.saveVtxos(contract.address, [
        createMockExtendedVtxo({
            txid: "cd".repeat(32),
            vout: 0,
            value: VALUE,
            script: contract.script,
            ...deriveContractTapscripts(contract),
        }),
    ]);

    const wallet = await Wallet.create({
        // Key 1: its x-only pubkey is TEST_PUB_KEY, the program's `$user`, so the
        // router can actually sign the contract's collaborative leaf.
        identity: SingleKey.fromHex("00".repeat(31) + "01"),
        indexerProvider: offlineIndexer(),
        storage: { walletRepository, contractRepository },
        oneShotSubmit: false,
    });
    return { wallet, contract, vtxoScript };
}

const coinOf = async (wallet: Wallet, contract: Contract): Promise<ExtendedVirtualCoin> => {
    const [coin] = (await wallet.getVtxos()).filter((v) => v.script === contract.script);
    expect(coin).toBeDefined();
    return coin;
};

const output = { script: new Uint8Array([0x51, 0x20, ...RECEIVER]), amount: BigInt(VALUE - 500) };

describe("arkadetweak on wallet-level spends", () => {
    it("annotation carries the contract's arkade tweaks", () => {
        expect(deriveContractTapscripts(contractFor(tweakOnly)).arkadeTweaks).toEqual([PAY_HASH]);
        expect(deriveContractTapscripts(contractFor(plainServer)).arkadeTweaks).toBeUndefined();
    });

    it("stamps the tweaks onto the coins read back for spending", async () => {
        const { wallet, contract } = await seededWallet(tweakOnly);
        expect((await coinOf(wallet, contract)).arkadeTweaks).toEqual([PAY_HASH]);
    });

    it("re-derives the tweaks a column-mapped repository cannot store", async () => {
        const contract = contractFor(tweakOnly);
        const walletRepository = new SQLiteWalletRepository(createNodeSQLExecutor());
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract(contract);
        await walletRepository.saveVtxos(contract.address, [
            createMockExtendedVtxo({
                txid: "ab".repeat(32),
                vout: 0,
                value: VALUE,
                script: contract.script,
                ...deriveContractTapscripts(contract),
            }),
        ]);

        const [row] = await collectScriptVtxos(walletRepository, contract.script);
        expect(row.arkadeTweaks).toBeUndefined();

        const manager = await ContractManager.create({
            indexerProvider: offlineIndexer(),
            contractRepository,
            walletRepository,
        });
        const [{ vtxos }] = await manager.getStoredContractsWithVtxos();
        expect(vtxos[0].arkadeTweaks).toEqual([PAY_HASH]);
        await manager.dispose();
    });

    it("sets ArkadeTweak on the ark tx input of an offchain send, never on its checkpoint", async () => {
        const { wallet, contract } = await seededWallet(tweakOnly);
        const submit = vi
            .spyOn(wallet.arkProvider, "submitTx")
            .mockRejectedValue(new Error("captured"));

        await expect(
            wallet.buildAndSubmitOffchainTx([await coinOf(wallet, contract)], [output]),
        ).rejects.toThrow("captured");

        const [arkTxB64, checkpointsB64] = submit.mock.calls[0] as [string, string[]];
        const arkTx = Transaction.fromPSBT(base64.decode(arkTxB64));
        expect(getArkPsbtFields(arkTx, 0, ArkadeTweak)).toEqual([[PAY_HASH]]);
        const checkpoint = Transaction.fromPSBT(base64.decode(checkpointsB64[0]));
        expect(getArkPsbtFields(checkpoint, 0, ArkadeTweak)).toEqual([]);
    });

    it("adds no field to an offchain send of a coin whose leaves all name the plain server", async () => {
        const { wallet, contract } = await seededWallet(plainServer);
        const submit = vi
            .spyOn(wallet.arkProvider, "submitTx")
            .mockRejectedValue(new Error("captured"));

        await expect(
            wallet.buildAndSubmitOffchainTx([await coinOf(wallet, contract)], [output]),
        ).rejects.toThrow("captured");

        const arkTx = Transaction.fromPSBT(base64.decode(submit.mock.calls[0][0] as string));
        expect(getArkPsbtFields(arkTx, 0, ArkadeTweak)).toEqual([]);
    });

    it("sets ArkadeTweak on the intent proof input the coin lands on", async () => {
        const { wallet, contract } = await seededWallet(tweakOnly);
        const intent = await wallet.makeRegisterIntentSignature(
            [await coinOf(wallet, contract)],
            [output],
            [],
            [],
        );
        const proof = Transaction.fromPSBT(base64.decode(intent.proof));
        expect(getArkPsbtFields(proof, 1, ArkadeTweak)).toEqual([[PAY_HASH]]);
        expect(getArkPsbtFields(proof, 0, ArkadeTweak)).toEqual([]);
    });

    it("sets ArkadeTweak on the onchain input the handler's path selects", () => {
        const contract = contractFor(tweakOnly);
        const script = ArkadeContractHandler.createScript(contract.params);
        const path = ArkadeContractHandler.selectPath(script, contract, {
            collaborative: true,
            currentTime: Date.now(),
        })!;
        expect(path.arkadeTweaks).toEqual([PAY_HASH]);

        const tx = new Transaction({ version: 2, allowUnknown: true, allowUnknownInputs: true });
        tx.addInput({ txid: hex.decode("ef".repeat(32)), index: 0 });
        prepareOwnedInput(tx, {
            index: 0,
            coin: { value: VALUE, script: contract.script },
            path,
            tapTree: script.encode(),
        });
        expect(getArkPsbtFields(tx, 0, ArkadeTweak)).toEqual([[PAY_HASH]]);
    });

    it("adds no onchain field when every leaf names the plain server", () => {
        const contract = contractFor(plainServer);
        const script = ArkadeContractHandler.createScript(contract.params);
        const path = ArkadeContractHandler.selectPath(script, contract, {
            collaborative: true,
            currentTime: Date.now(),
        })!;
        expect(path.arkadeTweaks).toBeUndefined();

        const tx = new Transaction({ version: 2, allowUnknown: true, allowUnknownInputs: true });
        tx.addInput({ txid: hex.decode("ef".repeat(32)), index: 0 });
        prepareOwnedInput(tx, {
            index: 0,
            coin: { value: VALUE, script: contract.script },
            path,
            tapTree: script.encode(),
        });
        expect(getArkPsbtFields(tx, 0, ArkadeTweak)).toEqual([]);
    });
});
