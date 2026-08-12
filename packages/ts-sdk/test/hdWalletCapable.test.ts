import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    Wallet,
    MnemonicIdentity,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD,
    isHDWalletCapable,
    isHDAllocationCapable,
    ForeignDescriptorError,
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
        "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
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
        const own = `tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`;
        expect(await wallet.signerForDescriptor(own)).toBe(wallet.identity);
        // A key this wallet does not hold is a refusal, not a silent
        // substitution — the identity would sign with the wrong key.
        await expect(wallet.signerForDescriptor("tr(deadbeef)")).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
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

    it("keeps allocation a separate probe from descriptor awareness", async () => {
        // Widening `isHDWalletCapable` instead would demote every wallet
        // implementing only its original surface — an older SDK build, a
        // hand-rolled double — from HD-capable to static, silently.
        const readOnly = {
            getCurrentSigningDescriptor: async () => undefined,
            getUsedSigningDescriptors: async () => [],
            signerForDescriptor: async () => undefined,
        };
        expect(isHDWalletCapable(readOnly)).toBe(true);
        expect(isHDAllocationCapable(readOnly)).toBe(false);

        const wallet = await makeWallet({ hd: true });
        expect(isHDAllocationCapable(wallet)).toBe(true);
        await wallet.dispose();
    });

    it("allocates a fresh descriptor per call, never repeating one", async () => {
        // A peek would hand two artifacts the same key; anything deriving
        // per-artifact secrets from it would derive them identically.
        const wallet = await makeWallet({ hd: true });
        const allocated = [
            await wallet.getNextSigningDescriptor(),
            await wallet.getNextSigningDescriptor(),
            await wallet.getNextSigningDescriptor(),
        ];
        expect(new Set(allocated).size).toBe(3);
        expect(await wallet.getCurrentSigningDescriptor()).toBe(allocated[2]);
        await wallet.dispose();
    });

    it("a static wallet answers allocation with its one identity descriptor", async () => {
        // The wallet decides what "next" means: static policy is the same
        // key every time, answered through the same method — consumers never
        // branch on wallet shape, and never mint a key of their own.
        const wallet = await makeWallet({ hd: false });
        const own = `tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`;
        expect(await wallet.getNextSigningDescriptor()).toBe(own);
        expect(await wallet.getNextSigningDescriptor()).toBe(own);
        // The static descriptor round-trips: adoptable (no watermark to
        // move) and resolvable back to the identity.
        await wallet.advanceSigningDescriptorWatermark(own);
        expect(await wallet.signerForDescriptor(own)).toBe(wallet.identity);
        // Foreign descriptors stay refusals on the no-watermark arm too.
        await expect(wallet.advanceSigningDescriptorWatermark("tr(deadbeef)")).rejects.toThrow(
            /not derivable/,
        );
        await wallet.dispose();
    });

    describe("advanceSigningDescriptorWatermark", () => {
        it("skips a restored index so it cannot be allocated twice", async () => {
            const wallet = await makeWallet({ hd: true });
            const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;

            await wallet.advanceSigningDescriptorWatermark(provider.materializeDescriptorAt(7));

            expect(await wallet.getNextSigningDescriptor()).toBe(
                provider.materializeDescriptorAt(8),
            );
            await wallet.dispose();
        });

        it("never rewinds", async () => {
            const wallet = await makeWallet({ hd: true });
            const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
            await provider.advanceLastIndexUsed(5);

            await wallet.advanceSigningDescriptorWatermark(provider.materializeDescriptorAt(2));

            expect(await wallet.getNextSigningDescriptor()).toBe(
                provider.materializeDescriptorAt(6),
            );
            await wallet.dispose();
        });

        it("refuses a rangeable descriptor, which names no index at all", async () => {
            // `.../0/*)` is ours but concrete-index-free. The lenient parse
            // answers 0 for it, and 0 is a real index — so the watermark would
            // stay put while the call reported success.
            const wallet = await makeWallet({ hd: true });
            const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
            const ranged = provider.materializeDescriptorAt(0).replace(/\/\d+\)$/, "/*)");
            await provider.advanceLastIndexUsed(4);

            await expect(wallet.advanceSigningDescriptorWatermark(ranged)).rejects.toThrow(
                /no trailing child index/,
            );
            expect(await provider.getLastIndexUsed()).toBe(4);
            await wallet.dispose();
        });

        it("ignores an index past the BIP32 non-hardened ceiling", async () => {
            // Nothing can derive at or above 2^31, so persisting such a
            // watermark would brick the repo: every later allocation would
            // fail to materialize, permanently. Reached through the
            // contract-manager API, which takes a raw index and has no
            // `isOurs` gate in front of it.
            const wallet = await makeWallet({ hd: true });
            const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;
            await provider.advanceLastIndexUsed(4);

            for (const bad of [0x80000000, Number.MAX_SAFE_INTEGER, 1e20]) {
                await provider.advanceLastIndexUsed(bad);
                expect(await provider.getLastIndexUsed()).toBe(4);
            }
            expect(await wallet.getNextSigningDescriptor()).toBe(
                provider.materializeDescriptorAt(5),
            );
            await wallet.dispose();
        });

        it("refuses a descriptor from another seed", async () => {
            const wallet = await makeWallet({ hd: true });
            await expect(wallet.advanceSigningDescriptorWatermark("tr(deadbeef)")).rejects.toThrow(
                /not derivable/,
            );
            await wallet.dispose();
        });
    });

    it("appends look-ahead descriptors without moving the watermark", async () => {
        const wallet = await makeWallet({ hd: true });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;

        const probed = await wallet.getUsedSigningDescriptors({ lookAhead: 2 });

        expect(probed).toEqual([0, 1, 2].map((i) => provider.materializeDescriptorAt(i)));
        // An index nothing has claimed stays available to the next allocation.
        expect(await provider.getLastIndexUsed()).toBe(0);
        await wallet.dispose();
    });

    it("rejects non-finite look-ahead values", async () => {
        const wallet = await makeWallet({ hd: true });

        await expect(wallet.getUsedSigningDescriptors({ lookAhead: Infinity })).rejects.toThrow(
            /finite number/,
        );
        await wallet.dispose();
    });

    it("caps excessive finite look-ahead before materializing descriptors", async () => {
        const wallet = await makeWallet({ hd: true });
        const provider: HDDescriptorProvider = (wallet as any)._descriptorProvider;

        const probed = await wallet.getUsedSigningDescriptors({
            lookAhead: MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD + 500,
        });

        expect(probed).toHaveLength(MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD + 1);
        expect(probed.at(-1)).toBe(
            provider.materializeDescriptorAt(MAX_USED_SIGNING_DESCRIPTORS_LOOK_AHEAD),
        );
        expect(await provider.getLastIndexUsed()).toBe(0);
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

    it("signerForDescriptor refuses a foreign descriptor", async () => {
        // The old fallback answered with the baseline identity, which signs
        // happily with the wrong key — the failure then surfaces as a
        // rejected transaction far from this call. A typed refusal here is
        // what lets callers distinguish "not my key" from transient errors.
        const wallet = await makeWallet({ hd: true });
        const foreign = MnemonicIdentity.fromMnemonic(
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
            { isMainnet: false },
        ).descriptor.replace("/*)", "/0)");
        await expect(wallet.signerForDescriptor(foreign)).rejects.toBeInstanceOf(
            ForeignDescriptorError,
        );
        await wallet.dispose();
    });

    it("signerForDescriptor answers the identity for the identity's own bare descriptor", async () => {
        // An HD wallet may hold records bound to its baseline key — e.g.
        // written while the wallet ran as `auto`/static, before an HD
        // migration. The identity key IS that descriptor's key.
        const wallet = await makeWallet({ hd: true });
        const own = `tr(${hex.encode(await wallet.identity.xOnlyPublicKey())})`;
        expect(await wallet.signerForDescriptor(own)).toBe(wallet.identity);
        await wallet.dispose();
    });
});
