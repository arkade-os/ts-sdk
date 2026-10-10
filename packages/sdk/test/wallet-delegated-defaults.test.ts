import { collectContracts } from "../src/repositories/contractRepository";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    DelegateeContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
    networks,
    type DelegateeProvider,
} from "../src";
import { ArkAddress } from "../src/script/address";
import vectors from "./fixtures/delegatee/vectors.json";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", () => ({ fetch: mockFetch, baseFetch: mockFetch }));

const SERVER_KEY_HEX = vectors.serverPubkey;
const arkInfo = {
    signerPubkey: SERVER_KEY_HEX,
    forfeitPubkey: SERVER_KEY_HEX,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};
const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);
// a delegatee is configured; the wallet never calls it for its addresses
const delegateeProvider = {} as DelegateeProvider;

async function delegateeRow(template: "renewal" | "boarding") {
    const params = DelegateeContractHandler.serializeParams({
        template,
        owner: await identity.compressedPublicKey(),
        exitDelay: 144,
        renewalWindow: 1000,
        maxFee: 100,
        ...(template === "boarding" ? { boardingExitDelay: 144 } : {}),
        delegatePubKey: hex.decode(vectors.delegatePubkey),
        serverPubKey: hex.decode(SERVER_KEY_HEX),
        emulatorPubKey: hex.decode(vectors.emulatorPubkey),
    });
    const script = DelegateeContractHandler.createScript(params);
    return {
        script,
        contract: {
            type: "delegatee",
            params,
            script: hex.encode(script.pkScript),
            address: script.address("tark", hex.decode(SERVER_KEY_HEX).subarray(1)).encode(),
            state: "active" as const,
            createdAt: Date.now(),
        },
    };
}

async function walletWith(options: { delegatee: boolean; rows: boolean }) {
    const contractRepository = new InMemoryContractRepository();
    const renewal = await delegateeRow("renewal");
    const boarding = await delegateeRow("boarding");
    if (options.rows) {
        await contractRepository.saveContract(renewal.contract);
        await contractRepository.saveContract(boarding.contract);
    }
    const wallet = await Wallet.create({
        identity,
        arkServerUrl: "http://localhost:7070",
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository },
        settlementConfig: false,
        ...(options.delegatee ? { delegateeProvider } : {}),
    });
    return { wallet, renewal, boarding };
}

// a send to the server's address that leaves change, with the submission stubbed
async function changeOf(wallet: Wallet) {
    const submit = vi
        .spyOn(wallet as never, "_submitOffchainSpend")
        .mockResolvedValue("txid" as never);
    const recipient = new ArkAddress(
        hex.decode(SERVER_KEY_HEX).subarray(1),
        new Uint8Array(32).fill(0xaa),
        "tark",
    ).encode();
    await wallet.send({
        recipients: [{ address: recipient, amount: 2000 }],
        selectedVtxos: [{ txid: "00".repeat(32), vout: 0, value: 10_000 } as never],
    });
    const [, outputs, opts] = submit.mock.calls[0] as unknown as [
        unknown,
        { script: Uint8Array; amount: bigint }[],
        { offchainTapscript: { pkScript: Uint8Array } },
    ];
    return { change: outputs[1], tapscript: opts.offchainTapscript };
}

describe("delegated default addresses", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockFetch.mockImplementation(async () => jsonResponse(arkInfo));
    });

    it("receives, takes change and boards at the delegatee contracts when delegating", async () => {
        const { wallet, renewal, boarding } = await walletWith({ delegatee: true, rows: true });

        expect(await wallet.getAddress()).toBe(renewal.contract.address);
        expect(await wallet.getBoardingAddress()).toBe(
            boarding.script.onchainAddress(networks.mutinynet),
        );
        const { change, tapscript } = await changeOf(wallet);
        expect(change.amount).toBe(8000n);
        expect(hex.encode(change.script)).toBe(renewal.contract.script);
        // the change VTXO is recorded under the same script it is paid to
        expect(hex.encode(tapscript.pkScript)).toBe(renewal.contract.script);
    });

    it("keeps the wallet's own addresses without a delegatee, the rows staying watched", async () => {
        const { wallet, renewal } = await walletWith({ delegatee: false, rows: true });
        const own = wallet.arkAddress.encode();

        expect(await wallet.getAddress()).toBe(own);
        expect(await wallet.getAddress()).not.toBe(renewal.contract.address);
        expect(await wallet.getBoardingAddress()).toBe(
            wallet.boardingTapscript.onchainAddress(networks.mutinynet),
        );
        const { change } = await changeOf(wallet);
        expect(hex.encode(change.script)).toBe(hex.encode(ArkAddress.decode(own).pkScript));
        const [row] = await collectContracts(wallet.contractRepository, {
            script: renewal.contract.script,
        });
        expect(row?.type).toBe("delegatee");
    });

    it("keeps the wallet's own addresses until delegation registers its contracts", async () => {
        const { wallet, renewal } = await walletWith({ delegatee: true, rows: false });
        const own = await wallet.getAddress();
        expect(own).not.toBe(renewal.contract.address);

        await wallet.contractRepository.saveContract(renewal.contract);
        expect(await wallet.getAddress()).toBe(renewal.contract.address);
    });

    it("reports the funds of its delegatee contracts to incoming-funds subscribers", async () => {
        const { wallet, renewal } = await walletWith({ delegatee: true, rows: true });
        let emit: (event: unknown) => void = () => {};
        vi.spyOn(wallet, "getContractManager").mockResolvedValue({
            onContractEvent: (handler: (event: unknown) => void) => {
                emit = handler;
                return () => {};
            },
            annotateVtxos: async (vtxos: unknown[]) => vtxos,
        } as never);
        vi.spyOn(wallet, "getBoardingAddresses").mockResolvedValue([]);
        const funds = vi.fn();
        const stop = await wallet.notifyIncomingFunds(funds);

        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 5000,
            script: renewal.contract.script,
        };
        emit({
            type: "vtxo_received",
            contractScript: renewal.contract.script,
            contract: renewal.contract,
            vtxos: [vtxo],
            timestamp: 0,
        });
        emit({
            type: "vtxo_received",
            contractScript: "51",
            contract: { ...renewal.contract, type: "vhtlc" },
            vtxos: [vtxo],
            timestamp: 0,
        });
        await vi.waitFor(() => expect(funds).toHaveBeenCalledTimes(1));
        expect(funds).toHaveBeenCalledWith({ type: "vtxo", newVtxos: [vtxo], spentVtxos: [] });
        stop();
    });
});
