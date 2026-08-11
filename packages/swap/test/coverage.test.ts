import { describe, expect, it, vi } from "vitest";
import { promoteOfferContract, retireOfferContract } from "../src/coverage";
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
