/**
 * `getStoredVtxosForContract` end to end: a page-side service worker wallet,
 * the real worker handler, and a real `Wallet` behind it, with only the
 * network faked. A canned responder would agree with itself; this pins the
 * letter the page sends, and that the worker answers from storage alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryContractRepository, InMemoryWalletRepository, SingleKey, Wallet } from "../../src";
import { ServiceWorkerReadonlyWallet } from "../../src/wallet/serviceWorker/wallet";
import {
    DEFAULT_MESSAGE_TAG,
    WalletMessageHandler,
} from "../../src/wallet/serviceWorker/wallet-message-handler";
import { MockEventSource } from "../mocks/eventSource";
import { jsonResponse } from "../helpers/response";
import { createHandlerBackedBus } from "../helpers/handlerBackedBus";
import { createMockExtendedVtxo } from "../contracts/helpers";

const STATIC_KEY_HEX = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
const SERVER_PUBKEY_HEX = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const mockArkInfo = {
    signerPubkey: SERVER_PUBKEY_HEX,
    forfeitPubkey: SERVER_PUBKEY_HEX,
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

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

/** Disposed after every test so a leaked wallet cannot poll a mocked fetch. */
const openWallets: Array<{ dispose: () => Promise<void> | void }> = [];

beforeEach(() => {
    MockEventSource.reset();
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) => Promise.resolve(jsonResponse(body));
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        return reply([]);
    });
});

afterEach(async () => {
    for (const wallet of openWallets.splice(0)) await wallet.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** A real wallet inside the worker, and the page-side wallet that talks to it. */
async function makePair() {
    const identity = SingleKey.fromHex(STATIC_KEY_HEX);
    const walletRepository = new InMemoryWalletRepository();
    const inner = await Wallet.create({
        identity,
        walletMode: "static",
        arkServerUrl: "http://localhost:7070",
        storage: { walletRepository, contractRepository: new InMemoryContractRepository() },
    });
    openWallets.push(inner);

    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = inner;
    const { navigatorServiceWorker, serviceWorker } = createHandlerBackedBus(handler);
    vi.stubGlobal("navigator", { serviceWorker: navigatorServiceWorker } as any);

    const sw = new (ServiceWorkerReadonlyWallet as any)(
        serviceWorker as unknown as ServiceWorker,
        identity,
        walletRepository,
        new InMemoryContractRepository(),
        DEFAULT_MESSAGE_TAG,
    ) as ServiceWorkerReadonlyWallet;

    return { inner, sw, serviceWorker, walletRepository };
}

describe("getStoredVtxosForContract through the service worker", () => {
    it("reads spent rows from worker storage in one letter, without the indexer", async () => {
        const { inner, sw, serviceWorker, walletRepository } = await makePair();

        // a spent coin already stored under one of the wallet's own contracts
        const innerManager = await inner.getContractManager();
        const [contract] = await innerManager.getContracts({ type: "default" });
        const spentBy = "cc".repeat(32);
        await walletRepository.saveVtxos(contract.address, [
            createMockExtendedVtxo({ script: contract.script, isSpent: true, spentBy }),
        ]);

        // building the proxy sends its own sync-state probe, which is not ours to count
        const manager = await sw.getContractManager();
        serviceWorker.postMessage.mockClear();
        mockFetch.mockClear();

        // a full row, carrying a bigint that JSON cannot serialize
        const row = { ...contract, metadata: { amount: BigInt(5) } };
        const vtxos = await manager.getStoredVtxosForContract!(row);

        expect(vtxos).toHaveLength(1);
        expect(vtxos[0]).toMatchObject({ isSpent: true, spentBy, contractScript: contract.script });

        // exactly one letter, carrying only what the worker needs
        const letters = serviceWorker.postMessage.mock.calls.map(([message]) => message);
        expect(letters.map((message) => message.type)).toEqual(["GET_STORED_VTXOS_FOR_CONTRACT"]);
        expect(letters[0].payload.contract).toEqual({
            script: contract.script,
            address: contract.address,
        });

        // nothing went to the indexer while answering
        const isIndexerRead = (url: unknown) => String(url).includes("/v1/indexer/vtxos");
        expect(mockFetch.mock.calls.filter(([url]) => isIndexerRead(url))).toHaveLength(0);
    });
});
