import { describe, expect, it, vi } from "vitest";
import {
    LOCKUP_RETIRABLE,
    promoteOfferContract,
    retireOfferContract,
    registerContractCoverage,
} from "../src/coverage";
import type { AssetSwap } from "../src/store";

const SCRIPT = "51" + "aa".repeat(32);

const manager = () => ({
    setContractWatchState: vi.fn(async (_script: string, _watch: string) => {}),
});

const swap = (over: Partial<AssetSwap>): AssetSwap => ({
    id: "aa".repeat(32),
    fromAsset: "btc",
    toAsset: "cc".repeat(34),
    fromAmount: "10000",
    toAmount: "50000",
    swapAddress: "",
    swapPkScript: SCRIPT,
    offerHex: "00",
    fundingTxid: "aa".repeat(32),
    status: "fulfilled",
    createdAt: 1_700_000_000_000,
    ...over,
});

// The two sides of one row. `createOffer` promotes a script the moment it hands
// out an address to fund; a settlement at that same script — identical offers
// derive one — retires it. What must never happen is the demotion landing last.
describe("offer contract coverage", () => {
    it("does not retire a script whose address is still waiting for its deposit", async () => {
        // the race the watcher would otherwise lose: it read its records, found
        // them all settled, and only then does a new offer claim the script.
        // The old swap's `createdAt` predates the issuance, so it is not this
        // address's funding and says nothing about it.
        const { setContractWatchState } = manager();
        await promoteOfferContract({ setContractWatchState }, SCRIPT);
        await retireOfferContract({ setContractWatchState }, [swap({})], SCRIPT);

        expect(setContractWatchState.mock.calls).toEqual([[SCRIPT, "watched"]]);
    });

    it("retires once the issued address has been funded and settled", async () => {
        // the mark answers one question — has this address been funded — and a
        // record created since the issuance is that funding; from there the
        // records are the liveness answer again
        const { setContractWatchState } = manager();
        await promoteOfferContract({ setContractWatchState }, SCRIPT);
        const funded = [swap({ createdAt: Date.now() })];
        await retireOfferContract({ setContractWatchState }, funded, SCRIPT);

        expect(setContractWatchState.mock.calls).toEqual([
            [SCRIPT, "watched"],
            [SCRIPT, "retained"],
        ]);
    });

    it("keeps a promotion that arrives mid-retire", async () => {
        // `setContractWatchState` is a read-modify-write over the row, so the
        // two are ordered here: a promotion that overlaps a demotion in flight
        // must not end up underneath it
        let release: () => void = () => {};
        const blocked = new Promise<void>((resolve) => (release = resolve));
        // the row as the manager would leave it: what lands, lands last, so a
        // slow demotion left free to overlap wins over the promotion it raced
        let row = "watched";
        const setContractWatchState = async (_script: string, watch: string) => {
            if (watch === "retained") await blocked;
            row = watch;
        };

        const retire = retireOfferContract({ setContractWatchState }, [swap({})], SCRIPT);
        // let the retire reach its write before the promotion is asked for
        await Promise.resolve();
        const promote = promoteOfferContract({ setContractWatchState }, SCRIPT);
        release();
        await Promise.all([retire, promote]);

        expect(row).toBe("watched");
    });
});

describe("corridor lockup coverage", () => {
    it("retires only the two states that mean the lockup was spent", () => {
        expect([...LOCKUP_RETIRABLE].sort()).toEqual(["refunded", "settled"]);
    });

    it.each(["pending", "claimable", "claimed", "needs_counterparty", "failed"] as const)(
        "never retires %s, which can still hold the user's money",
        (state) => {
            expect(LOCKUP_RETIRABLE).not.toContain(state);
        },
    );
});

