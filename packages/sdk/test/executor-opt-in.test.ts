import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultVtxo,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    SingleKey,
    Wallet,
} from "../src";
import { saveVtxosForContract } from "../src/contracts/vtxoOwnership";
import { VtxoManager } from "../src/wallet/vtxo-manager";
import { createMockExtendedVtxo } from "./contracts/helpers";
import { jsonResponse } from "./helpers/response";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (importActual) => ({
    ...(await importActual<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

// Arkade's mutinynet operator: the one whose retired delegator the Executor opt-in discovers.
const ARKADE_SIGNER = "03301078808e4f7bc0dadfe29e34b1df8eaf0108ef06b1722274075ebc107a127a";
const serverPubKey = hex.decode(ARKADE_SIGNER).subarray(1);
const arkInfo = {
    signerPubkey: ARKADE_SIGNER,
    forfeitPubkey: ARKADE_SIGNER,
    batchExpiry: BigInt(144),
    unilateralExitDelay: BigInt(144),
    boardingExitDelay: BigInt(144),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript: `039d0440b27520${ARKADE_SIGNER.slice(2)}ac`,
};
const identity = SingleKey.fromHex(
    "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
);
const bob = new DefaultVtxo.Script({
    pubKey: await SingleKey.fromHex("11".repeat(32)).xOnlyPublicKey(),
    serverPubKey,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
})
    .address("tark", serverPubKey)
    .encode();

async function bootWallet() {
    mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/info")) return jsonResponse(arkInfo);
        if (url.includes("subscri")) return jsonResponse({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return jsonResponse({ vtxos: [] });
        return jsonResponse([]);
    });
    const walletRepository = new InMemoryWalletRepository();
    const wallet = await Wallet.create({
        identity,
        arkProvider: new RestArkProvider("http://localhost:7070"),
        storage: { walletRepository, contractRepository: new InMemoryContractRepository() },
        settlementConfig: false,
    });
    const manager = await wallet.getContractManager();
    await manager.whenBooted?.();
    return { wallet, walletRepository, manager };
}

/** A spendable coin at the wallet's own address. */
async function seedCoin(
    { wallet, walletRepository }: Awaited<ReturnType<typeof bootWallet>>,
    expiresAt: Date,
) {
    const coin = createMockExtendedVtxo({
        script: wallet.defaultContractScript,
        txid: "aa".repeat(32),
        value: 10_000,
        isPreconfirmed: true,
        commitmentTxIds: ["cc".repeat(32)],
        expiresAt,
    });
    await saveVtxosForContract(
        walletRepository,
        { script: wallet.defaultContractScript, address: await wallet.getAddress() },
        [coin],
    );
    return coin;
}

// A wallet with no `executorProvider` behaves as before the Executor existed.
describe("a wallet without an Executor, on Arkade's operator", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("persists only the baseline contracts at boot", async () => {
        const { wallet, manager } = await bootWallet();
        try {
            const pubKey = await identity.xOnlyPublicKey();
            const scriptOf = (csvTimelock: DefaultVtxo.Script["options"]["csvTimelock"]) =>
                hex.encode(new DefaultVtxo.Script({ pubKey, serverPubKey, csvTimelock }).pkScript);
            const baseline = new Set(
                [
                    ...wallet.walletContractTimelocks,
                    wallet.boardingTapscript.options.csvTimelock ??
                        DefaultVtxo.Script.DEFAULT_TIMELOCK,
                ].map(scriptOf),
            );

            const rows = await manager.getContracts();

            expect(new Set(rows.map((row) => row.script))).toEqual(baseline);
            expect(rows.every((row) => row.type === "default" || row.type === "boarding")).toBe(
                true,
            );
        } finally {
            await wallet.dispose();
        }
    });

    it("sends with change and renews without any Executor lookup", async () => {
        const fx = await bootWallet();
        const { wallet } = fx;
        try {
            const submit = vi
                .spyOn(wallet as any, "_buildAndSubmitOffchainTx")
                .mockResolvedValue({ arkTxid: "ee".repeat(32), signedCheckpointTxs: [] });
            const settle = vi.spyOn(wallet, "settle").mockResolvedValue("settle-txid");
            const operatorInfo = vi.spyOn(wallet, "getOperatorInfo");
            const xOnlyPublicKey = vi.spyOn(identity, "xOnlyPublicKey");
            const coin = await seedCoin(fx, new Date(Date.now() + 100 * 3_600_000));
            operatorInfo.mockClear();
            xOnlyPublicKey.mockClear();

            await wallet.send({
                recipients: [{ address: bob, amount: 4_000 }],
                selectedVtxos: [coin],
            });
            expect(submit).toHaveBeenCalledOnce();

            // a renewal pass over a coin about to expire: it reaches settle, past the deferral
            const expiring = { ...coin, expiresAt: new Date(Date.now() + 1_000) };
            vi.spyOn(wallet, "getSpendableVtxos").mockResolvedValue([expiring] as never);
            await new VtxoManager(wallet, {}).renewVtxos();
            expect(settle).toHaveBeenCalledOnce();

            // the address it shows is the own one, from one repository read
            expect(await wallet.getAddress()).toBe(wallet.arkAddress.encode());

            expect(operatorInfo).not.toHaveBeenCalled();
            expect(xOnlyPublicKey).not.toHaveBeenCalled();
        } finally {
            await wallet.dispose();
        }
    });

    it("shows its own boarding address", async () => {
        const { wallet } = await bootWallet();
        try {
            expect(await wallet.getBoardingAddress()).toBe(wallet.ownBoardingAddress());
        } finally {
            await wallet.dispose();
        }
    });
});
