import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("@arkade-os/sdk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@arkade-os/sdk")>()),
    Wallet: { create: (...args: unknown[]) => create(...args) },
}));

vi.mock("sats-connect", () => ({
    getProviders: () => [],
    request: vi.fn(),
    signMultipleTransactions: vi.fn(),
    AddressPurpose: { Ordinals: "ordinals", Payment: "payment" },
    BitcoinNetworkType: { Mainnet: "Mainnet", Testnet: "Testnet", Signet: "Signet" },
}));

const { ArkadeWallet } = await import("../src/wallet/ArkadeWallet");

const ARK_ADDRESS =
    "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameehwpteq6u430ehtk9pz3vpd8j4vee8m2sxdvc83ss87xye4cf43k0pwhj6";
const APPROVED = {
    status: "success",
    result: {
        addresses: [
            { purpose: "payment", address: "bc1qpayment" },
            { purpose: "ordinals", address: "bc1pordinals", publicKey: `02${"11".repeat(32)}` },
        ],
    },
};

function fakeWallet() {
    return {
        getAddress: vi.fn(async () => ARK_ADDRESS),
        getBoardingAddress: vi.fn(async () => "bc1pboarding"),
        send: vi.fn(async () => "txid"),
        dispose: vi.fn(async () => {}),
    };
}

/** A wallet_connect prompt the test answers when it chooses. */
function deferredPrompt() {
    let approve: (value: unknown) => void = () => {};
    const request = vi.fn(async (method: string) =>
        method === "wallet_connect" && request.mock.calls.length === 1
            ? new Promise((resolve) => {
                  approve = resolve;
              })
            : APPROVED,
    );
    return { request, approve: () => approve(APPROVED) };
}

const configWith = (request: unknown, arkServerUrl = "https://arkade.computer") => ({
    arkServerUrl,
    esploraUrl: "https://mempool.space/api",
    checkProvider: false,
    satsConnectRequest: request as never,
});

describe("ArkadeWallet", () => {
    beforeEach(() => {
        create.mockReset();
        create.mockImplementation(async () => fakeWallet());
    });

    it("drops a connection that reset() superseded", async () => {
        const prompt = deferredPrompt();
        const arkWallet = new ArkadeWallet(configWith(prompt.request));

        const connecting = arkWallet.connect();
        arkWallet.reset();
        prompt.approve();

        await expect(connecting).rejects.toThrow("superseded");
        expect(arkWallet.getWallet()).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it("drops a connection whose config changed mid-prompt", async () => {
        const prompt = deferredPrompt();
        const arkWallet = new ArkadeWallet(configWith(prompt.request));

        const connecting = arkWallet.connect();
        arkWallet.updateConfig(configWith(prompt.request, "https://other.example"));
        prompt.approve();

        await expect(connecting).rejects.toThrow("superseded");
        expect(arkWallet.getWallet()).toBeNull();
    });

    it("disposes the SDK wallet when it resets", async () => {
        const arkWallet = new ArkadeWallet(configWith(vi.fn(async () => APPROVED)));
        await arkWallet.connect();
        const sdkWallet = arkWallet.getWallet() as unknown as ReturnType<typeof fakeWallet>;

        arkWallet.reset();

        expect(sdkWallet.dispose).toHaveBeenCalledOnce();
    });

    it("disposes the SDK wallet a second connect replaces", async () => {
        const arkWallet = new ArkadeWallet(configWith(vi.fn(async () => APPROVED)));
        await arkWallet.connect();
        const first = arkWallet.getWallet() as unknown as ReturnType<typeof fakeWallet>;

        await arkWallet.connect();
        const second = arkWallet.getWallet() as unknown as ReturnType<typeof fakeWallet>;

        expect(second).not.toBe(first);
        expect(first.dispose).toHaveBeenCalledOnce();
        expect(second.dispose).not.toHaveBeenCalled();
    });

    it("refuses fractional and unsafe amounts, and sends a whole one unchanged", async () => {
        const arkWallet = new ArkadeWallet(configWith(vi.fn(async () => APPROVED)));
        await arkWallet.connect();
        const sdkWallet = arkWallet.getWallet() as unknown as ReturnType<typeof fakeWallet>;

        for (const amount of [1e-7, 1.5, 2 ** 53, 0, -1]) {
            await expect(arkWallet.sendBitcoin(ARK_ADDRESS, amount)).rejects.toThrow(
                "positive whole number",
            );
        }
        await arkWallet.sendBitcoin(ARK_ADDRESS, 1_000);

        expect(sdkWallet.send).toHaveBeenCalledOnce();
        expect(sdkWallet.send).toHaveBeenCalledWith({ address: ARK_ADDRESS, amount: 1_000 });
    });
});