describe("native issuance identity", () => {
    it("shares a wallet's holds across fresh manager proxies without pinning another wallet", async () => {
        const first = {};
        const second = {};
        const script = "native-wallet-scopes";
        const firstWatch = vi.fn(async (_script: string, _watch: string) => {});
        const secondWatch = vi.fn(async (_script: string, _watch: string) => {});
        const proxy = (setContractWatchState: typeof firstWatch) => ({ setContractWatchState });
        await promoteOfferContract(proxy(firstWatch), script, 1000, {
            coverageId: "first",
            scope: first,
        });
        await promoteOfferContract(proxy(secondWatch), script, 1000, {
            coverageId: "second",
            scope: second,
        });
        await retireOfferContract(
            proxy(secondWatch),
            [swap({ id: "second", swapPkScript: script })],
            script,
            { scope: second },
        );
        expect(secondWatch).toHaveBeenLastCalledWith(script, "retained");
        await promoteOfferContract(proxy(firstWatch), script, 1000, {
            coverageId: "restored",
            scope: first,
            restore: true,
        });
        firstWatch.mockClear();
        const restored = swap({ id: "restored", swapPkScript: script });
        await retireOfferContract(proxy(firstWatch), [restored], script, { scope: first });
        expect(firstWatch).not.toHaveBeenCalled();
        await retireOfferContract(
            proxy(firstWatch),
            [restored, swap({ id: "first", swapPkScript: script })],
            script,
            { scope: first },
        );
        expect(firstWatch).toHaveBeenCalledExactlyOnceWith(script, "retained");
    });

    it.each(["offer", "lockup"])(
        "keeps an older outstanding %s when a newer record is cancelled first",
        async (kind) => {
            const m = manager();
            const script = `native-reversed-${kind}`;
            const register = async (id: string) => {
                if (kind === "offer") {
                    await promoteOfferContract(m, script, 1000, { coverageId: id });
                } else {
                    await registerContractCoverage(script, async () => {}, { coverageId: id });
                }
            };
            await register("older");
            await register("newer");
            m.setContractWatchState.mockClear();
            const cancelled = swap({ id: "newer", swapPkScript: script, status: "cancelled" });
            await retireOfferContract(m, [cancelled], script);
            expect(m.setContractWatchState).not.toHaveBeenCalled();
            const funded = swap({ id: "older", swapPkScript: script, status: "pending" });
            await retireOfferContract(m, [cancelled, funded], script);
            expect(m.setContractWatchState).not.toHaveBeenCalled();
            await retireOfferContract(m, [cancelled, { ...funded, status: "fulfilled" }], script);
            expect(m.setContractWatchState).toHaveBeenCalledExactlyOnceWith(script, "retained");
        },
    );

    it("retires a matching record despite second precision", async () => {
        const m = manager();
        const script = "native-fractional";
        await promoteOfferContract(m, script, 1_700_000_000_537, { coverageId: "quote-a" });
        await retireOfferContract(m, [swap({ id: "quote-a", swapPkScript: script })], script);
        expect(m.setContractWatchState.mock.calls).toEqual([
            [script, "watched"],
            [script, "retained"],
        ]);
    });

    it.each([0, 1])("preserves a newer issuance %s milliseconds later", async (offset) => {
        const m = manager();
        const script = `native-identical-${offset}`;
        const issued = 1_700_000_000_537;
        await promoteOfferContract(m, script, issued, { coverageId: "old" });
        await promoteOfferContract(m, script, issued + offset, { coverageId: "new" });
        await retireOfferContract(
            m,
            [swap({ id: "old", swapPkScript: script, createdAt: issued + 1000 })],
            script,
        );
        expect(m.setContractWatchState.mock.calls).toEqual([
            [script, "watched"],
            [script, "watched"],
        ]);
        await retireOfferContract(m, [swap({ id: "new", swapPkScript: script })], script);
        expect(m.setContractWatchState).toHaveBeenLastCalledWith(script, "retained");
    });

    it("retains a tokened lockup until its own record is durable", async () => {
        const m = manager();
        const script = "native-lockup";
        await registerContractCoverage(script, async () => {}, { coverageId: "lockup-new" });
        await retireOfferContract(
            m,
            [swap({ id: "lockup-old", swapPkScript: script, createdAt: Date.now() + 1000 })],
            script,
        );
        expect(m.setContractWatchState).not.toHaveBeenCalled();
        await retireOfferContract(m, [swap({ id: "lockup-new", swapPkScript: script })], script);
        expect(m.setContractWatchState).toHaveBeenCalledWith(script, "retained");
    });

    it("keeps native and legacy issuances independently outstanding", async () => {
        const m = manager();
        const script = "native-and-legacy";
        await promoteOfferContract(m, script, 1000, { coverageId: "native" });
        await promoteOfferContract(m, script, 2000);
        m.setContractWatchState.mockClear();
        const legacy = swap({ id: "legacy", swapPkScript: script, createdAt: 2000 });
        await retireOfferContract(m, [legacy], script);
        expect(m.setContractWatchState).not.toHaveBeenCalled();
        await retireOfferContract(
            m,
            [legacy, swap({ id: "native", swapPkScript: script, createdAt: 1000 })],
            script,
        );
        expect(m.setContractWatchState).toHaveBeenCalledExactlyOnceWith(script, "retained");
    });

    it("does not replace a newer issuance while restoring an older native record", async () => {
        const m = manager();
        const script = "native-restore";
        await promoteOfferContract(m, script, 1000, { coverageId: "new" });
        await promoteOfferContract(m, script, 1000, { coverageId: "old", restore: true });
        await retireOfferContract(
            m,
            [swap({ id: "old", swapPkScript: script, createdAt: 2000 })],
            script,
        );
        expect(m.setContractWatchState.mock.calls).toEqual([
            [script, "watched"],
            [script, "watched"],
        ]);
    });

    it("reads records within the script queue and preserves coverage on read failure", async () => {
        const m = manager();
        const script = "native-fresh-read";
        await promoteOfferContract(m, script, 1000, { coverageId: "new" });
        const read = vi.fn(async () => {
            throw new Error("store offline");
        });
        await expect(retireOfferContract(m, read, script)).rejects.toThrow("store offline");
        await retireOfferContract(
            m,
            [swap({ id: "old", swapPkScript: script, createdAt: 2000 })],
            script,
        );
        expect(m.setContractWatchState.mock.calls).toEqual([[script, "watched"]]);
    });
});

it("keeps legacy millisecond precision without a registration token", async () => {
    const m = manager();
    const script = "legacy-fractional";
    await promoteOfferContract(m, script, 1_700_000_000_537);
    await retireOfferContract(m, [swap({ swapPkScript: script })], script);
    expect(m.setContractWatchState.mock.calls).toEqual([[script, "watched"]]);
});

it("waits for the coverage queue before reading current durable liabilities", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const script = "native-queued-read";
    const m = {
        setContractWatchState: vi.fn(async () => {
            await blocked;
        }),
    };
    const promoting = promoteOfferContract(m, script, 1000, { coverageId: "new" });
    await Promise.resolve();
    let records = [swap({ id: "new", swapPkScript: script })];
    const read = vi.fn(async () => records);
    const retiring = retireOfferContract(m, read, script);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    records = [swap({ id: "new", swapPkScript: script, status: "pending" })];
    release();
    await Promise.all([promoting, retiring]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(m.setContractWatchState.mock.calls).toEqual([[script, "watched"]]);
});
