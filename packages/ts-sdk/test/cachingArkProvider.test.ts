import { describe, it, expect, vi, afterEach } from "vitest";
import { CachingArkProvider } from "../src/providers/cachingArk";
import { ArkInfo, ArkProvider } from "../src/providers/ark";

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

/** Minimal ArkProvider stub exposing only what CachingArkProvider touches. */
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
});
