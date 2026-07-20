import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkadeSwaps } from "../src/arkade-swaps";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import type { ChainTipSnapshot } from "../src/utils/locktime";

/**
 * Chain-tip resolution on `ArkadeSwaps`: the laziness that keeps a timestamp
 * locktime off the network, and the warn latch that makes a missing
 * `OnchainProvider` diagnosable instead of silently deferring refunds forever.
 *
 * The pure threshold arithmetic these sit on top of is covered in
 * test/locktime.test.ts; what needs an instance is precisely the part that
 * consults `this.onchainProvider`.
 */

const HEIGHT_LOCKTIME = 200_000;
const TIMESTAMP_LOCKTIME = 1_800_000_000;

// Matches the phrasing of warnMissingOnchainProviderOnce, loosely enough to
// survive rewording but tightly enough to not match the fetch-failure warning.
const MISSING_PROVIDER_WARNING = /no\s+OnchainProvider is configured/i;

type Swaps = ArkadeSwaps & {
    chainTipSnapshotFor(locktimes: number[]): Promise<ChainTipSnapshot>;
    isRefundLocktimeReachedAt(locktime: number, tip: ChainTipSnapshot): boolean;
};

function makeSwaps(onchainProvider?: unknown, wallet?: unknown): Swaps {
    const arkProvider = { getInfo: vi.fn() } as any;
    const indexerProvider = { getVtxos: vi.fn() } as any;
    return new ArkadeSwaps({
        wallet: (wallet ?? { identity: {}, arkProvider, indexerProvider }) as any,
        arkProvider,
        indexerProvider,
        onchainProvider: onchainProvider as any,
        swapProvider: new BoltzSwapProvider({ network: "regtest" }),
        swapRepository: { getAllSwaps: vi.fn() } as any,
        swapManager: false,
    }) as Swaps;
}

const providerAt = (height: number) => ({ getChainTip: vi.fn().mockResolvedValue({ height }) });

describe("ArkadeSwaps chain-tip resolution", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const missingProviderWarnings = () =>
        warnSpy.mock.calls.filter(([first]) => MISSING_PROVIDER_WARNING.test(String(first)));

    describe("chainTipSnapshotFor laziness", () => {
        it("skips the fetch entirely when no locktime is block-denominated", async () => {
            const provider = providerAt(210_000);
            const swaps = makeSwaps(provider);

            const tip = await swaps.chainTipSnapshotFor([TIMESTAMP_LOCKTIME, TIMESTAMP_LOCKTIME]);

            expect(provider.getChainTip).not.toHaveBeenCalled();
            expect(tip).toEqual({ resolved: true });
        });

        it("fetches once for a batch containing any block-denominated locktime", async () => {
            const provider = providerAt(210_000);
            const swaps = makeSwaps(provider);

            const tip = await swaps.chainTipSnapshotFor([
                TIMESTAMP_LOCKTIME,
                HEIGHT_LOCKTIME,
                HEIGHT_LOCKTIME + 1,
            ]);

            expect(provider.getChainTip).toHaveBeenCalledTimes(1);
            expect(tip).toEqual({ resolved: true, height: 210_000 });
        });

        it("reports a resolved-but-empty snapshot when the fetch fails", async () => {
            const provider = { getChainTip: vi.fn().mockRejectedValue(new Error("network down")) };
            const swaps = makeSwaps(provider);

            // `resolved: true` with no height is what stops callers from
            // re-fetching per swap after a failed hoisted lookup.
            expect(await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME])).toEqual({ resolved: true });
        });
    });

    describe("missing-provider warning", () => {
        it("warns exactly once across repeated block-height evaluations", async () => {
            const swaps = makeSwaps(undefined, { identity: {} });
            const tip = await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME]);

            for (let i = 0; i < 5; i++) {
                expect(swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME, tip)).toBe(false);
            }

            expect(missingProviderWarnings()).toHaveLength(1);
        });

        it("latches per instance, so a second instance warns again", async () => {
            for (const _ of [0, 1]) {
                const swaps = makeSwaps(undefined, { identity: {} });
                const tip = await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME]);
                swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME, tip);
            }

            // A module-scoped latch would report 1 here — and would silence the
            // warning for every test after the first, and for a second network.
            expect(missingProviderWarnings()).toHaveLength(2);
        });

        it("does not warn when the locktime is a timestamp", async () => {
            const swaps = makeSwaps(undefined, { identity: {} });
            const tip = await swaps.chainTipSnapshotFor([TIMESTAMP_LOCKTIME]);

            swaps.isRefundLocktimeReachedAt(TIMESTAMP_LOCKTIME, tip);

            // The absent provider is harmless on the timestamp path — which is
            // all of mainnet — so warning there would be a false alarm.
            expect(missingProviderWarnings()).toHaveLength(0);
        });

        it("does not warn when a configured provider's getChainTip rejects", async () => {
            const provider = { getChainTip: vi.fn().mockRejectedValue(new Error("network down")) };
            const swaps = makeSwaps(provider);
            const tip = await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME]);

            expect(swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME, tip)).toBe(false);

            // Same undefined height, different cause: a transient fetch failure
            // is already logged by chainTipHeight, and "no provider configured"
            // would misdiagnose it.
            expect(missingProviderWarnings()).toHaveLength(0);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringMatching(/Failed to fetch chain tip/),
            );
        });
    });

    describe("evaluating against a pre-resolved snapshot", () => {
        it("does not re-fetch when the snapshot carries no height", async () => {
            const provider = { getChainTip: vi.fn().mockRejectedValue(new Error("network down")) };
            const swaps = makeSwaps(provider);
            const tip = await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME]);
            provider.getChainTip.mockClear();

            expect(swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME, tip)).toBe(false);

            // The batch path hoists one fetch for N swaps; re-resolving here
            // would restore N attempts, each paying its own failure latency.
            expect(provider.getChainTip).not.toHaveBeenCalled();
        });

        it("resolves the locktime against the snapshot's height", async () => {
            const swaps = makeSwaps(providerAt(HEIGHT_LOCKTIME));
            const tip = await swaps.chainTipSnapshotFor([HEIGHT_LOCKTIME]);

            expect(swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME, tip)).toBe(true);
            expect(swaps.isRefundLocktimeReachedAt(HEIGHT_LOCKTIME + 1, tip)).toBe(false);
        });
    });

    describe("onchainProvider resolution from the wallet", () => {
        // Regression for the service-worker path: worker-side, MessageBus builds
        // a real `Wallet` (which always constructs an EsploraProvider) and hands
        // it to ArkadeSwaps without an explicit onchainProvider. If the wallet
        // fallback broke, that context would silently lose block-height refunds.
        it("falls back to the wallet's provider when config omits one", () => {
            const walletProvider = providerAt(210_000);
            const swaps = makeSwaps(undefined, {
                identity: {},
                onchainProvider: walletProvider,
            });

            expect(swaps.onchainProvider).toBe(walletProvider);
        });

        it("prefers an explicit provider over the wallet's", () => {
            const explicit = providerAt(1);
            const swaps = makeSwaps(explicit, {
                identity: {},
                onchainProvider: providerAt(2),
            });

            expect(swaps.onchainProvider).toBe(explicit);
        });

        it("is null when neither the config nor the wallet carries one", () => {
            // ServiceWorkerWallet is the real instance of this shape: it holds
            // URL strings, not provider objects.
            expect(makeSwaps(undefined, { identity: {} }).onchainProvider).toBeNull();
        });
    });
});
