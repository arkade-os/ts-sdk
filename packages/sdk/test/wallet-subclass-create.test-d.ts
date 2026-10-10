import { describe, expectTypeOf, it } from "vitest";
import { ReadonlyWallet, Wallet, type ReadonlyWalletConfig, type WalletConfig } from "../src";

declare const walletConfig: WalletConfig;
declare const readonlyConfig: ReadonlyWalletConfig;

class SubWallet extends Wallet {
    readonly tag = "sub";
}

class SubReadonlyWallet extends ReadonlyWallet {
    readonly tag = "sub";
}

class PooledWallet extends Wallet {
    static override async create(config: WalletConfig & { pool: string }): Promise<PooledWallet> {
        return (await super.create(config)) as PooledWallet;
    }
}

describe("create on a subclass", () => {
    it("is typed as the subclass", () => {
        expectTypeOf(SubWallet.create(walletConfig)).resolves.toEqualTypeOf<SubWallet>();
        expectTypeOf(
            SubReadonlyWallet.create(readonlyConfig),
        ).resolves.toEqualTypeOf<SubReadonlyWallet>();
    });

    it("stays typed as the base class on the base class", () => {
        expectTypeOf(Wallet.create(walletConfig)).resolves.toEqualTypeOf<Wallet>();
        expectTypeOf(
            ReadonlyWallet.create(readonlyConfig),
        ).resolves.toEqualTypeOf<ReadonlyWallet>();
    });

    it("can be overridden with a wider config and the subclass as its return", () => {
        expectTypeOf(
            PooledWallet.create({ ...walletConfig, pool: "p1" }),
        ).resolves.toEqualTypeOf<PooledWallet>();
    });

    it("keeps its parameter and return types for callers that name them", () => {
        expectTypeOf<Parameters<typeof Wallet.create>[0]>().toEqualTypeOf<WalletConfig>();
        expectTypeOf<Awaited<ReturnType<typeof Wallet.create>>>().toEqualTypeOf<Wallet>();
        expectTypeOf<
            Parameters<typeof ReadonlyWallet.create>[0]
        >().toEqualTypeOf<ReadonlyWalletConfig>();
    });
});
