import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../src";

/**
 * Per-derivation boarding rotation (plan §6-II).
 *
 * Mirrors the harness in `test/walletHdRotation.test.ts`: mock the minimum
 * `fetch` / `EventSource` surface so `Wallet.create` succeeds, then drive the
 * explicit boarding allocator (`getNewBoardingAddress`) directly. Boarding
 * coins are always reported empty by the onchain stub, so these tests exercise
 * allocation / boot / receive-drift only — spending is covered elsewhere.
 */

const MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SINGLEKEY_HEX = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
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

const mockFetch = vi.fn();
const MockEventSource = vi.fn().mockImplementation((url: string) => ({
    url,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
}));

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("EventSource", MockEventSource);
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
        const reply = (body: unknown) =>
            Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        if (url.includes("/info")) return reply(mockArkInfo);
        if (url.includes("subscribe") || url.includes("subscriptions"))
            return reply({ subscriptionId: "sub-1" });
        if (url.includes("vtxo") || url.includes("scripts")) return reply({ vtxos: [] });
        // Esplora onchain (boarding coins, txs, …) — empty.
        return reply([]);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function makeHdWallet(
    walletRepo?: InMemoryWalletRepository,
    contractRepo?: InMemoryContractRepository,
) {
    return Wallet.create({
        identity: MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false }),
        walletMode: "hd",
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: walletRepo ?? new InMemoryWalletRepository(),
            contractRepository: contractRepo ?? new InMemoryContractRepository(),
        },
    });
}

describe("Wallet boarding rotation", () => {
    describe("static / auto (no rotation)", () => {
        it("getNewBoardingAddress returns the fixed index-0 boarding address — no index burned", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: SingleKey.fromHex(SINGLEKEY_HEX),
                walletMode: "static",
                arkServerUrl: "http://localhost:7070",
                storage: {
                    walletRepository: walletRepo,
                    contractRepository: new InMemoryContractRepository(),
                },
            });

            const fixed = await wallet.getBoardingAddress();
            const next = await wallet.getNewBoardingAddress();
            expect(next).toBe(fixed);
            // No HD watermark touched — static wallets never allocate.
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd).toBeUndefined();

            await wallet.dispose();
        });
    });

    describe("HD rotation", () => {
        it("getBoardingAddress is a stable read (does not burn an index)", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const wallet = await makeHdWallet(walletRepo);

            const a1 = await wallet.getBoardingAddress();
            const a2 = await wallet.getBoardingAddress();
            expect(a2).toBe(a1);

            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd?.lastIndexUsed).toBe(0);

            await wallet.dispose();
        });

        it("getNewBoardingAddress advances the index, persists a tagged boarding contract, and swaps the current tapscript", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(walletRepo, contractRepo);

            const before = await wallet.getBoardingAddress();
            const rotated = await wallet.getNewBoardingAddress();

            // A fresh boarding address (different HD index).
            expect(rotated).not.toBe(before);
            // The current display swapped to it.
            expect(await wallet.getBoardingAddress()).toBe(rotated);
            // Shared watermark advanced (boot allocated 0; boarding took 1).
            const state = await walletRepo.getWalletState();
            expect(state?.settings?.hd?.lastIndexUsed).toBe(1);

            // The rotated boarding script is persisted as a tagged, active
            // `boarding` contract.
            const rotatedScript = hexEncode(wallet.boardingTapscript.pkScript);
            const row = (await contractRepo.getContracts({})).find(
                (c) => c.script === rotatedScript,
            );
            expect(row).toBeDefined();
            expect(row!.type).toBe("boarding");
            expect(row!.state).toBe("active");
            expect(row!.metadata?.source).toBe("wallet-receive");
            expect(typeof row!.metadata?.signingDescriptor).toBe("string");

            await wallet.dispose();
        });

        it("boot restores the most recently allocated boarding address across restarts", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            const first = await makeHdWallet(walletRepo, contractRepo);
            const rotated = await first.getNewBoardingAddress();
            await first.dispose();

            // Restart on the same repos — boot picks the newest tagged
            // `boarding` contract and re-derives the boarding tapscript there.
            const second = await makeHdWallet(walletRepo, contractRepo);
            expect(await second.getBoardingAddress()).toBe(rotated);
            await second.dispose();
        });

        it("a boarding-only rotation does NOT drift the L2 receive address on reboot (receive-boot fix)", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            const first = await makeHdWallet(walletRepo, contractRepo);
            const receiveBefore = await first.getAddress();

            // Boarding allocation advances the shared watermark with NO L2
            // `vtxo_received`, so the L2 receive must stay at index 0.
            await first.getNewBoardingAddress();
            expect(await first.getAddress()).toBe(receiveBefore);
            const stateAfter = await walletRepo.getWalletState();
            expect(stateAfter?.settings?.hd?.lastIndexUsed).toBe(1);
            await first.dispose();

            // Reboot: the watermark is 1 (consumed by boarding) and there is no
            // tagged L2 receive row. The boot must resolve receive to the
            // baseline index-0 key, NOT the boarding-consumed index.
            const second = await makeHdWallet(walletRepo, contractRepo);
            expect(await second.getAddress()).toBe(receiveBefore);
            await second.dispose();
        });
    });
});

// Local hex encoder to avoid importing @scure/base just for one call.
function hexEncode(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
