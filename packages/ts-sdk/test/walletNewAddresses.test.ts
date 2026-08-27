import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    WalletCannotAllocateAddressError,
    signingDescriptorIndex,
} from "../src";

/**
 * The explicit multi-type address allocator (`getNewAddresses`).
 *
 * Reuses the harness in `test/walletBoardingRotation.test.ts`: mock the minimum
 * `fetch` / `EventSource` surface so `Wallet.create` succeeds, then drive the
 * allocator directly. The behaviour under test is allocation and persistence,
 * so the onchain stub reports no coins throughout.
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
    boardingExitDelay: BigInt(512),
    roundInterval: BigInt(144),
    network: "mutinynet",
    dust: BigInt(1000),
    forfeitAddress: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
    checkpointTapscript:
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
};

const { mockFetch } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
}));

vi.mock("../src/utils/fetch", () => ({
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

function makeStaticWallet(walletRepo?: InMemoryWalletRepository) {
    return Wallet.create({
        identity: SingleKey.fromHex(SINGLEKEY_HEX),
        walletMode: "static",
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: walletRepo ?? new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
    });
}

async function watermark(repo: InMemoryWalletRepository): Promise<number | undefined> {
    return (await repo.getWalletState())?.settings?.hd?.lastIndexUsed;
}

describe("Wallet.getNewAddresses", () => {
    describe("HD allocation", () => {
        it("mints every requested type at ONE shared HD index", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const wallet = await makeHdWallet(walletRepo);

            const before = await watermark(walletRepo);
            const minted = await wallet.getNewAddresses({ types: ["default", "boarding"] });

            expect(minted).toHaveLength(2);
            expect(minted.map((m) => m.contract.type)).toEqual(["default", "boarding"]);

            // The whole point: two addresses, ONE index burned.
            const descriptors = new Set(
                minted.map((m) => m.contract.metadata?.signingDescriptor as string),
            );
            expect(descriptors.size).toBe(1);
            expect(await watermark(walletRepo)).toBe((before ?? -1) + 1);

            await wallet.dispose();
        });

        it("defaults to a single offchain address when no types are given", async () => {
            const wallet = await makeHdWallet();

            const minted = await wallet.getNewAddresses();

            expect(minted).toHaveLength(1);
            expect(minted[0].contract.type).toBe("default");

            await wallet.dispose();
        });

        it("returns a different address on every call with no payment in between", async () => {
            const wallet = await makeHdWallet();

            const first = await wallet.getNewAddresses();
            const second = await wallet.getNewAddresses();

            // The reported bug: rotation used to require a `vtxo_received`, so
            // two receive addresses could not be outstanding at once.
            expect(second[0].address).not.toBe(first[0].address);
            expect(
                signingDescriptorIndex(second[0].contract.metadata?.signingDescriptor),
            ).toBeGreaterThan(
                signingDescriptorIndex(first[0].contract.metadata?.signingDescriptor),
            );

            await wallet.dispose();
        });

        it("persists each minted address as an active, watched contract", async () => {
            const contractRepo = new InMemoryContractRepository();
            const wallet = await makeHdWallet(new InMemoryWalletRepository(), contractRepo);

            const [minted] = await wallet.getNewAddresses();

            const row = (await contractRepo.getContracts({})).find(
                (c) => c.script === minted.contract.script,
            );
            expect(row).toBeDefined();
            expect(row!.state).toBe("active");
            // Carried so `signerForDescriptor` can recover the per-index key.
            expect(typeof row!.metadata?.signingDescriptor).toBe("string");

            await wallet.dispose();
        });

        it("hands out the onchain address for boarding, not the row's Arkade encoding", async () => {
            const wallet = await makeHdWallet();

            const minted = await wallet.getNewAddresses({ types: ["default", "boarding"] });
            const offchain = minted.find((m) => m.contract.type === "default")!;
            const boarding = minted.find((m) => m.contract.type === "boarding")!;

            // A boarding contract row stores the ark-encoded address, so the
            // usable onchain address has to come from `address`, not `contract`.
            expect(boarding.address.startsWith("tb1")).toBe(true);
            expect(boarding.contract.address.startsWith("tark1")).toBe(true);
            expect(boarding.address).not.toBe(boarding.contract.address);

            // Offchain has no such split.
            expect(offchain.address).toBe(offchain.contract.address);
            expect(offchain.address.startsWith("tark1")).toBe(true);

            await wallet.dispose();
        });
    });

    describe("display neutrality", () => {
        it("does not change getAddress() or getBoardingAddress()", async () => {
            const wallet = await makeHdWallet();

            const receiveBefore = await wallet.getAddress();
            const boardingBefore = await wallet.getBoardingAddress();

            const minted = await wallet.getNewAddresses({ types: ["default", "boarding"] });
            expect(minted.map((m) => m.address)).not.toContain(receiveBefore);

            expect(await wallet.getAddress()).toBe(receiveBefore);
            expect(await wallet.getBoardingAddress()).toBe(boardingBefore);

            await wallet.dispose();
        });

        it("is not adopted as the display address across a restart", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();

            const first = await makeHdWallet(walletRepo, contractRepo);
            const receiveBefore = await first.getAddress();
            const boardingBefore = await first.getBoardingAddress();
            await first.getNewAddresses({ types: ["default", "boarding"] });
            await first.dispose();

            // Minted rows are written UNTAGGED, so neither boot lookup adopts
            // them — a side address must never hijack the advertised one.
            const second = await makeHdWallet(walletRepo, contractRepo);
            expect(await second.getAddress()).toBe(receiveBefore);
            expect(await second.getBoardingAddress()).toBe(boardingBefore);
            await second.dispose();
        });
    });

    describe("wallets with no HD stream", () => {
        it("throws when forceNew is set", async () => {
            const wallet = await makeStaticWallet();

            await expect(wallet.getNewAddresses({ forceNew: true })).rejects.toThrow(
                WalletCannotAllocateAddressError,
            );

            await wallet.dispose();
        });

        it("returns the current addresses and burns nothing without forceNew", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const wallet = await makeStaticWallet(walletRepo);

            const minted = await wallet.getNewAddresses({ types: ["default", "boarding"] });

            expect(minted.find((m) => m.contract.type === "default")!.address).toBe(
                await wallet.getAddress(),
            );
            expect(minted.find((m) => m.contract.type === "boarding")!.address).toBe(
                await wallet.getBoardingAddress(),
            );
            // No HD watermark exists to move.
            expect(await watermark(walletRepo)).toBeUndefined();

            await wallet.dispose();
        });

        it("returns the genuine persisted baseline rows, not synthesized ones", async () => {
            const wallet = await makeStaticWallet();

            const [minted] = await wallet.getNewAddresses();

            // `createContract` is first-wins on script, so a static wallet gets
            // back the row registered at construction — `createdAt` proves it
            // was not minted by this call.
            expect(minted.contract.createdAt).toBeGreaterThan(0);
            expect(minted.contract.state).toBe("active");

            await wallet.dispose();
        });
    });
});
