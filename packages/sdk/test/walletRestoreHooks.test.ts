import { describe, expect, it, vi } from "vitest";
import type { IWallet } from "../src/wallet";
import { registerWalletRestoreHook, runWalletRestoreHooks } from "../src/wallet/restoreHooks";

describe("wallet restore hooks", () => {
    it("runs hooks in registration order", async () => {
        const wallet = {} as IWallet;
        const calls: string[] = [];
        registerWalletRestoreHook(wallet, {
            id: "first",
            restore: async () => void calls.push("first"),
        });
        registerWalletRestoreHook(wallet, {
            id: "second",
            restore: async () => void calls.push("second"),
        });

        await runWalletRestoreHooks(wallet);

        expect(calls).toEqual(["first", "second"]);
    });

    it("replaces a duplicate id without changing its order", async () => {
        const wallet = {} as IWallet;
        const calls: string[] = [];
        registerWalletRestoreHook(wallet, {
            id: "stable",
            restore: async () => void calls.push("old"),
        });
        registerWalletRestoreHook(wallet, {
            id: "after",
            restore: async () => void calls.push("after"),
        });
        registerWalletRestoreHook(wallet, {
            id: "stable",
            restore: async () => void calls.push("new"),
        });

        await runWalletRestoreHooks(wallet);

        expect(calls).toEqual(["new", "after"]);
    });

    it("makes unregister exact and idempotent", async () => {
        const wallet = {} as IWallet;
        const oldRestore = vi.fn(async () => undefined);
        const newRestore = vi.fn(async () => undefined);
        const unregisterOld = registerWalletRestoreHook(wallet, {
            id: "stable",
            restore: oldRestore,
        });
        const unregisterNew = registerWalletRestoreHook(wallet, {
            id: "stable",
            restore: newRestore,
        });

        unregisterOld();
        unregisterOld();
        await runWalletRestoreHooks(wallet);
        expect(oldRestore).not.toHaveBeenCalled();
        expect(newRestore).toHaveBeenCalledOnce();

        unregisterNew();
        unregisterNew();
        await runWalletRestoreHooks(wallet);
        expect(newRestore).toHaveBeenCalledOnce();
    });

    it("uses a stable snapshot for each run", async () => {
        const wallet = {} as IWallet;
        const calls: string[] = [];
        let unregisterSecond = () => undefined;
        registerWalletRestoreHook(wallet, {
            id: "first",
            restore: async () => {
                calls.push("first");
                unregisterSecond();
                registerWalletRestoreHook(wallet, {
                    id: "third",
                    restore: async () => void calls.push("third"),
                });
            },
        });
        unregisterSecond = registerWalletRestoreHook(wallet, {
            id: "second",
            restore: async () => void calls.push("second"),
        });

        await runWalletRestoreHooks(wallet);
        expect(calls).toEqual(["first", "second"]);

        calls.length = 0;
        await runWalletRestoreHooks(wallet);
        expect(calls).toEqual(["first", "third"]);
    });

    it("attempts every hook before aggregating failures", async () => {
        const wallet = {} as IWallet;
        const second = vi.fn(async () => {
            throw new Error("second failed");
        });
        registerWalletRestoreHook(wallet, {
            id: "first",
            restore: async () => {
                throw new Error("first failed");
            },
        });
        registerWalletRestoreHook(wallet, { id: "second", restore: second });

        const failure = await runWalletRestoreHooks(wallet).catch((error) => error);

        expect(second).toHaveBeenCalledOnce();
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([
            expect.objectContaining({ message: "first failed" }),
            expect.objectContaining({ message: "second failed" }),
        ]);
    });
});
