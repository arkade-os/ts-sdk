import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    MnemonicIdentity,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
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
        "5ab27520e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdbac",
};

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../../src/utils/fetch", () => ({
    fetch: mockFetch,
    baseFetch: mockFetch,
}));

const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));

beforeEach(() => {
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) =>
            Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        return reply([]);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// Taproot scriptPubKey the wallet does not own — simulates an unresolved boarding script.
const FOREIGN_BOARDING_SCRIPT = new Uint8Array([
    0x51,
    0x20,
    ...hex.decode("4b19fd86e7e906094334b7f683aad231d472979a6109fba34b3a49fe0ea80df9"),
]);

describe("unsignable boarding input diagnostic", () => {
    it("names the outpoint, the unresolved boarding address, and the recognized boarding set", async () => {
        const wallet = await Wallet.create({
            identity: MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false }),
            walletMode: "hd",
            arkServerUrl: "http://localhost:7070",
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
        });

        const recognized = await wallet.getBoardingAddress();

        const msg = await (wallet as any).unsignableBoardingInputError(
            { txid: "0c2a677ca31a50d1745b9f49d43756b8a274e751e957d9cb7271960f87649243", vout: 2 },
            FOREIGN_BOARDING_SCRIPT,
        );

        expect(msg).toContain("0c2a677ca31a50d1745b9f49d43756b8a274e751e957d9cb7271960f87649243:2");
        expect(msg).toContain(hex.encode(FOREIGN_BOARDING_SCRIPT));
        expect(msg).toContain("not a wallet script");
        expect(msg).toContain(recognized);

        await wallet.dispose();
    });

    it("never throws while building the error, even on an undecodable script", async () => {
        const wallet = await Wallet.create({
            identity: MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false }),
            walletMode: "hd",
            arkServerUrl: "http://localhost:7070",
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
            },
        });

        const garbage = new Uint8Array([0x00, 0x01, 0x02]);
        const msg = await (wallet as any).unsignableBoardingInputError(
            { txid: "deadbeef", vout: 0 },
            garbage,
        );
        expect(msg).toContain("deadbeef:0");
        expect(msg).toContain("<undecodable>");

        await wallet.dispose();
    });
});
