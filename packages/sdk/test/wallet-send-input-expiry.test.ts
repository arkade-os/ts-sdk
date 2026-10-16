import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    SingleKey,
    RestArkProvider,
    RestIndexerProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    ServiceWorkerWallet,
    WalletMessageHandler,
    SendDeadlineExceededError,
    type ExtendedVirtualCoin,
    type SendParams,
} from "../src";
import { normalizeVtxo } from "../src/wallet/vtxo";
import { jsonResponse } from "./helpers/response";
import { MockEventSource } from "./mocks/eventSource";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("../src/utils/fetch", async (original) => ({
    ...(await original<typeof import("../src/utils/fetch")>()),
    fetch: mockFetch,
    baseFetch: mockFetch,
}));
const ARK_INFO = {
    signerPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    forfeitPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    batchExpiry: 144n,
    unilateralExitDelay: 144n,
    boardingExitDelay: 144n,
    roundInterval: 144n,
    network: "mutinynet",
    dust: 1000n,
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};
const wallets: Wallet[] = [];
async function makeWallet() {
    const wallet = await Wallet.create({
        identity: SingleKey.fromHex(
            "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2",
        ),
        arkProvider: new RestArkProvider("http://localhost:7070"),
        indexerProvider: new RestIndexerProvider("http://localhost:7070"),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    wallets.push(wallet);
    const submit = vi.spyOn(wallet as any, "_submitOffchainSpend").mockResolvedValue("sent");
    return { wallet, submit };
}
function coin(
    wallet: Wallet,
    index: number,
    expiry: Partial<ExtendedVirtualCoin>,
): ExtendedVirtualCoin {
    const tree = wallet.offchainTapscript;
    return {
        txid: index.toString(16).padStart(64, "0"),
        vout: 0,
        value: 50_000,
        status: { confirmed: true },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        script: hex.encode(tree.pkScript),
        forfeitTapLeafScript: tree.forfeit(),
        intentTapLeafScript: tree.forfeit(),
        tapTree: tree.encode(),
        ...expiry,
    };
}
function params(wallet: Wallet, inputExpiryFloor: unknown, selectedVtxos?: ExtendedVirtualCoin[]) {
    return {
        recipients: [{ address: wallet.arkAddress.encode(), amount: 2000 }],
        inputExpiryFloor,
        ...(selectedVtxos ? { selectedVtxos } : {}),
    } as SendParams;
}
function pageFor(
    wallet: Wallet,
    mutate?: (response: any, request: any, worker: any) => { data: any; source: any }[],
) {
    const handler = new WalletMessageHandler();
    (handler as any).readonlyWallet = wallet;
    (handler as any).wallet = wallet;
    const listeners = new Set<(event: any) => void>();
    const worker = {
        postMessage: vi.fn((request: any) => {
            void handler.handleMessage(structuredClone(request)).then((response) => {
                const cloned = structuredClone(response);
                for (const event of mutate?.(cloned, request, worker) ?? [
                    { data: cloned, source: worker },
                ]) {
                    for (const listener of [...listeners]) listener(event);
                }
            });
        }),
    };
    vi.stubGlobal("navigator", {
        serviceWorker: {
            addEventListener: (_type: string, listener: (event: any) => void) =>
                listeners.add(listener),
            removeEventListener: (_type: string, listener: (event: any) => void) =>
                listeners.delete(listener),
        },
    });
    const page = new (ServiceWorkerWallet as any)(
        worker,
        wallet.identity,
        new InMemoryWalletRepository(),
        new InMemoryContractRepository(),
        handler.messageTag,
        false,
    ) as ServiceWorkerWallet;
    return { page, worker, handler };
}

beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        if (url.includes("/info")) return Promise.resolve(jsonResponse(ARK_INFO));
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return Promise.resolve(jsonResponse({ subscriptionId: "sub-1" }));
        if (url.includes("vtxo") || url.includes("scripts"))
            return Promise.resolve(jsonResponse({ vtxos: [] }));
        return Promise.resolve(jsonResponse([]));
    });
});
afterEach(async () => {
    await Promise.all(wallets.splice(0).map((wallet) => wallet.dispose()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("Wallet.send inputExpiryFloor", () => {
    it.each([
        ["time", 4_102_444_800n, { expiresAt: new Date("2100-01-01") }, true],
        ["time", 4_102_444_801n, { expiresAt: new Date("2100-01-01") }, false],
        ["time", 4_102_444_799n, { expiresAt: new Date("2100-01-01") }, true],
        ["height", 900_000n, { expiresAtHeight: 900_000 }, true],
        ["height", 900_001n, { expiresAtHeight: 900_000 }, false],
        ["height", 899_999n, { expiresAtHeight: 900_000 }, true],
    ] as const)("enforces explicit %s floor %s", async (kind, value, expiry, accepted) => {
        const { wallet, submit } = await makeWallet();
        const input = coin(wallet, 1, expiry);
        const send = wallet.send(params(wallet, { kind, value }, [input]));
        if (accepted) {
            await expect(send).resolves.toBe("sent");
            expect(submit.mock.calls[0][0]).toEqual([normalizeVtxo(input)]);
        } else {
            await expect(send).rejects.toThrow("input expiry floor");
            expect(submit).not.toHaveBeenCalled();
        }
    });

    it.each(["2100-01-01T00:00:00.000Z", 4_102_444_800_000])(
        "normalizes explicit JSON expiry %s before checking and submitting",
        async (expiresAt) => {
            const { wallet, submit } = await makeWallet();
            const input = coin(wallet, 1, { expiresAt } as never);
            await expect(
                wallet.send(params(wallet, { kind: "time", value: 4_102_444_800n }, [input])),
            ).resolves.toBe("sent");
            expect(submit.mock.calls[0][0]).toEqual([normalizeVtxo(input)]);
            expect(input.expiresAt).toBe(expiresAt);
        },
    );

    it.each([
        {},
        { expiresAt: new Date("invalid") },
        { expiresAtHeight: 1.5 },
        { expiresAtHeight: 900_000, expiresAt: new Date("2100-01-01") },
        { expiresAt: new Date("2100-01-01") },
    ])("refuses unknown, ambiguous or wrong-domain explicit expiry %#", async (expiry) => {
        const { wallet, submit } = await makeWallet();
        await expect(
            wallet.send(
                params(wallet, { kind: "height", value: 900_000n }, [
                    coin(wallet, 1, { expiresAtHeight: 900_000 }),
                    coin(wallet, 2, expiry),
                ]),
            ),
        ).rejects.toThrow("input expiry floor");
        expect(submit).not.toHaveBeenCalled();
    });

    it.each(["time", "height"] as const)(
        "filters mixed inventory before native %s selection",
        async (kind) => {
            const { wallet, submit } = await makeWallet();
            const time = new Date("2100-01-01");
            const floor = { kind, value: kind === "time" ? 4_102_444_800n : 900_000n };
            const valid = coin(
                wallet,
                6,
                kind === "time" ? { expiresAt: time } : { expiresAtHeight: 900_000 },
            );
            const candidates = [
                coin(wallet, 1, {}),
                coin(wallet, 2, { expiresAt: new Date("2099-01-01"), expiresAtHeight: 900_000 }),
                coin(wallet, 3, { expiresAt: new Date("2099-01-01") }),
                coin(wallet, 4, { expiresAtHeight: 899_999 }),
                coin(
                    wallet,
                    5,
                    kind === "time" ? { expiresAtHeight: 900_000 } : { expiresAt: time },
                ),
                valid,
                coin(
                    wallet,
                    7,
                    kind === "time"
                        ? { expiresAt: new Date("2101-01-01") }
                        : { expiresAtHeight: 900_001 },
                ),
            ];
            const inventory = vi
                .spyOn(wallet, "getSpendableVtxos")
                .mockResolvedValue(candidates.map(normalizeVtxo));
            await expect(wallet.send(params(wallet, floor))).resolves.toBe("sent");
            expect(inventory).toHaveBeenCalledWith({
                withRecoverable: false,
                genericallySpendableOnly: true,
            });
            expect(submit.mock.calls[0][0]).toEqual([normalizeVtxo(valid)]);
        },
    );

    it("does not reach for short inputs to cover an eligible-input shortfall", async () => {
        const { wallet, submit } = await makeWallet();
        const eligible = coin(wallet, 1, { expiresAtHeight: 900_000, value: 1000 });
        const short = coin(wallet, 2, { expiresAtHeight: 899_999 });
        vi.spyOn(wallet, "getSpendableVtxos").mockResolvedValue(
            [eligible, short].map(normalizeVtxo),
        );
        await expect(
            wallet.send(params(wallet, { kind: "height", value: 900_000n })),
        ).rejects.toThrow("Insufficient funds");
        expect(submit).not.toHaveBeenCalled();
    });

    it("keeps native asset selection and exact change within eligible inventory", async () => {
        const { wallet, submit } = await makeWallet();
        const assetId = "aa".repeat(32) + "0000";
        const inputs = [
            coin(wallet, 1, { expiresAtHeight: 899_999, assets: [{ assetId, amount: 100n }] }),
            coin(wallet, 2, { expiresAtHeight: 900_000, assets: [{ assetId, amount: 9n }] }),
            coin(wallet, 3, { expiresAtHeight: 900_001 }),
        ];
        vi.spyOn(wallet, "getSpendableVtxos").mockResolvedValue(inputs.map(normalizeVtxo));
        const request = params(wallet, { kind: "height", value: 900_000n });
        request.recipients[0].assets = [{ assetId, amount: 5n }];
        await expect(wallet.send(request)).resolves.toBe("sent");
        expect(submit.mock.calls[0][0]).toEqual([normalizeVtxo(inputs[1])]);
        expect(submit.mock.calls[0][2]).toMatchObject({ changeAssets: [{ assetId, amount: 4n }] });
    });

    it("captures the caller floor before waiting for the transaction lock", async () => {
        const { wallet, submit } = await makeWallet();
        let release!: () => void;
        (wallet as any)._txLock = new Promise<void>((done) => {
            release = done;
        });
        const floor = { kind: "height", value: 900_000n };
        const request = params(wallet, floor, [coin(wallet, 1, { expiresAtHeight: 899_999 })]);
        const pending = wallet.send(request);
        floor.kind = "time";
        floor.value = 1n;
        (request as any).inputExpiryFloor = undefined;
        release();
        await expect(pending).rejects.toThrow("input expiry floor");
        expect(submit).not.toHaveBeenCalled();
    });

    it.each([
        null,
        {},
        { kind: "blocks", value: 1n },
        { kind: "height", value: 0n },
        { kind: "time", value: -1n },
        { kind: "time", value: 1 },
    ])("rejects malformed floor before queuing %#", async (floor) => {
        const { wallet, submit } = await makeWallet();
        const lock = vi.spyOn(wallet as any, "_withTxLock");
        await expect(wallet.send(params(wallet, floor))).rejects.toThrow("inputExpiryFloor");
        expect(lock).not.toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
    });

    it("leaves default sends with unknown expiry unchanged", async () => {
        const { wallet, submit } = await makeWallet();
        const input = coin(wallet, 1, {});
        await expect(
            wallet.send({
                recipients: params(wallet, undefined).recipients,
                selectedVtxos: [input],
            }),
        ).resolves.toBe("sent");
        expect(submit.mock.calls[0][0]).toEqual([input]);
    });
});

describe("ServiceWorkerWallet inputExpiryFloor", () => {
    it.each([undefined, 4_102_444_800])(
        "forwards the captured bigint floor and optional deadline %s",
        async (validUntil) => {
            const { wallet } = await makeWallet();
            const send = vi.spyOn(wallet, "send").mockResolvedValue("sent");
            const { page, worker } = pageFor(wallet);
            const floor = { kind: "height", value: 900_000n };
            const request = {
                ...params(wallet, floor),
                ...(validUntil === undefined ? {} : { validUntil }),
            };
            const pending = page.send(request);
            floor.kind = "time";
            floor.value = 1n;
            request.validUntil = 1;
            await expect(pending).resolves.toBe("sent");
            expect(worker.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
                "SEND_WITH_INPUT_EXPIRY_FLOOR",
            ]);
            expect(send).toHaveBeenCalledWith(
                expect.objectContaining({
                    inputExpiryFloor: { kind: "height", value: 900_000n },
                    ...(validUntil === undefined ? {} : { validUntil }),
                }),
            );
            expect(worker.postMessage.mock.calls[0][0].payload.inputExpiryFloor).toEqual({
                kind: "height",
                value: 900_000n,
            });
        },
    );

    it("rejects constrained input expiry in the real worker send path", async () => {
        const { wallet, submit } = await makeWallet();
        const { page, worker } = pageFor(wallet);
        await expect(
            page.send(
                params(wallet, { kind: "height", value: 900_000n }, [
                    coin(wallet, 1, { expiresAtHeight: 899_999 }),
                ]),
            ),
        ).rejects.toThrow("input expiry floor");
        expect(submit).not.toHaveBeenCalled();
        expect(worker.postMessage.mock.calls[0][0].type).toBe("SEND_WITH_INPUT_EXPIRY_FLOOR");
    });

    it("refuses an old worker without retrying an unconstrained send", async () => {
        const { wallet, submit } = await makeWallet();
        const { page, worker, handler } = pageFor(wallet);
        vi.spyOn(handler, "handleMessage").mockImplementation(
            async (message) =>
                ({
                    id: message.id,
                    tag: message.tag,
                    error: new Error("Unsupported message type"),
                }) as never,
        );
        await expect(
            page.send(params(wallet, { kind: "height", value: 900_000n })),
        ).rejects.toThrow("Unsupported message type");
        expect(worker.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
            "SEND_WITH_INPUT_EXPIRY_FLOOR",
        ]);
        expect(submit).not.toHaveBeenCalled();
    });

    it.each([undefined, null, { kind: "height", value: 0n }, { kind: "height", value: 900_000 }])(
        "refuses malformed constrained worker payload %# before calling send",
        async (inputExpiryFloor) => {
            const { wallet, submit } = await makeWallet();
            const send = vi.spyOn(wallet, "send");
            const { handler } = pageFor(wallet);
            const response = await handler.handleMessage({
                id: "malformed-floor",
                tag: handler.messageTag,
                type: "SEND_WITH_INPUT_EXPIRY_FLOOR",
                payload: { recipients: params(wallet, undefined).recipients, inputExpiryFloor },
            } as never);
            expect(response.error).toBeInstanceOf(TypeError);
            expect(send).not.toHaveBeenCalled();
            expect(submit).not.toHaveBeenCalled();
        },
    );

    it("rejects a malformed page floor before posting any message", async () => {
        const { wallet } = await makeWallet();
        const { page, worker } = pageFor(wallet);
        await expect(page.send(params(wallet, { kind: "height", value: 1 }))).rejects.toThrow(
            "inputExpiryFloor",
        );
        expect(worker.postMessage).not.toHaveBeenCalled();
    });

    it.each([
        "source",
        "id",
        "tag",
        "deadline",
        "broadcast",
        "missing-error",
        "missing-deadline",
        "string-deadline",
        "untimed",
    ])("does not brand a %s mismatch as constrained-send deadline proof", async (change) => {
        const { wallet, submit } = await makeWallet();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_001_000);
        const { page } = pageFor(wallet, (response, request, worker) => {
            const forged = {
                ...response,
                type: "SEND_DEADLINE_EXCEEDED",
                payload: { validUntil: 1_700_000_001 },
            };
            const event = { data: forged, source: worker };
            if (change === "source") event.source = {};
            if (change === "id") forged.id = "unrelated";
            if (change === "tag") forged.tag = "unrelated";
            if (change === "deadline") forged.payload.validUntil++;
            if (change === "broadcast") forged.broadcast = true;
            if (change === "missing-error") delete forged.error;
            if (change === "missing-deadline") delete (forged as any).payload;
            if (change === "string-deadline") (forged.payload as any).validUntil = "1700000001";
            return [
                event,
                {
                    source: worker,
                    data: {
                        id: request.id,
                        tag: request.tag,
                        error: new Error("unconfirmed refusal"),
                    },
                },
            ];
        });
        const request = {
            ...params(wallet, { kind: "height", value: 900_000n }, [
                coin(wallet, 1, { expiresAtHeight: 899_999 }),
            ]),
            ...(change === "untimed" ? {} : { validUntil: 1_700_000_001 }),
        };
        const error = await page.send(request).catch((value) => value);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(SendDeadlineExceededError);
        expect(submit).not.toHaveBeenCalled();
    });

    it("preserves authenticated deadline refusal on a floor-constrained send", async () => {
        const { wallet, submit } = await makeWallet();
        vi.spyOn(Date, "now").mockReturnValue(1_700_000_001_000);
        const { page, worker } = pageFor(wallet);
        await expect(
            page.send({
                ...params(wallet, { kind: "height", value: 900_000n }, [
                    coin(wallet, 1, { expiresAtHeight: 900_000 }),
                ]),
                validUntil: 1_700_000_001,
            }),
        ).rejects.toBeInstanceOf(SendDeadlineExceededError);
        expect(submit).not.toHaveBeenCalled();
        expect(worker.postMessage.mock.calls[0][0].payload).toMatchObject({
            inputExpiryFloor: { kind: "height", value: 900_000n },
            validUntil: 1_700_000_001,
        });
    });
});
