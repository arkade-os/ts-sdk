// @vitest-environment happy-dom
import { ClientDisposed } from "@arkade-os/swap";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArkadeWalletProvider } from "../src/ArkadeWalletProvider";
import type { ArkadeWalletContextType, NetworkConfig } from "../src/types";
import { useArkadeWallet } from "../src/useArkadeWallet";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const h = vi.hoisted(() => ({
    wrappers: [] as any[],
    createSwapClient: vi.fn(),
    getSwapRecord: vi.fn(),
    removeSwapRecord: vi.fn(),
}));

vi.mock("@arkade-os/sats-connect", () => ({
    ArkadeWallet: class {
        connection = (() => {
            let resolve!: (value: unknown) => void;
            const promise = new Promise((res) => {
                resolve = res;
            });
            return { promise, resolve };
        })();
        reset = vi.fn();
        sdkWallet = { getTransactionHistory: vi.fn(async () => []) };
        constructor() {
            h.wrappers.push(this);
        }
        connect() {
            return this.connection.promise;
        }
        getWallet() {
            return this.sdkWallet;
        }
        async getBalance() {
            return {
                boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
                settled: 0,
                preconfirmed: 0,
                available: 0,
                recoverable: 0,
                total: 0,
            };
        }
        async getVtxos() {
            return [];
        }
    },
    SatsConnectIdentity: class {},
}));

vi.mock("@arkade-os/swap", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@arkade-os/swap")>()),
    createSwapClient: (...args: unknown[]) => h.createSwapClient(...args),
    IndexedDbAssetSwapRepository: class {
        getSwapRecord = (...args: unknown[]) => h.getSwapRecord(...args);
        removeSwapRecord = (...args: unknown[]) => h.removeSwapRecord(...args);
    },
}));

const INFO = {
    ordinalAddress: "bc1pordinals",
    paymentAddress: "bc1qpayment",
    arkAddress: "tark1address",
    boardingAddress: "tb1pboarding",
    userPubKey: "11".repeat(32),
};
const INVOICE = "lntbs1example";

const network = (hasLightning: boolean): NetworkConfig => ({
    networkName: "mutinynet",
    arkServerUrl: "https://mutinynet.arkade.sh",
    esploraUrl: "https://mutinynet.com/api",
    hasLightning,
    satsConnectNetwork: "Signet",
});

/** A swap client whose payment reports `outcome`, or never ends when `paying` is given. */
function swapClient({ outcome, paying }: { outcome?: string; paying?: Promise<unknown> }) {
    return {
        ready: Promise.resolve(),
        pay: vi.fn(() => paying ?? Promise.resolve({ kind: "swap", swap: { id: "rfq:1" } })),
        cancel: vi.fn(),
        onUpdate: (fn: (update: unknown) => void) => {
            if (outcome) fn({ swap: { id: "rfq:1" }, outcome });
            return () => {};
        },
        [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
}

let ctx: ArkadeWalletContextType<string>;
let root: Root;

function render(hasLightning: boolean) {
    const Probe = () => {
        ctx = useArkadeWallet();
        return null;
    };
    root = createRoot(document.createElement("div"));
    act(() => {
        root.render(
            createElement(ArkadeWalletProvider, {
                config: {
                    networks: { a: network(hasLightning), b: network(hasLightning) },
                    defaultNetwork: "a",
                },
                children: createElement(Probe),
            }),
        );
    });
}

/** Connects the next wrapper the provider creates. */
async function connect() {
    let connecting!: Promise<void>;
    act(() => {
        connecting = ctx.connectWallet();
    });
    await act(async () => {
        h.wrappers.at(-1).connection.resolve(INFO);
        await connecting;
    });
}

describe("ArkadeWalletProvider", () => {
    beforeEach(() => {
        h.wrappers.length = 0;
        h.createSwapClient.mockReset();
        h.getSwapRecord.mockReset();
        h.removeSwapRecord.mockReset();
        localStorage.clear();
    });

    afterEach(() => {
        act(() => root.unmount());
    });

    it("drops a connect that a network switch overtook before React re-rendered", async () => {
        render(false);
        let connecting!: Promise<void>;
        act(() => {
            connecting = ctx.connectWallet();
            void ctx.switchNetwork("b");
        });
        await act(async () => {
            h.wrappers[0].connection.resolve(INFO);
            await connecting;
        });

        expect(ctx.currentNetwork).toBe("b");
        expect(ctx.wallet).toBeNull();
        expect(h.wrappers[0].reset).toHaveBeenCalled();
    });

    it("drops a connect that finishes after the provider unmounted", async () => {
        render(true);
        let connecting!: Promise<void>;
        act(() => {
            connecting = ctx.connectWallet();
        });
        act(() => root.unmount());
        await act(async () => {
            h.wrappers[0].connection.resolve(INFO);
            await connecting;
        });

        expect(h.wrappers[0].reset).toHaveBeenCalled();
        expect(h.createSwapClient).not.toHaveBeenCalled();
        render(false);
    });

    it("keeps history read for a wallet that was replaced out of the new one", async () => {
        render(false);
        await connect();
        const history = deferred<unknown[]>();
        h.wrappers[0].sdkWallet.getTransactionHistory.mockReturnValue(history.promise);
        let reading!: Promise<void>;
        act(() => {
            reading = ctx.getTransactionHistory();
        });
        act(() => ctx.disconnectWallet());
        await connect();

        await act(async () => {
            history.resolve([
                { key: { arkTxid: "ab" }, type: "SENT", amount: 1, settled: true, createdAt: 1 },
            ]);
            await reading;
        });

        expect(ctx.transactions).toEqual([]);
    });

    it("resolves a paid invoice with an empty preimage when it cannot be read back", async () => {
        h.createSwapClient.mockReturnValue(swapClient({ outcome: "paid" }));
        h.getSwapRecord.mockRejectedValue(new Error("IndexedDB unavailable"));
        render(true);
        await connect();

        let preimage: string | undefined;
        await act(async () => {
            preimage = await ctx.payLightningInvoice(INVOICE);
        });

        expect(preimage).toBe("");
    });

    it("stops following a payment the wallet disconnects from mid-funding", async () => {
        const funding = deferred<unknown>();
        const client = swapClient({ paying: funding.promise });
        client[Symbol.asyncDispose].mockImplementation(async () =>
            funding.reject(new ClientDisposed("pay")),
        );
        h.createSwapClient.mockReturnValue(client);
        render(true);
        await connect();

        let paying!: Promise<string>;
        act(() => {
            paying = ctx.payLightningInvoice(INVOICE);
        });
        act(() => ctx.disconnectWallet());

        await act(async () => {
            await expect(paying).rejects.toThrow("Stopped following this Lightning payment");
        });
        expect(client.cancel).not.toHaveBeenCalled();
        expect(h.removeSwapRecord).not.toHaveBeenCalled();
    });
});
