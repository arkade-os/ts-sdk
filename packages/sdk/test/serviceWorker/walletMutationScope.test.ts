import { describe, expect, it, vi } from "vitest";
import { SingleKey } from "../../src/identity";
import { getNetwork, type NetworkName } from "../../src/networks";
import type { Wallet } from "../../src/wallet/wallet";
import { vtxoReservationScope } from "../../src/wallet/vtxoReservationScope";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

async function walletContext(options: { key?: string; url?: string; network?: NetworkName } = {}) {
    const identity = SingleKey.fromHex((options.key ?? "12").repeat(32));
    const network = options.network ?? "regtest";
    const url = options.url ?? "https://ark.example/ark/";
    const scope = vtxoReservationScope(url, await identity.xOnlyPublicKey());
    const binding = { scope, network };
    const send = vi.fn().mockResolvedValue("funded");
    const dispose = vi.fn().mockResolvedValue(undefined);
    const holds = new Map<string, unknown>();
    const acquire = vi.fn(async (outpoints, id) => {
        holds.set(id, outpoints);
    });
    const release = vi.fn(async (id) => {
        holds.delete(id);
    });
    const wallet = {
        identity,
        network: getNetwork(network),
        send,
        dispose,
        indexerProvider: {},
        reserveVtxosPersistently: acquire,
        releaseVtxoReservation: release,
        finalizePendingTxs: vi.fn().mockResolvedValue({ pending: [], finalized: [] }),
        notifyIncomingFunds: vi.fn().mockResolvedValue(vi.fn()),
        getVtxoManager: vi.fn().mockResolvedValue({}),
        getAddress: vi.fn().mockResolvedValue("address"),
        getProviderConnectionState: () => ({ mode: "online", syncing: false }),
    } as unknown as Wallet;
    return { wallet, identity, url, network, binding, send, dispose, holds, acquire, release };
}

async function setup() {
    const context = await walletContext();
    const handler = new WalletMessageHandler() as any;
    const start = async (next: Awaited<ReturnType<typeof walletContext>>) => {
        await handler.start(
            {
                wallet: next.wallet,
                readonlyWallet: next.wallet,
                arkProvider: {},
                vtxoReservationScope: next.binding.scope,
                walletRequestBinding: next.binding,
            },
            { walletRepository: {} },
        );
    };
    await start(context);
    const sendMessageDirect = vi.fn(async (request) => {
        const result = await handler.handleMessage(structuredClone(request));
        if (result.error) throw result.error;
        return result;
    });
    const proxy = Object.assign(Object.create(ServiceWorkerWallet.prototype), {
        identity: context.identity,
        messageTag: handler.messageTag,
        messageTimeouts: {},
        inflightRequests: new Map(),
        initConfig: { arkServer: { url: context.url } },
        expectedWalletScope: context.binding.scope,
        expectedNetwork: context.network,
        walletRequestBinding: context.binding,
        sendMessageDirect,
        pingServiceWorker: async () => {},
    }) as ServiceWorkerWallet;
    const initialize = () =>
        handler.handleMessage({
            id: "init",
            tag: handler.messageTag,
            type: "SCOPED_WALLET_REQUEST_V1",
            payload: {
                binding: context.binding,
                request: {
                    id: "init",
                    tag: handler.messageTag,
                    type: "INIT_WALLET",
                    payload: {},
                },
            },
        });
    return { ...context, handler, start, proxy, sendMessageDirect, initialize };
}

