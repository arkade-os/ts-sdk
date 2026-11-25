import { describe, expect, it } from "vitest";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import { SendInputsRefusedError } from "../../src/wallet/sendInputsRefused";
import { bindTestWallet, testWalletBinding } from "../helpers/walletRequest";

// What the bus hands the page after restoring the worker error's name.
const fromWorker = (name: string) => Object.assign(new Error(`${name} from worker`), { name });

const walletWhoseWorkerThrows = (error: Error) =>
    bindTestWallet(
        Object.assign(Object.create(ServiceWorkerWallet.prototype), {
            messageTag: "test",
            messageTimeouts: {},
            inflightRequests: new Map(),
            sendMessageDirect: async () => {
                throw error;
            },
            sendMessageStreaming: async () => {
                throw error;
            },
        }) as ServiceWorkerWallet,
        testWalletBinding(new Uint8Array(32).fill(0xab)),
    );

describe("ServiceWorkerWallet settle and send errors", () => {
    it("pass VtxoReservedError through so a caller can tell a lost race", async () => {
        const reserved = fromWorker("VtxoReservedError");
        const wallet = walletWhoseWorkerThrows(reserved);
        await expect(wallet.settle({ inputs: [], outputs: [] })).rejects.toBe(reserved);
        await expect(wallet.send({ address: "ark1", amount: 1_000 })).rejects.toBe(reserved);
    });

    it("rebuild SendInputsRefusedError from the name the worker relays", async () => {
        const wallet = walletWhoseWorkerThrows(fromWorker("SendInputsRefusedError"));
        const error = await wallet.send({ address: "ark1", amount: 1_000 }).catch((e) => e);
        expect(error).toBeInstanceOf(SendInputsRefusedError);
        expect(error.message).toBe("SendInputsRefusedError from worker");
    });

    it("still wrap every other error as before", async () => {
        const wallet = walletWhoseWorkerThrows(fromWorker("ArkError"));
        await expect(wallet.settle({ inputs: [], outputs: [] })).rejects.toThrow(
            /^Settlement failed: /,
        );
        await expect(wallet.send({ address: "ark1", amount: 1_000 })).rejects.toThrow(
            /^Send failed: /,
        );
    });
});
