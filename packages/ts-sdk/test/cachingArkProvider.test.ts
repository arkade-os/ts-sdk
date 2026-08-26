import { describe, it, expect, vi, afterEach } from "vitest";
import { CachingArkProvider } from "../src/providers/cachingArk";
import { ArkInfo, ArkProvider, RestArkProvider } from "../src/providers/ark";
import { extractArkProviderUrl } from "../src/wallet/wallet";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const ROTATED = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";

function fakeInfo(digest: string): ArkInfo {
    return {
        boardingExitDelay: 0n,
        checkpointTapscript: "",
        deprecatedSigners: [],
        digest,
        dust: 0n,
        fees: { intentFee: {} as never, txFeeRate: "" },
        forfeitAddress: "",
        forfeitPubkey: "",
        network: "regtest",
        serviceStatus: {},
        sessionDuration: 0n,
        signerPubkey: "signer",
        unilateralExitDelay: 0n,
        utxoMaxAmount: -1n,
        utxoMinAmount: 0n,
        version: "1.0",
        vtxoMaxAmount: -1n,
        vtxoMinAmount: 0n,
    };
}

function fakeInner(getInfo: () => Promise<ArkInfo>) {
    const listeners = new Set<(info: ArkInfo) => void>();
    return {
        getInfo,
        onServerInfoChanged: (listener: (info: ArkInfo) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit: (info: ArkInfo) => listeners.forEach((l) => l(info)),
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("CachingArkProvider", () => {
    it("serves getInfo from cache within the TTL", async () => {
        const getInfo = vi.fn().mockResolvedValue(fakeInfo("d1"));
        const provider = new CachingArkProvider(
            fakeInner(getInfo) as unknown as ArkProvider,
            60_000,
        );

        await provider.getInfo();
        await provider.getInfo();

        expect(getInfo).toHaveBeenCalledTimes(1);
    });

    it("refetches once the TTL expires", async () => {
        vi.useFakeTimers();
        const getInfo = vi.fn().mockResolvedValue(fakeInfo("d1"));
        const provider = new CachingArkProvider(
            fakeInner(getInfo) as unknown as ArkProvider,
            60_000,
        );

        await provider.getInfo();
        vi.advanceTimersByTime(60_001);
        await provider.getInfo();

        expect(getInfo).toHaveBeenCalledTimes(2);
    });

    it("dedupes concurrent misses into a single inner call", async () => {
        let resolveInner!: (info: ArkInfo) => void;
        const getInfo = vi.fn().mockReturnValue(
            new Promise<ArkInfo>((resolve) => {
                resolveInner = resolve;
            }),
        );
        const provider = new CachingArkProvider(
            fakeInner(getInfo) as unknown as ArkProvider,
            60_000,
        );

        const a = provider.getInfo();
        const b = provider.getInfo();
        resolveInner(fakeInfo("d1"));
        await Promise.all([a, b]);

        expect(getInfo).toHaveBeenCalledTimes(1);
    });

    it("refreshes the cache instantly when the inner provider reports a signer rotation", async () => {
        const getInfo = vi.fn().mockResolvedValue(fakeInfo("d1"));
        const inner = fakeInner(getInfo);
        const provider = new CachingArkProvider(inner as unknown as ArkProvider, 60_000);

        await provider.getInfo();
        inner.emit(fakeInfo("d2"));
        const info = await provider.getInfo();

        expect(info.digest).toBe("d2");
        expect(getInfo).toHaveBeenCalledTimes(1);
    });

    it("keeps an event-cached rotation over an older in-flight fetch result", async () => {
        let resolveInner!: (info: ArkInfo) => void;
        const getInfo = vi.fn().mockReturnValue(
            new Promise<ArkInfo>((resolve) => {
                resolveInner = resolve;
            }),
        );
        const inner = fakeInner(getInfo);
        const provider = new CachingArkProvider(inner as unknown as ArkProvider, 60_000);

        const pending = provider.getInfo();
        inner.emit(fakeInfo("d2"));
        resolveInner(fakeInfo("d1"));

        expect((await pending).digest).toBe("d2");
        expect((await provider.getInfo()).digest).toBe("d2");
        expect(getInfo).toHaveBeenCalledTimes(1);
    });

    it("does not extend the TTL of an event-cached rotation with the older fetch's clock", async () => {
        vi.useFakeTimers();
        let resolveInner!: (info: ArkInfo) => void;
        const getInfo = vi.fn().mockReturnValueOnce(
            new Promise<ArkInfo>((resolve) => {
                resolveInner = resolve;
            }),
        );
        const inner = fakeInner(getInfo);
        const provider = new CachingArkProvider(inner as unknown as ArkProvider, 60_000);

        const pending = provider.getInfo();
        inner.emit(fakeInfo("d2"));
        vi.advanceTimersByTime(30_000);
        resolveInner(fakeInfo("d1"));
        await pending;

        getInfo.mockResolvedValue(fakeInfo("d3"));
        vi.advanceTimersByTime(30_001);

        expect((await provider.getInfo()).digest).toBe("d3");
    });

    it("stops caching rotation events once disposed", async () => {
        const getInfo = vi.fn().mockResolvedValue(fakeInfo("d1"));
        const inner = fakeInner(getInfo);
        const provider = new CachingArkProvider(inner as unknown as ArkProvider, 60_000);

        await provider.getInfo();
        provider.dispose();
        inner.emit(fakeInfo("d2"));

        expect((await provider.getInfo()).digest).toBe("d1");
    });

    it("disposes cleanly when the inner provider emits no server-info events", () => {
        const provider = new CachingArkProvider({
            getInfo: async () => fakeInfo("d1"),
        } as unknown as ArkProvider);

        expect(() => provider.dispose()).not.toThrow();
    });

    it("surfaces a rotation first observed by a TTL-expiry refetch", async () => {
        vi.useFakeTimers();
        let digest = "d1";
        let signerPubkey = SIGNER;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: true, json: async () => ({ signerPubkey, digest }) })),
        );
        const provider = new CachingArkProvider(new RestArkProvider("http://ark.test"), 60_000);
        await provider.getInfo();

        const seen: ArkInfo[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        digest = "d2";
        signerPubkey = ROTATED;
        vi.advanceTimersByTime(60_001);
        const info = await provider.getInfo();

        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(ROTATED);
        expect(info.signerPubkey).toBe(ROTATED);
        expect((await provider.getInfo()).digest).toBe("d2");
    });

    it("forwards the inner provider's serverUrl to wallet setup's structural read", () => {
        const provider = new CachingArkProvider(new RestArkProvider("http://ark.test"));

        expect(provider.serverUrl).toBe("http://ark.test");
        expect(extractArkProviderUrl(provider)).toBe("http://ark.test");
    });

    it("reports no serverUrl when the inner provider has none", () => {
        const provider = new CachingArkProvider(
            fakeInner(async () => fakeInfo("d1")) as unknown as ArkProvider,
        );

        expect(provider.serverUrl).toBeUndefined();
        expect(extractArkProviderUrl(provider)).toBeUndefined();
    });
});