describe("wallet request scope", () => {
    it("refuses B-derived payout preparation before an A-wallet send after switching back", async () => {
        const original = await setup();
        const other = await walletContext({ key: "34" });
        const restored = await walletContext();
        vi.mocked(other.wallet.getAddress).mockResolvedValue("wallet-B-payout");
        await original.handler.stop();
        await original.start(other);
        const prepareAndFund = async () => {
            const payout = await original.proxy.getAddress();
            await original.handler.stop();
            await original.start(restored);
            return original.proxy.send({ address: payout, amount: 1_000 });
        };
        await expect(prepareAndFund()).rejects.toThrow(/wallet request scope/i);
        expect(other.wallet.getAddress).not.toHaveBeenCalled();
        expect(other.send).not.toHaveBeenCalled();
        expect(restored.send).not.toHaveBeenCalled();
    });

    it("rejects stale hold acquisition and release when only the network changes", async () => {
        const original = await setup();
        const point = { txid: "aa".repeat(32), vout: 0 };
        const hold = await original.proxy.reserveVtxos([point], "transfer");
        const other = await walletContext({ network: "signet" });
        expect(other.binding.scope).toBe(original.binding.scope);
        other.holds.set("transfer", [{ txid: "bb".repeat(32), vout: 0 }]);
        await original.handler.stop();
        await original.start(other);
        await expect(hold.release()).rejects.toThrow(/wallet request scope/i);
        await expect(original.proxy.reserveVtxos([point], "other-transfer")).rejects.toThrow(
            /wallet request scope/i,
        );
        expect(other.acquire).not.toHaveBeenCalled();
        expect(other.release).not.toHaveBeenCalled();
        expect(other.holds.get("transfer")).toEqual([{ txid: "bb".repeat(32), vout: 0 }]);
    });

    it.each([
        { change: "identity", key: "34" },
        { change: "operator origin", url: "https://other.example/ark" },
        { change: "operator path", url: "https://ark.example/other" },
        { change: "network", network: "signet" as const },
    ])("refuses a retained proxy after changing $change", async (options) => {
        const original = await setup();
        const replacement = await walletContext(options);
        await original.handler.stop();
        await original.start(replacement);
        await expect(original.proxy.send({ address: "recipient", amount: 1_000 })).rejects.toThrow(
            /wallet request scope/i,
        );
        expect(original.send).not.toHaveBeenCalled();
        expect(replacement.send).not.toHaveBeenCalled();
    });

    it("drains an admitted original-wallet send before disposing it or starting a replacement", async () => {
        const original = await setup();
        const replacement = await walletContext({ key: "34" });
        const finish = deferred<string>();
        original.send.mockImplementation(() => finish.promise);
        const sending = original.proxy.send({ address: "recipient", amount: 1_000 });
        await vi.waitFor(() => expect(original.send).toHaveBeenCalledOnce());
        let replaced = false;
        const stopping = original.handler.stop().then(async () => {
            await original.start(replacement);
            replaced = true;
        });
        try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(original.dispose).not.toHaveBeenCalled();
            expect(replaced).toBe(false);
        } finally {
            finish.resolve("original-tx");
            await sending;
            await stopping;
        }
        expect(original.dispose).toHaveBeenCalledOnce();
        expect(replacement.send).not.toHaveBeenCalled();
    });

    it.each([
        "SEND",
        "SEND_WITH_DEADLINE",
        "SEND_WITH_INPUT_EXPIRY_FLOOR",
        "SETTLE",
        "SIGN_TRANSACTION",
        "SUBMIT_TX",
        "FINALIZE_TX",
        "ISSUE",
        "REISSUE",
        "BURN",
        "DELEGATE",
        "RECOVER_VTXOS",
        "RENEW_VTXOS",
        "SWEEP_EXPIRED_BOARDING_UTXOS",
        "COSIGN_ONCHAIN_TX",
        "SEND_ONCHAIN",
        "MIGRATE_DEPRECATED_SIGNER_VTXOS",
        "RESTORE_WALLET",
        "CLEAR",
        "CREATE_CONTRACT",
        "UPDATE_CONTRACT",
        "DELETE_CONTRACT",
        "GET_NEXT_SIGNING_DESCRIPTOR",
        "GET_NEW_ADDRESSES",
        "ADVANCE_SIGNING_DESCRIPTOR_WATERMARK",
        "INIT_WALLET",
        "GET_ADDRESS",
        "GET_BOARDING_ADDRESS",
        "GET_OPERATOR_INFO",
        "GET_CURRENT_SIGNING_DESCRIPTOR",
        "GET_BALANCE",
        "GET_VTXOS",
        "GET_SPENDABLE_VTXOS",
        "GET_CONTRACTS",
        "GET_CONTRACTS_WITH_VTXOS",
        "GET_STORED_CONTRACTS_WITH_VTXOS",
        "INDEXER_GET_VTXOS",
        "INDEXER_GET_VIRTUAL_TXS",
        "RESERVE_SCOPED_VTXOS",
        "RELEASE_SCOPED_VTXOS",
    ])("rejects legacy unscoped %s before its payload is processed", async (type) => {
        const { handler, send } = await setup();
        const response = await handler.handleMessage({
            tag: handler.messageTag,
            id: "old",
            type,
            payload: {},
        });
        expect(response.error?.message).toMatch(/scoped wallet request required/i);
        expect(send).not.toHaveBeenCalled();
    });

    it("fails closed with an older active worker that only supports SEND", async () => {
        const { proxy, sendMessageDirect, send } = await setup();
        sendMessageDirect.mockImplementation(async (request) => {
            if (request.type !== "SEND") throw new Error("Unknown message");
            await send();
            return { type: "SEND_SUCCESS", payload: { txid: "old-worker-tx" } } as any;
        });
        await expect(proxy.send({ address: "recipient", amount: 1_000 })).rejects.toThrow(
            "Unknown message",
        );
        expect(send).not.toHaveBeenCalled();
    });

    it("keeps the same captured binding after restarting the same wallet", async () => {
        const original = await setup();
        await original.handler.stop();
        const restarted = await walletContext({
            url: "https://ark.example/ark?ignored=1#fragment",
        });
        await original.start(restarted);
        await expect(original.proxy.send({ address: "recipient", amount: 1_000 })).resolves.toBe(
            "funded",
        );
        expect(restarted.send).toHaveBeenCalledOnce();
    });

    it("does not hold disposal behind pending subscription setup and unsubscribes its late result", async () => {
        const original = await setup();
        const replacement = await walletContext({ key: "34" });
        const registered = deferred<() => void>();
        const unsubscribe = vi.fn();
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "getVtxosFromRepo").mockResolvedValue([]);
        vi.mocked(original.wallet.notifyIncomingFunds).mockImplementation(() => registered.promise);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(original.wallet.notifyIncomingFunds).toHaveBeenCalledOnce());
        await original.handler.stop();
        expect(original.dispose).toHaveBeenCalledOnce();
        await original.start(replacement);
        registered.resolve(unsubscribe);
        await initializing;
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(await original.handler.tick(0)).toEqual([]);
        expect(replacement.send).not.toHaveBeenCalled();
    });

    it("drains initialization's admitted finalization before disposal", async () => {
        const original = await setup();
        const finished = deferred<{ pending: never[]; finalized: string[] }>();
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "getVtxosFromRepo").mockResolvedValue([]);
        vi.mocked(original.wallet.finalizePendingTxs).mockImplementation(() => finished.promise);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(original.wallet.finalizePendingTxs).toHaveBeenCalledOnce());
        const stopping = original.handler.stop();
        try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(original.dispose).not.toHaveBeenCalled();
        } finally {
            finished.resolve({ pending: [], finalized: ["original-finalization"] });
            await stopping;
            await initializing;
        }
        expect(original.dispose).toHaveBeenCalledOnce();
        expect(original.wallet.notifyIncomingFunds).not.toHaveBeenCalled();
    });

    it("refuses late initialization effects after shutdown and same-wallet restart", async () => {
        const original = await setup();
        const restarted = await walletContext();
        const coins = deferred<never[]>();
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        const reading = vi
            .spyOn(original.handler, "getVtxosFromRepo")
            .mockImplementation(() => coins.promise);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
        await original.handler.stop();
        await original.start(restarted);
        coins.resolve([]);
        await initializing;
        expect(original.wallet.finalizePendingTxs).not.toHaveBeenCalled();
        expect(restarted.wallet.finalizePendingTxs).not.toHaveBeenCalled();
        expect(original.wallet.getVtxoManager).not.toHaveBeenCalled();
        expect(restarted.wallet.getVtxoManager).not.toHaveBeenCalled();
    });

    it("drains initialization's admitted automation startup before disposal", async () => {
        const original = await setup();
        const started = deferred<any>();
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "getVtxosFromRepo").mockResolvedValue([]);
        vi.mocked(original.wallet.getVtxoManager).mockImplementation(() => started.promise);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(original.wallet.getVtxoManager).toHaveBeenCalledOnce());
        const stopping = original.handler.stop();
        try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(original.dispose).not.toHaveBeenCalled();
        } finally {
            started.resolve({});
            await stopping;
            await initializing;
        }
        expect(original.dispose).toHaveBeenCalledOnce();
    });

    it("drains contract-manager initialization before disposing its repository", async () => {
        const original = await setup();
        const manager = deferred<any>();
        const getContractManager = vi.fn(() => manager.promise);
        (original.wallet as any).getContractManager = getContractManager;
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(getContractManager).toHaveBeenCalledOnce());
        const stopping = original.handler.stop();
        try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(original.dispose).not.toHaveBeenCalled();
        } finally {
            manager.resolve({ onContractEvent: vi.fn() });
            await stopping;
            await initializing;
        }
        expect(original.dispose).toHaveBeenCalledOnce();
        expect(original.wallet.finalizePendingTxs).not.toHaveBeenCalled();
    });

    it("drains initialization's boarding refresh writes before disposing its repository", async () => {
        const original = await setup();
        const refreshed = deferred<void>();
        const getBoardingUtxosForSigners = vi.fn(() => refreshed.promise);
        Object.assign(original.wallet, {
            boardingTapscript: {
                options: { serverPubKey: await original.identity.xOnlyPublicKey() },
            },
            getBoardingUtxosForSigners,
        });
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "loadHistoryCache").mockResolvedValue(undefined);
        const initializing = original.initialize();
        await vi.waitFor(() => expect(getBoardingUtxosForSigners).toHaveBeenCalledOnce());
        const stopping = original.handler.stop();
        try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            expect(original.dispose).not.toHaveBeenCalled();
        } finally {
            refreshed.resolve();
            await stopping;
            await initializing;
        }
        expect(original.dispose).toHaveBeenCalledOnce();
        expect(original.wallet.finalizePendingTxs).not.toHaveBeenCalled();
    });

    it("preserves operation-specific timeouts and streaming classification inside the envelope", async () => {
        const { proxy, handler, binding } = await setup();
        (proxy as any).messageTimeouts = { SEND: 60_000, SETTLE: 120_000 };
        const request = (type: string) => ({
            id: "request",
            tag: handler.messageTag,
            type: "SCOPED_WALLET_REQUEST_V1",
            payload: {
                binding,
                request: { id: "request", tag: handler.messageTag, type, payload: {} },
            },
        });
        expect((proxy as any).getTimeoutForRequest(request("SEND"))).toBe(60_000);
        expect((proxy as any).getTimeoutForRequest(request("SETTLE"))).toBe(120_000);
        expect(handler.getRequestType(request("SEND"))).toBe("SEND");
        expect(handler.isLongRunning(request("SETTLE"))).toBe(true);
        expect(handler.isLongRunning(request("SEND"))).toBe(false);
    });

    const scoped = (ctx: Awaited<ReturnType<typeof setup>>, type: string, payload: unknown = {}) =>
        ctx.handler.handleMessage({
            id: type,
            tag: ctx.handler.messageTag,
            type: "SCOPED_WALLET_REQUEST_V1",
            payload: {
                binding: ctx.binding,
                request: { id: type, tag: ctx.handler.messageTag, type, payload },
            },
        });

    it("disposes without waiting for a settlement in its batch round", async () => {
        const original = await setup();
        const round = deferred<string>();
        const settle = vi.fn(() => round.promise);
        Object.assign(original.wallet, { settle });
        const settling = scoped(original, "SETTLE", {});
        await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
        await original.handler.stop();
        expect(original.dispose).toHaveBeenCalledOnce();
        round.resolve("txid");
        await settling;
    });

    it("bounds the drain of finite work before disposing", async () => {
        const original = await setup();
        original.handler.drainBudgetMs = 20;
        const never = deferred<string>();
        original.send.mockImplementation(() => never.promise);
        void original.proxy.send({ address: "recipient", amount: 1_000 }).catch(() => undefined);
        await vi.waitFor(() => expect(original.send).toHaveBeenCalledOnce());
        await original.handler.stop();
        expect(original.dispose).toHaveBeenCalledOnce();
    });

    it("refuses CLEAR during a settlement without revoking the wallet", async () => {
        const original = await setup();
        const clear = vi.fn().mockResolvedValue(undefined);
        const round = deferred<string>();
        const settle = vi.fn(() => round.promise);
        Object.assign(original.wallet, { settle, clear });
        const settling = scoped(original, "SETTLE", {});
        await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
        await expect(original.proxy.clear()).rejects.toThrow(/settlement is in progress/);
        expect(original.handler.walletRequestBinding).toEqual(original.binding);
        await expect(original.proxy.send({ address: "recipient", amount: 1_000 })).resolves.toBe(
            "funded",
        );
        round.resolve("txid");
        await settling;
        expect(clear).not.toHaveBeenCalled();
    });

    it("fails CLEAR without wiping when its drain outlasts the budget", async () => {
        const original = await setup();
        original.handler.drainBudgetMs = 20;
        const clear = vi.fn().mockResolvedValue(undefined);
        Object.assign(original.wallet, { clear });
        const finish = deferred<string>();
        original.send.mockImplementation(() => finish.promise);
        const sending = original.proxy.send({ address: "recipient", amount: 1_000 });
        await vi.waitFor(() => expect(original.send).toHaveBeenCalledOnce());
        await expect(original.proxy.clear()).rejects.toThrow(/not cleared/);
        finish.resolve("original-tx");
        await sending;
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(clear).not.toHaveBeenCalled();
    });

    it("revokes incoming-funds callbacks while CLEAR drains an admitted send", async () => {
        const original = await setup();
        let incoming!: (event: unknown) => Promise<void>;
        const getBoardingUtxos = vi.fn().mockResolvedValue([]);
        Object.assign(original.wallet, {
            getBoardingUtxos,
            clear: vi.fn().mockResolvedValue(undefined),
        });
        vi.spyOn(original.handler, "ensureContractEventBroadcasting").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "refreshCachedData").mockResolvedValue(undefined);
        vi.spyOn(original.handler, "getVtxosFromRepo").mockResolvedValue([]);
        vi.mocked(original.wallet.notifyIncomingFunds).mockImplementation(async (callback) => {
            incoming = callback as typeof incoming;
            return vi.fn<() => void>();
        });
        await original.initialize();
        const finished = deferred<string>();
        original.send.mockImplementation(() => finished.promise);
        const sending = original.proxy.send({ address: "recipient", amount: 1_000 });
        await vi.waitFor(() => expect(original.send).toHaveBeenCalledOnce());
        const clearing = original.proxy.clear();
        await vi.waitFor(() => expect(original.handler.walletRequestBinding).toBeUndefined());
        try {
            await expect(incoming({ type: "utxo", coins: [] })).resolves.toBeUndefined();
            expect(getBoardingUtxos).not.toHaveBeenCalled();
        } finally {
            finished.resolve("original-tx");
            await sending;
            await clearing;
        }
    });

    it("filters contract broadcasts by captured wallet binding across restarts", async () => {
        const original = await setup();
        const listeners = new Set<(event: MessageEvent) => void>();
        vi.stubGlobal("navigator", {
            serviceWorker: {
                addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
                    listeners.add(listener),
                removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
                    listeners.delete(listener),
            },
        });
        const manager = await original.proxy.getContractManager();
        const callback = vi.fn();
        const unsubscribe = manager.onContractEvent(callback);
        const emit = async () => {
            original.handler.newEmitter("contractEvents").emit({
                tag: original.handler.messageTag,
                type: "CONTRACT_EVENT",
                broadcast: true,
                payload: { event: { type: "contract_updated" } },
            });
            for (const data of await original.handler.tick(0)) {
                for (const listener of listeners) listener({ data } as MessageEvent);
            }
        };
        try {
            await emit();
            expect(callback).toHaveBeenCalledOnce();
            for (const changed of [{ key: "34" }, { network: "signet" as const }]) {
                await original.handler.stop();
                await original.start(await walletContext(changed));
                await emit();
                expect(callback).toHaveBeenCalledOnce();
            }
            for (const listener of listeners) {
                listener({
                    data: {
                        tag: original.handler.messageTag,
                        type: "CONTRACT_EVENT",
                        payload: { event: { type: "contract_updated" } },
                    },
                } as MessageEvent);
            }
            expect(callback).toHaveBeenCalledOnce();
            await original.handler.stop();
            await original.start(await walletContext());
            await emit();
            expect(callback).toHaveBeenCalledTimes(2);
        } finally {
            unsubscribe();
            vi.unstubAllGlobals();
        }
    });

    it.each(["CONTRACT_EVENT", "VTXO_UPDATE", "UTXO_UPDATE"])(
        "filters all %s subscribers through the immutable wallet binding",
        async (type) => {
            const original = await setup();
            const listeners = new Set<(event: MessageEvent) => void>();
            vi.stubGlobal("navigator", {
                serviceWorker: {
                    addEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
                        listeners.add(listener),
                    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) =>
                        listeners.delete(listener),
                },
            });
            const callback = vi.fn();
            const unsubscribe = original.proxy.onWalletUpdate(callback);
            const message = {
                tag: original.handler.messageTag,
                type,
                broadcast: true,
                payload: { event: {}, newVtxos: [], spentVtxos: [], coins: [] },
            };
            const deliver = (data: unknown) => {
                for (const listener of listeners) listener({ data } as MessageEvent);
            };
            try {
                original.handler.newEmitter("incomingFunds").emit(message);
                const [update] = await original.handler.tick(0);
                expect(update.walletRequestBinding).toEqual(original.binding);
                deliver(update);
                expect(callback).toHaveBeenCalledOnce();
                for (const changed of [
                    { key: "34" },
                    { url: "https://other.example/ark" },
                    { url: "https://ark.example/other" },
                    { network: "signet" as const },
                ]) {
                    const foreign = await walletContext(changed);
                    deliver({ ...message, walletRequestBinding: foreign.binding });
                }
                deliver(message);
                deliver({ ...update, tag: "other" });
                deliver({ ...update, type: "SEND_SUCCESS" });
                deliver({ ...update, broadcast: false });
                expect(callback).toHaveBeenCalledOnce();
                deliver(update);
                expect(callback).toHaveBeenCalledTimes(2);
                unsubscribe();
                deliver(update);
                expect(callback).toHaveBeenCalledTimes(2);
            } finally {
                unsubscribe();
                vi.unstubAllGlobals();
            }
        },
    );

    it.each(["network", "operator", "missing capability"])(
        "checks bootstrap %s against local expectations",
        async (changed) => {
            const { proxy, identity, binding, sendMessageDirect } = await setup();
            const workerBinding =
                changed === "missing capability"
                    ? undefined
                    : {
                          ...binding,
                          ...(changed === "network"
                              ? { network: "signet" }
                              : { scope: "other-operator" }),
                      };
            (proxy as any).walletRequestBinding = undefined;
            sendMessageDirect.mockResolvedValue({
                type: "WALLET_STATUS",
                payload: {
                    walletInitialized: true,
                    xOnlyPublicKey: await identity.xOnlyPublicKey(),
                    walletRequestBinding: workerBinding,
                },
            });
            await expect((proxy as any).assertWorkerIdentityMatches()).rejects.toThrow(
                /network|scope|scoped wallet/i,
            );
            expect((proxy as any).walletRequestBinding).toBeUndefined();
        },
    );
});
