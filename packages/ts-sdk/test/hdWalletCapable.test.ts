import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    isHDWalletCapable,
} from "../src";
import { deriveDescriptorLeafCompressedPubKey } from "../src/identity/descriptor";
import { HDDescriptorProvider } from "../src/wallet/hdDescriptorProvider";

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
        const reply = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
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

function makeWallet(opts: { hd: boolean; contractRepo?: InMemoryContractRepository }) {
    return Wallet.create({
        identity: opts.hd
            ? MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet: false })
            : SingleKey.fromHex("ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2"),
        walletMode: opts.hd ? "hd" : "static",
        arkServerUrl: "http://localhost:7070",
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: opts.contractRepo ?? new InMemoryContractRepository(),
        },
    });
}

describe("HDWalletCapable", () => {
    it("Wallet passes the capability probe", async () => {
        const wallet = await makeWallet({ hd: true });
        expect(isHDWalletCapable(wallet)).toBe(true);
        await wallet.dispose();
    });

    it("a static wallet reports no HD state and signs with its identity", async () => {
        const wallet = await makeWallet({ hd: false });
        expect(await wallet.getCurrentSigningDescriptor()).toBeUndefined();
        expect(await wallet.getUsedSigningDescriptors()).toEqual([]);
        expect(await wallet.signerForDescriptor("tr(deadbeef)")).toBe(wallet.identity);
        await wallet.dispose();
    });

    it("a fresh HD wallet is bound to index 0", async () => {
        const wallet = await makeWallet({ hd: true });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
        expect(await wallet.getCurrentSigningDescriptor()).toBe(
            provider.materializeDescriptorAt(0),
        );
        expect(await wallet.getUsedSigningDescriptors()).toEqual([
            provider.materializeDescriptorAt(0),
        ]);
        await wallet.dispose();
    });

    it("enumerates the whole watermark band, ascending", async () => {
        const wallet = await makeWallet({ hd: true });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
        await provider.advanceLastIndexUsed(3);
        expect(await wallet.getUsedSigningDescriptors()).toEqual(
            [0, 1, 2, 3].map((i) => provider.materializeDescriptorAt(i)),
        );
        await wallet.dispose();
    });

    it("includes descriptors persisted on contracts beyond the watermark", async () => {
        const contractRepo = new InMemoryContractRepository();
        const wallet = await makeWallet({ hd: true, contractRepo });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
        const outOfBand = provider.materializeDescriptorAt(9);
        await contractRepo.saveContract({
            id: "restored-9",
            type: "default",
            params: {},
            script: "00",
            address: "ark1restored",
            state: "active",
            createdAt: Date.now(),
            metadata: { signingDescriptor: outOfBand },
        } as any);

        expect(await wallet.getUsedSigningDescriptors()).toEqual([
            provider.materializeDescriptorAt(0),
            outOfBand,
        ]);
        await wallet.dispose();
    });

    it("signerForDescriptor scopes keys to the descriptor", async () => {
        const wallet = await makeWallet({ hd: true });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
        const descriptor = provider.materializeDescriptorAt(4);
        const signer = await wallet.signerForDescriptor(descriptor);

        expect(hex.encode(await signer.compressedPublicKey())).toBe(
            hex.encode(deriveDescriptorLeafCompressedPubKey(descriptor)),
        );
        expect(hex.encode(await signer.compressedPublicKey())).not.toBe(
            hex.encode(await wallet.identity.compressedPublicKey()),
        );
        await wallet.dispose();
    });

    it("signerForDescriptor falls back to the identity for a foreign descriptor", async () => {
        const wallet = await makeWallet({ hd: true });
        const foreign = MnemonicIdentity.fromMnemonic(
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
            { isMainnet: false },
        ).descriptor.replace("/*)", "/0)");
        expect(await wallet.signerForDescriptor(foreign)).toBe(wallet.identity);
        await wallet.dispose();
    });
});
