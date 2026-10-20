import { afterEach, describe, expect, it } from "vitest";
import type { ReadonlyWalletConfig, WalletConfig } from "../src/wallet";
import type { ArkadeInfo } from "../src/providers/ark";
import { ReadonlyWallet, Wallet } from "../src/wallet/wallet";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { ReadonlySingleKey, SingleKey } from "../src/identity/singleKey";
import { makeMockIndexer, makeMockOnchain } from "./helpers/restoreWallet";

const PRIVATE_KEY_HEX = "1".repeat(64);
const SERVER_KEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const arkInfo = (): ArkadeInfo => ({
    boardingExitDelay: 144n,
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
    deprecatedSigners: [],
    digest: "d",
    dust: 1000n,
    fees: { intentFee: {}, txFeeRate: "0" },
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    forfeitPubkey: SERVER_KEY_HEX,
    network: "mutinynet",
    serviceStatus: {},
    sessionDuration: 3600n,
    signerPubkey: SERVER_KEY_HEX,
    unilateralExitDelay: 144n,
    utxoMaxAmount: -1n,
    utxoMinAmount: 0n,
    version: "1",
    vtxoMaxAmount: -1n,
    vtxoMinAmount: 0n,
});

const providers = () => ({
    arkProvider: { getInfo: async () => arkInfo() } as never,
    indexerProvider: makeMockIndexer(new Set()),
    onchainProvider: makeMockOnchain(),
    storage: {
        walletRepository: new InMemoryWalletRepository(),
        contractRepository: new InMemoryContractRepository(),
    },
});

const walletConfig = (): WalletConfig => ({
    identity: SingleKey.fromHex(PRIVATE_KEY_HEX),
    settlementConfig: false,
    ...providers(),
});

const readonlyConfig = async (): Promise<ReadonlyWalletConfig> => ({
    identity: ReadonlySingleKey.fromPublicKey(
        await SingleKey.fromHex(PRIVATE_KEY_HEX).compressedPublicKey(),
    ),
    ...providers(),
});

class SubWallet extends Wallet {
    readonly tag = "sub";
}

class SubReadonlyWallet extends ReadonlyWallet {
    readonly tag = "sub";
}

class PooledWallet extends Wallet {
    pool?: string;

    static override async create(config: WalletConfig & { pool: string }): Promise<PooledWallet> {
        const wallet = (await super.create(config)) as PooledWallet;
        wallet.pool = config.pool;
        return wallet;
    }
}

const created: { dispose(): Promise<void> }[] = [];
const track = <T extends { dispose(): Promise<void> }>(wallet: T): T => {
    created.push(wallet);
    return wallet;
};

afterEach(async () => {
    await Promise.all(created.splice(0).map((wallet) => wallet.dispose()));
});

describe("create on a subclass", () => {
    it("Wallet.create returns an instance of the subclass", async () => {
        const wallet = track(await SubWallet.create(walletConfig()));

        expect(wallet).toBeInstanceOf(SubWallet);
        expect(wallet.tag).toBe("sub");
    });

    it("ReadonlyWallet.create returns an instance of the subclass", async () => {
        const wallet = track(await SubReadonlyWallet.create(await readonlyConfig()));

        expect(wallet).toBeInstanceOf(SubReadonlyWallet);
        expect(wallet.tag).toBe("sub");
    });

    it("builds the subclass through a super.create call in an override", async () => {
        const wallet = track(await PooledWallet.create({ ...walletConfig(), pool: "p1" }));

        expect(wallet).toBeInstanceOf(PooledWallet);
        expect(wallet.pool).toBe("p1");
    });

    it("sets a subclass wallet up exactly as the base class does", async () => {
        const base = track(await Wallet.create(walletConfig()));
        const sub = track(await SubWallet.create(walletConfig()));

        expect(await sub.getAddress()).toBe(await base.getAddress());
        expect(await sub.getBoardingAddress()).toBe(await base.getBoardingAddress());
    });
});

describe("create on the base classes", () => {
    it("Wallet.create still builds a plain Wallet", async () => {
        const wallet = track(await Wallet.create(walletConfig()));

        expect(Object.getPrototypeOf(wallet)).toBe(Wallet.prototype);
    });

    it("ReadonlyWallet.create still builds a plain ReadonlyWallet", async () => {
        const wallet = track(await ReadonlyWallet.create(await readonlyConfig()));

        expect(Object.getPrototypeOf(wallet)).toBe(ReadonlyWallet.prototype);
    });

    it("toReadonly still yields a plain ReadonlyWallet from a subclass wallet", async () => {
        const wallet = track(await SubWallet.create(walletConfig()));
        const readonly = track(await wallet.toReadonly());

        expect(Object.getPrototypeOf(readonly)).toBe(ReadonlyWallet.prototype);
    });
});
