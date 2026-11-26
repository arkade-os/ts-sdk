/**
 * `getAddress()` through the service worker: the page asks, the real worker-side wallet answers
 * from its stored Executor watches, so a watch registered from the page is followed at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestOperatorProvider,
    Wallet,
} from "../../src";
import { ServiceWorkerReadonlyWallet } from "../../src/wallet/serviceWorker/wallet";
import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../../src/wallet/serviceWorker/wallet-message-handler";
import { MockEventSource } from "../mocks/eventSource";
import { arkInfo, identity, renewalRow } from "../helpers/delegatedRows";
import { jsonResponse } from "../helpers/response";
import { bindTestWallet, testWalletBinding } from "../helpers/walletRequest";
import { createHandlerBackedBus } from "../helpers/handlerBackedBus";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) => Promise.resolve(jsonResponse(body));
        if (url.includes("/info")) return reply(arkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        return reply([]);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("getAddress through the service worker", () => {
    it("follows an Executor renewal watch registered after the wallet started", async () => {
        const contractRepository = new InMemoryContractRepository();
        const walletRepository = new InMemoryWalletRepository();
        const inner = await Wallet.create({
            identity,
            walletMode: "static",
            arkProvider: new RestOperatorProvider("http://localhost:7070"),
            storage: { walletRepository, contractRepository },
        });
        try {
            const handler = new WalletMessageHandler();
            const binding = testWalletBinding(
                await identity.xOnlyPublicKey(),
                "http://localhost:7070",
                inner.network.name,
            );
            (handler as any).walletRequestBinding = binding;
            (handler as any).readonlyWallet = inner;
            const { navigatorServiceWorker, serviceWorker } = createHandlerBackedBus(handler);
            vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);
            const page = bindTestWallet(
                new (ServiceWorkerReadonlyWallet as any)(
                    serviceWorker as unknown as ServiceWorker,
                    identity,
                    walletRepository,
                    new InMemoryContractRepository(),
                    DEFAULT_MESSAGE_TAG,
                ) as ServiceWorkerReadonlyWallet,
                binding,
            );
            expect(await page.getAddress()).toBe(inner.arkAddress.encode());

            const row = await renewalRow();
            await contractRepository.saveContract(row.contract);

            expect(await page.getAddress()).toBe(row.contract.address);
            expect(await page.getOwnAddress()).toBe(inner.arkAddress.encode());
        } finally {
            await inner.dispose();
        }
    });
});
