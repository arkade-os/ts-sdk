import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    MnemonicIdentity,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";

/**
 * Regression for the boarding onboard failure that surfaced server-side as the
 * opaque arkd error "script ... is not a wallet script" (arkd-wallet
 * SignTransaction key-path branch): a boarding UTXO the wallet selected but
 * whose script the signer router could not resolve was *silently skipped*, so
 * its commitment-tx input reached the operator unsigned/leaf-less.
 *
 * The wallet now fails fast with a diagnostic naming the exact outpoint, the
 * unresolved boarding address, and the boarding addresses it *does* recognize.
 * This test pins that diagnostic (the harness mirrors walletBoardingRotation).
 */

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

// A taproot scriptPubKey (OP_1 <32-byte key>) for a boarding address the wallet
// does NOT own — stands in for the unresolved boarding script (e.g. a rotated
// boarding address whose contract row is missing from the repo).
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

        // Exact outpoint and script the operator would have rejected.
        expect(msg).toContain("0c2a677ca31a50d1745b9f49d43756b8a274e751e957d9cb7271960f87649243:2");
        expect(msg).toContain(hex.encode(FOREIGN_BOARDING_SCRIPT));
        // Maps the cryptic server error to its client-side cause.
        expect(msg).toContain("not a wallet script");
        // Surfaces what the wallet *can* sign, so the offender is classifiable
        // without introspecting wallet internals.
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

        // A non-taproot / undecodable script must degrade to a placeholder, not
        // throw — the signing error must never be masked by error-building.
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
